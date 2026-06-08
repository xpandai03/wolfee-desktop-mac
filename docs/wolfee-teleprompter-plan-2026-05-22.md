# Wolfee Teleprompter — Implementation Plan

**Date:** 2026-05-22
**Status:** investigation + plan only, no code yet
**Predecessor:** `wolfee-desktop-unified-ux-2026-05-21.md` (Part D + Iteration 4)
**Builds on:** 0.8.12 (Copilot recording) + the unified panel from iteration 2

---

## TL;DR

The Copilot overlay window is **already** invisible to screen capture
(`set_content_protected(true)`), already always-on-top above
fullscreen apps, already on every Space, already drawn at
NSScreenSaverWindowLevel above macOS Spaces. **The teleprompter is
not a new window — it's a new content mode of that one overlay**,
loaded with the user's script during a recording.

Mutual exclusion (Copilot session XOR recording) is already enforced
in the panel and the state machines, so the overlay is guaranteed to
be free of Copilot UI during a recording. The teleprompter just
takes over the same DOM.

MVP scope (Phase 1) is a hand-typed/pasted script + manual scroll
(wheel + `⌘⌥↑/↓`). That alone is the differentiator over Loom — a
script you can read mid-recording that no viewer can ever see.

---

## 1. Investigation findings

### 1.1 The overlay window (`src-tauri/src/copilot/window.rs`)

| Property | Value | Source |
|---|---|---|
| Tauri label | `copilot-overlay` | `OVERLAY_LABEL` |
| URL | `index.html` (default hash route → `CopilotOverlay`) | `WebviewUrl::App("index.html".into())` |
| Decorations | none, transparent, `macos-private-api` glass | `decorations(false).transparent(true)` |
| Always on top | yes, elevated to `NSScreenSaverWindowLevel` (1000) | `elevate_window_level()` |
| Spaces | visible on all + fullscreen-auxiliary | `visible_on_all_workspaces(true)` + bitmask in `setCollectionBehavior` |
| Taskbar | hidden | `skip_taskbar(true)` |
| Focus | non-focusing | `focused(false)` |
| Shadow | off | `shadow(false)` |
| **Content protection** | **on** | `set_content_protected(true)` ← this is the whole point |
| Strip size | `600 × 44` | `STRIP_WIDTH/STRIP_HEIGHT` |
| Expanded size | `600 × 520` | `EXPANDED_WIDTH/EXPANDED_HEIGHT` |
| Position | top-center, `TOP_MARGIN = 24` from menu bar | `position_top_center()` |

It exists from app boot; never re-created during a session. Strip and
expanded sizes are switched via `set_size` so the position is stable.

**Reuse, don't fork.** Building a second window for the teleprompter
would either duplicate every content-protection / window-level /
Space-membership tweak above, or risk drifting from it.

### 1.2 Content modes in `overlay/src/CopilotOverlay.tsx`

The overlay is a single React component that renders one of several
mutually-exclusive bodies based on state. Render precedence today
(lines 764–784):

```
permissionNeeded != null
  ? <PermissionModal />
  : showSessionComplete         // overlayState.lastFinalizedSession != null
  ? <SessionCompleteCard />
  : showOnboarding              // overlayState.onboardingOpen
  ? <OnboardingWizard />
  : (default — the live Copilot strip + expanded panel)
```

The default branch renders `<Strip />` always and `<ExpandedPanel />`
only when `overlayState.mode === "expanded"` (it's driven by
`expand-overlay` / `collapse-overlay` actions from Rust).

The teleprompter slots in as a **fourth body**, with higher precedence
than the live Copilot UI (because if a teleprompter is active, the
Copilot session can't be) and lower than the Permission / SessionComplete
modals (still safety-critical surfaces):

```
permissionNeeded
  ? <PermissionModal />
  : showSessionComplete
  ? <SessionCompleteCard />
  : showTeleprompter             // ← new
  ? <TeleprompterView />
  : showOnboarding
  ? <OnboardingWizard />
  : ( … Copilot strip + expanded … )
```

`showTeleprompter` is a new boolean driven by `overlayState.teleprompter`
(an object — script text + scroll position + line count — see §2).

### 1.3 Mutual exclusion (Copilot ⊥ Recording)

Already enforced in two places:

- **Panel:** `RecorderPanel.tsx` — CopilotTab's Start button is
  disabled while `loomBusy` (`LoomState in {countdown, recording,
  stopping, uploading}`); the RecordTab's Start button is disabled
  while Copilot is in any active state (Copilot tab shows "Stop your
  recording first" when applicable).
- **Rust:** `start-copilot-session` arm rejects if `loom_state` is
  busy; `loom-record-screen` arm rejects if Copilot state is anything
  but `Idle`/`ShowingOverlay`.

Therefore: **whenever recording is active, the Copilot session machine
is `Idle`** — the overlay is free of `TranscriptView`, `ChatThread`,
auto-suggestions, etc. It may still be in `ShowingOverlay` (the user
peeking at it), but that has no live content. **The teleprompter
takes over with no conflict.**

### 1.4 Hash routes (`overlay/src/main.tsx`)

```
default       → <CopilotOverlay />   (← reused for teleprompter)
#/context     → <ContextWindow />
#/recorder    → <RecorderPanel />
#/webcam-bubble → <WebcamBubble />
#/countdown   → <Countdown />
#/control-bar → <ControlBar />
```

**No new hash route is needed.** The overlay's existing default route
hosts the teleprompter — the React tree just renders a different body
based on state.

### 1.5 Hotkeys already registered (`src-tauri/src/copilot/hotkey.rs`)

| Shortcut | Action | Status |
|---|---|---|
| `⌘⌥W` | toggle overlay | taken |
| `⌘+\` | toggle overlay (alias) | taken |
| `⌘⌥G` | generate Copilot suggestion | taken |
| `⌘+Enter` | focus Copilot chat input | taken |
| `⌘+⇧+N` | new chat thread | taken |
| `⌃↑` / `⌃↓` / `⌃←` / `⌃→` | nudge overlay window 20 px | taken |
| **`⌘⌥↑`** | (free) | → **teleprompter: scroll up** |
| **`⌘⌥↓`** | (free) | → **teleprompter: scroll down** |
| **`⌘⌥←`** | (free, optional) | → previous line / paragraph |
| **`⌘⌥→`** | (free, optional) | → next line / paragraph |

`⌘⌥` is the established Wolfee modifier (used for `⌘⌥W`, `⌘⌥G`); the
`↑/↓` arrows are free (window nudge uses `⌃` not `⌘⌥`). **No conflicts.**

---

## 2. `TeleprompterView` component

### 2.1 Visual

Plain DOM, no virtualization — even a 2000-word script is ~12 KB and
~150 paragraphs; React renders it once. Layout:

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   Talk about the new screen recording feature.               │  ← dim
│                                                              │
│   Mention that it includes AI transcription                  │  ← dim
│                                                              │
│ ▸ and shareable links with automatic summaries. ◂            │  ← bright, bold
│                                                              │
│   Compare the cost to Loom — $19 vs $15/mo but               │  ← dim
│   you also get the meeting recorder and simulator.           │  ← dim
│                                                              │
│                                              Line 3 of 8     │  ← faint footer
└──────────────────────────────────────────────────────────────┘
```

Tokens:

- Font: same Inter/system stack as the rest of the overlay.
- Size: `28 px` (was tempted by 32 — 28 reads comfortably from 2-3 ft
  on a 14" MBP without making 200-word scripts overflow). Line-height
  `1.4`.
- Active paragraph: full weight (`font-semibold`), `text-zinc-50`,
  optional `▸ … ◂` left/right markers.
- Inactive paragraphs: `text-zinc-500/70`, normal weight.
- Background: same translucent dark glass the strip uses
  (`bg-zinc-950/80 backdrop-blur`), so it blends with the overlay's
  existing chrome.
- Footer: `Line N of M`, `text-[11px] text-zinc-600`, right-aligned.
- Splitting: paragraphs by double-newline, lines by single-newline.
  Active "line" in MVP = paragraph; line-level highlight is Phase 2.

### 2.2 Overlay sizing + positioning for teleprompter

**Strip (600 × 44):** too small — at 28 px font you fit one half-line.

**Expanded (600 × 520):** big — but matches the existing footprint,
no `set_size` round-trip. **Use this.** Three paragraphs of script
fit comfortably with the dim ones partially visible.

**A new 600 × 200 "band" size** was considered — short like a TV
teleprompter — but introduces a third size to the overlay state
machine + a new `set_size` request. Rejected for MVP. Phase 2 can
add a `band` mode if user testing shows the full panel is overkill.

**Position:** top-center stays. The overlay already lives there, the
user's eye-line is already there during a screen recording (it's
where the menu bar is — the most natural place to glance). Bottom
position would look more like a TV teleprompter but force the user
to break eye contact with their own webcam preview.

**Resizable:** no for MVP. Fixed 600 × 520, top-center, same as the
expanded Copilot panel. Add `band` size in Phase 2 if the full panel
feels too tall.

### 2.3 Scroll mechanics

- **Scroll wheel** over the overlay → advances the active paragraph
  by ±1. Implemented via React `onWheel` with a small threshold
  (`Math.abs(deltaY) > 30`) so it isn't twitchy.
- **`⌘⌥↓` / `⌘⌥↑`** (global hotkey from `hotkey.rs`) → next /
  previous paragraph. Fires a new `copilot-teleprompter-scroll` Tauri
  event with `{ delta: +1 | -1 }`. Overlay listens and dispatches a
  reducer action.
- **`⌘⌥→` / `⌘⌥←`** (optional in MVP) → jump 5 paragraphs forward /
  back. Page-Down-style. Easy to add now; if it feels gratuitous in
  practice, drop one.
- **Smooth vs line-by-line:** **line-by-line** in MVP. A TV
  teleprompter scrolls smoothly, but smooth scrolling requires either
  reading speed estimation (auto-scroll) or a steady-state UI that
  doesn't quite match what we're shipping — the user is in control,
  one paragraph at a time. Phase 2 can add smooth interpolation when
  AI auto-scroll lands.

#### Phase 3 sketch (not building now)

> **AI auto-scroll:** Deepgram already streams mic audio for the
> Copilot. During a recording with the teleprompter on, route the
> same mic stream (single SCK SCStream + cpal mic still going for
> recording) to a parallel Deepgram WS at minimal cost. Fuzzy-match
> the live transcript against `script.split("\n\n")` using
> [`fast-levenshtein`](https://www.npmjs.com/package/fast-levenshtein)
> or a 2-3 word window match; when N consecutive words match the
> next paragraph, advance. Tunable threshold + 1-paragraph lookahead.
> Add a "Manual / Auto" pill in the overlay's footer.

---

## 3. Panel integration — Record tab

### 3.1 Toggle + textarea

Placement: between the device-pickers block and the Start button.
Follows the existing visual rhythm — DeviceRows above, primary CTA
below.

```
┌──────────────────────────────────────┐
│  ● Connected to Wolfee               │  (existing indicator)
│  Screen ▢ Full screen               │  (existing DeviceRow)
│  Camera ▢ FaceTime HD               │
│  Microphone ▢ MacBook Pro Mic       │
│  ─────────────────────────────────  │
│  Teleprompter           [   On ⬤  ] │  ← new row
│  ┌──────────────────────────────┐   │
│  │ Type or paste your script…   │   │  ← visible only when On
│  │                              │   │     min-h-[88px], max-h-[260px]
│  │                              │   │     resize-y
│  └──────────────────────────────┘   │
│        Paste from clipboard ⌘V     │  ← quick-paste link
│  ─────────────────────────────────  │
│  ╭─────────────────────────╮         │
│  │   ◉  Start recording    │         │  (existing button)
│  ╰─────────────────────────╯         │
└──────────────────────────────────────┘
```

- Default: **off**. Persist the toggle across sessions via
  `tauri-plugin-store` (`flags.json`, same store the recorder uses).
- Textarea: `min-height: 88px`, `max-height: 260px`, `resize: vertical`.
  Caps the panel height around 540 px even with a long script, while
  letting the user grow it for a peek.
- "Paste from clipboard" is a `<button>` that `navigator.clipboard.readText()`s
  into the textarea (with a one-line "📋 Pasted" toast on success). MVP
  doesn't need permission plumbing — Tauri's webview already grants
  clipboard read.
- The textarea is **always visible when On** (no separate collapse
  control). Toggling Off hides it and clears the staged script (the
  text is only kept across recordings if you keep the toggle On).

### 3.2 Validation

- Empty / whitespace-only script: the toggle stays On but Start
  Recording renders a small "Add a script first" hint and disables
  itself. (Mirrors how Copilot's Start is disabled when not linked.)
- Excessively long script (> 10 000 chars / ~1500 words): allow but
  show a `~12 min read` estimate in the textarea footer so the user
  doesn't paste a novel by accident. Estimate: 130 wpm.

### 3.3 Persistence semantics

- Toggle (`recorder.teleprompter.enabled`): persisted.
- Script (`recorder.teleprompter.draft`): persisted while the toggle
  is On so an accidental panel close doesn't lose work. Cleared when
  the toggle goes Off, or after a successful Stop (the script was
  for that recording).

---

## 4. Script-passing mechanism (panel → overlay)

Looked at all three options the prompt listed; the right answer is
**Tauri event** with a small Rust pass-through, which matches every
other panel-↔-overlay flow in the codebase:

```
panel (RecorderPanel.tsx)
   └─ emit("wolfee-action", { type: "teleprompter-start",
                              script: "…", linePolicy: "paragraph" })

lib.rs handle.listen("wolfee-action") — structured-action dispatch
   └─ handle_structured_action("teleprompter-start", …)
       └─ stash script in AppState.teleprompter_script
       └─ handle.emit("copilot-teleprompter-open", { script, … })

overlay (CopilotOverlay.tsx)
   └─ listen("copilot-teleprompter-open") → dispatch SHOW_TELEPROMPTER
   overlayReducer → { teleprompter: { script, lineIdx: 0, … } }
   render precedence → <TeleprompterView />
```

Why event > command:
- Existing precedent: `copilot-session-finalized`, `copilot-chat-complete`,
  `copilot-request-end`, `request-wolfee-state` — **every** panel↔overlay
  message in the codebase is a `wolfee-action` outbound + a specific
  inbound event back.
- Stashing the script in Rust (`AppState.teleprompter_script`) means
  `loom-restart-recording` (already exists) can re-emit `copilot-teleprompter-open`
  to the overlay without the panel having to be open.
- A Tauri command would synchronously cross the IPC bridge twice
  (panel→Rust→overlay) — same hops, less idiomatic.

**Other events** in the flow:

- `copilot-teleprompter-close` (Rust → overlay) — fires on Stop /
  Discard / failure. Overlay dispatches `HIDE_TELEPROMPTER`.
- `copilot-teleprompter-scroll` (Rust → overlay) — fires from
  `⌘⌥↑/↓` global hotkey. Payload `{ delta: ±1 }` (or `±5` for
  `⌘⌥←/→`).

All names share the `copilot-teleprompter-*` prefix to match the
existing `copilot-session-*`, `copilot-chat-*`, `copilot-show-onboarding`
naming.

---

## 5. Lifecycle

Tied to the existing recording lifecycle (`LoomState`); a sub-state of
RECORDING per the UX doc.

| Trigger | Panel | Rust | Overlay |
|---|---|---|---|
| User clicks **Start recording** with teleprompter On | emits `teleprompter-start` + closes itself + emits `loom-record-screen` | Stashes script in state; sets `LoomState::Countdown` | Stays in current mode |
| Countdown overlay shows for 3 s | — | — | Unchanged |
| Capture starts (`LoomState::Recording`) | — | After `ScreenRecorder::start` Ok, emits `copilot-teleprompter-open` to overlay (next to opening the control bar) | Receives event → dispatches `SHOW_TELEPROMPTER` → `<TeleprompterView>` renders. Auto-resizes to expanded if not already. |
| User scrolls (wheel or `⌘⌥↓`) | — | Hotkey handler emits `copilot-teleprompter-scroll` | `onWheel` / event listener → reducer advances `lineIdx`. |
| User toggles overlay with `⌘⌥W` mid-recording | — | Hotkey handler hides / shows the overlay window itself | Teleprompter state is **preserved** — when the window reappears, it shows the same line. |
| User clicks **Stop** in the control bar | — | `loom-stop-recording` arm — emits `copilot-teleprompter-close` after `capture.stop()` (next to closing the control bar) | `HIDE_TELEPROMPTER` → fallback to default Copilot strip (which is the no-op Idle state). |
| User clicks **Discard** | — | `loom-discard-recording` — same `copilot-teleprompter-close` emit | Same as Stop. |
| Capture fails | — | `finish_loom_failure` — also emits `copilot-teleprompter-close` | Same. |
| Restart (`loom-restart-recording`) | — | Stop branch closes; new capture branch re-emits `copilot-teleprompter-open` with the stashed script (so the user keeps their script) | Re-mounts at `lineIdx: 0`. |

**One subtle question:** does the overlay need to be *forced* visible
when the teleprompter opens, the way `copilot-session-finalized`
auto-expands? Answer: yes — `copilot-teleprompter-open` should also
fire `expand-overlay` if the overlay is in strip mode (or hidden).
The user enabled the teleprompter intentionally; they shouldn't have
to also press `⌘⌥W`.

**Persistence during recording:** `⌘⌥W` hides the overlay window
itself but **must not reset the teleprompter state**. If the user
toggles the overlay back on, the teleprompter reappears on the
same line. Same mechanics as `lastFinalizedSession` — the state
survives window hide/show.

---

## 6. Component / file map

### New files

```
overlay/src/components/TeleprompterView.tsx     ← the body component
```

### Modified — Overlay (React)

```
overlay/src/CopilotOverlay.tsx
  + listen("copilot-teleprompter-open"  → dispatch SHOW_TELEPROMPTER)
  + listen("copilot-teleprompter-close" → dispatch HIDE_TELEPROMPTER)
  + listen("copilot-teleprompter-scroll" → dispatch SCROLL_TELEPROMPTER)
  + showTeleprompter precedence branch (between SessionComplete and Onboarding)
  + onWheel passthrough on the body when teleprompter active

overlay/src/state/types.ts
  + OverlayState.teleprompter: { script: string; lineIdx: number;
                                 totalLines: number } | null
  + Actions: SHOW_TELEPROMPTER, HIDE_TELEPROMPTER, SCROLL_TELEPROMPTER

overlay/src/state/overlayReducer.ts
  + cases for the three new actions
```

### Modified — Panel

```
overlay/src/pages/RecorderPanel.tsx
  + RecordTab: TeleprompterToggle row + textarea + "Paste from clipboard" button
  + persisted state via tauri-plugin-store (flags.json key
    `recorder.teleprompter.{enabled, draft}`)
  + on Start: emitAction({ type: "teleprompter-start", script: draft.trim() })
    *before* the existing emitAction("loom-record-screen")
  + Start button disabled if (enabled && !draft.trim()) with hint
```

### Modified — Rust

```
src-tauri/src/lib.rs
  - handle_structured_action: new case "teleprompter-start"
    → stashes script in AppState.teleprompter_script
    → handle.emit("copilot-teleprompter-open", { script })
  - loom-record-screen arm: after ScreenRecorder::start Ok, if script
    is Some, emit "copilot-teleprompter-open"
  - loom-stop-recording / loom-discard-recording / finish_loom_failure:
    emit "copilot-teleprompter-close"; clear AppState.teleprompter_script
  - loom-restart-recording: re-emit open with the stashed script

src-tauri/src/state.rs
  + AppState.teleprompter_script: Mutex<Option<String>>

src-tauri/src/copilot/hotkey.rs
  + register Shortcut(SUPER | ALT, ArrowDown) → emit copilot-teleprompter-scroll { delta:  1 }
  + register Shortcut(SUPER | ALT, ArrowUp)   → emit copilot-teleprompter-scroll { delta: -1 }
  + (optional) Shortcut(SUPER | ALT, ArrowRight) → delta:  5
  + (optional) Shortcut(SUPER | ALT, ArrowLeft)  → delta: -5
```

### Untouched (explicitly)

- `copilot/window.rs` — overlay window is reused, no constructor change.
- `copilot/audio/*` — teleprompter is text-only in MVP; no audio
  pipeline contact.
- `recorder/screen_capture.rs` — recording capture is unchanged.
- Web app (`wolfee-mvp`) — entirely desktop-side feature.

---

## 7. Phased build plan

### Phase 1 — MVP (shippable on its own)

Everything in §6 above. Result:

- Panel toggle + textarea + paste-from-clipboard.
- Script stashed in Rust state on Start, emitted to the overlay.
- `TeleprompterView` renders the script in 28 px, current paragraph
  bold, dim above/below, `Line N of M` footer.
- Manual scroll: wheel + `⌘⌥↑/↓`. Optional `⌘⌥←/→` for ±5.
- Tears down cleanly on Stop / Discard / Restart / failure.
- State survives `⌘⌥W` hide/show.
- Persisted toggle + draft across panel reopens.

### Phase 2 — polish

- Word-level highlight inside the active paragraph (advances on
  keystroke; useful only when paragraphs are long).
- Smooth scroll interpolation (CSS transform + RAF, 150 ms ease).
- Optional 600 × 200 "band" overlay size for users who want a
  smaller footprint.
- Position memory — if the user dragged the overlay sideways via
  `⌃→/←`, the teleprompter respects that position (already true,
  since we never move the window).
- Reading-speed estimate in the textarea footer (`~12 min read`).
- Settings: font size slider (24 / 28 / 32), light/dark contrast
  override.

### Phase 3 — AI

- **AI script generation:** `Generate with AI` button in the panel
  textarea. Calls `/api/copilot/intelligence/quick-action` (existing)
  with a prompt template; streams a draft into the textarea via SSE.
- **AI auto-scroll:** parallel Deepgram WS during recording. Fuzzy-
  match transcript → script. Advance the active paragraph on N
  consecutive matched words. Manual/Auto toggle in the overlay footer.
- Saved scripts library (web app + sync).

---

## 8. Risks + edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Very long script (> 1000 words) makes overlay laggy | low | Plain DOM; 1000 paragraphs render in <16 ms. Re-evaluate at 5000 words; add virtualization in Phase 2 only if it's a problem. |
| Multiple displays — teleprompter appears on the "wrong" one | medium | The overlay's `position_top_center` is computed at window create time. If the user has dragged the overlay via `⌃` arrows, the teleprompter respects that. If they have multiple displays, the overlay's "all spaces" + always-on-top means it's wherever it was last — fine. Add an explicit "Center on primary display" command in Phase 2 if reports come in. |
| User has overlay hidden (`⌘⌥W`) when recording starts | medium | `copilot-teleprompter-open` includes an implicit `expand-overlay` if the overlay is currently hidden (mirrors `copilot-session-finalized` behavior). |
| User uses `⌘⌥W` to close overlay mid-recording, then forgets | low | The overlay window itself disappears but the recording continues unaffected (teleprompter state is preserved). `⌘⌥W` toggles it back on with the script intact. |
| Script text leaks into the recording somehow | **critical** but already mitigated | `set_content_protected(true)` is set at window create time and verified by our own Copilot's `SCRecordingOutput`-based recorder for months. The teleprompter inherits this with zero new surface area. Add a startup integration test that records 1 s with the overlay visible and asserts the resulting MP4 doesn't contain the overlay region. |
| Overlay resizes affect text reflow | low | Fixed `600 × 520` for MVP; no user resize. Resize handle isn't visible. |
| Teleprompter state leaks across recordings | low | `loom-stop-recording` and friends clear `AppState.teleprompter_script`; reducer's `HIDE_TELEPROMPTER` sets `overlayState.teleprompter = null`. Draft in the *panel* persists; the runtime state on the overlay does not. |
| Conflicting `wolfee-action` if a Copilot session starts mid-record | not possible | Mutual exclusion already blocks it (§1.3). |
| User pastes 100 KB of text (e.g. an entire blog post) | low | Cap at 50 000 chars in the textarea; show "shorten your script" hint past that. |

---

## 9. Out of scope (explicit confirmations)

- ❌ New window for the teleprompter (reuse `copilot-overlay`).
- ❌ Backend / web app changes (purely desktop).
- ❌ AI auto-scroll (Phase 3).
- ❌ AI script generation (Phase 3).
- ❌ Saved scripts library / cloud sync (Phase 3).
- ❌ Per-user font-size preference (Phase 2 if asked).
- ❌ Recording-side changes (`SCRecordingOutput` pipeline untouched).
- ❌ Copilot session changes (`copilot/audio/*` untouched).

---

## 10. Acceptance checklist (for the build prompt)

- [ ] `TeleprompterView` component renders 28 px text, paragraph-level
      highlighting, `Line N of M` footer.
- [ ] Panel Record tab has a persisted Teleprompter toggle + textarea +
      paste-from-clipboard button.
- [ ] Toggle Off clears the staged script and hides the textarea.
- [ ] On Start with toggle On: `teleprompter-start` action fires, script
      lands in `AppState.teleprompter_script`, the overlay shows the
      teleprompter (with overlay auto-expanded to 600 × 520).
- [ ] Scroll wheel over the overlay advances the active paragraph.
- [ ] `⌘⌥↓` / `⌘⌥↑` advance / retreat by one paragraph.
- [ ] `⌘⌥W` hides / shows the overlay; the teleprompter resumes on the
      same line on re-show.
- [ ] Stop / Discard / Restart / failure all fire `copilot-teleprompter-close`
      and clear `AppState.teleprompter_script`.
- [ ] `set_content_protected(true)` is unchanged — record a 5 s test;
      the resulting MP4 does **not** show the script text.
- [ ] Mutual exclusion: Copilot Start is disabled while a
      teleprompter-recording is active; vice versa.
- [ ] Empty script + toggle On disables Start with a clear hint.
- [ ] Pre-existing hotkeys (`⌘⌥W`, `⌘⌥G`, `⌘+\`, `⌘+Enter`, `⌘+⇧+N`,
      `⌃arrows`) still work.

---

## 11. Estimated ship size

Single release, ~6 files touched + 1 new file. Comparable in scope to
the **Loom recorder Phase 4** iteration (control bar + countdown) —
no new windows, no new audio pipeline, no backend, no migrations. A
focused build prompt should land it in one cycle. Suggested release:
**0.8.13**.
