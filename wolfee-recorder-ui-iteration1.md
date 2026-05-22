# Recorder UI Redesign — Iteration 1: Pre-record Panel

**Branch:** `feat/recorder-ui`
**Date:** 2026-05-21
**Status:** Builds clean (overlay `tsc`+`vite` ✓, `cargo build` ✓). Not runtime-tested — needs your eyes on the rendered panel.

Per your iteration protocol ("build the pre-record panel first → verify it looks right → then…"), this is **step 1**: the polished Loom-style pre-record panel. Countdown overlay, recording control bar, and webcam bubble are the next iteration.

## What was built

A frameless, transparent, always-on-top webview window hosting a Loom-style panel:

- **3 mode tabs** — Screen (active), Webcam, Screenshot (disabled, "soon").
- **Screen mode:** "Full screen" selector (dropdown: Full screen ✓, Specific window / Custom size disabled, "Camera only" → switches to Webcam mode), camera row, mic row.
- **Webcam mode:** large circular live preview, camera row (forced on), mic row.
- **Camera row** — On/Off badge; dropdown lists cameras (`enumerateDevices`) + "No camera". Live preview circle appears when on.
- **Mic row** — On/Off badge; dropdown lists mics + "Noise filter" (disabled, soon) + "Record computer sounds" toggles.
- **Orange "Start recording"** button.
- **Footer** — Effects / Notes (disabled), More (Help → opens help URL).
- Open-dropdown row turns blue, matching the Loom screenshots. Header is drag-to-move.

### Files
| File | Change |
|---|---|
| `overlay/src/pages/RecorderPanel.tsx` | **New** — the panel component (React + Tailwind + lucide). |
| `overlay/src/main.tsx` | Added the `#/recorder` hash route. |
| `src-tauri/src/recorder/panel_window.rs` | **New** — `open/close_recorder_panel`, frameless transparent window. |
| `src-tauri/src/recorder.rs` | Registers `panel_window`. |
| `src-tauri/src/tray.rs` | "Record Screen" now **opens the panel** (not immediate record); no longer auth-gated. |
| `src-tauri/src/lib.rs` | `wolfee-action` arms: `open-recorder-panel`, `cancel-recorder-panel`; `loom-record-screen` closes the panel first. |

## Flow

Tray **🎬 Record Screen** → panel opens centered → configure → **Start recording** → panel closes → existing capture flow runs (3 s notification countdown → record). **X** → panel closes. Stop is still the tray "Stop Recording" (the control bar is iteration 2).

## How to look at it

```bash
git checkout feat/recorder-ui && cargo tauri dev
```
Tray → **🎬 Record Screen** → the panel should float center-screen. Check against the Loom screenshots: tab row, device rows with green On badges, dropdowns (blue active row), orange button, footer. Toggle the camera On → macOS prompts for camera once → live preview circle appears. Send me what's off and I'll refine, then build iteration 2.

## Honest scope notes (iteration 1)

- **Device *selection* isn't wired to capture yet.** "Start recording" triggers the existing native flow as-is: **primary display + default mic + system audio** — which equals the panel's defaults. Picking a specific mic / turning "Record computer sounds" off / the camera do not affect the recording yet. That's the "wire to recorder" step (iteration 2), and it needs a small `screen_capture.rs` change to accept a chosen display/device.
- **Camera defaults Off** (not On like Loom). Phase 1 doesn't record the webcam, so defaulting On would prompt for camera permission and preview a feed that isn't in the recording. Flip to On when webcam *recording* lands.
- Screenshot mode, Effects, Notes, Specific-window, Noise-filter — visible but disabled placeholders, per your change policy.
- **Countdown overlay, recording control bar (timer/stop/discard), webcam bubble** — iteration 2. The control bar will be a content-protected window (`set_content_protected(true)` already excludes a window from ScreenCaptureKit capture — verified in `context_window.rs`), so it needs no capture-pipeline change.
