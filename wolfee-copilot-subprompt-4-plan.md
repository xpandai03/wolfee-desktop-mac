# Wolfee Copilot Sub-prompt 4 (Overlay UI) — Execution Plan

Author: implementing engineer
Status: planning pass complete, **zero code changed**. Read-only.
Date: 2026-05-02

---

## 0 — Status & relationship to prior work

Sub-prompts 1, 2, 3 are functionally complete. Sub-prompt 4 is the **user-facing payoff** — until now, Copilot's intelligence emits Tauri events into a console.log void.

**Build-on points:**
- Overlay window: 420×280, frameless, content-protected, top-center of focused monitor (Sub-prompt 1 — sacred).
- Hotkeys: ⌘⌥W toggles overlay, ⌘⌥G triggers suggestion (Sub-prompts 1, 3 — sacred).
- Phase 6 permission modal logic in [`overlay/src/CopilotOverlay.tsx`](overlay/src/CopilotOverlay.tsx) — kept exactly as-is.
- 6 events to consume:
  - `transcript-chunk` (Sub-prompt 2 Phase 3) — partials + finals from Deepgram
  - `copilot-summary-updated` (Sub-prompt 3) — full rolling summary text
  - `copilot-moment-detected` (Sub-prompt 3) — `{trigger, trigger_phrase, urgency, rationale}`
  - `copilot-suggestion-streaming` (Sub-prompt 3) — `{kind, text?, moment_type?}`
  - `copilot-suggestion` (Sub-prompt 3) — full payload `{primary, secondary, confidence, reasoning, ttl_seconds}`
  - `copilot-suggestion-failed` (Sub-prompt 3) — `{reason}`
- Tauri stack pre-locked: React 18 + Vite 5 + Tailwind 3, with `framer-motion`, `lucide-react`, `clsx`, `tailwind-merge` already in `overlay/package.json` (Sub-prompt 1). Tailwind tokens already defined: `copilot.accent` (#22d3ee cyan-400), `copilot.glow`. Dark theme (zinc-950).

**Sacred files (DO NOT modify in Sub-prompt 4):**
- All `src-tauri/**/*.rs` — Sub-prompt 4 is **frontend-only**
- Backend (`WOLFEE-MVP/`) — untouched
- Existing Phase 6 permission modal section of `CopilotOverlay.tsx` — keep its logic identical; new code wraps around it
- `tauri.conf.json`, `capabilities/`, `entitlements.plist`, `Info.plist`
- `overlay/tailwind.config.ts` — extend (additive only) if new tokens needed; don't break existing

**What this plan locks fresh, in 11 sections.**

---

## 1 — Architecture overview

```
┌────────────────────────────────────────────┐ 420 × 280
│ ⚙           🟢 Listening (mid-session)     │ ← top bar 28px
├────────────────────────────────────────────┤
│ user: hello hello                          │
│ speakers: Yeah we're worried about         │ ← transcript zone 100px
│           the price                        │   (last 2 utterances)
├────────────────────────────────────────────┤
│ ⚠ OBJECTION   ✦                            │
│ Acknowledge their concern, then ask        │ ← suggestion zone 130px
│ what ROI would unlock this for them.       │
│                                            │
│ Esc · Click to copy                        │ ← footer hint 22px
└────────────────────────────────────────────┘
```

**State machine** (overlay-side only — distinct from CopilotState in Rust):

```
                  permission denied → PermissionModal (Phase 6, sacred)
                                  │
                            (resolved)
                                  ▼
   Idle ──── ⌘⌥W ────► ShowingOverlay
     ▲                       │
     │                       │ session lifecycle in Rust unchanged;
     │                       │ Sub-prompt 4 just renders different
     │                       │ content based on local "uiPhase" state
     │                       ▼
     │                  ┌────────┐
     │                  │ Idle   │ ── transcript-chunk ─► render scroll
     │                  │ (no    │ ── copilot-moment-detected ─► uiPhase = Reasoning
     │                  │ active │
     │                  │ sugg.) │
     │                  └────────┘
     │                       │
     │              (moment OR ⌘⌥G)
     │                       ▼
     │                  ┌────────────┐
     │                  │ Reasoning… │ ── streaming delta ─► append tokens
     │                  │ (animated) │ ── 2s no delta ─► fall back to Idle
     │                  └────────────┘
     │                       │
     │                  (first delta arrives)
     │                       ▼
     │                  ┌──────────────┐
     │                  │ Streaming    │ ── delta ─► append
     │                  │              │ ── complete ─► uiPhase = Showing
     │                  └──────────────┘
     │                       │
     │                       ▼
     │                  ┌──────────────────┐
     │                  │ Showing          │ ── Esc/click X ─► dismiss
     │                  │ (TTL countdown)  │ ── click primary ─► copy + flash
     │                  │                  │ ── 25s elapsed ─► fade warning
     └──── 30s TTL ◄─── │                  │ ── 30s elapsed ─► auto-dismiss
                        └──────────────────┘
```

The overlay is a single React component tree mirroring this state machine via local `useReducer`. Every Tauri event is a dispatched action.

---

## 2 — Layout architecture

**Locked: Option A — two-zone vertical split.**

### Pixel breakdown (420 × 280)

```
top bar              28px   status indicator + Settings hook (⚙)
transcript zone     100px   last 2 utterances, partials with low-opacity
suggestion zone     130px   the action zone — idle hint, Reasoning…, suggestion card
footer hint          22px   ephemeral keyboard / copy hint, 3s autohide on first show
```

### Why this layout

- **Two zones match the user's mental model**: "what's being said now" + "what to say next." Reading flows top-to-bottom, suggestion is the call to action at the bottom.
- **280px is tight** — three-zone (Option C) felt cramped; tab-style (D) defeats the ambient-awareness goal; transcript-as-background (B) hurts readability during a call.
- **100px transcript** = realistically 2-3 short utterances. Sub-prompt 3's TranscriptBuffer is 90s; we render only the trailing window. Older content scrolls off the top with no visible scrollbar (already CSS-hidden in `index.css`).
- **130px suggestion** = enough for a 2-line `primary` (180px wide × 2) + 1-line `secondary` + trigger badge + reasoning peek. Sub-prompt 3 hard-caps `primary` and `secondary` at 200 chars each.

### Idle state (no active suggestion)

Suggestion zone shows centered text: **`Listening… ⌘⌥G to ask`** at `text-zinc-500` (Tailwind), 60% opacity, 13px. No card chrome — empty space reads as "nothing pressing right now."

### Reasoning state (moment fired, deltas haven't arrived)

```
⚠ OBJECTION (auto)
Reasoning ●●●     ← three pulsing dots, 250ms stagger
```

Card chrome shows IMMEDIATELY when `copilot-moment-detected` fires (or the local "hotkey pressed" action dispatches), so the user sees Copilot is working. Pulsing dots replaced by streaming text on first `copilot-suggestion-streaming` delta.

### Streaming + Showing states

Card content fills with streaming text. On `copilot-suggestion`, the card finalizes: badge + `primary` + optional `secondary` + footer. TTL countdown is invisible until the last 5 seconds, when card opacity slowly fades from 100% → 60% over 5s as a subtle "this is going away" signal.

---

## 3 — Live transcript display

**Locked: Option B — partials with subtle styling, finalize on `is_final`.**

### Visual treatment

```tsx
// pseudocode shape, real impl uses cn() helper
<div data-channel={channel} data-final={isFinal}>
  <span className="speaker-label">{channel === "user" ? "You" : "Speakers"}</span>
  <span className={isFinal ? "opacity-100" : "opacity-60 italic"}>{transcript}</span>
</div>
```

| field | rendering |
|---|---|
| Speaker label | `text-zinc-500 text-xs uppercase tracking-wider`. **`You`** for `user`, **`Speakers`** for `speakers` (locked friendlier names than the raw channel slugs). |
| Final transcript | `text-zinc-100 text-sm leading-snug` |
| Partial transcript | same as final but `opacity-60 italic`. Replaced in place when `is_final=true` arrives. |
| Timestamp | **none** in V1. Hover-to-show could ship as Sub-prompt 6 polish. |
| Per-utterance separator | none — line-break only |

### Partial → final substitution

State holds a single ordered list of `{utterance_id, channel, text, is_final}`. Partials use a synthetic `utterance_id` derived from `channel + started_at_ms`. When a `final=true` chunk arrives with the same id, the partial entry is replaced (not appended) so text doesn't jump.

### Visible utterance count

**Locked: last 2 utterances visible.** Older utterances drop off the top instantly (no scroll animation — would compete with suggestion appearance). 100px / 14px line-height ≈ 7 lines of text; 2 utterances at 2-3 lines each fits comfortably.

### Auto-scroll

**Always pinned to most-recent**. We never let the user scroll back — overlay is for the *current moment*. If they want history, that's the rolling summary (hidden in V1) or the full Notes recording (separate product).

### Empty transcript

If no utterances have arrived yet (session just started), transcript zone is **completely empty** (no placeholder). The status pill in the top bar carries the "Listening" affordance.

---

## 4 — Suggestion card visual design

**Locked: Option B — monochrome with brand accent, no per-trigger color coding.**

V1 ships without color-by-trigger. Sub-prompt 6 telemetry (suggestions_dismissed_user) tells us whether scannability is hurting; we add color coding then if data warrants. The risk in shipping color is "alarming during pro calls" — calling out an OBJECTION in red while the rep is mid-meeting feels combat-coded.

### Card anatomy

```
┌────────────────────────────────────────────┐
│ ⚠ OBJECTION  · auto                        │ ← badge row 18px
│                                            │
│ Acknowledge their concern, then ask        │ ← primary 16px, 2 lines max
│ what ROI would unlock this for them.       │
│                                            │
│ ↳ Anchor on annual savings, not monthly.   │ ← secondary 12px, optional, 1 line
│                                            │
│ Esc · Click to copy                        │ ← footer 11px, 50% opacity
└────────────────────────────────────────────┘
```

### Tailwind classes (concrete)

| element | classes |
|---|---|
| Card wrap | `rounded-xl border border-white/10 bg-zinc-900/95 px-3 py-2 shadow-lg shadow-copilot-glow/20` |
| Trigger badge | `inline-flex items-center gap-1 rounded-full bg-copilot-accent/15 text-copilot-accent text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5` |
| Source marker | small text after badge: `text-[10px] text-zinc-500` reading `auto` (moment) or `manual` (hotkey) |
| Primary | `text-sm font-medium text-zinc-50 leading-snug mt-2` |
| Secondary | `text-xs text-zinc-300 leading-snug mt-1.5 before:content-["↳_"] before:text-zinc-500` |
| Footer hint | `text-[11px] text-zinc-500 mt-2` |
| Confidence | **NOT shown to user in V1** (open decision N4 below) |

### Streaming text appearance

Tokens append directly to the primary text node. **No per-token animation** — just `text` keeps growing as deltas arrive. The card itself has already faded in (200ms) before first delta. Implementation: `useReducer` accumulates the streaming string; React's diffing re-renders the text node only.

### Click-to-copy feedback

Click anywhere on the primary text → copies to clipboard via `navigator.clipboard.writeText(primary)`. Card flashes once: brief `bg-copilot-accent/30` overlay for 200ms, then settles back. Footer changes from `Esc · Click to copy` → `Copied ✓` for 1.2s.

### Trigger labels (user-facing strings)

Lock the user-visible label per `trigger`:

| trigger (backend) | badge label |
|---|---|
| `objection` | OBJECTION |
| `pricing_question` | PRICING |
| `silence_after_question` | THEY WENT QUIET |
| `decision_moment` | DECISION TIME |
| `buying_signal` | BUYING SIGNAL |
| `confusion` | CONFUSED |
| `competitor_mentioned` | COMPETITOR |
| `question_asked` | QUESTION |

These ship in [`overlay/src/lib/triggerLabels.ts`](overlay/src/lib/triggerLabels.ts) so Sub-prompt 6 can localize without touching component code.

---

## 5 — Moment vs hotkey differentiation

**Locked: Option B — subtle marker (small text label after the trigger badge).**

```
⚠ OBJECTION  · auto       ← moment-triggered
✦ GENERAL    · manual     ← hotkey-triggered, no specific trigger
```

Hotkey suggestions get a `✦` glyph instead of `⚠`, and the badge label reads **GENERAL** (matches `trigger=null` from the backend, which the backend renders as `moment_type="general"`).

### Why subtle, not strong

- V1 needs a hint not a shout. Strong differentiation (different card style entirely, Option C in the prompt) adds design surface we'll have to redesign once we have user data.
- The marker is enough to answer "why is this showing?" — auto means the AI noticed something; manual means the user asked.
- Sub-prompt 6 polish can introduce the "subtle pulse" animation for moment-triggered (per design doc §3.4) once the basic ergonomics are validated.

---

## 6 — Animation policy

**Locked: framer-motion already in deps — use it for two effects only. Everything else is Tailwind transitions.**

| trigger | animation |
|---|---|
| Card mount (Reasoning state appearing) | `framer-motion`: `{opacity: 0, y: 8} → {opacity: 1, y: 0}`, 200ms ease-out |
| Card unmount (dismiss / auto-fade) | `{opacity: 0, y: 4}`, 150ms ease-in. AnimatePresence wraps. |
| Reasoning dots | pure CSS keyframes — three `<span>`s with `animation-delay: 0/250/500ms` on `pulse 750ms infinite` |
| Streaming text | NO animation — tokens append directly, React re-renders text node only |
| Click-to-copy flash | Tailwind transition: `transition-colors duration-200` toggles a class |
| TTL final-5s fade | Tailwind transition: `transition-opacity duration-[5000ms]` toggles `opacity-60` at T-5s |

### Why this policy

- `framer-motion` is **already in the bundle** (Sub-prompt 1 added it). No new dep cost.
- Per-token animation (Option B in the prompt) creates cumulative lag at 5-20 deltas/sec. Skip.
- Tailwind transitions cover the simple states cleanly; AnimatePresence is the cleanest way to handle exit animations on conditional renders.

### What stays static

No screen-edge slides. No "swoosh" sounds. No haptics. The overlay is a quiet ambient surface — the design lock is **calm**.

---

## 7 — Idle state

**Locked: Option B — subtle hint `Listening… ⌘⌥G to ask`.**

When `uiPhase = Idle` and there's no active suggestion:

```
                                                  ← suggestion zone
                  Listening… ⌘⌥G to ask           ← centered, opacity-60
                                                    text-zinc-500 text-[13px]
```

**Why B over D (rolling summary excerpt):** Decision N10 in Sub-prompt 3's plan locked rolling summary as **hidden in V1** (only used as LLM context). Surfacing it here would contradict that and risk feeling preachy ("Here's what's been said"). The hint is enough.

### Persistence

The idle hint stays as long as `uiPhase = Idle`. It does NOT pulse, blink, or otherwise demand attention — that defeats "subtle."

---

## 8 — Dismiss + copy interactions

**Locked: Esc + click X both fire `wolfee-action: copilot-suggestion-dismissed` (already wired in Sub-prompt 3 lib.rs handler). Click-on-primary copies + flashes.**

### Dismiss paths

| action | behavior | telemetry |
|---|---|---|
| Press `Esc` while suggestion is showing | emit `wolfee-action` payload `"copilot-suggestion-dismissed"` (string for backward compat with the existing tray-action listener pattern). Card unmounts. | `dismissed_via: esc` |
| Click `×` button (top-right of card) | same as Esc | `dismissed_via: click` |
| TTL elapses (30s) | card auto-fades + unmount | `dismissed_via: auto` |
| New suggestion fires (rare — Rust ActiveSuggestionMutex blocks concurrent) | not possible in V1; suggest_client drops new triggers | n/a |

**Telemetry rider:** Sub-prompt 3 backend already accepts the action emit; the `dismissed_via` distinction is recorded at the Rust side via the action payload. We extend the action payload from a string to an object on the JS side and update the lib.rs handler to read both forms.

> **PO open decision N5 below**: do we ship richer payload now, or keep V1 dumb and add `dismissed_via` in Sub-prompt 6 telemetry pass?

### Copy paths

| action | behavior |
|---|---|
| Click anywhere on primary text | `navigator.clipboard.writeText(payload.primary)`. Flash card. Footer changes to `Copied ✓` for 1200ms then back. |
| `Cmd+C` while suggestion focused | same as click. `<button>` wrapping primary text gets autofocus on suggestion mount. |
| Dedicated Copy button | NOT shipped in V1. Click-to-copy is discoverable via the footer hint. |

### Esc behavior coupling

The existing Phase 6 modal already uses Esc to dismiss the modal (sacred logic). The new suggestion-dismiss Esc handler must NOT fire when the modal is up. Implementation: the dismiss handler short-circuits if `permissionNeeded != null`. Modal Esc handler runs first, suggestion dismiss runs only when overlay is in non-modal mode.

---

## 9 — Streaming UX

**Locked: Reasoning indicator on moment, replaced by streaming text on first delta. Hard cap 2s.**

### Sequence

```
T+0     copilot-moment-detected fires
T+0     uiPhase = Reasoning
        Card mounts (fade-in 200ms) showing "⚠ {trigger badge} · auto" + "Reasoning ●●●"
T+~600ms-2s  copilot-suggestion-streaming delta arrives, kind="start"
        Reasoning dots replaced by empty primary text node
T+~700ms+  delta events with kind="delta", text=" the next..."
        primary text node grows
T+~3s   copilot-suggestion (kind="complete") arrives
        primary + secondary settled
        uiPhase = Showing
T+30s   TTL elapsed, card auto-dismisses
```

### Hard cap (2s no delta)

If `Reasoning` state lasts > 2s with no streaming-delta event, we silently drop back to Idle and emit `console.warn` (Sub-prompt 7 telemetry will pick this up). User sees: card was there briefly, then went away. No error toast — error UX would be more disruptive than the brief "ghost card."

This timer is independent of the `copilot-suggestion-failed` event, which fires on backend errors and triggers a brief 1.2s toast: `Couldn't generate suggestion` in `text-zinc-400`, footer position. Toast auto-fades; the suggestion zone returns to Idle.

### Hotkey path

⌘⌥G is wired Rust-side (lib.rs handler reads CopilotState, snapshots transcript, calls `suggest_client::spawn_for_hotkey`). The overlay doesn't need to know the user pressed ⌘⌥G — it sees `copilot-suggestion-streaming` deltas with `moment_type: "general"` and renders accordingly. This means the **`Reasoning…` indicator should ALSO appear on hotkey path** — but we only know the suggestion is coming once the first stream event arrives, so there's a 200-800ms window where nothing happens after the keypress.

> **PO open decision N3 below**: should Rust emit a `copilot-suggestion-pending` event the instant ⌘⌥G is pressed (and on moment fire) so the overlay can show Reasoning earlier? Otherwise hotkey UX has 200-800ms of dead air.

---

## 10 — Performance strategy

**Locked: naive React state with strategic memoization. Profile before optimizing further.**

### Re-render boundaries

```
<CopilotOverlay>            ← top-level state holder via useReducer
  <TopBar />                ← memo: re-renders only on uiPhase change
  <TranscriptZone           ← memo: re-renders on transcript array change
    utterances={...} />
  <SuggestionZone           ← memo: re-renders on suggestion state change
    state={...}
    payload={...} />
  <FooterHint />            ← memo: never re-renders after mount
</CopilotOverlay>
```

`React.memo` on `TranscriptZone` and `SuggestionZone` so a streaming-delta event only re-renders the suggestion subtree, not the transcript.

### Event throttling

Transcript chunks fire at 5-20/s. Streaming deltas at 5-15/s. Both are dispatched into the reducer immediately — no debouncing — but the reducer state is shaped so each dispatch causes exactly one zone to re-render.

### When to revisit

Profile with React DevTools Profiler during Sub-prompt 7 beta. If frame time > 16ms during streaming, options:
- `requestAnimationFrame` batching for streaming deltas (coalesce N events per frame)
- Move primary text into a sub-component with `useSyncExternalStore` to bypass React's render cycle
- Virtualize transcript list (low priority — only 2-3 visible)

V1 ships naive. Don't preoptimize.

### Stability

Use stable keys in transcript list: `${channel}:${started_at_ms}:${is_final}`. The is_final suffix ensures partial→final substitution doesn't get mistaken for an unmount (would lose typing-in-progress state if we had any).

---

## 11 — Testing strategy

**Locked: dev-mode mock event generator + production .app smoke test. No Storybook.**

### Dev-mode mock event generator

A dev-only module `overlay/src/dev/mockEvents.ts` exposes a `runMockSession()` that fires fake Tauri events on a timer:

- `transcript-chunk`: 1 every 600-1200ms with realistic text from a fixture
- `copilot-summary-updated`: every 30s
- `copilot-moment-detected`: every 60s
- `copilot-suggestion-streaming` + `copilot-suggestion`: full sequence triggered after each moment

A keyboard shortcut **`Ctrl+Shift+M`** (only registered when `import.meta.env.DEV` is true) toggles the mock loop. Lets the engineer iterate visual design without touching the backend.

### Production .app smoke test

After Sub-prompt 4 ships, run the existing Sub-prompt 3 verification flow:
1. `pnpm tauri build --bundles app`
2. Open .app, click Start Copilot Session
3. Speak + play prospect-style audio with objections, pricing questions
4. Verify in the overlay (not just console):
   - Transcript appears live, partials in italic, finals solid
   - Reasoning dots show on moment fire
   - Streaming text fills in
   - Final card has badge + primary + footer
   - Esc dismisses, click-to-copy works
   - 30s auto-dismiss fires

### What we do NOT test

- Storybook (overkill for one component tree)
- E2E with Playwright/Cypress (Tauri webview is a moving target)
- Visual regression (eyeball it for V1)

---

## 12 — Settings hook

**Locked: top-right ⚙ icon, click logs `[Copilot] settings clicked` and otherwise no-ops.**

### Visual

`<Settings />` icon from `lucide-react` (already in deps), `text-zinc-500 hover:text-zinc-300`, top-right corner of the top bar, 16×16 px, `cursor-pointer`.

### Behavior

```tsx
<button
  onClick={() => console.log("[Copilot] settings clicked — Sub-prompt 6")}
  aria-label="Open Wolfee Copilot settings"
>
  <Settings className="w-4 h-4" />
</button>
```

That's it. Sub-prompt 6 wires it to a real settings panel route or window. The hook existing means Sub-prompt 6 is unblocked — it can write the settings view in parallel.

### Why a no-op vs hidden

A visible-but-no-op button gives the user a known anchor for "where settings will live." Hidden until Sub-prompt 6 ships means we have to redesign the top bar then. Cheaper to commit now.

---

## 13 — Effort breakdown

Total target: **~50 hr (~1 calendar week at 1 focused engineer).**

| section | effort | notes |
|---|---|---|
| §2 Layout architecture (top bar + zones + status pill) | 6 hr | mostly CSS scaffolding + Tauri window-state status reads |
| §3 Live transcript display (state mgmt + partial/final substitution) | 8 hr | reducer logic for in-place replacement is the trickiest part |
| §4 Suggestion card (badge + primary + secondary + footer + classes) | 10 hr | highest stakes; iterate on typography until it feels right |
| §5 Moment vs hotkey differentiation (badge marker + glyph swap) | 2 hr | trivial once card exists |
| §6 Animations (framer-motion mount/unmount + Tailwind transitions) | 4 hr | Reasoning dots is custom keyframes |
| §7 Idle state (centered hint) | 1 hr |  |
| §8 Dismiss + copy (Esc handler + click-to-copy + flash) | 4 hr | Esc-vs-modal-Esc coupling needs care |
| §9 Streaming UX (Reasoning state + 2s fallback + failed toast) | 4 hr | timer logic in reducer |
| §10 Performance (React.memo on zones) | 2 hr | low effort, do upfront |
| §11 Testing (mockEvents.ts + Ctrl+Shift+M dev hotkey) | 4 hr | useful for design iteration even before code complete |
| §12 Settings hook (gear icon + console log) | 1 hr |  |
| Trigger labels lib + tests | 2 hr |  |
| Production .app smoke + regression | 2 hr | re-runs existing Sub-prompt 3 verification |

**Total: 50 hr.**

**Best-case 38 hr** if visual design lands first iteration without major redo.
**Worst-case 70 hr** if PO requests a layout swap mid-execution (Option C three-zone) or per-trigger color coding gets re-opened.

---

## 14 — Open decisions for PO

| # | decision | recommendation | alternatives | tradeoff |
|---|---|---|---|---|
| **N1** | Layout: A (two-zone) vs C (three-zone with moment indicator strip) | **A** — two-zone | C adds info density at the cost of cramping a 280px-tall window | C reads as more "AI-y", A reads as cleaner. Both are buildable. |
| **N2** | Per-trigger color coding (red objection, green buying signal, etc.) | **No** — monochrome with brand accent | Yes, per plan §4 Option A | Color coding is faster to scan but feels combat-coded during professional calls. Defer to data from telemetry in Sub-prompt 6+. |
| **N3** | Should Rust emit `copilot-suggestion-pending` immediately on ⌘⌥G press OR moment fire (before LLM call begins)? | **Yes** — eliminates 200-800ms dead air on hotkey path | No, just rely on `copilot-suggestion-streaming` first delta | Adds 1 new event for clean UX. Without it hotkey UX has noticeable lag. **This is the only decision that touches Rust** — minor lib.rs additive. |
| **N4** | Show user-facing confidence indicator on suggestion card | **No** — internal use only | Yes (subtle bar / percentage) | Showing confidence invites users to mistrust the system ("oh this is only 0.65"). Hidden = "the AI either suggests or it doesn't." |
| **N5** | `copilot-suggestion-dismissed` action payload: keep as string `"copilot-suggestion-dismissed"` (V1) vs upgrade to object `{action, dismissed_via}` (richer telemetry now) | **Keep string in V1** — Sub-prompt 6 adds payload when it ships telemetry UI | Upgrade now | Both work; richer-now means a tiny lib.rs change. Defer to keep Sub-prompt 4 frontend-only. |
| **N6** | Idle state: hint (B) vs rolling summary excerpt (D) | **Hint** — respects Decision N10 from Sub-prompt 3 plan | Summary excerpt | N10 locked summary as hidden in V1. Surfacing it here contradicts. |
| **N7** | Sound effect on suggestion fire (subtle "ding") | **No** — silent overlay | Yes, optional in settings | Audio in pro calls = annoying. If demanded by users, add as opt-in in Sub-prompt 6. |
| **N8** | Dismissed-suggestion history view (scroll-back through past suggestions) | **No** — V1 | Yes — small history button | Adds surface; users can ask the system to regenerate via ⌘⌥G. |

8 open decisions. Estimated PO review: 20–30 min. Only **N3** has implementation knock-on (minor Rust additive); the rest are pure frontend.

---

## 15 — Files to create / modify

### NEW

- `overlay/src/components/SuggestionCard.tsx` — the centerpiece component (badge + primary + secondary + footer)
- `overlay/src/components/TranscriptZone.tsx` — renders the last-2-utterances list
- `overlay/src/components/TopBar.tsx` — status pill + Settings ⚙ button
- `overlay/src/components/FooterHint.tsx` — the keyboard hint that auto-fades
- `overlay/src/components/ReasoningIndicator.tsx` — the three-dot pulser
- `overlay/src/lib/triggerLabels.ts` — trigger → user-facing label map
- `overlay/src/lib/copyToClipboard.ts` — wrapper around `navigator.clipboard.writeText` with flash callback
- `overlay/src/state/overlayReducer.ts` — useReducer state machine (Idle/Reasoning/Streaming/Showing/Failed) + action types
- `overlay/src/state/types.ts` — TS types for events + reducer state (mirrors Rust event payloads)
- `overlay/src/dev/mockEvents.ts` — dev-only fake event generator + Ctrl+Shift+M hotkey
- `overlay/src/dev/fixtures.ts` — synthetic transcripts + trigger / suggestion examples for mock mode

### MODIFIED

- `overlay/src/CopilotOverlay.tsx` — wire up the new components alongside the existing Phase 6 modal logic. The Phase 6 modal block stays untouched; new code is conditional rendering when `permissionNeeded === null`. The 6 listener stubs from Sub-prompt 3 are upgraded from `console.log` to dispatching actions into the reducer.

### POSSIBLY MODIFIED (only if PO accepts decision N3)

- `src-tauri/src/lib.rs` — add `copilot-suggestion-pending` Tauri emit on ⌘⌥G handler entry + at moment_worker fire-time (before suggest_client spawn). One-liner additive in two places. **THIS IS THE ONLY POTENTIAL RUST CHANGE.**

### NOT MODIFIED (sacred)

- All `src-tauri/**/*.rs` (modulo decision N3)
- `src-tauri/Cargo.toml`, `tauri.conf.json`, `capabilities/`, `entitlements.plist`, `Info.plist`
- `overlay/tailwind.config.ts` (extends only — no changes for V1)
- `WOLFEE-MVP/**` (no backend changes)
- The Phase 6 permission modal logic in `CopilotOverlay.tsx` (existing JSX block preserved verbatim)

---

## 16 — Acceptance tests

### Build
- [ ] `pnpm --dir overlay build` clean (no TS errors, vite build succeeds)
- [ ] `pnpm tauri build --bundles app` produces a notarizable .app
- [ ] `cargo check` clean (regression — Sub-prompt 4 shouldn't break Rust build)

### Visual + behavior (production .app)
- [ ] **Transcript**: open Copilot session → speak → user/speakers utterances appear in transcript zone within 1s; partials show italic+60% opacity, replaced by solid finals
- [ ] **Idle hint**: when no suggestion is active, suggestion zone shows `Listening… ⌘⌥G to ask` centered + dimmed
- [ ] **Reasoning state**: trigger an objection ("It's expensive") → within ~10s a card with badge + Reasoning ●●● appears
- [ ] **Streaming**: text fills the primary slot as deltas arrive (no jank)
- [ ] **Final card**: card settles with badge + primary + optional secondary + footer hint
- [ ] **Esc dismiss**: Esc → card disappears with fade animation (150ms)
- [ ] **Click-to-copy**: click on primary → clipboard contains the primary text + footer flashes "Copied ✓"
- [ ] **TTL fade**: leave card alone → at T+25s it starts fading; at T+30s it auto-dismisses
- [ ] **Hotkey suggestion**: press ⌘⌥G during Listening → card appears with `✦ GENERAL · manual` badge + streaming text
- [ ] **Failed toast**: simulate backend failure → brief "Couldn't generate suggestion" toast for 1.2s, then back to Idle

### Phase 6 regression
- [ ] Revoke mic permission → permission modal appears (Phase 6 logic intact)
- [ ] Re-grant + Try again → session resumes; new suggestion UI also works

### Sub-prompts 1, 2, 3 regression
- [ ] ⌘⌥W still toggles overlay
- [ ] ⌘⌥G still triggers suggestion
- [ ] Recorder still uploads (separate code path)
- [ ] Layer A/B/C audio diagnostics still log

### Dev mode
- [ ] `pnpm dev` then Ctrl+Shift+M → fake events fire and render correctly without backend running

### Settings hook
- [ ] Click ⚙ → console log fires; no other behavior

**Total: 18 acceptance tests.**

---

## End of plan

**Plan path:** `/Users/raunekpratap/Desktop/wolfee-desktop/wolfee-copilot-subprompt-4-plan.md` (NOT committed).

**Top blocking decisions for PO** (must resolve before execution prompt is written):

- **N1** (layout — two-zone vs three-zone)
- **N2** (per-trigger color coding — yes/no)
- **N3** (Rust `copilot-suggestion-pending` event — yes/no; only decision touching Rust)
- **N4** (show user-facing confidence — yes/no)
- **N5** (dismissed-via payload upgrade now vs Sub-prompt 6)

The other 3 (N6–N8) are pure frontend tweaks that can resolve mid-execution without rework.

**Effort confidence:** 50 hr ± 20%. Likely range **38–70 hr**, driven by:
- Whether the visual design needs more than one iteration cycle (most likely cause of overrun)
- Whether N1 layout swaps mid-execution
- Whether color coding (N2) gets re-opened post-build

**Recommended next step:** PO 20–30 min review of §14, lock the 5 blocking decisions; once locked, the execution prompt for Sub-prompt 4 can be written directly from this plan. Frontend-only sub-prompt — no backend coordination needed.
