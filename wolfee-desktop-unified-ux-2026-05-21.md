# Wolfee Desktop — Unified Tray Experience: UX/UI Design

**Date:** 2026-05-21
**Type:** Investigation + design. **No code.** Deliverable for focused build prompts.
**Core idea:** Clicking the menu-bar icon opens **one** floating panel that answers *"what do you want to do right now?"* — with **Record** and **Copilot** as peer tabs. The Copilot overlay, already invisible to screen capture, doubles as an **AI teleprompter** during recordings. That teleprompter is Wolfee's wedge over Loom.

---

## Part A — Current UX surfaces (audit)

The app is a tray-only macOS app (`ActivationPolicy::Accessory` — no dock icon). Today there are **five** user-facing surfaces, loosely connected:

### A1. Tray menu — `tray.rs`
Native macOS `Menu`, rebuilt on every state change. Left-click shows it. Contents, top to bottom:
- **Copilot section:** status label (`🟢 Idle` / `🟡 Active` / `🟢 Listening` / `⚠️ Reconnecting…` / `🔄 Starting…`/`Ending…`), "Open Copilot Overlay ⌘⌥W", Start/End Copilot Session, "Generate Suggestion ⌘⌥G", "Set Up Copilot…", "Show Onboarding Tour", "Manage Modes…".
- **Loom recorder section:** "🎬 Record Screen" (now opens the recorder panel) / "⏹ Stop Recording" / "● Finishing…" / "⬆ Uploading…", and result rows "✅ Recording uploaded — open & copy link" / "❌ …" + Dismiss.
- **Linking / upload status rows:** "🔄 Linking…", "✅ Linked!", "⚠️ Recording saved — link to upload", etc.
- **Nav:** "Link with Wolfee…", "Open Wolfee", "Quit Wolfee".
- **Tray icon itself** carries live state via title text: `● REC`, `⬆ 45%`, `UP`.

→ **Problem:** ~15 flat items, two features interleaved with status rows. No sense of "one product."

### A2. Copilot overlay — `copilot/window.rs`, `CopilotOverlay.tsx`
Window `copilot-overlay`. Transparent, frameless, **content-protected** (`set_content_protected(true)` → invisible to screen capture/share), always-on-top **above fullscreen apps** (`NSScreenSaverWindowLevel` 1000 + `FullScreenAuxiliary`), `visible_on_all_workspaces`. Top-center. Two sizes: **strip** 600×44 (always-visible control bar) and **expanded** 600×520 (Chat/Transcript panel). Toggled by **⌘⌥W**. Components: `Strip`, `ExpandedPanel`, `TranscriptView`, `ChatThread`, `SuggestionCard`, `SessionCompleteCard`, `WelcomeCard`. Does **not** hide on focus loss (deliberate — a 2026-05-04 fix).

### A3. Recorder pre-record panel — `recorder/panel_window.rs`, `RecorderPanel.tsx` (iteration 1, shipped 0.8.1)
Window `recorder-panel`. Frameless, transparent, content-protected, centered, 360×600. Loom-style: 3 mode tabs (screen/webcam/screenshot), Full-screen selector, camera + mic pickers with On/Off badges, live `getUserMedia` preview, orange Start, Effects/Notes/More footer. Opened by tray "Record Screen"; emits `loom-record-screen` / `cancel-recorder-panel`.

### A4. Context window — `copilot/context_window.rs`
Window `copilot-context`. 600×500, **system chrome** (decorated), content-protected. Opens before each Copilot session for the rep to paste 3 fields (about self/company, about the call, expected objections). Destroyed on submit/cancel.

### A5. Onboarding wizard — `overlay/src/components/onboarding/*`
Rendered **inside the overlay window** (the overlay listens for `copilot-show-onboarding`). Multi-step: pairing (`Step3Pairing`), permissions (`Step4Permissions`). Re-openable from the tray.

### Hotkeys — `copilot/hotkey.rs`
⌘⌥W toggle overlay · ⌘⌥G generate suggestion · ⌘\ hide · ⌘Enter focus input · Ctrl+arrows nudge overlay · ⌘⇧N new thread.

### Journey map (today)
```
click tray icon ─ native menu ─┬─ Copilot: Start Session → context window → overlay (strip/expanded) → End
                               ├─ Record Screen → recorder panel → Start → (notification countdown) → record → tray Stop → upload
                               └─ status rows / Link / Quit
```
Two journeys, one flat menu, no shared shell.

---

## Part B — Loom's model (from the screenshots)

- **Click menu-bar icon → a compact floating panel** (not a native menu). White, rounded, shadowed, always-on-top.
- **One row of mode tabs** at the top: screen recording · webcam · screenshot. Active tab = filled.
- **Body changes per tab.** Screen mode: a "Full screen" selector (dropdown: Full screen / Specific window / Custom size / Camera only), a camera row + green On badge, a mic row + green On badge (dropdown carries Noise filter + "Record computer sounds").
- **Big orange "Start recording".**
- **Bottom bar:** Effects · Notes · More. "More" = app-level menu (Settings, About, Help, Updates, Quit, …).
- **During recording** the panel closes → minimal control bar + floating webcam bubble.
- Row being configured highlights blue; device state shown as a green "On" pill.

Takeaway: **one panel, one tab row, body swaps, one primary button, app-level stuff demoted to "More."** Clarity over density.

---

## Part C — The unified Wolfee panel

### C1. Tray interaction
**Left-click the icon → toggle the unified panel** (not a native menu). Tauri 2 supports this: `TrayIconBuilder::show_menu_on_left_click(false)` + handle `TrayIconEvent::Click { button: Left, rect, .. }` in `on_tray_icon_event`. Use the event's `rect` to **anchor the panel just below the icon**, top-right (Loom does exactly this). Click again / click-away / `Esc` → hide.

Keep a **minimal right-click native menu** as a safety net: just "Open Wolfee", "Quit". Everything else lives in the panel. The tray icon still shows live glyphs (`● REC`, `⬆ 45%`).

> Dismiss behavior: **toggle on icon-click + Esc + X button.** Do *not* hide on focus loss — the Copilot overlay learned that lesson, and a camera-permission dialog stealing focus would flicker the panel away mid-setup.

### C2. Panel shell
Reuse the iteration-1 recorder panel window (`recorder-panel`) as the **shell**, renamed conceptually to the *Wolfee panel*. Frameless, transparent, content-protected, always-on-top. ~340 wide; height varies by tab.

```
┌───────────────────────────────┐
│  ● Record   ◌ Copilot   ⊕   ✕ │  ← top tab row (⊕ = Screenshot, disabled)
├───────────────────────────────┤
│                               │
│      « body — per tab »       │
│                               │
├───────────────────────────────┤
│   Notes      Settings    More │  ← shared bottom bar
└───────────────────────────────┘
```

Two real tabs — **Record** and **Copilot** — plus a disabled **Screenshot**. This is the one structural change from iteration 1: iteration 1's screen/webcam/screenshot tabs collapse — screen-vs-webcam becomes the Record tab's "Full screen / Camera only" dropdown (iteration 1 already has "Camera only" in that dropdown), so there is still only **one** tab row.

### C3. Record tab
Iteration-1 content, plus the teleprompter:
- **Capture selector** — "Full screen ▾" (dropdown: Full screen ✓ · Specific window · Custom size · Camera only). Phase: Full screen functional, rest staged.
- **Camera row** — On/Off badge, device dropdown, live preview circle when on.
- **Mic row** — On/Off badge, device dropdown + "Noise filter" + "Record computer sounds".
- **Teleprompter row** — a toggle. Off by default. When **On**, a notes area expands inline (textarea: type / "Paste from clipboard" / — later — "Generate with AI"). See Part D.
- **Start recording** — orange, full width.
- If a Copilot session is live: Start is disabled with an inline note "End your Copilot session to record" (Part F).

### C4. Copilot tab
Surfaces what's scattered in today's tray Copilot section:
- **Status card** — Idle / Starting… / Listening (with elapsed) / Reconnecting… / Ending…, mirroring `CopilotState`.
- **Primary button** — "Start Copilot Session" ↔ "End Copilot Session" (disabled during transient states, same rule as the tray today).
- **Open overlay** toggle (⌘⌥W) and **Generate Suggestion** (⌘⌥G) — shown only mid-session.
- Secondary links — "Set up Copilot", "Manage Modes", "Onboarding tour".
- If a recording is active: Start Session disabled with "Stop your recording first."

### C5. Bottom bar (shared)
- **Notes** — opens the notes area (the same store the teleprompter reads). MVP: one scratch note. Later: saved notes.
- **Settings** — permissions status, device defaults, hotkeys. (Stub initially — links to onboarding's permission step, which already exists.)
- **More** — About, Help, Check for Updates, Quit. Absorbs the tray's app-level items.

Status rows (linking/upload) move **into** the relevant tab (upload progress in the Record tab; link state in a small panel-header chip), not a flat menu list.

---

## Part D — The teleprompter (the differentiator)

**The one-line pitch:** the Copilot overlay is *already* invisible to screen capture (`set_content_protected(true)`). Point it at the user's script during a recording and you have an **AI teleprompter nobody in the video can see.** Loom has nothing like it.

### D1. Getting talking points in
In the Record tab, **Teleprompter** toggle → inline notes area:
- **Type or paste** directly (MVP).
- **"Paste from clipboard"** button (one tap — common case: script written elsewhere).
- **"Generate with AI"** (later) — a one-line prompt ("3-min demo of feature X") → backend LLM → draft script. Reuses the Copilot intelligence backend; not MVP.

The notes area is the same content the bottom-bar **Notes** opens — one store. Keep it dead simple: a single plain-text scratchpad in MVP, no document manager.

### D2. Displaying during the recording
The teleprompter is a **third content mode of the existing `copilot-overlay` window** — not a new window. The window is already content-protected, always-on-top above fullscreen, on all spaces. Reuse it wholesale.

- **Layout:** the expanded-width window (~600 wide) as a short band (~600×220). Large type (~20 px), high contrast, on the existing dark glassmorphic background. The current `TranscriptView` is a near-perfect base — a styled scroller.
- **Position:** top-center (the overlay's existing home) — reads naturally, near the top of the framed content.
- **Scroll:** MVP = manual (scroll wheel, or a dedicated ⌘⌥↑ / ⌘⌥↓ that scrolls *text* — distinct from Ctrl+arrows which *move the window*). The current line is bold/highlighted; the user advances it.
- **Auto-scroll (post-MVP):** the mic audio also streams to Deepgram; fuzzy-match the live transcript against the script and advance the highlight automatically. This is the "AI" in "AI teleprompter" — but it is **not MVP**. MVP ships static notes + manual scroll and is already a real differentiator.

### D3. Relationship to Copilot
**Same window, mutually exclusive modes.** The `copilot-overlay` window renders:
- **Copilot mode** — transcript + suggestions (live meeting), or
- **Teleprompter mode** — the script (during a recording).

It never shows both. A recording-with-teleprompter and a Copilot session cannot run at once (Part F) — which also sidesteps two subsystems contending for mic/system audio. One overlay, one job at a time.

---

## Part E — Recording control bar, countdown, webcam bubble

Three small windows, each **content-protected so they're excluded from the capture** — no capture-pipeline change needed (the `set_content_protected` trick is already proven by the Copilot overlay).

- **Countdown** — 3·2·1, large, centered, brief translucent overlay. Can be a transient window or the control-bar window pre-bar.
- **Control bar** — bottom-center, draggable, minimal: ⏺ pulsing dot · `MM:SS` timer · Pause · **Stop** · Discard (trash → stop + delete, no upload). Stop → existing finalize + upload flow. Replaces the current tray "Stop Recording".
- **Webcam bubble** — circular `getUserMedia` feed, draggable (fixed-corner OK for MVP), shown only when the camera is on. (Webcam *recording* is still Phase 2; the bubble is a live preview for now.)
- **Teleprompter scroll mid-recording** — scroll wheel over the overlay, or ⌘⌥↑/↓.

---

## Part F — States & transitions

```
                 ┌──────── IDLE ────────┐
        click icon│                      │click icon
                 ▼                      ▼
        ┌──── PANEL OPEN ────┐   (panel closes on click-away/Esc)
        │  tab = Record      │   tab = Copilot
        ▼                    ▼
  RECORD path             COPILOT path
  ─────────────           ─────────────
  Start ▶                 Start Session ▶
   COUNTDOWN (3·2·1)       → context window
   RECORDING ──────────┐   STARTING → LISTENING ⇄ RECONNECTING
    + control bar      │   End ▶ ENDING → session card → IDLE
    + webcam bubble?   │
    + teleprompter? ───┘   (overlay = Copilot mode)
   Stop ▶ STOPPING
   UPLOADING (⬆ NN%)
   COMPLETE (link copied) ──auto 12s──▶ IDLE
   FAILED (sticky) ──Dismiss──▶ IDLE
```

Backed by existing enums: **`LoomState`** (Idle/Countdown/Recording/Stopping/Uploading/Complete/Failed) and **`CopilotState`** (Idle/ShowingOverlay/StartingSession/Listening/Reconnecting/EndingSession). No new state machine — the panel just *renders* them.

**Mutual exclusion (Step 6 edge case).** Record and Copilot are mutually exclusive top-level activities:
- Copilot session live → Record tab's **Start is disabled**: "End your Copilot session to record."
- Recording live → Copilot tab's **Start Session is disabled**: "Stop your recording first."
- Rationale: one overlay window can't be both teleprompter and Copilot, and two capture subsystems shouldn't both grab mic/system audio. Simpler, clearer, and matches how a user actually works (you're either recording *or* in a meeting).

**Teleprompter is a sub-state of RECORDING**, not its own machine: `RECORDING { teleprompter: on|off }`. When on, the overlay opens in teleprompter mode alongside the control bar; both tear down on Stop.

---

## Part G — Exists vs. new

| Piece | Status |
|---|---|
| `recorder-panel` window (frameless/transparent/content-protected) | ✅ exists (iteration 1) — **becomes the unified panel shell** |
| Record-tab content (selectors, pickers, preview, Start) | ✅ exists — drop the webcam *tab*, keep "Camera only" in the dropdown |
| `copilot-overlay` window (content-protected, above fullscreen) | ✅ exists — **reused as the teleprompter** |
| `TranscriptView` scroller | ✅ exists — base for the teleprompter text view |
| `LoomState` / `CopilotState` / status enums | ✅ exist — panel renders them |
| `set_content_protected` capture-exclusion | ✅ proven — control bar / bubble / countdown rely on it |
| Hash-routed multi-window (`#/recorder`, `#/context`) | ✅ pattern exists — add `#/teleprompter` etc. |
| Tray icon-click → panel (`show_menu_on_left_click(false)` + anchored positioning) | 🔨 new — tray rework |
| Copilot tab UI | 🔨 new component |
| Teleprompter content mode (overlay) + notes entry | 🔨 new |
| Countdown overlay · control bar · webcam bubble windows | 🔨 new (3 small windows) |
| Wire panel device selections → `screen_capture.rs` | 🔨 new (small capture change — chosen display / mic / system-audio flag) |

Nothing is rebuilt from scratch — the two hard parts (a content-protected always-on-top webview, and a frameless panel) already exist and are proven.

---

## Part H — Prioritized build plan

**Iteration 1 — Pre-record panel** ✅ *shipped (0.8.1)*.

**Iteration 2 — Unified panel + tray rework** *(the headline of this doc)*
Tray icon-click opens the panel (anchored under the icon); minimal right-click menu. Add the Record/Copilot tab row; fold iteration-1 content into the Record tab; build the Copilot tab from the existing tray Copilot actions; bottom bar (Notes/Settings/More). Move status into the panel. — *Delivers the "one cohesive product" feel.*

**Iteration 3 — Complete the recording flow**
Countdown overlay, control bar (timer/pause/stop/discard), webcam bubble. Wire the panel's device selections into `screen_capture.rs` (chosen display, chosen mic, system-audio toggle). — *Makes recording fully usable from the panel without the tray.*

**Iteration 4 — Teleprompter (MVP)**
Teleprompter toggle + notes entry in the Record tab; teleprompter content mode in the `copilot-overlay`; show it during recording; manual scroll. — *Ships the differentiator.*

**Iteration 5 — Later**
Auto-scroll teleprompter (Deepgram match), AI-generated talking points, Specific-window capture, webcam *recording* (Phase 2 capture), Screenshot mode, Effects, saved Notes.

> Strategic note: Iteration 4 is the moat. If the founder wants to lead with it, the teleprompter can move ahead of Iteration 3's bubble/window-picker — it only hard-depends on Iteration 2 (the panel) and the already-built content-protected overlay. The control bar's **Stop**, however, is a true blocker for a usable recording, so Iteration 3's control bar should not slip past Iteration 4.

---

## Risks & open questions

- **Tray-anchored positioning** across multi-monitor / menu-bar-on-notch Macs — use the click event's `rect`; clamp to the screen with the menu bar.
- **Panel dismiss vs. permission dialogs** — toggle/Esc/X only, never blur-hide (camera-permission dialog would otherwise kill the panel mid-setup).
- **Teleprompter readability while it overlays the recorded content** — it's invisible to viewers but the *user* sees it over their own screen; keep the band short, top-center, movable.
- **Two webviews of the same Vite bundle** (panel + overlay) both calling `getUserMedia` for camera preview — only one should hold the camera at a time; the panel must release its preview stream before the bubble window opens.
- **Mutual exclusion** is a deliberate simplification — if "record a meeting while Copilot coaches" ever becomes a real ask, it needs a second SCStream and a non-shared teleprompter/Copilot surface. Out of scope now.
- Keep it **as plain as Loom** — two tabs, one button per tab, app-stuff under "More." Resist adding a third and fourth tab.
