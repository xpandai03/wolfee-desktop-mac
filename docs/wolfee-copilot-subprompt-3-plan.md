# Wolfee Copilot Sub-prompt 3 (Intelligence) — Execution Plan

Author: implementing engineer
Status: planning pass complete, **zero code changed**. Read-only.
Date: 2026-05-02

---

## 0 — Status & relationship to prior work

Sub-prompt 2 (Listening) is **functionally complete**. Live transcripts flow end-to-end on production .app builds — verified 2026-05-03 with real speech (mic) and YouTube (system audio) producing `final (user, 1.00)` and `final (speakers, 1.00)` Deepgram events landing in `TranscriptBufferMutex`. The Phase 7 24-hour soak is deferred to PO availability but is independent of this planning work.

**Sacred files (do NOT modify in Sub-prompt 3 execution):**
- `src-tauri/src/copilot/window.rs`, `copilot/hotkey.rs` — Sub-prompt 1
- `src-tauri/src/copilot/audio/*.rs` — Sub-prompt 2 Phase 2
- `src-tauri/src/copilot/transcribe/buffer.rs` — Sub-prompt 2 Phase 4
- `src-tauri/src/copilot/transcribe/deepgram.rs` — Sub-prompt 2 Phase 3
- `src-tauri/src/copilot/session/api.rs` — Sub-prompt 2 Phase 5
- `src-tauri/src/recorder.rs`, `uploader.rs`, `auth.rs`
- `WOLFEE-MVP/server/lib/meetings/*`, `lib/analysis/*`, `lib/auth.ts` — Notes/Practice product

**Read-only inputs:**
- [`TranscriptBufferMutex`](src-tauri/src/copilot/state.rs) and [`Utterance`](src-tauri/src/copilot/transcribe/buffer.rs) — shape locked, just consume `merged_view()` / `last_n_seconds()` / `last_user_question_age_ms()`
- [`SessionApi`](src-tauri/src/copilot/session/api.rs) — extend with new methods, don't break existing
- Existing Tauri events: `transcript-chunk` (consume, don't re-emit), `copilot-permission-needed` (Phase 6), `wolfee-action` (use for actions)

**Locked architecture inputs from prior docs:**
- [Audit §3](../WOLFEE-MVP/wolfee-copilot-architecture-audit-2026-05-01.md) — backend endpoint shape, OAuth patterns, `requireDeviceAuth` middleware, OpenAI usage pattern (`AI_INTEGRATIONS_OPENAI_API_KEY` env, per-call client, `gpt-4o-mini` for fast paths, JSON mode for structured)
- [Design §3.1](../WOLFEE-MVP/wolfee-copilot-v1-design-2026-05-02.md) — three-worker architecture (rolling summary / moment detector / suggestion generator), 30s cadence, hybrid model, trigger taxonomy, cost analysis

**What the audit + design already locked, that I do NOT relitigate:**
- Hybrid model (always-listening detector + hotkey override) — design §3
- 30s default cadence for rolling summary and moment detector — design Decisions 9, N1
- Trigger taxonomy: objection / pricing_question / silence_after_question / decision_moment / emotional_cue (+ buying_signal as new addition) — design §3.2
- Sensitivity preset 4-step (Off / Low / Medium / High) — design Decision N4, but the actual UI ships in **Sub-prompt 6**, not here
- Surface UI distinction (hotkey vs moment-triggered visuals) — ships in **Sub-prompt 4**, not here
- Backend-mediated LLM (no direct desktop→OpenAI calls) — design §3.1 + audit §3.3
- Privacy: transcripts RAM-only, suggestions opt-in for persistence — design Decision 20

What this plan locks fresh, in 11 sections.

---

## 1 — Architecture overview

```
                ┌───── DESKTOP (wolfee-desktop) ────────────┐         ┌── BACKEND (WOLFEE-MVP) ──┐
                │                                            │         │                          │
[mic] ──┐       │   Phase 2 audio + Phase 3 Deepgram WS      │         │  Express 5 + Drizzle     │
        ├──── 250ms stereo ──► [TranscriptBufferMutex]       │         │                          │
[sys] ──┘       │       (final Utterances, 90s window)       │         │  /api/copilot/sessions   │
                │             ▲          ▲                   │         │   /:id/intelligence/     │
                │             │          │                   │         │   ├─ summary  (POST)     │
                │   ┌─────────┴────┐    │                   │         │   ├─ detect-moment (POST)│
                │   │              │    │                   │         │   └─ suggest (POST, SSE) │
                │   │ NEW: copilot/intelligence/ tokio task │   HTTPS  │                          │
                │   │   ┌──────────────────┐               ◄────┬─────►│  intelligence/           │
                │   │   │ summary worker   │ every 30s     │    │      │   summary.ts             │
                │   │   │ (calls /summary) │               │    │      │   momentDetector.ts      │
                │   │   ├──────────────────┤               │    │      │   suggest.ts (SSE)       │
                │   │   │ moment worker    │ every 30s     │    │      │   prompts/*.md           │
                │   │   │ (heuristic gate ─┤───────────────┘    │      │                          │
                │   │   │  + /detect-…)    │                    │      │   (per-session map)      │
                │   │   ├──────────────────┤                    │      │                          │
                │   │   │ suggest trigger  │◄─ emits ───────────┘      │  in-RAM:                 │
                │   │   │ (moment OR hotkey│                           │   sessionId →            │
                │   │   │  → /suggest SSE) │                           │     { rollingSummary,    │
                │   │   └──────────────────┘                           │       lastMoment,        │
                │   │           │                                      │       lastSuggestionAt } │
                │   │           ▼                                      │                          │
                │   │  emits Tauri events:                             │   OpenAI SDK             │
                │   │   - copilot-moment-detected                      │   (gpt-4o-mini default)  │
                │   │   - copilot-suggestion                           │                          │
                │   │   - copilot-suggestion-dismissed                 │                          │
                │   └──────────────────────────────────────────────────┘                          │
                │                                                      │                          │
                │   Sub-prompt 4 (later) renders these events          │                          │
                └──────────────────────────────────────────────────────┘──────────────────────────┘
```

**Three layers, all hosted as tokio tasks on `tauri::async_runtime::spawn`:**

1. **Summary worker** — interval 30s; reads `TranscriptBufferMutex.merged_view()`, POSTs window + previous summary to backend, stores returned summary in `RollingSummaryMutex`.
2. **Moment worker** — interval 5s **heuristic check** + 30s **LLM verification gate**. Heuristics run cheaply in Rust on the latest finals; only when at least one heuristic hits does the worker call backend `/detect-moment`. This is the **heuristic-first with LLM verifier** architecture (Section 5 below).
3. **Suggestion trigger** — fires from two paths: (a) moment worker reports `should_suggest=true` AND `urgency >= 3`, or (b) Sub-prompt 3's new hotkey is pressed. Either way, POST `/suggest` SSE; stream tokens in; emit `copilot-suggestion` event.

**Data flow rules:**
- Transcript stays in Rust (`TranscriptBufferMutex`); backend never persists transcript text. Each LLM call sends a windowed snippet.
- Rolling summary stored in **both** Rust (for sub-prompt 4 overlay rendering) AND backend (so `/detect-moment` and `/suggest` can read it without round-trip). Authoritative copy on backend; Rust mirror is a cache pushed by `/summary` response.
- Suggestion is generated backend-side, streamed back via SSE, rendered by overlay (Sub-prompt 4).
- Cooldowns (per-moment-type rate limit) live in **Rust** so we save the LLM call entirely when cooldown is active.

---

## 2 — LLM provider + model choice

**Locked: tiered OpenAI default, with abstraction for swap-in.**

| layer | model (default) | provider | rationale |
|---|---|---|---|
| Rolling summary | `gpt-4o-mini` | OpenAI | matches design Decision 10; cheap synthesis, 1-2s p50 |
| Moment detector | `gpt-4o-mini` | OpenAI | matches design Decision N2; fast classifier with JSON mode |
| Suggestion generator | `gpt-4o-mini` (default) with `gpt-4o` A/B switch in dev | OpenAI | matches design Decision 11; suggestion quality is highest-impact lever |

**Why not Claude (Haiku 4.5 / Sonnet 4.6)?**

The design doc considered Anthropic and rejected for V1 — the existing backend uses OpenAI exclusively (`server/lib/analysis/*`, `server/lib/meetings/askWolfee.ts`); adding Anthropic means a second SDK, second credential management path, second rate-limit pool, no shared retry/timeout helpers. Quality difference between `gpt-4o-mini` and `claude-haiku-4-5` for short structured tasks is not large enough to justify the operational cost in V1. Haiku-4.5 is a viable swap target post-V1 if eval data shows quality gains; the abstraction below makes the swap a 1-day change.

**Abstraction layer (lives in `WOLFEE-MVP/server/lib/copilot/intelligence/llmClient.ts`):**

```ts
type LlmCall = (params: {
  model: string;                    // resolved at call site
  system: string;
  user: string;
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}) => Promise<...>;
```

Single file imports `openai`. If we ever swap, only this file changes.

**Per-call config (locked):**

| layer | model | temp | max_tokens | json_mode | stream |
|---|---|---|---|---|---|
| Summary | gpt-4o-mini | 0.2 | 600 | no | no |
| Moment detector | gpt-4o-mini | 0.0 | 200 | yes | no |
| Suggest | gpt-4o-mini | 0.4 | 400 | yes | yes (SSE) |

**Cost per 30-min session (locked):**
- Summary: 60 calls × ~1K in / 200 out = ~$0.016
- Moment detector: ~40 calls (heuristic-gated; less than 60) × ~250 in / 30 out = ~$0.003
- Suggest: ~5 surfaced/session × ~1.5K in / 400 out = ~$0.003
- **Total LLM ≈ $0.022/session**, plus ~$0.13 Deepgram = ~$0.15/session. Matches design §3.3.

**API key:** existing env `AI_INTEGRATIONS_OPENAI_API_KEY` (Replit-channel preferred) with `OPENAI_API_KEY` fallback. Per-call instantiation matches existing pattern in `askWolfee.ts:280`. No new env var.

---

## 3 — Where intelligence runs (desktop vs backend)

**Locked: backend-driven (Option A).** Audit §3.3 + design §3.1 already specify this. Reasons:

- LLM API keys must stay backend-side (not on user machines)
- Mirrors existing `askWolfee.ts` SSE pattern — no new server infra
- Backend can rate-limit per-user and cap cost (Section 12 telemetry needs this anyway)
- Desktop Rust can stay thin: 3 workers, each a 60-line tokio task

**Desktop responsibilities:**
- 3 worker tasks (intervals + triggers)
- Heuristic moment-candidate detection (cheap Rust)
- Cooldown tracking (per moment type)
- Tauri event emission
- Rolling summary mirror in `RollingSummaryMutex` (read-only after backend response)

**Backend responsibilities:**
- 3 endpoints (POST /summary, /detect-moment, /suggest with SSE)
- LLM orchestration via `openai` SDK
- Per-session in-memory state (rolling summary + last-moment-fired-at + last-suggestion-fired-at)
- Optional telemetry write to DB (Section 12)
- Auth: `requireDeviceAuth` (existing)

**Failure handling:**
- LLM call fails → Rust worker logs, retries on next interval; never crashes session
- Backend 5xx → Rust worker backs off (exponential, 5s/15s/45s cap), surface to tray after 3 consecutive failures
- Network blip → reuse Phase 3's reconnection lessons (don't kill session, keep audio capture flowing)

---

## 4 — Rolling summary architecture

**Locked: incremental every 30s + periodic full re-synthesis every 5 min (Option C from prompt).**

**Storage:** Backend in-memory map keyed by `sessionId`. Rust mirrors latest in `RollingSummaryMutex` for Sub-prompt 4 overlay render.

**Trigger:** `tokio::time::interval(Duration::from_secs(30))` in `summary` worker.

**Update logic:**
```
every 30s:
  window = TranscriptBuffer.last_n_seconds(35)   // small overlap
  if window.is_empty(): skip (no new transcript)
  resp = POST /summary { previous, window, mode: "incremental" }
  store resp.summary in backend map + Rust mirror
  every 10th tick (≈ every 5 min):
    resp = POST /summary { previous, window: last_n_seconds(300), mode: "full" }
    // full re-synthesis prevents drift accumulation
```

**Failure:** if call fails, keep previous summary. After 3 consecutive failures over ~90s, log warn and continue at next interval — don't surface error to user.

**Memory budget:** summary capped at ~500 tokens (~2 KB). Per session this is trivial. Backend map is `Map<sessionId, SessionState>`; cleanup on `/end` call (existing endpoint).

**First call:** when no previous summary exists, prompt is "produce initial summary"; Rust skips first interval if window has < 60s of finals.

---

## 5 — Moment detector

**Locked: heuristic-first with LLM verifier (Option B from prompt).**

This is the most cost-sensitive layer. Pure-LLM at 30s cadence costs ~$0.003/session — cheap. But heuristic-first gives us a knob to push cadence to 5s for snappier surfacing without 6× the cost.

### 5.1 — Heuristic candidates (Rust-side, cheap)

Run every 5s on `TranscriptBuffer.last_n_seconds(30)`:

| heuristic | matches | maps to candidate trigger |
|---|---|---|
| Most-recent `speakers` final ends with `?` | direct question | `pricing_question` if matches `(cost\|price\|how much\|ROI\|discount\|contract)` else `question_asked` |
| Last `user` final was a question, then ≥ 5s of silence on `speakers` | silence after question | `silence_after_question` |
| `speakers` final contains keyword in objection set: `expensive`, `concern`, `not sure`, `but `, `worried`, `pushback`, `problem` | objection cue | `objection` |
| `speakers` final contains: `let me think`, `talk to my team`, `get back to you`, `send me`, `circle back` | decision cue | `decision_moment` |
| `speakers` final contains: `competitor` keyword (configurable list — defaults: `salesforce`, `hubspot`, `gong`, `chorus`, `outreach`, `apollo`) | competitor mentioned | `competitor_mentioned` |
| `speakers` final contains positive cue: `that's great`, `love that`, `interesting`, `let's do it`, `sign me up` | buying signal | `buying_signal` |

**Cooldown (Rust state):** per trigger type, minimum N seconds between candidates entering LLM verification. Defaults:

| trigger | cooldown |
|---|---|
| objection | 60s |
| pricing_question | 45s |
| silence_after_question | 90s |
| decision_moment | 120s |
| buying_signal | 90s |
| competitor_mentioned | 180s |

**Spam guard:** if heuristics fire more than 5 candidates in 30s, throttle to 2 (the most urgent — decision_moment > objection > pricing_question > rest).

### 5.2 — LLM verifier

When ≥ 1 candidate passes heuristic + cooldown:

```
POST /api/copilot/sessions/:id/detect-moment
Body: {
  candidate_triggers: ["objection", "pricing_question"],
  transcript_window: "...90s of merged labeled finals...",
  rolling_summary: "..."
}
Response: {
  should_suggest: bool,
  trigger: "objection" | ... | "none",
  trigger_phrase: string | null,
  urgency: 1-5,
  rationale: string,
  is_speaker_mid_statement: bool   // gate per design §3.5 Risk row "Wrong moment"
}
```

**Surfacing rule (Rust):** emit `copilot-moment-detected` event AND fire suggest worker if `should_suggest && urgency >= 3 && !is_speaker_mid_statement`.

**Mid-statement gate:** verifier prompt explicitly checks if the most recent 3s of transcript is a partial / non-final from `speakers` (Rust passes a flag based on `TranscriptBuffer` state; backend cross-checks via the trailing token of the window).

### 5.3 — Moment types V1 ships

Locked: `question_asked`, `objection`, `silence_after_question`, `decision_moment`, `buying_signal`, `pricing_question`, `competitor_mentioned`, `confusion`. Eight types.

**Deferred to V1.x:** `decision_maker_mentioned`, `next_step_unclear`. Listed in prompt but adds eval surface area for marginal value.

### 5.4 — Sensitivity preset hookup

The Sub-prompt 6 sensitivity preset (Off / Low / Medium / High) maps to:

| preset | heuristic interval | LLM cadence cap | urgency threshold |
|---|---|---|---|
| Off | — (worker disabled) | — | — |
| Low | 10s | 60s | 4 |
| Medium (default) | 5s | 30s | 3 |
| High | 5s | 15s | 3 |

The preset value lives in the existing tauri-plugin-store; Sub-prompt 3 reads it but doesn't ship the UI to edit it (that's Sub-prompt 6). For V1 launch, default is **Low** per design Risk #6 mitigation ("ship as preview, conservative defaults") until eval harness validates Medium quality.

---

## 6 — Suggestion generator

**Locked: single LLM call per trigger event, JSON output, SSE streaming.**

### 6.1 — Inputs

```json
POST /api/copilot/sessions/:id/suggest
{
  "trigger_source": "moment" | "hotkey",
  "trigger": "objection",                // null if hotkey
  "trigger_phrase": "It's expensive",    // null if hotkey
  "rolling_summary": "...",              // backend reads from in-mem map; payload optional
  "transcript_window": "...90s..."
}
```

### 6.2 — Output (streamed JSON via SSE)

```jsonc
// stream chunks (existing askWolfee SSE pattern):
data: {"type": "suggestion-start", "id": "uuid", "moment_type": "objection"}
data: {"type": "delta", "field": "primary", "text": "Acknowledge "}
data: {"type": "delta", "field": "primary", "text": "the price concern, "}
data: {"type": "delta", "field": "primary", "text": "then anchor on ROI."}
data: {"type": "complete", "payload": {
  "suggestion_id": "uuid",
  "moment_type": "objection",
  "primary": "Acknowledge the price concern, then anchor on ROI.",
  "secondary": "Ask what ROI they'd need to see to greenlight.",   // optional
  "confidence": 0.78,
  "reasoning": "Direct objection without specific number — value-anchor opportunity",
  "ttl_seconds": 30
}}
data: {"done": true}
```

### 6.3 — Locked decisions

| decision | lock |
|---|---|
| Length cap | `primary` ≤ 200 chars; `secondary` (optional) ≤ 200 chars; ≤ 2 sentences each |
| Confidence threshold for surfacing | **0.6** (open decision N3 — PO may push to 0.65 or 0.5) |
| TTL | 30s default; overlay auto-fades at TTL (Sub-prompt 4 implements) |
| Streaming display | **Stream tokens to overlay** so user sees partial text within ~200ms (not wait full LLM call). Sub-prompt 4 renders. |
| Concurrency | Only one in-flight suggestion per session. New trigger during active suggestion → drop new (don't queue) and log telemetry "suggestion suppressed because previous still active". |
| Hotkey vs moment differentiation | Same call shape, different `trigger_source`; visual distinction is Sub-prompt 4. |

### 6.4 — Failure handling

- Stream errors mid-call → emit `copilot-suggestion-failed` event, log; user sees nothing (silent failure preferred to "loading… error" UX)
- LLM returns confidence < threshold → drop, telemetry counts the suppression
- LLM JSON parse fails → drop, telemetry counts; common failure mode worth tracking

---

## 7 — Hotkey override

**Locked: ⌘⌥G ("Generate") — separate from ⌘⌥W (overlay) and ⌘⌥⇧W (Pause Copilot from Sub-prompt 6).**

Three mac modifiers in use already (⌘⌥W, ⌘⌥⇧W reserved). Adding a fourth-modifier (⌘⌥⇧G) reads as too crowded; ⌘⌥G is one stroke + visually distinct ("G for Generate").

**Behavior:**
- Pressed during `Listening` state → bypass moment detector, fire suggest endpoint with `trigger_source: "hotkey"`, `trigger: null`.
- Pressed during any other state → no-op (log a warning at debug level, don't notify user; pressing a hotkey when nothing's listening is a silent fail per design taste).
- During `Reconnecting` — fire as normal (suggestion still works against the rolling summary even if WS is briefly disconnected).
- Cooldown: 5s minimum between hotkey presses. Spam protection.

**Customization:** **deferred to Sub-prompt 6.** Hardcoded ⌘⌥G in V1 launch.

**Open decision N4:** the hotkey choice. ⌘⌥G is the recommendation; PO may pick something else (⌘⌥S "Suggest" was considered, rejected because S conflicts with Save semantics on ⌘ S).

---

## 8 — Backend endpoints + streaming

### 8.1 — New endpoints

```
POST /api/copilot/sessions/:sessionId/intelligence/summary
  Auth: requireDeviceAuth
  Body: { window: string, previous?: string, mode: "incremental" | "full" }
  Returns: 200 { summary: string, generated_at: ISO8601 }
  Latency budget: < 3s p95
  Errors: 401 / 429 (rate limit) / 5xx

POST /api/copilot/sessions/:sessionId/intelligence/detect-moment
  Auth: requireDeviceAuth
  Body: { candidate_triggers: string[], transcript_window: string, rolling_summary?: string }
  Returns: 200 { should_suggest, trigger, trigger_phrase, urgency, rationale, is_speaker_mid_statement }
  Latency budget: < 1.5s p95
  Errors: 401 / 429 / 5xx

POST /api/copilot/sessions/:sessionId/intelligence/suggest
  Auth: requireDeviceAuth
  Content-Type: application/json
  Accept: text/event-stream  ← critical
  Body: { trigger_source, trigger?, trigger_phrase?, transcript_window }
  Returns: SSE stream (chunks per Section 6.2)
  Latency budget: time-to-first-token < 800ms p95; full < 4s p95
  Errors: 401 / 429 / 5xx (sent as SSE error event)
```

### 8.2 — SSE pattern (mirrors existing `/api/meetings/:id/ask`)

Reuse exact pattern from `routes.ts:3393-3410`:
```ts
res.setHeader("Content-Type", "text/event-stream");
res.setHeader("Cache-Control", "no-cache");
res.setHeader("Connection", "keep-alive");
for await (const chunk of stream) { res.write(`data: ${JSON.stringify({...})}\n\n`); }
```

### 8.3 — Rate limits (per device + per user)

- Summary: 1 call / 25s minimum spacing per session (server-enforced)
- Detect-moment: 1 call / 5s minimum spacing per session
- Suggest: 1 call / 3s minimum spacing per session
- Per-user daily: 200 sessions/day soft cap (matches design §3.3 ramp; 5 calls × 4hr cap is well under this)
- 429 response includes `Retry-After` header

### 8.4 — Backpressure

If the desktop disconnects mid-SSE (e.g., user hides overlay → window blur → app process backgrounded), the server should detect the closed socket and abort the LLM stream. Use Express's `req.on('close', () => abortController.abort())` pattern. Without this, OpenAI bills for completed tokens we never delivered.

---

## 9 — Prompt engineering

**Locked: separate `.md` files in backend, loaded once at server boot.**

Pattern: `WOLFEE-MVP/server/lib/copilot/intelligence/prompts/{summary,moment,suggest}.md`. Each file uses `{{var}}` template syntax substituted at call time. Loaded into a `Map<string, string>` at module init via `fs.readFileSync` — no DB-backed prompts in V1 (design Decision: file-based).

Why files vs inline strings (departure from existing `askWolfee.ts`):
- Iteration: prompt engineers can edit `.md` without reading TS code
- Diffability: prompt changes show up cleanly in PRs
- Length: moment detector + suggest prompts are 200-400 lines with examples. Inlining bloats the TS file.
- Future: easier path to A/B testing different prompt versions (read from env-selected file)

### 9.1 — V0 draft: `summary.md`

```markdown
You are maintaining a rolling summary of an in-progress sales call for Wolfee Copilot.

Speaker labels in the transcript:
- "user" = the sales rep (mic capture)
- "speakers" = the prospect or other parties (system audio)

You will be given:
1. The previous summary (may be empty on the first call)
2. A new transcript window (most recent ~30 seconds)
3. A mode: "incremental" or "full"

When mode = "incremental": extend the previous summary with what's new. Preserve everything still relevant; drop only what's clearly superseded.

When mode = "full": re-synthesize from scratch using the full window plus the previous summary as a hint.

Cover, in this order:
1. Who's on the call (only what the transcript reveals — names, companies, roles)
2. What's been discussed: products, pain points, timelines, decision-makers, pricing context
3. Open questions or unresolved objections
4. Current emotional/decision state (interested, hesitant, exploratory, ready to commit)

Output format: plain text, ≤ 500 tokens. Three short paragraphs. No headers, no bullets, no JSON. Pure summarization — never speculate beyond what's in the transcript.

Previous summary:
{{previous}}

Transcript window:
{{window}}

Mode: {{mode}}
```

### 9.2 — V0 draft: `moment.md`

```markdown
You are a sales-call moment classifier for Wolfee Copilot. Given a 90-second window of a live call transcript, decide whether NOW is the right moment to surface a tactical suggestion to the rep.

Speaker labels:
- "user" = the sales rep (mic capture)
- "speakers" = the prospect or other parties (system audio)

Inputs:
- candidate_triggers: shortlist from heuristic pre-filter (you are NOT bound to these — override if the real moment is different)
- transcript_window: last ~90 seconds, labeled
- rolling_summary: 2-3 paragraph context

Your output is JSON only. Schema:

{
  "should_suggest": boolean,
  "trigger": "objection" | "pricing_question" | "silence_after_question" | "decision_moment" | "buying_signal" | "confusion" | "competitor_mentioned" | "question_asked" | "none",
  "trigger_phrase": string | null,    // verbatim quote from "speakers" — null if trigger is "none"
  "urgency": 1 | 2 | 3 | 4 | 5,
  "rationale": string,                // ≤ 120 chars
  "is_speaker_mid_statement": boolean // true if last final from "speakers" reads incomplete (no terminal punctuation, mid-clause)
}

Rules:
- should_suggest = true ONLY IF urgency >= 3
- is_speaker_mid_statement = true → set should_suggest = false (don't fire while prospect is mid-sentence)
- Already-handled objections (rep already addressed them in transcript_window) → should_suggest = false
- Default to should_suggest = false when uncertain
- trigger_phrase MUST be a verbatim substring from "speakers" channel
- Never invent quotes

Examples:

[Example 1 — clear objection, fire]
window: ... speakers: It's a little expensive for our team right now. user: I hear that...
output: { "should_suggest": true, "trigger": "objection", "trigger_phrase": "It's a little expensive for our team right now", "urgency": 4, "rationale": "Direct price objection without specific number, value-anchor opportunity", "is_speaker_mid_statement": false }

[Example 2 — speaker mid-statement, hold]
window: ... speakers: I was thinking maybe we could—
output: { "should_suggest": false, "trigger": "none", "trigger_phrase": null, "urgency": 1, "rationale": "Speaker mid-statement", "is_speaker_mid_statement": true }

[Example 3 — already-addressed, hold]
window: ... speakers: It's expensive. user: I understand. We have a 30-day money-back guarantee plus tiered pricing... speakers: Oh, that's great.
output: { "should_suggest": false, "trigger": "none", "trigger_phrase": null, "urgency": 1, "rationale": "Objection already addressed", "is_speaker_mid_statement": false }

candidate_triggers: {{candidate_triggers}}

rolling_summary:
{{rolling_summary}}

transcript_window:
{{window}}

JSON output:
```

### 9.3 — V0 draft: `suggest.md`

```markdown
You are Wolfee Copilot, a tactical AI assistant for live sales calls. Given a moment that just happened (or a hotkey press requesting a suggestion), generate 1-2 concise, actionable suggestions for the rep to say or do next.

Speaker labels:
- "user" = the rep
- "speakers" = the prospect

Inputs:
- trigger_source: "moment" or "hotkey"
- trigger: e.g. "objection" (null if hotkey)
- trigger_phrase: verbatim quote from speakers (null if hotkey)
- rolling_summary: full call context
- transcript_window: last 90s

Output: JSON only.

{
  "suggestion_id": string,                   // UUID-like
  "moment_type": string,                     // = trigger or "general" if hotkey
  "primary": string,                         // 1-2 sentences, ≤ 200 chars, what to say or do
  "secondary": string | null,                // optional alternate framing, ≤ 200 chars; null if not useful
  "confidence": float,                       // 0.0 - 1.0
  "reasoning": string,                       // ≤ 100 chars, brief why
  "ttl_seconds": 30
}

Style:
- Punchy, second person: "Acknowledge their concern, then…", "Ask what would unlock this for them"
- No fluff. No "I think", "Maybe", "Perhaps". Direct.
- Don't repeat what the rep already said
- Don't make up account-specific facts (company size, industry data, named people not in transcript)
- If unsure, set confidence < 0.6

Examples:

[Example 1 — objection trigger]
trigger: objection, trigger_phrase: "It's a little expensive"
output: {
  "primary": "Acknowledge the budget concern, then ask what ROI would justify it for their team.",
  "secondary": "Anchor on annual savings, not monthly price.",
  "confidence": 0.85,
  "reasoning": "Vague price objection — value-anchor before discount",
  "ttl_seconds": 30,
  ...
}

[Example 2 — hotkey, no specific moment]
trigger_source: hotkey
output: {
  "primary": "Summarize what they've said so far and ask 'What's most important to get right here?'",
  "secondary": null,
  "confidence": 0.7,
  "reasoning": "No specific moment — re-anchor on priorities",
  ...
}

trigger_source: {{trigger_source}}
trigger: {{trigger}}
trigger_phrase: {{trigger_phrase}}

rolling_summary:
{{rolling_summary}}

transcript_window:
{{window}}

JSON output:
```

These are V0 starting points. Sub-prompt 3 execution will iterate against the eval harness (Section 5.3 of audit + design Risk #5/#6 mitigation).

---

## 10 — Latency budget

| layer | budget | what we measure | fallback if exceeded |
|---|---|---|---|
| Summary worker | < 3s p95 | Rust: time from POST /summary to response | log warn, keep previous summary, retry next interval |
| Moment detector heuristic | < 5ms | Rust: time inside heuristic check | not applicable (cheap) |
| Moment detector verifier | < 1.5s p95 | time from POST /detect-moment to response | drop the candidate; next heuristic hit will retry |
| Suggest time-to-first-token | < 800ms p95 | time from /suggest open to first SSE chunk | overlay shows nothing for ≤ 1.5s, then "..." spinner; gives up after 5s |
| Suggest full completion | < 4s p95 | time to `done: true` | suggestion still rendered; user can dismiss anytime |

**Hard caps:**
- Suggest time-to-first-token > 2s → drop; emit `copilot-suggestion-failed` (silent UX). Better no suggestion than late one.
- Detect-moment > 3s → drop result even if it arrives; cooldown forward to skip the next 30s window.

**Concurrent calls:** allowed: summary + detect-moment in parallel (different sessions OK; same session OK because they're independent). NOT allowed: two suggest streams on the same session (Section 6.3).

---

## 11 — State management + concurrency

### 11.1 — Desktop (Rust)

Three new managed state types:

```rust
pub struct RollingSummaryMutex(pub Mutex<Option<RollingSummary>>);
pub struct MomentCooldownMutex(pub Mutex<MomentCooldownState>);
pub struct ActiveSuggestionMutex(pub Mutex<Option<ActiveSuggestion>>);

pub struct RollingSummary {
    pub session_id: String,
    pub text: String,
    pub generated_at: Instant,
    pub generation_count: u32,
}

pub struct MomentCooldownState {
    pub session_id: String,
    pub last_fired: HashMap<TriggerType, Instant>,
}

pub struct ActiveSuggestion {
    pub session_id: String,
    pub suggestion_id: String,
    pub started_at: Instant,
    pub trigger_source: TriggerSource,
}
```

Registered in `lib.rs` `.manage(...)` chain alongside existing `CopilotStateMutex`, `CopilotAudioCaptureMutex`, `TranscriptBufferMutex`.

**Lock discipline:** drop guards before `await` (audit failed Phase 6 commit when a `MutexGuard` crossed `await` and Tauri's State borrow lifetimes complained — see commit `5cc2425` for the pattern). All async LLM calls happen with no held locks.

**Cleanup on session end:** `end-copilot-session` handler clears all three mutexes back to `None` / empty.

### 11.2 — Backend (Express)

New module: `server/lib/copilot/intelligence/sessionState.ts`. In-memory `Map<string, IntelligenceSessionState>`:

```ts
interface IntelligenceSessionState {
  sessionId: string;
  rollingSummary: string;
  rollingSummaryGeneratedAt: number;     // epoch ms
  lastMomentDetectedAt: Map<string, number>; // trigger type → epoch ms (server-side rate-limit)
  lastSuggestionAt: number;
  activeSuggestionAbortController?: AbortController;  // for SSE cancel
  createdAt: number;
}
```

Cleanup triggers:
- `POST /api/copilot/sessions/:id/end` → delete from map
- LRU eviction: max 1000 active sessions in map, evict oldest if exceeded
- Stale TTL: drop entries with no activity for 1hr

Concurrency: Express handlers are single-threaded per Node event loop; map access is naturally serialized. No locks needed.

### 11.3 — Tauri events introduced

| event | direction | payload | when |
|---|---|---|---|
| `copilot-summary-updated` | Rust → JS | `{ session_id, summary, generated_at_ms }` | every successful /summary response |
| `copilot-moment-detected` | Rust → JS | `{ session_id, trigger, trigger_phrase, urgency, rationale }` | every `should_suggest=true` from verifier |
| `copilot-suggestion` | Rust → JS | full suggestion JSON (one event per complete suggestion) | every successful /suggest stream |
| `copilot-suggestion-streaming` | Rust → JS | `{ session_id, suggestion_id, field, delta }` | every SSE delta chunk; Sub-prompt 4 streams render |
| `copilot-suggestion-failed` | Rust → JS | `{ session_id, reason }` | LLM call failed / timed out |
| `copilot-suggestion-dismissed` | JS → Rust | `{ suggestion_id, dismissed_via: "auto" \| "esc" \| "click" }` | user dismisses; Rust clears `ActiveSuggestionMutex`, sends telemetry |

These are NEW (none exist today). No conflict with existing events.

---

## 12 — Telemetry

**Locked: opt-in detailed telemetry (Option C from prompt).**

Default: aggregate counts only. Opt-in via Sub-prompt 6 settings ("Help improve Wolfee Copilot — share suggestion data") writes to a separate table.

### 12.1 — Always-on aggregate (privacy-safe)

New columns on existing `copilot_sessions`:
- `suggestions_shown: int` — count of suggestions surfaced
- `suggestions_dismissed_auto: int`
- `suggestions_dismissed_user: int`
- `suggestions_clicked: int` (Sub-prompt 4 click-to-copy)
- `moment_detector_calls: int`
- `summary_calls: int`
- `total_llm_input_tokens: int`
- `total_llm_output_tokens: int`

These are written to `copilot_sessions` row at session end. No new table needed.

### 12.2 — Opt-in detailed (sensitive)

New table `copilot_suggestions_detail`:
```sql
CREATE TABLE copilot_suggestions_detail (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES copilot_sessions(id) ON DELETE CASCADE,
  fired_at TIMESTAMPTZ NOT NULL,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('moment','hotkey')),
  trigger TEXT,                                       -- nullable for hotkey
  trigger_phrase TEXT,                                -- transcript fragment (sensitive)
  primary_suggestion TEXT NOT NULL,                   -- output (sensitive)
  secondary_suggestion TEXT,
  confidence REAL NOT NULL,
  user_action TEXT NOT NULL CHECK (user_action IN ('shown','dismissed_auto','dismissed_user','clicked','suppressed_low_confidence')),
  llm_latency_ms INTEGER,
  model_version TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Migration: `0007_add_copilot_intelligence_telemetry.sql`. Default off; user toggles to opt in. UI is Sub-prompt 6.

**Privacy footnote:** the table schema explicitly stores trigger phrase + suggestion text. Per design Decision 17, this requires user opt-in. Sub-prompt 6 ships the toggle; until then, the table can exist but no rows are inserted (gated by a `user.preferences.copilot_telemetry_detailed = true` boolean).

---

## 13 — Effort breakdown

Total target: **~120 hr (~3 weeks at 1 focused agent)**.

| section | effort | notes |
|---|---|---|
| §2 LLM client abstraction in backend | 6 hr | thin wrapper, mostly types + 1 file |
| §3 Backend orchestration scaffold (3 routes, sessionState, requireDeviceAuth wiring) | 12 hr | mirror askWolfee.ts patterns |
| §4 Rolling summary worker (Rust) + summary endpoint | 12 hr | timer task + simple POST |
| §5 Moment detector — Rust heuristics + cooldown + verifier endpoint | 24 hr | most code; testing matters |
| §6 Suggestion generator + SSE stream + parsing | 16 hr | SSE on Rust side is the new pattern |
| §7 ⌘⌥G hotkey wiring | 4 hr | mirror Sub-prompt 1 hotkey pattern |
| §8 Backend SSE plumbing + abort handling + rate limits | 8 hr | reuse askWolfee SSE; add abort + 429 |
| §9 V0 prompts + eval harness scaffold | 16 hr | prompts above + 30 transcript snippets + LLM-as-rater script in `server/lib/copilot/intelligence/eval/` |
| §10–11 State management + concurrency wiring | 8 hr | 3 mutexes + cleanup + 6 new events |
| §12 Telemetry — aggregate columns + detail table migration + opt-in gate | 6 hr | migration + write hooks |
| Testing + verification (incl. cargo build, frontend build, smoke test on .app) | 8 hr | per-phase + end-to-end |

**Total: 120 hr.**

**Best-case 96 hr** if eval harness converges first try (Risk #5/#6 don't bite).
**Worst-case 160 hr** if Risk #6 forces splitting Sub-prompt 3 into 3a (hotkey-only) + 3b (moment detector with reduced ambition).

---

## 14 — Open decisions for PO

| # | decision | recommendation | alternatives | tradeoff |
|---|---|---|---|---|
| **N1** | LLM provider: stay OpenAI vs swap to Claude (Haiku 4.5 / Sonnet 4.6) | **Stay OpenAI gpt-4o-mini default with abstraction for swap** | Swap entirely to Claude Haiku 4.5 (cheaper for moment detector); Tiered (Haiku for moment, Sonnet for suggest) | Claude has marginally better instruction-following on JSON; OpenAI has zero new infra cost. |
| **N2** | Suggestion display: streaming vs instant | **Streaming SSE (token-by-token render)** | Instant (wait for full LLM completion) | Streaming feels ~600ms faster; for 1-2 sentence output, gain is real but not huge. Instant is simpler. |
| **N3** | Confidence threshold for surfacing | **0.6** | 0.5 (more, more false-pos); 0.65 (fewer, more precise) | Affects perceived value. Validate against eval harness before launch. |
| **N4** | Hotkey for "generate suggestion" | **⌘⌥G** | ⌘⌥S, ⌘⌥⇧W (overload), repeat-press ⌘⌥W | Need a free key. ⌘⌥G has no clash with macOS or common app shortcuts. |
| **N5** | Moment cooldowns (per type) | values in §5.1 | shorter (more aggressive), longer (more conservative) | Affects UX feel — too short = spam, too long = missed moments. Tune via eval. |
| **N6** | Suggestion TTL (auto-fade) | **30s** | 15s (snappier), 60s (less invasive) | If user is reading mid-call, 15s is too short. 30s is the design-doc default for hotkey. |
| **N7** | Telemetry: opt-in detailed default state | **OFF (opt-in)** | ON (opt-out); aggregate-only forever | Privacy-safe default = OFF; gives Wolfee less prompt-iteration data early. Eval harness compensates initially. |
| **N8** | Initial sensitivity preset for V1 launch | **Low** (per design Risk #6) | Medium (default in design doc); High | Conservative launch lets us measure FP rate before turning up. |
| **N9** | Eval harness gate before shipping moment detector | **Required: precision ≥ 65% on `should_suggest`, FP "wrong moment" ≤ 5% on 30 labeled snippets** | Optional (ship and iterate); lower bar | Quality gate. If we ship without this, Risk #6 likely materializes. |
| **N10** | Rolling summary visibility to user | **Hidden in V1 (only used as LLM context)** | Show in overlay (Sub-prompt 4) or settings panel | Hidden = simpler V1 scope. PO may want to surface for trust. |
| **N11** | Concurrent moment + summary calls | **Allow (independent endpoints)** | Serialize (lower load) | Concurrent risks 2× cost spike during high-activity windows; serializing adds 1.5s lag to suggestions. |

11 open decisions. PO review estimated 30-45 min.

---

## 15 — Files to create / modify

### 15.1 — Backend (WOLFEE-MVP)

**NEW:**
- `server/lib/copilot/intelligence/llmClient.ts` — abstraction wrapper for OpenAI calls
- `server/lib/copilot/intelligence/sessionState.ts` — in-memory map + cleanup
- `server/lib/copilot/intelligence/summary.ts` — handler logic for summary endpoint
- `server/lib/copilot/intelligence/momentDetector.ts` — handler logic for detect-moment
- `server/lib/copilot/intelligence/suggest.ts` — handler logic for SSE suggest
- `server/lib/copilot/intelligence/promptLoader.ts` — fs-based prompt loading + template substitution
- `server/lib/copilot/intelligence/prompts/summary.md`
- `server/lib/copilot/intelligence/prompts/moment.md`
- `server/lib/copilot/intelligence/prompts/suggest.md`
- `server/lib/copilot/intelligence/eval/scenarios.json` — 30 labeled transcript snippets
- `server/lib/copilot/intelligence/eval/runEval.ts` — LLM-as-rater eval harness
- `migrations/0007_add_copilot_intelligence_telemetry.sql` — `copilot_sessions` columns + `copilot_suggestions_detail` table

**MODIFIED:**
- `server/routes.ts` — register 3 new endpoints in the existing `// ██ COPILOT` block; reuse `requireDeviceAuth`
- `shared/schema.ts` — add columns + new table per migration
- `server/storage.ts` — CRUD for telemetry writes
- `.env.example` — no new vars (reuses `AI_INTEGRATIONS_OPENAI_API_KEY`)

### 15.2 — Desktop (wolfee-desktop)

**NEW:**
- `src-tauri/src/copilot/intelligence/mod.rs`
- `src-tauri/src/copilot/intelligence/summary_worker.rs`
- `src-tauri/src/copilot/intelligence/moment_worker.rs` — heuristics + LLM verifier client
- `src-tauri/src/copilot/intelligence/suggest_client.rs` — SSE consumer
- `src-tauri/src/copilot/intelligence/heuristics.rs` — pure logic (testable)
- `src-tauri/src/copilot/intelligence/api.rs` — extends SessionApi with intelligence calls (separate file)
- `src-tauri/src/copilot/intelligence/state.rs` — RollingSummaryMutex / MomentCooldownMutex / ActiveSuggestionMutex

**MODIFIED:**
- `src-tauri/src/lib.rs` — `.manage(...)` chain (3 new mutexes), spawn workers on `start-copilot-session`, drop on `end-copilot-session`, register ⌘⌥G hotkey, add `wolfee-action` handlers for suggestion-dismissed
- `src-tauri/src/copilot/mod.rs` — `pub mod intelligence;`
- `src-tauri/src/copilot/hotkey.rs` — register ⌘⌥G alongside existing ⌘⌥W
- `src-tauri/Cargo.toml` — `eventsource-stream` or `reqwest-eventsource` for SSE consumer (or roll our own — check existing patterns first)
- `src-tauri/src/tray.rs` — minor: optional "Generate Suggestion" menu item that emits `wolfee-action: trigger-copilot-suggestion`

**NOT MODIFIED (sacred):**
- `src-tauri/src/copilot/audio/*`
- `src-tauri/src/copilot/transcribe/buffer.rs`
- `src-tauri/src/copilot/transcribe/deepgram.rs`
- `src-tauri/src/copilot/session/api.rs`
- `src-tauri/src/copilot/state.rs` — only USE it; do not extend (intelligence has its own mutexes)
- `src-tauri/src/copilot/window.rs`
- `src-tauri/src/recorder.rs`, `uploader.rs`, `auth.rs`
- `overlay/src/CopilotOverlay.tsx` — Sub-prompt 4 ships the suggestion UI; Sub-prompt 3 just emits events

---

## 16 — Acceptance tests

**Build:**
- [ ] `cargo check` clean
- [ ] `cargo build --release` clean
- [ ] `pnpm tauri build --bundles app` clean
- [ ] Backend `pnpm build` / `pnpm test` clean
- [ ] Migration `0007` applies on staging Postgres without error

**Backend smoke:**
- [ ] `curl POST /api/copilot/sessions/:id/intelligence/summary` returns valid JSON in < 3s
- [ ] `curl POST /api/copilot/sessions/:id/intelligence/detect-moment` returns valid JSON in < 1.5s
- [ ] `curl -N POST /api/copilot/sessions/:id/intelligence/suggest` returns SSE stream with first chunk < 800ms
- [ ] All three endpoints return 401 when called without device bearer
- [ ] Rate limits return 429 with `Retry-After` when over threshold

**Desktop smoke:**
- [ ] Start Copilot Session → speakers say "It's expensive" → within ~30s, `copilot-moment-detected` event fires with `trigger=objection`, then `copilot-suggestion` event fires
- [ ] Press ⌘⌥G during Listening → within ~4s, `copilot-suggestion` event fires with `trigger_source=hotkey`
- [ ] End session → all three intelligence mutexes return to None; backend session map entry deleted
- [ ] Layer A/B/C audio diagnostics still log (regression: Phase 3 observability intact)
- [ ] Recorder still uploads (regression: Phase 5 sacred)
- [ ] ⌘⌥W overlay still toggles (regression: Sub-prompt 1 sacred)
- [ ] Phase 6 permission modal still renders if mic revoked (regression)

**Eval harness:**
- [ ] 30 labeled scenarios run; precision on `should_suggest` ≥ 65%; "wrong moment" rate ≤ 5%
- [ ] Eval report committed to `server/lib/copilot/intelligence/eval/results/v0-baseline.json`

**24-hour parity (post Phase 7 soak):**
- [ ] Memory growth across a 30-min session with all 3 intelligence layers active < 30 MB delta from Phase 7 baseline
- [ ] No panics, no orphan SSE connections in backend logs

---

## End of plan

**Plan path:** `/Users/raunekpratap/Desktop/wolfee-desktop/wolfee-copilot-subprompt-3-plan.md` (NOT committed).

**Top blocking decisions for PO** (must resolve before execution prompt is written):
- N1 (LLM provider — stay OpenAI vs swap to Claude)
- N2 (streaming vs instant suggestion display)
- N9 (eval harness gate as ship requirement vs nice-to-have)
- N8 (initial sensitivity preset — Low vs Medium)
- N4 (hotkey choice — ⌘⌥G vs alternative)

The other 6 (N3, N5–N7, N10–N11) can resolve mid-execution without rework.

**Effort confidence:** 120 hr ± 25%. Likely range **96–160 hr**, driven by eval harness convergence speed (Risk #5/#6).

**Recommended next step:** PO 30-45 min review of §14, lock the 5 blocking decisions; once locked, the execution prompt for Sub-prompt 3 can be written from this plan without re-investigation.
