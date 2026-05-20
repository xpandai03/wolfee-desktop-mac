# Wolfee Copilot Sub-prompt 4.5 (Cluely-style UX Retune) — Execution Plan

Author: implementing engineer
Status: planning pass complete, **zero code changed**. Read-only.
Date: 2026-05-04

---

## 0 — Status & relationship to prior work

Sub-prompts 1, 2, 3, 4 are functionally complete and verified. Wolfee Copilot has working: overlay (invisible during fullscreen Chrome), system+mic audio capture, live Deepgram transcription, AI moment detection, suggestion generator, hotkey-driven manual suggestions (⌘⌥G), auto-fired suggestions (now at "High" sensitivity per the 2026-05-04 retune), click-to-expand cards.

**What's missing vs Cluely's UX**, based on PO testing:

1. **Generic suggestions without user context.** Current suggestions read "acknowledge their concern, ask about budget" because the LLM has no idea who the user is, what they sell, or what objections to expect. Cluely's resume + job description + role injection produces dramatically more specific output.

2. **One suggestion path = limited user agency.** Current product fires only "tactical advice" suggestions. Cluely demonstrates 4 click-driven actions cover ~80% of real-call use cases: ask / follow-up / fact-check / recap.

3. **⌘+\ as a second hide-all hotkey** matching Cluely's primary control gesture.

Sub-prompt 4.5 ships these three as a focused retune. **Sub-prompts 5, 6, 7 are paused** until 4.5 ships.

**Sacred files** (do NOT modify in 4.5):
- All `src-tauri/src/copilot/audio/*.rs`
- `src-tauri/src/copilot/transcribe/buffer.rs`, `transcribe/deepgram.rs`
- `src-tauri/src/copilot/session/api.rs`
- `src-tauri/src/copilot/intelligence/audio/*` (audio path)
- `src-tauri/src/copilot/window.rs` — extend additively for context window only; do NOT modify overlay-window logic
- `src-tauri/src/recorder.rs`, `uploader.rs`, `auth.rs`
- Phase 6 permission modal block in [`overlay/src/CopilotOverlay.tsx`](overlay/src/CopilotOverlay.tsx) — verbatim
- WOLFEE-MVP `server/lib/meetings/*`, `lib/analysis/*`, `lib/auth.ts`
- All existing `/api/copilot/sessions/:id/intelligence/{summary,detect-moment,suggest}` routes (extend additively with new routes; existing ones unchanged)

**What this plan locks fresh, in 11 sections.**

---

## 1 — Architecture overview

```
                ┌──────────────── DESKTOP ─────────────────┐         ┌─── BACKEND ────┐
[click          │                                            │         │                │
 Start          │   1. tray "Start Copilot Session" clicked │         │                │
 Copilot]──────►│              │                            │         │                │
                │              ▼                            │         │                │
                │   2. NEW: Context window opens            │         │                │
                │      (programmatic WebviewWindowBuilder, │         │                │
                │       600×500 system-chrome window,      │         │                │
                │       3 textareas + Submit/Cancel)       │         │                │
                │              │                            │         │                │
                │       ┌──────┴──────┐                     │         │                │
                │   Cancel          Submit                  │         │                │
                │       │              │                    │         │                │
                │       ▼              ▼                    │         │                │
                │     idle    3. POST /sessions          ──►│  POST /api/copilot/     │
                │             4. POST /sessions/:id/context │  sessions/:id/context   │
                │                + audio capture spawn      │                          │
                │                + intelligence workers     │                          │
                │                                           │                          │
                │   5. Session live. Overlay shows:         │                          │
                │                                           │                          │
                │      ┌─────────────────────────────────┐ │                          │
                │      │ ⚙ 🟢 Listening              ✕ │ │                          │
                │      ├─────────────────────────────────┤ │                          │
                │      │ user: ...                       │ │                          │
                │      │ speakers: ...                   │ │                          │
                │      ├─────────────────────────────────┤ │                          │
                │      │   Idle:                         │ │                          │
                │      │   [💬 Ask] [❓ Follow]          │ │                          │
                │      │   [✓ Fact] [↻ Recap]           │ │                          │
                │      ├─────────────────────────────────┤ │                          │
                │      │   Active:                       │ │                          │
                │      │   [💬][❓][✓][↻]  ← compact   │ │                          │
                │      │   ⚠ OBJECTION · auto            │ │                          │
                │      │   Suggestion text...            │ │                          │
                │      └─────────────────────────────────┘ │                          │
                │                                           │  POST /sessions/:id/    │
                │   Click action button OR ⌘⌥G:        ──►│  intelligence/          │
                │                                           │  quick-action {action}  │
                │                                           │                         │
                │   ⌘⌥W or ⌘+\ toggles overlay         │   (SSE stream, same    │
                │                                           │    shape as /suggest)   │
                │                                           │                         │
                │   Auto-suggestions still fire from        │   Existing /summary,    │
                │   moment_worker as before, with           │   /detect-moment,       │
                │   user_context injected into all prompts  │   /suggest unchanged.   │
                │                                           │   All 3 prompts updated │
                │                                           │   to inject {{context}} │
                └───────────────────────────────────────────┘─────────────────────────┘
```

**Three new event/data flows:**

1. **Context flow**: tray click → context window opens → user submits → backend session created with context attached → existing audio/intelligence flow proceeds with context in `IntelligenceSessionState`.

2. **Quick-action flow**: user clicks one of 4 action buttons → frontend dispatches → Rust `trigger_quick_action` command → POST to new SSE endpoint → response renders in same SuggestionCard component (reuses Sub-prompt 4's streaming/expand UX).

3. **Hotkey alias**: ⌘+\ wired alongside ⌘⌥W to the same `toggle_overlay` handler.

---

## 2 — Context paste window (Tauri 2)

**Locked: Option B — programmatic `WebviewWindowBuilder` from Rust.**

### Window spec

| property | value |
|---|---|
| label | `copilot-context` |
| URL | `index.html#/context` (single overlay bundle, hash-routed) |
| dimensions | 600 × 500 |
| position | center of focused monitor |
| decorations | system chrome (NOT frameless) — feels like a real input dialog |
| resizable | true (let user drag larger if they're pasting a lot) |
| always_on_top | true |
| transparent | false (solid zinc-950 backdrop) |
| skip_taskbar | true |
| visible | false at create; show when session-start triggers |
| set_content_protected | true (consistent with overlay — invisible to screen-share if user opens this during a call) |
| Activation policy | inherits from app's existing Accessory policy |

### Lifecycle

```
[tray click "Start Copilot Session"]
        │
        ▼
[Rust: spawn context window via WebviewWindowBuilder]
        │
        ▼
[user pastes / submits / cancels]
        │
   ┌────┴────┐
Cancel    Submit
   │         │
   ▼         ▼
[destroy   [Rust:
 window,    1. POST /sessions (existing)
 return     2. POST /sessions/:id/context (NEW)
 to idle]   3. spawn audio capture + intelligence workers
            4. show overlay window
            5. destroy context window]
```

The context window is **destroyed** on either path — not hidden — because re-using it across sessions risks stale state. Reopening on next session is cheap (~50ms).

### Why programmatic over static config

Static `tauri.conf.json` window registration has Tauri start the window at app launch. The user may never start a Copilot session in a given app run — pre-warming a 500×600 webview is wasteful. Programmatic creation also matches the existing overlay-window pattern in [`window.rs::create_overlay_window`](src-tauri/src/copilot/window.rs).

### Frontend route

Same Vite project, single bundle, hash-routed. The overlay HTML serves both `#/overlay` (default — the existing suggestion card UI) and `#/context` (new context paste page). Decision Section 8 below details routing.

---

## 3 — Context schema + storage

**Locked: Option B — structured 3-field form.**

### Field schema

| field | label | placeholder | char limit | required |
|---|---|---|---|---|
| `context_about_user` | About you / your company | "I'm a sales rep at Acme Health, an AI compliance platform for hospital systems. We've shipped TFC implementations at 12 health networks." | 2000 | optional |
| `context_about_call` | About this call | "Discovery call with Mercy Hospital VP of IT. They flagged HIPAA concerns in their current vendor. Decision likely Q2." | 1000 | optional |
| `context_objections` | Expected objections | "Pricing (we're 30% above competitor), 6-month implementation timeline, integration with existing Epic install" | 500 | optional |

All fields optional — submitting an empty form creates a session with no context (matches current pre-4.5 behavior, graceful degradation). Total token budget at max: ~3500 chars ≈ 900 tokens. Comfortable within all prompt budgets.

**No "save as default" checkbox** in V1 (locked Decision #10 blocks static profile). User pastes fresh per session.

### Database schema

Migration `0008_add_copilot_session_context.sql`:

```sql
ALTER TABLE copilot_sessions
  ADD COLUMN IF NOT EXISTS context_about_user TEXT,
  ADD COLUMN IF NOT EXISTS context_about_call TEXT,
  ADD COLUMN IF NOT EXISTS context_objections TEXT;
```

NULL-able. Existing rows get NULL. New sessions populate via the new endpoint.

### Backend endpoint

```
POST /api/copilot/sessions/:sessionId/context
Auth: requireDeviceAuth
Body: {
  about_user: string | null,
  about_call: string | null,
  objections: string | null
}
Returns: 200 { ok: true } on success; 401 / 404 / 5xx on failure
Side effect: updates DB row + populates IntelligenceSessionState fields
```

### In-memory state extension

Extend `IntelligenceSessionState` in [`server/lib/copilot/intelligence/sessionState.ts`](../WOLFEE-MVP/server/lib/copilot/intelligence/sessionState.ts):

```ts
interface IntelligenceSessionState {
  sessionId: string;
  rollingSummary: string;
  // ... existing fields ...

  // ── Sub-prompt 4.5: per-session user-provided context ─────
  contextAboutUser: string;
  contextAboutCall: string;
  contextObjections: string;
}
```

Defaults to empty strings on session create. Populated on `/context` POST. Read by all 3 existing handlers (summary, detect-moment, suggest) AND the new quick-action handler.

---

## 4 — Action buttons UI placement

**Locked: Option B — mode-switching idle vs active.**

### Idle state (no suggestion firing)

```
┌─────────────────────────────────────┐ 420×280
│ ⚙             🟢 Listening      ✕ │ ← top bar 28px
├─────────────────────────────────────┤
│ user: hello there                   │
│ speakers: yeah we were just         │ ← transcript 100px
│           talking about pricing     │
├─────────────────────────────────────┤
│   ┌─────────────┐ ┌─────────────┐  │
│   │ 💬 Ask      │ │ ❓ Follow-up│  │ ← idle action zone 130px
│   └─────────────┘ └─────────────┘  │   (2x2 grid, 4 large buttons)
│   ┌─────────────┐ ┌─────────────┐  │
│   │ ✓ Fact-check│ │ ↻ Recap     │  │
│   └─────────────┘ └─────────────┘  │
├─────────────────────────────────────┤
│  ⌘⌥W toggle · ⌘+\ hide · Esc      │ ← footer 22px
└─────────────────────────────────────┘
```

Each button ~180×52px. Tailwind: `grid grid-cols-2 gap-2 px-3 py-2 h-[130px]`. Icon (16×16 lucide-react) + label, hover lifts opacity, click triggers action.

### Active state (suggestion firing or expanded)

```
┌─────────────────────────────────────┐ 420×280
│ ⚙             🟢 Listening      ✕ │ ← top bar 28px
├─────────────────────────────────────┤
│ user: ...                           │
│ speakers: ...                       │ ← transcript 100px
├─────────────────────────────────────┤
│ [💬] [❓] [✓] [↻]                  │ ← compact strip 28px
├─────────────────────────────────────┤
│ ⚠ OBJECTION · auto                  │
│ Acknowledge their HIPAA concern,   │ ← suggestion 102px
│ then surface the TFC track record. │
│ Click to expand                     │
└─────────────────────────────────────┘
```

Action buttons compress to icon-only 28px strip above the suggestion card. Suggestion zone shrinks from 130px → 102px — still room for 2-line primary at `text-sm` + footer hint.

When suggestion is **expanded** (click-to-expand from Sub-prompt 4 retune), the compact button strip stays visible at the top — user can fire a different action at any time.

### Transition

`framer-motion` with `mode="wait"` AnimatePresence. 200ms ease-out from grid → compact strip. No layout shift below — transcript zone height stays 100px throughout.

### Tooltip on icon-only mode

Hover tooltip shows label: "Ask", "Follow-up questions", "Fact-check", "Recap last 2 min". Tailwind `group-hover` pattern + a small floating div.

---

## 5 — Action button behavior + backend

**Locked: single endpoint with action discriminator (Option A).**

### New endpoint

```
POST /api/copilot/sessions/:sessionId/intelligence/quick-action
Auth: requireDeviceAuth
Body: {
  action: "ask" | "follow_up" | "fact_check" | "recap",
  transcript_window: string,
  rolling_summary?: string
}
Returns: SSE stream (mirrors existing /suggest pattern):
  data: {"type":"suggestion-start","id":"...","moment_type":"..."}
  data: {"type":"delta","text":"..."}
  data: {"type":"complete","payload":{...}}
  data: {"done":true}
Latency: TTFT < 800ms p95, full < 4s p95 (same budget as /suggest)
Errors: 401 / 429 / 5xx via SSE error event
```

### Per-action prompt mapping

| action | prompt file | output shape | suggestion_card moment_type |
|---|---|---|---|
| `ask` | `prompts/quickAction/ask.md` (copy of existing `suggest.md` + context block) | 1-2 sentence advice | `"general"` (matches hotkey path) |
| `follow_up` | `prompts/quickAction/followUp.md` (NEW) | 2-3 questions, bulleted in JSON array | `"follow_up"` |
| `fact_check` | `prompts/quickAction/factCheck.md` (NEW) | claim verification + counter-evidence | `"fact_check"` |
| `recap` | `prompts/quickAction/recap.md` (NEW) | 2-3 sentence summary | `"recap"` |

All 4 use the existing `SuggestPayload` JSON shape from Sub-prompt 3 (`primary`, `secondary`, `confidence`, `reasoning`, `ttl_seconds`). For `follow_up`, the LLM is instructed to put the bulleted list inside `primary` separated by newlines — overlay renders verbatim.

### Concurrency rule (PO open decision N1 below)

**Recommendation: user-click wins.** If user clicks an action button while an auto-suggestion is mid-stream, abort the auto and fire the user's action. ActiveSuggestionMutex's existing AbortController makes this surgical:

```rust
// In suggest_client.rs, add:
pub fn replace_active(app: &AppHandle, new_suggestion_id: String) {
    if let Ok(mut guard) = app.state::<ActiveSuggestionMutex>().0.lock() {
        if let Some(existing) = guard.as_ref() {
            // Abort the in-flight stream task
            // (we'd need to stash AbortController in ActiveSuggestion)
        }
        *guard = Some(ActiveSuggestion { suggestion_id: new_suggestion_id, ... });
    }
}
```

Requires extending `ActiveSuggestion` to hold an `AbortHandle` for the prior task. Reasonable surgical change.

### Reuse vs new code in suggest_client

The existing `suggest_client::run_stream` is parameterized by trigger_source / trigger / phrase. Add `quick_action: Option<QuickActionType>` as a new optional field on the request payload. The Rust client routes to the new endpoint when `quick_action.is_some()` — same SSE consumer, same Tauri event emit shape. **~30 LOC delta.**

---

## 6 — Prompt updates for context injection

All 3 existing prompts (`summary.md`, `moment.md`, `suggest.md`) get a context block injected near the top.

### Template variables

```
{{context_about_user}}
{{context_about_call}}
{{context_objections}}
```

Substituted by the existing `promptLoader::render()`. Empty strings rendered as `(not provided)` so the prompt structure stays valid even when user submitted empty fields.

### Placement

After the role/intro paragraph, before the task description. Pattern:

```markdown
You are Wolfee Copilot, [...intro paragraph...].

The rep using you provided this context BEFORE the call:

About them / their company:
{{context_about_user}}

About this call:
{{context_about_call}}

Expected objections / things to handle:
{{context_objections}}

Use this context to make your output specific. Don't generate generic advice — reference the rep's actual product, customers, or objection-handling stories where relevant.

[... rest of existing prompt ...]
```

The injection point is identical across all 7 prompts (3 existing + 4 new) — single source of truth in a shared prompt header partial would be cleaner, but Sub-prompt 3's `promptLoader.ts` doesn't support partials. V1 keeps it as duplicated text across files. Sub-prompt 6+ can refactor.

### V0 drafts for new quick-action prompts

#### `followUp.md`

```markdown
You are Wolfee Copilot. The rep clicked "Follow-up questions" — they want 2-3 sharp questions they could ask the prospect to advance the call.

About them / their company:
{{context_about_user}}

About this call:
{{context_about_call}}

Expected objections / things to handle:
{{context_objections}}

Recent transcript (~90s):
{{window}}

Generate 2-3 follow-up questions the rep should ask the prospect. The questions should:
- Be specific to what was just discussed (reference the prospect's actual words where natural)
- Move the conversation toward a decision (qualifying, surfacing concerns, narrowing scope)
- Be open-ended (not yes/no) unless yes/no genuinely advances things
- Avoid generic discovery clichés ("what's your timeline?")

Output JSON only:

{
  "suggestion_id": "uuid-like",
  "moment_type": "follow_up",
  "primary": "1. Question one?\n2. Question two?\n3. Question three?",
  "secondary": null,
  "confidence": 0.0-1.0,
  "reasoning": "≤ 100 chars on why these questions",
  "ttl_seconds": 30
}

Style:
- Each question on its own line, numbered
- ≤ 200 chars total in `primary`
- If you can only think of 2 strong questions, return 2 — don't pad with weak ones

JSON output:
```

#### `factCheck.md`

```markdown
You are Wolfee Copilot. The rep clicked "Fact-check" — they want a quick sanity check on the prospect's most recent claim.

About them / their company:
{{context_about_user}}

About this call:
{{context_about_call}}

Recent transcript (~90s):
{{window}}

Identify the most recent factual claim from the "speakers" channel (the prospect). Check it for:
- Internal consistency with what they said earlier
- Compatibility with what the rep's product / company can deliver (use the about_user context)
- Plausibility against general knowledge (e.g., a claim that "everyone in our industry uses X" is suspect)

Output JSON only:

{
  "suggestion_id": "uuid-like",
  "moment_type": "fact_check",
  "primary": "Their claim: '...verbatim quote...'. Verdict: [verified / questionable / contradicts earlier / outside our knowledge]. Counter-evidence: ...",
  "secondary": "Suggested response if questionable: '...'",
  "confidence": 0.0-1.0,
  "reasoning": "≤ 100 chars on basis for verdict",
  "ttl_seconds": 30
}

Rules:
- If no recent factual claim from "speakers" exists, set primary to "No verifiable claim in recent transcript" and confidence < 0.5
- Don't invent counter-evidence — say "outside our knowledge" if you genuinely don't have data
- Keep `primary` ≤ 200 chars

JSON output:
```

#### `recap.md`

```markdown
You are Wolfee Copilot. The rep clicked "Recap" — they want a quick summary of the last ~2 minutes of conversation. They probably zoned out, missed something, or want to confirm shared understanding.

About them / their company:
{{context_about_user}}

About this call:
{{context_about_call}}

Rolling summary (so far):
{{rolling_summary}}

Most recent transcript (last ~120s):
{{window}}

Generate a 2-3 sentence recap of what was just discussed in the recent window. Focus on:
- Decisions or commitments made (by either side)
- New information surfaced (especially from "speakers")
- Questions left hanging

Output JSON only:

{
  "suggestion_id": "uuid-like",
  "moment_type": "recap",
  "primary": "Recap: [2-3 sentences]. Open questions: [if any].",
  "secondary": null,
  "confidence": 0.0-1.0,
  "reasoning": "≤ 100 chars",
  "ttl_seconds": 30
}

Style:
- Past tense, neutral voice
- Reference both sides where relevant ("They flagged X, you proposed Y")
- ≤ 200 chars in `primary`
- Skip preamble like "Here's a recap:" — go straight into it

JSON output:
```

---

## 7 — Rust-side wiring

### NEW file

`src-tauri/src/copilot/context_window.rs` — programmatic context window:

```rust
pub fn open_context_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window("copilot-context").is_some() {
        // already open — focus it
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        app, "copilot-context", WebviewUrl::App("index.html#/context".into())
    )
    .title("Wolfee Copilot — Set Up Session")
    .decorations(true)              // system chrome
    .resizable(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .inner_size(600.0, 500.0)
    .visible(false)
    .build()?;
    let _ = window.set_content_protected(true);
    position_center(&window);
    window.show()?;
    Ok(())
}

pub fn close_context_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("copilot-context") {
        let _ = window.destroy();
    }
}
```

### MODIFIED files

**`src-tauri/src/copilot/mod.rs`** — add `pub mod context_window;`

**`src-tauri/src/lib.rs`**:
- Modify `start-copilot-session` action handler: instead of immediately creating the backend session, open the context window first. The actual session create + audio spawn moves into a NEW handler that fires when context is submitted.
- Add new `wolfee-action` handlers:
  - `submit-context` — receives 3 strings via Tauri command from context window; creates backend session; POSTs /context; spawns audio + workers; shows overlay; closes context window
  - `cancel-context` — destroys context window, returns to idle
  - `trigger-quick-action` — receives action type via Tauri command; spawns suggest_client with quick_action set
- Register ⌘+\ hotkey alongside existing ⌘⌥W (same handler, alias)
- ~80 LOC of additive lib.rs changes

**`src-tauri/src/copilot/hotkey.rs`**:
- Register `Cmd+Backslash` shortcut in `register()`
- Same `toggle_overlay` handler — alias the two key combos
- ~5 LOC additive

**`src-tauri/src/copilot/intelligence/api.rs`** (NOT the sacred `session/api.rs`):
- Add `post_context(session_id, payload)` method
- Add `post_quick_action(session_id, payload)` method (returns SSE stream like existing `post_suggest_sse`)
- Reuses existing `IntelligenceApi` struct, `device_token`, `client`. ~60 LOC.

**`src-tauri/src/copilot/intelligence/suggest_client.rs`**:
- Extend `SuggestRequest` (or add a `QuickActionRequest` variant) with `quick_action: Option<QuickActionType>`
- When set, route through `post_quick_action` instead of `post_suggest_sse`
- Same SSE consumer code path, same Tauri event emission shape
- Need to extend `ActiveSuggestionMutex`'s entry to hold an `AbortHandle` for the prior task so the user-click-wins concurrency rule works (cancel auto on user-click)
- ~40 LOC additive

### NOT touched (sacred per Decision #11)

- `src-tauri/src/copilot/window.rs` overlay logic — only ADDS the `position_center` helper if needed, doesn't modify `create_overlay_window` / `show_overlay` / `hide_overlay` / `elevate_window_level`
- `src-tauri/src/copilot/audio/*`, `transcribe/*`, `session/api.rs`
- `recorder.rs`, `uploader.rs`, `auth.rs`

---

## 8 — Frontend overlay changes

### Routing

Single Vite project (`overlay/`), single bundle, hash-routed.

**`overlay/src/main.tsx`** modified:

```tsx
const route = window.location.hash;
const Page =
  route === "#/context" ? <ContextWindow /> : <CopilotOverlay />;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>{Page}</ErrorBoundary>
  </React.StrictMode>,
);
```

No router library — hash matching is sufficient for two routes. Adding React Router for two routes is overkill.

### NEW files

- `overlay/src/pages/ContextWindow.tsx` — context paste UI:
  - 3 textareas (about_user / about_call / objections)
  - Char counter per field (`X / 2000` style)
  - Submit button (primary, Tailwind `bg-copilot-accent`)
  - Cancel button (secondary, neutral)
  - Esc → cancel (calls `wolfee-action: cancel-context`)
  - Cmd+Enter → submit (calls Tauri command `submit_context` with 3 string fields)
  - Auto-focus first textarea on mount
  - Loading state during submit (spinner + disabled buttons)

- `overlay/src/components/ActionButtonsRow.tsx` — 4-button component, two visual modes:
  - `mode="idle"` → 2x2 grid, 180×52 buttons with icon + label
  - `mode="active"` → 28px horizontal strip, icon-only with hover tooltip
  - Props: `onAsk()`, `onFollowUp()`, `onFactCheck()`, `onRecap()`, `disabled` (during in-flight action)

### MODIFIED files

**`overlay/src/CopilotOverlay.tsx`**:
- Render `<ActionButtonsRow mode={active ? "active" : "idle"} onClick handlers />` between transcript and suggestion zone
- When mode is idle, the suggestion zone renders the buttons; when active, a 28px strip + the suggestion card
- Each button onClick → `dispatch({type: 'TRIGGER_QUICK_ACTION', action})` + emit Tauri command `trigger_quick_action({action})`
- ~50 LOC additive

**`overlay/src/state/overlayReducer.ts`**:
- Add `TRIGGER_QUICK_ACTION` action — sets up the active suggestion in pending state, similar to SUGGESTION_PENDING but with the action type stored
- Add `quickAction: QuickActionType | null` to `ActiveSuggestion`
- ~30 LOC additive

**`overlay/src/state/types.ts`**:
- New types: `QuickActionType` ("ask" | "follow_up" | "fact_check" | "recap")
- Extend reducer Action union

---

## 9 — Session-start flow with context

**Locked: BLOCK session start until context is submitted (or cancelled).**

### Flow

```
1. User clicks tray "Start Copilot Session"
2. lib.rs handler: open context window via context_window::open_context_window
3. NO backend session created yet
4. NO audio capture yet
5. NO intelligence workers yet

[Pause — user types or pastes context]

6a. User clicks Cancel (or presses Esc):
    → context_window::close_context_window
    → CopilotState stays Idle
    → Tray remains in "Start Copilot Session" state

6b. User clicks Submit (or Cmd+Enter):
    → Tauri command receives 3 strings
    → POST /api/copilot/sessions (existing)
    → POST /api/copilot/sessions/:id/context (NEW)
    → CopilotState → StartingSession → Listening
    → Audio capture spawn
    → Deepgram WS spawn
    → Intelligence workers spawn (with context already in IntelligenceSessionState)
    → context_window::close_context_window
    → window::show_overlay
```

### Why block over async

The async alternative (start audio capture immediately, accept context POST in the background) means the first 30-60s of the session run with no context. Auto-suggestions fired during that window would be uncontextualized — exactly what 4.5 is trying to fix. PO already committed to setup overhead by clicking "Start Copilot Session"; 5-30 extra seconds for context paste is acceptable.

### Empty-context path

If user submits with all 3 fields blank, backend stores empty strings → prompts inject `(not provided)` placeholders → suggestions fall back to current generic quality. Graceful degradation matches pre-4.5 behavior.

---

## 10 — Testing strategy

**Locked: extend Sub-prompt 3 eval harness + Sub-prompt 4 dev-mock generator.**

### Eval harness extension

Modify [`server/lib/copilot/intelligence/eval/runEval.ts`](../WOLFEE-MVP/server/lib/copilot/intelligence/eval/runEval.ts):

- Add 5-10 NEW scenarios with realistic Wolfee-specific context blob (Raunek's actual product info)
- Run each existing scenario TWICE: once with empty context, once with realistic context
- Assert: precision/FP gates from Sub-prompt 3 (≥65% / ≤5%) hold under both conditions — context injection should NOT regress moment-detection accuracy
- New manual metric: count "specific reference" mentions in suggestion outputs (LLM-as-rater scores how often suggestions reference user_context vs being generic)
- Output: `eval/results/v0-with-context.json`

Quick-action endpoints don't get their own eval gates V1 — they're informational rather than precision-driven (a "follow-up question" is fine even if mediocre; a false-positive moment detection is harmful).

### Dev-mock generator update

Modify [`overlay/src/dev/mockEvents.ts`](overlay/src/dev/mockEvents.ts):

- Add `runMockQuickAction(action)` function that fires the same SSE event sequence as the existing mock suggestion, but with action-type-specific fixture text
- Add 4 new fixture sets in `fixtures.ts` — one per quick-action type (ask, follow_up, fact_check, recap)
- The Ctrl+Shift+M dev hotkey gains a sub-menu: 1=auto suggestion, 2=ask, 3=follow_up, 4=fact_check, 5=recap

Lets engineers iterate visual design without the backend running.

### Production smoke

After Sub-prompt 4.5 ships, run a real session:
- Open context window via tray
- Paste realistic Wolfee context (a few hundred chars per field)
- Submit → overlay should show
- Speak / play sales-call audio
- Verify auto-suggestions reference paste-in context
- Click each of the 4 action buttons → verify each produces appropriate output
- Press ⌘+\ → overlay hides; ⌘+\ again → shows
- Esc to dismiss action result; ⌘⌥W still works

---

## 11 — ⌘+\ hotkey

**Locked: register `Cmd+Backslash` as alias for `Cmd+Alt+W`.**

### Implementation

In [`src-tauri/src/copilot/hotkey.rs`](src-tauri/src/copilot/hotkey.rs)::register, add:

```rust
let hide_alias = Shortcut::new(Some(Modifiers::SUPER), Code::Backslash);
let app_handle3 = app.clone();
app.global_shortcut().on_shortcut(hide_alias, move |_app, _shortcut, event| {
    if event.state() == ShortcutState::Pressed {
        toggle_overlay(&app_handle3);
    }
})?;
log::info!("[Copilot] Registered hotkey ⌘+\\ (toggle overlay alias)");
```

Same `toggle_overlay` handler as ⌘⌥W — pure aliasing.

### Conflict check

`Cmd+\\` on macOS is:
- Browser: split-view in some browsers (rare, easily overridden)
- Slack: hide sidebar (only when Slack is focused)
- Various IDEs: nothing universal
- macOS system: not bound

Acceptable conflict surface. Wolfee Desktop's Accessory activation policy means we don't take focus, so a press while in (e.g.) Slack would propagate to Slack's handler. If user wants Wolfee's hide-all behavior, they'd need to be in their primary app where ⌘+\ is unbound — which is the typical case during a sales call.

If conflicts surface in usage, Sub-prompt 6 hotkey customization gives users an out.

---

## 12 — Regression safety

Mandatory acceptance tests for execution to declare done:

### Sub-prompt 1 (Foundation)
- [ ] ⌘⌥W still toggles overlay (without affecting context window)
- [ ] ⌘+\ now ALSO toggles overlay (NEW)
- [ ] Tray menu still shows expected items (with new "Generate Suggestion" from 4-retune AND new context flow under "Start")

### Sub-prompt 2 (Listening)
- [ ] Mic + system audio still capture
- [ ] Layer A/B/C diagnostics still log
- [ ] Deepgram WS still connects + delivers transcripts
- [ ] Recorder upload still works (separate code path)

### Sub-prompt 3 (Intelligence)
- [ ] Existing /summary, /detect-moment, /suggest endpoints unchanged (verify via curl with empty context)
- [ ] Auto-fired suggestions still work (now with context injected)
- [ ] Eval harness passes precision ≥ 65% / FP ≤ 5% with AND without context
- [ ] /quick-action endpoint returns valid SSE for all 4 action types

### Sub-prompt 4 (Overlay UI)
- [ ] Phase 6 permission modal preserved verbatim
- [ ] Click-to-expand suggestion still works
- [ ] X button on suggestion card still dismisses
- [ ] Streaming JSON tokens still hidden (Reasoning indicator during stream)
- [ ] No "black screen" regression
- [ ] Auto-hide-on-blur still disabled

### Sub-prompt 4.5 (NEW)
- [ ] Tray "Start Copilot Session" → context window opens
- [ ] Context window cancel → returns to idle, no session created
- [ ] Context window submit → session created, context POSTed, audio + workers spawn, overlay shows
- [ ] Submitting empty fields produces a valid (no-context) session
- [ ] Action button click during idle → quick-action stream fires, response renders in suggestion card
- [ ] Action button click during in-flight auto-suggestion → auto cancels, user-requested fires (per Decision N1)
- [ ] All 4 actions produce valid output (per type)
- [ ] Suggestions reference user_context fields when those fields contain content (verified via eval comparison)
- [ ] ⌘+\ toggles overlay
- [ ] Migration 0008 applies cleanly (idempotent ADD COLUMN IF NOT EXISTS)

---

## 13 — Effort breakdown

Total target: **~50-65 hr (~1 calendar week at 1 focused engineer).**

| section | hours | notes |
|---|---|---|
| §2 Tauri context window infrastructure | 6 | WebviewWindowBuilder + lifecycle commands |
| §3 Context schema + migration 0008 + sessionState extension | 4 | small migration, in-memory map field add, /context endpoint |
| §4 ActionButtonsRow component (idle + active modes + transitions) | 10 | mode-switching + framer-motion transitions + tooltips |
| §5 Backend quick-action endpoint + 4 prompt variants + suggest_client routing | 12 | most code; new endpoint + 4 prompts loaded + Rust routing |
| §6 Existing prompt updates (3 files) + V0 quick-action prompts | 6 | pure prompt editing, no logic |
| §7 Rust wiring (commands, IPC, ⌘+\ hotkey, lib.rs handlers) | 5 | additive `wolfee-action` handlers + Tauri commands |
| §8 Frontend ContextWindow page + reducer extensions + routing | 10 | hash-router, ContextWindow component, reducer actions |
| §9 Session-start flow refactor (block on context submit) | 3 | mostly state-machine reordering in lib.rs |
| §10 Eval harness updates + dev-mock extensions | 5 | scenarios with context, mock action firing |
| §11 ⌘+\ hotkey registration | 1 | trivial |
| §12 Regression smoke + production .app verification | 4 | re-runs Sub-prompts 1–4 acceptance tests + new ones |

**Total: 66 hr** (worst case with full polish), **trim to ~50 hr** by simplifying §4 transitions (no animation between modes) if scope tight.

**Confidence interval: 50–80 hr.** Driven by:
- Whether the visual design of ActionButtonsRow lands first iteration (most likely overrun)
- Whether the Rust IPC pattern for context window submit is straightforward
- Whether prompt iteration on quick-action templates needs more than one cycle

---

## 14 — Open decisions for PO

| # | decision | recommendation | alternatives | tradeoff |
|---|---|---|---|---|
| **N1** | Concurrency: action-click during auto-suggestion firing | **User-click wins — cancel auto, fire user request** | Drop user click ("we're showing one already"); queue action | User intent should win, but cancel logic adds ~30 LOC for AbortHandle on ActiveSuggestionMutex |
| **N2** | Idle action buttons layout | **2x2 grid** (180×52 buttons with icon + label) | Horizontal row of 4 (~95×120 each), or 4-row stack | 2x2 reads as primary CTAs; horizontal feels toolbar-y; stack wastes vertical |
| **N3** | Block session start on context submit vs async | **Block** — better suggestion quality from second one | Async — start audio immediately, accept context in background | Block adds 5-30s setup time but gives full session benefit; async means first 30-60s of suggestions are generic |
| **N4** | Context field structure | **Structured 3-field** (about_user / about_call / objections) | Single freeform paste; or hybrid | Structure helps prompt template + LLM; freeform is lower friction |
| **N5** | Char limits per field | **2000 / 1000 / 500** | Longer (~10K total); shorter (~1500 total) | Longer = more LLM cost + token-limit risk; shorter = less expressive |
| **N6** | Action button keyboard shortcuts | **No 1/2/3/4 number-key shortcuts in V1** | Add 1-4 hotkeys when overlay focused | Discoverability gain marginal; preserves Esc / Cmd+C semantics |
| **N7** | Action button icons | lucide-react: `MessageCircle`, `HelpCircle`, `CheckCircle`, `RotateCw` | Custom SVG; or text-only | lucide-react already in deps; standard semantics |
| **N8** | Auto-suggestions during user-action concurrent | Auto-suggestions PAUSED while user-action result is showing | Allow auto-suggestions to interrupt | Pause matches "user intent wins" theme; lets user read what they asked for |
| **N9** | Context window default position | Center of focused monitor | Fixed top-center; remember last position | Center is conventional; fixed reduces choice; remember adds state |
| **N10** | Context paste field placeholders | Realistic examples (Wolfee-specific) inline | Generic placeholders; no placeholders | Examples teach the user what good context looks like; generic feels lazy |

10 open decisions. PO review: 30-45 min. Only N1 has implementation knock-on (the AbortHandle work); the rest are pure design.

---

## 15 — Files to create / modify

### NEW (desktop)

- `src-tauri/src/copilot/context_window.rs`
- `overlay/src/pages/ContextWindow.tsx`
- `overlay/src/components/ActionButtonsRow.tsx`

### NEW (backend)

- `migrations/0008_add_copilot_session_context.sql`
- `server/lib/copilot/intelligence/quickAction.ts` — handler module (validates action enum + dispatches to right prompt)
- `server/lib/copilot/intelligence/prompts/quickAction/ask.md` (NEW — copy of existing suggest.md with context block)
- `server/lib/copilot/intelligence/prompts/quickAction/followUp.md` (NEW — V0 above)
- `server/lib/copilot/intelligence/prompts/quickAction/factCheck.md` (NEW — V0 above)
- `server/lib/copilot/intelligence/prompts/quickAction/recap.md` (NEW — V0 above)

### MODIFIED (desktop)

- `src-tauri/src/copilot/mod.rs` — add `pub mod context_window;`
- `src-tauri/src/copilot/hotkey.rs` — register ⌘+\
- `src-tauri/src/lib.rs` — modify start-session flow + add submit-context / cancel-context / trigger-quick-action handlers
- `src-tauri/src/copilot/intelligence/api.rs` — add post_context + post_quick_action methods (NOT the sacred session/api.rs)
- `src-tauri/src/copilot/intelligence/suggest_client.rs` — extend to route via quick-action endpoint when set + AbortHandle on ActiveSuggestionMutex entry
- `overlay/src/main.tsx` — hash-route on `#/context`
- `overlay/src/CopilotOverlay.tsx` — render ActionButtonsRow alongside SuggestionCard
- `overlay/src/state/types.ts` — add QuickActionType + reducer action types
- `overlay/src/state/overlayReducer.ts` — add TRIGGER_QUICK_ACTION reducer case
- `overlay/src/dev/mockEvents.ts` + `dev/fixtures.ts` — add per-action mock firing

### MODIFIED (backend)

- `shared/schema.ts` — add 3 columns to copilot_sessions
- `server/storage.ts` — add updateCopilotSessionContext(sessionId, fields) helper
- `server/lib/copilot/intelligence/sessionState.ts` — extend IntelligenceSessionState with 3 context fields
- `server/lib/copilot/intelligence/prompts.ts` — add new constants (ASK_PROMPT, FOLLOW_UP_PROMPT, FACT_CHECK_PROMPT, RECAP_PROMPT) inlined alongside SUMMARY_PROMPT etc; promptLoader.ts unchanged structurally
- `server/lib/copilot/intelligence/promptLoader.ts` — extend PromptName union; add new templates to TEMPLATES record
- `server/lib/copilot/intelligence/{summary,momentDetector,suggest}.ts` — pass context vars into render() calls
- `server/lib/copilot/intelligence/eval/scenarios.json` — add context field per scenario; update runEval.ts to pass them through
- `server/routes.ts` — register `POST /api/copilot/sessions/:id/context` + `POST /api/copilot/sessions/:id/intelligence/quick-action`

### NOT MODIFIED (sacred per Decision #11)

- All `src-tauri/src/copilot/audio/*`
- `src-tauri/src/copilot/transcribe/buffer.rs`, `transcribe/deepgram.rs`
- `src-tauri/src/copilot/session/api.rs`
- `src-tauri/src/copilot/window.rs` overlay logic (only ADDS a `position_center` helper if needed)
- `src-tauri/src/recorder.rs`, `uploader.rs`, `auth.rs`
- Phase 6 PermissionModal block in CopilotOverlay.tsx (verbatim)
- Existing `/summary`, `/detect-moment`, `/suggest` route handlers (their prompts get context injection but the route plumbing is unchanged)
- WOLFEE-MVP `lib/meetings/*`, `lib/analysis/*`, `lib/auth.ts`

---

## 16 — Acceptance tests

### Build (4)
- [ ] `cargo check` clean
- [ ] `cargo build --release` clean
- [ ] `pnpm tauri build --bundles app` produces notarizable .app
- [ ] Migration 0008 applies cleanly on staging Postgres

### Backend smoke (4)
- [ ] `POST /api/copilot/sessions/:id/context` with valid payload returns 200, persists 3 columns
- [ ] Empty context POST stores empty strings, doesn't break existing handlers
- [ ] `POST /api/copilot/sessions/:id/intelligence/quick-action` returns SSE for all 4 actions
- [ ] All 3 existing intelligence endpoints still return correct shapes with context injected

### Desktop smoke (8)
- [ ] Tray "Start Copilot Session" → context window appears (system chrome, 600×500, centered)
- [ ] Cancel button (or Esc) → window destroyed, no session created
- [ ] Submit button (or Cmd+Enter) → window destroyed, session created with context, overlay shows
- [ ] Submitting empty fields → session creates, no-context fallback works
- [ ] Idle overlay shows 2x2 action-button grid
- [ ] Click "Ask" / "Follow-up" / "Fact-check" / "Recap" → SSE stream renders in suggestion card
- [ ] Click during auto-suggestion firing → auto cancels, user request shows (Decision N1)
- [ ] ⌘+\ toggles overlay show/hide

### Regressions (per Section 12 list)
- [ ] All 22 acceptance tests from Sub-prompts 1, 2, 3, 4 still pass
- [ ] Phase 6 permission modal still renders if mic revoked

### Eval (1, ship gate)
- [ ] Eval harness passes precision ≥ 65% / FP ≤ 5% on 30+ scenarios with context injected
- [ ] Spot check: 5 scenarios with realistic Wolfee context produce noticeably more specific suggestions than the same scenarios with empty context

**Total: 26 acceptance tests across all sub-prompt regressions + new functionality.**

---

## End of plan

**Plan path:** `/Users/raunekpratap/Desktop/wolfee-desktop/wolfee-copilot-subprompt-4.5-plan.md` (NOT committed).

**Top blocking decisions for PO** (must resolve before execution prompt is written):

- **N1** (concurrency: cancel auto on user-click vs drop user-click)
- **N2** (idle action button layout: 2x2 grid vs horizontal row vs stack)
- **N3** (block session start on context vs async)
- **N4** (field structure: structured 3-field — already locked, but PO should confirm)
- **N5** (char limits: 2000/1000/500 vs longer/shorter)

The other 5 (N6-N10) are pure design polish that can resolve mid-execution without rework.

**Effort confidence:** 50-65 hr ± 30%. Likely range **50-80 hr**, driven by:
- ActionButtonsRow visual design iterations
- Whether N1's AbortHandle work is straightforward
- Eval harness comparison (with-context vs empty-context) producing clean signal

**Recommended next step:** PO 30-45 min review of §14, lock the 5 blocking decisions; once locked, the execution prompt for Sub-prompt 4.5 can be written directly from this plan. Most of the work is additive — the riskiest part is the ContextWindow + multi-window IPC flow, which has no Tauri 2 precedent in our codebase yet.
