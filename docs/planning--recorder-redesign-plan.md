# Recorder Redesign — Implementation Plan

> Planning document. **No code changes** are made by this prompt — read-only investigation + this plan only.
> Three independently-shippable phases. Raunek green-lights each phase build separately.
> Versioned in git. Revisions go in dated sections at the bottom — do not overwrite history.

**Created:** 2026-05-30
**Author:** recorder investigation pass
**Scope:** macOS desktop binary only. Out of scope: meeting-bot (recall.ai), simulation recording, upload/storage pipeline, mobile/web, AI features.

---

## Current State Investigation

### Architectural correction up front
The C-L-E-A-R prompt's example paths (`desktop/Sources/Recorder/RecorderViewController.swift`, etc.) assume a **native Swift/AppKit** app. **Wolfee is not that.** It is a **Tauri 2 app**: a Rust backend (`src-tauri/`) hosting **React/TypeScript webviews** (`overlay/`) for all UI. There is no SwiftUI/ViewController layer. All file paths below are real and verified. Where the prompt's framing assumed Swift, I've mapped it to the Tauri equivalent and flagged the divergence.

### Capture framework — the good case
Screen capture already uses **ScreenCaptureKit** through the `screencapturekit` Rust crate **v1.5.4** with the `macos_15_0` feature (`src-tauri/Cargo.toml`). It records straight to H.264 MP4 via `SCRecordingOutput` (hardware VideoToolbox encode + muxing in-OS — no ffmpeg, no `AVAssetWriter` FFI).

- **There is no deprecated `CGWindowListCreateImage` in the recorder path.** The "outdated framework" precondition the prompt worried about does **not** apply. This is the clean, modern API surface, which de-risks Phase 2 substantially.
- Capture entry point: `src-tauri/src/recorder/screen_capture.rs` → `ScreenRecorder::start(output_path)`. It **hardcodes the primary display** and builds an **empty exclusion list**:
  ```rust
  // screen_capture.rs:165
  let filter = SCContentFilter::create()
      .with_display(&display)
      .with_excluding_windows(&[])   // ← nothing excluded today
      .build();
  ```
- Runtime-gated to **macOS 15 (Sequoia)+** via `macos_supports_recording()` (`screen_capture.rs:52`). On 13/14 the recorder is simply unavailable. `recorder::loom_recorder_available()` is the app-wide guard.

**Verified crate capabilities** (in `~/.cargo/registry/.../screencapturekit-1.5.4`):
- `SCContentFilterBuilder::with_window(&SCWindow)` — single-window capture → **Phase 1 "specific window"**
- `SCContentFilterBuilder::with_content_rect(CGRect)` / `set_content_rect()` — sub-rect of a display → **Phase 1 "custom region"**
- `SCContentFilterBuilder::with_excluding_windows(&[&SCWindow])` — **Phase 2 overlay exclusion at the OS level** (the clean approach the prompt asked about — it exists)
- `SCContentFilter::with_excluding_applications(...)` — exclude all of an app's windows
- `SCShareableContent::windows()` → `Vec<SCWindow>`, and `SCWindow::{window_id(), title(), owning_application(), frame(), is_on_screen()}` — everything needed to **build the picker list**.

### Legacy recorder (untouched, but note the trap)
`src-tauri/src/recorder.rs` is the **old audio-only WAV recorder** driving **ffmpeg as a sidecar**. Per memory `[[ffmpeg-sidecar-broken]]`, the bundled ffmpeg is Homebrew-dynamic-linked and fails on end-user machines. The Loom recorder (the subject of this plan) deliberately does **not** touch ffmpeg — it's pure ScreenCaptureKit. Phase 1 must keep it that way; do not route any new capture mode back through `recorder.rs`/ffmpeg. (This directly affects the "Camera only" decision — see Phase 1 open questions.)

### UI layer
- **Pre-record panel:** `overlay/src/pages/RecorderPanel.tsx` (`RecordTab`), hosted by `src-tauri/src/recorder/panel_window.rs` (window label `recorder-panel`, **content-protected**). Opened by a tray left-click.
- The panel **already contains the source-picker UI shell** (`RecorderPanel.tsx:453`):
  ```
  Full screen      ✓ (only working option)
  Specific window  — disabled, "Soon"
  Custom size      — disabled, "Soon"
  ```
  Camera + Mic device rows are wired and working. **Phase 1 is partly stubbed-in already** — do not rebuild the shell, light up the disabled rows.

### Webcam overlay — single reshapeable window
- One Tauri webview window (`webcam-bubble`), `src-tauri/src/recorder/webcam_bubble.rs` + `overlay/src/pages/WebcamBubble.tsx`. **Deliberately NOT content-protected** so the face is in the recording (the Loom bubble).
- **Shape is pure CSS today**: `rounded-full` (circle) for small/medium, full-bleed rectangle (`inset-0`) at `large`. The window itself is **square** for the circle sizes (`bubble_diameter + margin`), full-display at large.
- This is a **single window that can be reshaped** — Phase 3 does **not** need to replace multiple panels. Good news.

### Copilot overlay — already excluded from capture (the Phase 2 keystone)
- One Tauri webview window (`copilot-overlay`), `src-tauri/src/copilot/window.rs`. It calls **`set_content_protected(true)`** at creation (`window.rs:66`). On macOS this sets `NSWindowSharingType = none`, which excludes the window from **all** screen captures — including our own ScreenCaptureKit recording.
- **Therefore the Phase 2 privacy default (copilot NOT in the recording) already holds for free.** This reframes Phase 2 from "build exclusion" to "add an opt-in to *include* it, defaulting OFF." See Phase 2 + Risks.
- Same window also hosts the teleprompter (already content-protected, already hidden from viewers — confirmed by the existing teleprompter flow at `lib.rs:1982`).
- Countdown overlay and the recording control bar (`recording_ui.rs`) are **also content-protected** → already excluded. Only the webcam bubble is intentionally visible.

### State management pattern
- **Single source of truth in Rust.** `src-tauri/src/state.rs` → `AppState` with `Mutex<>` fields. The recorder pipeline is the `LoomState` enum (`Idle → Countdown → Recording → Stopping → Uploading → NeedsLink/Complete/Failed`).
- **No redux/Combine/Observable.** The webview gets state by listening to the `wolfee-state` Tauri event and sends commands by `emit("wolfee-action", payload)`. The big handler is a `match` in `src-tauri/src/lib.rs` (~line 1826+).
- Actions are mostly **bare strings** (`"loom-record-screen"`, `"webcam-bubble-large"`), but structured payloads are already used where needed (e.g. `teleprompter-start` carries `{script, fontSize, autoScroll, wpm}` — `RecorderPanel.tsx:231`). This is the template for passing a capture target.
- Recording flow today: panel → `emit("wolfee-action","loom-record-screen")` → `lib.rs` arm runs permission preflight → 3-2-1 countdown → `spawn_blocking(ScreenRecorder::start)` → `LoomState::Recording` + control bar. Stop: `loom-stop-recording` → `ScreenRecorder::stop()` → upload via `uploader_v2.rs`.

---

## Phase 1: Source Picker

Goal: full screen / specific window / custom region / camera only, replacing the single hardcoded primary-display target. UI shell already exists; the work is enumeration + capture-target plumbing.

**Files to modify**
- `src-tauri/src/recorder/screen_capture.rs` — give `ScreenRecorder::start` a `CaptureTarget` parameter; build the `SCContentFilter` from it.
- `src-tauri/src/lib.rs` — the `"loom-record-screen"` arm (line 1876): read a structured target payload instead of a bare string; add a new command to enumerate displays/windows for the picker.
- `overlay/src/pages/RecorderPanel.tsx` — un-stub the "Specific window" / "Custom size" rows; add "Camera only"; carry the chosen target in the `loom-record-screen` payload (`handleStart`, line 215).
- `src-tauri/src/state.rs` — optional: persist last-used target / custom region (`AppState`).

**New files**
- `overlay/src/pages/RegionSelector.tsx` — a full-screen transparent, content-protected drag-to-select overlay window for "custom region" (returns a CGRect). New webview route + a small builder in `recording_ui.rs` (or a sibling `region_picker.rs`).
- (Optional) `src-tauri/src/recorder/sources.rs` — window/display enumeration helpers wrapping `SCShareableContent`, keeping `lib.rs` thin.

**Functions added / modified**
- `screen_capture.rs`: new `pub enum CaptureTarget { FullScreen { display_id: u32 }, Window { window_id: u32 }, Region { display_id: u32, rect: CGRect }, CameraOnly }`. `ScreenRecorder::start(output_path, target)` selects the matching display/window from `SCShareableContent` and builds the filter with `with_display` / `with_window` / `with_content_rect`.
- `lib.rs`: new Tauri command e.g. `list_capture_sources()` → `{ displays: [...], windows: [{id,title,app,appIcon?}] }` via `SCShareableContent::windows()`/`displays()`, filtered to `is_on_screen()` and excluding Wolfee's own windows. The `loom-record-screen` arm parses `{ target: {...} }`.
- `RecorderPanel.tsx`: on opening the "Specific window" submenu, invoke `list_capture_sources`; render the window list; store `selectedTarget`; include it in the start payload. "Custom size" opens the region selector and stores the returned rect.

**New permissions**
- **None beyond what exists.** Window enumeration uses the *same* `SCShareableContent` API behind the *same* Screen Recording TCC grant the recorder already requires — **no separate window-list prompt** on macOS (unlike the old `CGWindowList` world). The existing preflight in the `loom-record-screen` arm (`lib.rs:1926`, "grant doesn't take effect until restart") already covers it.
- "Camera only" needs camera permission — already obtained today by the webcam bubble's `getUserMedia` (`WebcamBubble.tsx:30`).

**Edge cases to handle**
- **Multi-monitor "Full screen":** today only the primary display is captured (`screen_capture.rs:143` takes `displays().next()`). Loom lists each display as a separate source — picker should enumerate all `displays()` and pass the chosen `display_id`.
- **Target window closes / minimizes mid-recording:** `SCStream` keeps running but yields black/last-frame. Decide: auto-stop with a friendly finish, or keep recording black. Needs a delegate-side check.
- **Target window moves to another Space / display:** SCK follows the window surface; verify behavior, especially with the overlay's `visible_on_all_workspaces`.
- **User picks a Wolfee window as the target (recursion):** filter Wolfee's own windows out of the enumeration by `owning_application().bundle_identifier()`.
- **Custom region coordinate space:** `content_rect` is in the display's coordinate space; Retina (`point_pixel_scale`) and multi-monitor origin offsets must be handled. The drag-select overlay reports logical px — convert carefully.
- **Region selector window must be content-protected** (so the selection chrome isn't itself in the recording) and click-mapped to the right display.

**Open questions**
1. **"Camera only" capture path** — biggest unknown. Two options: (a) reuse ScreenCaptureKit to capture *only the webcam-bubble window* (`with_window`), keeping the existing MP4/`SCRecordingOutput` pipeline and uploader untouched; or (b) record the `getUserMedia` stream in the webview via `MediaRecorder`. Option (a) keeps one output path and avoids ffmpeg entirely (per `[[ffmpeg-sidecar-broken]]`); option (b) re-introduces a second encode path and a WebM→MP4 problem. **Recommendation: (a).** Confirm.
2. **Default target** when the user clicks Start without touching the picker — keep "primary full screen"? (Recommend yes.)
3. **Custom region persistence** between sessions — and per-display, or one global rect?
4. **Window-closes-mid-recording** policy — auto-stop-and-save, or keep recording?

**Effort:** **medium (3–5 days).** UI shell exists; the capture-target enum + enumeration command are straightforward against this crate. The region selector + "camera only" decision are what push it to medium, not small.

---

## Phase 2: Copilot Overlay Capture Toggle

Goal: explicit user control over whether the copilot overlay appears in the recording. **Default OFF (excluded)** — non-negotiable privacy/leak default.

**The keystone finding:** the copilot overlay is **already content-protected** (`copilot/window.rs:66`), so it is **already excluded from our ScreenCaptureKit recording by default**. The default-OFF requirement is satisfied **with zero new capture code**. Phase 2 is therefore mostly: (a) surface a toggle, (b) implement the *opt-in to include* path, (c) handle the cross-cutting tradeoff (see Risks).

**Files to modify**
- `overlay/src/pages/RecorderPanel.tsx` — add a "Capture copilot overlay" toggle in `RecordTab` (default OFF), next to the existing Mic/computer-sounds toggles. Carry the boolean in the `loom-record-screen` payload.
- `src-tauri/src/copilot/window.rs` — add `set_overlay_capturable(app, include: bool)` that flips `set_content_protected(!include)` on the `copilot-overlay` window.
- `src-tauri/src/lib.rs` — `loom-record-screen` arm: read `includeCopilotOverlay`; if true, drop content protection before capture starts; **always re-assert `set_content_protected(true)` on stop / discard / failure** (in the `loom-stop-recording` arm at `lib.rs:2045` and `finish_loom_failure`).
- `src-tauri/src/state.rs` — `AppState`: `include_copilot_overlay: Mutex<bool>` (defaults false) so the stop/failure paths know whether to restore.

**Functions added / modified**
- `copilot::window::set_overlay_capturable(app, include)` — single choke point for the protection flip; logs loudly (protection failures are already logged at creation).
- Alternative/defensive belt: even with content protection dropped, the `loom-record-screen` arm could still add the overlay's `SCWindow` to `with_excluding_windows([...])` when the toggle is OFF — making exclusion explicit at the filter level too. Requires resolving the overlay's `window_id` (Tauri `ns_window` → `CGWindowID`, or match by `owning_application` + title in `SCShareableContent`). Lower priority since content protection already handles default-OFF; useful only if we ever stop content-protecting the overlay for other reasons.

**New permissions**
- **None.**

**Edge cases to handle**
- **Recording started before copilot launched, then copilot launches:** the overlay window is *created* with `set_content_protected(true)` (`window.rs:66`), so a copilot opened mid-recording is **born excluded** — no race, default-safe. ✅
- **User toggles "include overlay" on/off mid-recording:** flipping `set_content_protected` live is honored by the OS in ~1 frame, but there's a brief window of exposure on the flip. If we expose a mid-recording toggle, debounce and accept a 1–2 frame flicker; flag it. (Simplest v1: the toggle is set-at-start only, not changeable mid-recording.)
- **Specific-window capture (Phase 1) of another app's window:** the overlay isn't part of *that* window's surface, so it can't leak there regardless of the toggle — the toggle only matters for **full-screen** and **custom-region** capture. Surface this in the UI (grey the toggle out when target is a specific non-Wolfee window).
- **Multi-display:** copilot overlay lives on one display; if the capture target is a *different* display, the overlay can't appear there anyway. Toggle is a no-op in that case — fine, but don't promise it does something.
- **Protection-restore must be bulletproof:** if the app crashes mid-recording with protection dropped, the overlay would stay exposed in other captures. Re-assert protection on every overlay `show`/create (already happens at create) and on app focus, as a safety net.

**Open questions**
5. **The include-tradeoff (see Risk #2):** including the overlay forces dropping `NSWindowSharingType=none`, which exposes it to **every** screen recorder (Zoom, Meet) during the recording — not just ours. Is that acceptable, or should "include overlay" be hard-blocked while any external screen-share is detected? (macOS gives no per-capture include of a protected window.)
6. Should the toggle be **changeable mid-recording**, or **set-at-start only**? (Recommend set-at-start for v1 to avoid the flip-exposure race.)

**Effort:** **small (1–2 days).** Default-OFF is free; the work is one toggle, one protection-flip choke point, and the restore-on-stop guarantee. The complexity is *policy* (the tradeoff in Q5), not code.

---

## Phase 3: Webcam Display Shape

Goal: webcam display-shape options — at minimum **circle** and **vertical rectangle** (portrait talking-head, like Loom).

**The keystone finding:** the bubble is a **single reshapeable Tauri window** (`webcam-bubble`), not multiple panels. Shape today is **pure CSS** (`rounded-full` vs full-bleed). So Phase 3 = add a `shape` dimension orthogonal to the existing size, adjust the window aspect ratio, and switch the CSS. **No window replacement needed.**

**Files to modify**
- `overlay/src/pages/WebcamBubble.tsx` — add a `shape` state (`"circle" | "portrait"`), a shape toggle in the hover controls, and switch container CSS (`rounded-full` ↔ `rounded-[20px]` portrait rectangle with `object-cover`). Emit `webcam-bubble-shape-*`.
- `src-tauri/src/recorder/webcam_bubble.rs` — generalize the window geometry: today `floating_window_px(size)` returns a square. Add shape-aware sizing — circle stays square; portrait uses a 9:16 (e.g. 280×500 logical) window. Add `reshape_webcam_bubble(app, shape)` (keep center fixed, like `resize_webcam_bubble` does at `webcam_bubble.rs:95`).
- `src-tauri/src/lib.rs` — add `webcam-bubble-shape-circle` / `webcam-bubble-shape-portrait` action arms (next to the existing `webcam-bubble-small/medium/large` arms at `lib.rs:1865`).
- `overlay/src/pages/RecorderPanel.tsx` — optional: expose default shape in the camera DeviceRow so the bubble opens in the chosen shape.

**Functions added / modified**
- `webcam_bubble.rs`: `fn window_dims(size, shape) -> (f64, f64)` replacing the square-only `floating_window_px`; `reshape_webcam_bubble(app, shape)`.
- `WebcamBubble.tsx`: `pickShape(shape)` mirroring the existing `pickSize` (`WebcamBubble.tsx:50`).

**New permissions**
- **None.**

**Edge cases to handle**
- **Shape × size interaction:** today `large` means full-display rectangle. Define what "portrait + large" means (probably: large is screen-fill and ignores shape; portrait only applies to small/medium floating sizes). Keep the matrix small to avoid over-engineering.
- **Aspect-ratio video cropping:** portrait needs `object-cover` so a landscape camera feed fills the tall frame without letterboxing — already the pattern (`object-cover` at `WebcamBubble.tsx:82`).
- **Reposition on reshape:** changing window dimensions must keep the bubble on-screen (the existing `resize_webcam_bubble` center-fix logic handles this; reuse it).
- **Mid-recording reshape:** the bubble is visible in the recording, so a reshape mid-recording is *intended* and visible to viewers — fine, but the window-resize must be smooth (no flash of background).

**Open questions**
7. **Shape set:** circle + vertical rectangle only (per prompt), or also a horizontal 16:9 rectangle? Loom offers circle + rectangle; the prompt names "circle, vertical rectangle." (Recommend exactly those two for v1.)

**Effort:** **small (1–2 days).** Single window, CSS-driven, mirrors existing size logic.

---

## Risks & Recommendations

**Risk #1 — "Camera only" is the only Phase 1 mode that breaks the single-pipeline assumption.**
Full-screen / window / region all flow through the existing `SCRecordingOutput` MP4 path. "Camera only" has no display/window-of-another-app source. Recommended path: capture the **webcam-bubble window** via `with_window` so it stays on the same MP4/uploader pipeline and avoids re-introducing ffmpeg (`[[ffmpeg-sidecar-broken]]`). The alternative (`MediaRecorder` in the webview) creates a second encode path and a WebM→MP4 conversion problem. **Decide this before building Phase 1** (Open Q1) — it's the one thing that could turn Phase 1 from medium into large.

**Risk #2 — Phase 2 "include overlay" has no clean per-capture path on macOS.**
This is the technical risk the prompt asked to flag explicitly:
- **Excluding the overlay (default OFF) is fully solved** — it's already content-protected, and the crate also supports `with_excluding_windows([overlayWindow])` at the OS level if we ever want belt-and-suspenders. ✅ No migration needed; the codebase is already on modern ScreenCaptureKit, **not** a deprecated framework.
- **Including the overlay (toggle ON) is the hard part.** A content-protected window **cannot be force-included** in any single capture — `SCContentFilter` can't override `NSWindowSharingType=none`. To include it we must **drop content protection**, which exposes the overlay to **every** screen recorder running (Zoom/Meet), not just ours, for the duration. There is no macOS API to say "show this protected window in *my* capture only." **Recommendation:** ship default-OFF (free, robust) first; treat "include overlay" as a deliberate, clearly-warned action, and consider hard-blocking it when an external screen-share is detected (Open Q5).
- **Race conditions:** an overlay created mid-recording is born protected → auto-excluded (no race). A live toggle flip is honored in ~1 frame but has brief exposure — so make the toggle **set-at-start only** for v1 (Open Q6).

**Risk #3 — Custom-region coordinate math.**
`content_rect` is display-relative and unit-sensitive (Retina `point_pixel_scale`, multi-monitor origins). The drag-select overlay reports logical px and must convert to the right display's space. Budget test time on a mixed-DPI multi-monitor rig.

**Cross-cutting recommendations**
- **Promote `loom-record-screen` to a structured payload** carrying `{ target, includeCopilotOverlay, webcamShape, ...teleprompter }`. The codebase already does this for `teleprompter-start`, so it's idiomatic. Do it in Phase 1 so Phases 2 and 3 just add fields.
- **Keep the phases discrete and independently shippable** — Phase 1 ships value alone (source picker); Phase 2 and 3 are additive toggles. No phase blocks another except the shared payload refactor, which lands in Phase 1.
- **No precondition blocker exists.** The recorder is on modern ScreenCaptureKit, not deprecated APIs — the "outdated codebase" feedback signal does **not** fire. The only legacy-debt note is the unrelated ffmpeg audio recorder (`recorder.rs`), which Phase 1 must simply avoid re-using.

---

## Effort Summary

| Phase | Scope | Effort |
|-------|-------|--------|
| 1 — Source picker | full screen / window / region / camera-only | **medium (3–5 days)** |
| 2 — Copilot overlay toggle | default-OFF already free; opt-in include | **small (1–2 days)** |
| 3 — Webcam shape | circle + vertical rectangle | **small (1–2 days)** |
| **Total** | | **~1.5–2 weeks** |

---

## Phase 1 Build Notes (2026-05-30)

Built on branch `feature/recorder-phase-1-source-picker`. Resolved open questions Q1–Q4 per the build prompt (Q1 = camera-only via SCK `with_window`; Q2 = default primary full screen; Q3 = per-display custom region persisted; Q4 = auto-stop-and-save on target invalidation).

**Verified by:** `cargo check` (exit 0) and the overlay `tsc -b && vite build` (exit 0). **NOT verified:** the 10 on-device acceptance tests — they require macOS 15+ hardware, multi-monitor + mixed-DPI rigs, and visual inspection of recorded MP4s, which can't be exercised from this environment. Raunek must run those before merge. Everything below is static-compile-correct, not runtime-confirmed.

**Files changed**
- `src-tauri/src/recorder.rs` — `CaptureTarget` + `RegionRect` types, `RecorderPrefs` + load/save (JSON at `…/io.wolfee.desktop/recorder_prefs.json`), new module decls.
- `src-tauri/src/recorder/screen_capture.rs` — `ScreenRecorder::start(path, Option<CaptureTarget>)`, filter built per target (`with_display`/`with_window`/`with_content_rect`), `fit_1080` + `clamp_region`, `WatchTarget` + `watch_target()`.
- `src-tauri/src/recorder/sources.rs` *(new)* — `list_capture_sources()`, `window_present`/`display_present`/`primary_display_id` (watchdog).
- `src-tauri/src/recorder/region_selector.rs` *(new)* — content-protected full-display drag-select window.
- `src-tauri/src/recorder/webcam_bubble.rs` — `WEBCAM_BUBBLE_TITLE` const (camera-only resolves the bubble window by it).
- `src-tauri/src/state.rs` — `last_capture_target` + `custom_region_per_display` fields, `capture_target()`/`set_capture_target()`/`persist_recorder_prefs()`.
- `src-tauri/src/lib.rs` — `recorder-config`/`region-selected` structured actions; `request-capture-sources`/`request-capture-target`/`open-region-selector`/`close-region-selector` bare actions; target read + watchdog spawn in `loom-record-screen`; prefs loaded into `AppState`.
- `overlay/src/pages/RecorderPanel.tsx` — live source picker (full screen / per-display / specific window / custom region / camera only), `capture-sources` + `recorder-region-result` + `capture-target` listeners, `MenuItem` `sub` line.
- `overlay/src/pages/RegionSelector.tsx` *(new)* + `overlay/src/main.tsx` — `#/region-selector` route.

**Deviations from the plan (followed actual code per the decision rules):**
1. **Event bus, not a Tauri command.** The plan/prompt said "add a `list_capture_sources` Tauri command," but the codebase has **zero** Tauri commands / `invoke` usage — it is entirely the `wolfee-action` event bus with `request-X` → emit-result-event (e.g. `request-wolfee-state`). Introducing `invoke_handler` would have been a new mechanism. Enumeration is therefore `request-capture-sources` → `capture-sources` event, matching `request-wolfee-state`.
2. **Structured payload via a staging action, not on `loom-record-screen` itself.** Structured `wolfee-action` payloads route through `handle_structured_action`, which has no access to the recorder handle. Rather than thread it in, the target is staged into `AppState` by a `recorder-config` action and read by the (still bare) `loom-record-screen` trigger — exactly the `teleprompter-start` pattern the prompt named as the template. Phase 2/3 extend the same staged config.
3. **`CaptureTarget`/`RegionRect` live in `recorder.rs` (un-gated), not `screen_capture.rs`.** They are pure serde types and `state.rs` (cross-platform) needs them, so keeping them in the macOS-gated capture file would break non-macOS builds.
4. **Auto-stop is a polling watchdog, not the SCStream error delegate.** The crate exposes `SCStreamDelegateTrait::did_stop_with_error`, but a delegate can't distinguish "window closed" from "stream hiccup," and wouldn't cover display-disconnect. A 500 ms poll of `SCShareableContent` with a 2-miss (~1 s) debounce handles window-close/quit and display-disconnect uniformly and is easy to reason about. It keys on window **presence** (not `is_on_screen`) so a Space switch does **not** trip it (Space-switched windows stay present); minimize likewise doesn't auto-stop (it presents identically to a Space switch — documented trade-off).

**Coordinate math (region):** the selector window covers the full primary display, so its CSS/logical coordinates are display-local logical **points**, which equal SCK `content_rect` points on macOS — **no Retina conversion** is applied, by design. `clamp_region` clamps to display bounds before the filter is built. This needs real multi-monitor + mixed-DPI verification (highest-risk area).

**Known limitations / smaller deviations:**
- `app_icon_base64` from the data contract is **omitted** — per-window icon fetch is costly; the picker uses the app name as the subtitle instead.
- The region selector always opens on the **primary** display; selecting a region on a secondary display isn't wired yet (it echoes the primary `display_id`). Follow-up.
- Camera-only captures the bubble window at whatever size it currently is; it does not auto-enlarge the bubble (bubble resizing is Phase 3).
- A persisted `Window` target whose window is gone on next launch shows "Selected window" until Start, which then fails with a clear "that window is no longer open" message rather than silently falling back.

**New open questions surfaced:**
- Should camera-only force the bubble to a larger size for a usable talking-head, or leave sizing to the user (Phase 3)?
- Region on a secondary display — worth wiring the selector to open under the cursor's display in Phase 1.5, or defer?

**Commits:** grouped logically (backend Rust / frontend / docs) rather than one-per-step — the steps interleave within `lib.rs` and `recorder.rs`, and `git add -p` isn't available in this environment, so per-step commits couldn't each be made to compile in isolation. Each committed state compiles.

**Effort vs estimate:** the plan estimated **medium (3–5 days)**; the implementation matches that — the region selector + camera-only window resolution + watchdog are what fill out the range, as predicted.

## Revision History
- **2026-05-30** — initial plan.
- **2026-05-30** — Phase 1 build notes appended (build complete on `feature/recorder-phase-1-source-picker`; pending on-device acceptance testing).
