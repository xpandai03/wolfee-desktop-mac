# Loom Recorder Phase 1 — Verification Plan

**Branch:** `feat/loom-recorder-phase1`
**Date:** 2026-05-21
**Status:** Code complete, compiles + links clean (`cargo build` ✓). **Not runtime-tested** — screen recording needs a human granting macOS permissions and doing GUI interaction, and the upload needs the live backend. Run this checklist on a Mac, then merge + release.

---

## What was built

A tray-driven screen recorder. Click **🎬 Record Screen** in the Wolfee tray → 3-second countdown → the primary display records to an H.264 MP4 → click **⏹ Stop Recording** → the file uploads to Wolfee → the `wolfee.io/v/<id>` link is copied to your clipboard.

### Architecture — what changed vs. the original spec

The original build spec assumed an `AVAssetWriter` FFI wrapper. During API verification I found the **`screencapturekit` crate already vendored in the project (v1.5.4) exposes `SCRecordingOutput`** — ScreenCaptureKit records straight to an MP4 with hardware H.264 encoding *and* microphone audio muxed in, entirely inside the OS. So:

- **No `AVAssetWriter` FFI, no `CMSampleBuffer` plumbing, no `encoder.rs`, no ffmpeg.** The capture+encode path is ~150 lines of *safe* Rust.
- **Cost:** `SCRecordingOutput` + `SCStreamConfiguration.captures_microphone` are **macOS 15.0+** APIs. The feature is **runtime-gated** (`sw_vers` check) — the app still launches and runs Copilot normally on macOS 13/14; only the recorder is unavailable there.
- Mic **and** system audio are both captured (SCK folds them into the file) — system audio came for free, so app sounds in a demo are captured too.

### Files

| File | Change |
|---|---|
| `src-tauri/src/recorder/screen_capture.rs` | **New.** `ScreenRecorder` (SCStream + SCRecordingOutput), macOS-15 gate, start/stop. |
| `src-tauri/src/recorder/uploader_v2.rs` | **New.** `create_video` → streaming presigned `PUT` → `mark_uploaded`, with progress. |
| `src-tauri/src/recorder.rs` | Registers the two submodules + `loom_recorder_available()`. Legacy audio recorder untouched. |
| `src-tauri/src/state.rs` | `LoomState` enum + `loom_*` fields on `AppState`. |
| `src-tauri/src/tray.rs` | Record/Stop/uploaded menu items + status rows + `update_tray_for_loom()`. |
| `src-tauri/src/lib.rs` | `wolfee-action` arms: `loom-record-screen` / `loom-stop-recording` / `loom-open-recording` / `loom-dismiss`; countdown + capture + upload orchestration. |
| `src-tauri/Cargo.toml` | `screencapturekit` feature `macos_13_0` → `macos_15_0`; added `tokio-util`, `futures-core`. |
| `src-tauri/Info.plist` / `entitlements.plist` | `NSCameraUsageDescription` + camera entitlement (Phase 2 prep — unused now). |

---

## Pre-flight — assumptions to confirm first

These could not be verified without the live backend / multiple OS versions. **Check these before deep testing** — a wrong assumption here is the most likely cause of failure:

1. **Backend contract.** Code assumes `POST /api/videos` accepts `{ title, contentType:"video/mp4", fileSize, ext:"mp4" }` and returns `{ id, shortId, uploadUrl }`; and `POST /api/videos/:id/uploaded` accepts `{ durationSeconds, sizeBytes }`. The `id` field is parsed as either a string or a number. If field names differ, fix `recorder/uploader_v2.rs`.
2. **R2 presigned PUT.** Code sends the file as a streaming `PUT` with `Content-Type: video/mp4` and `Content-Length`. If R2's presigned URL was signed expecting different headers, the PUT returns 403 — adjust the headers in `upload_to_r2()`.
3. **macOS 13/14 still launches.** The `macos_15_0` crate feature pulls in macOS-15 Swift symbols. They *should* weak-link (the crate degrades `SCRecordingOutput::new()` to `None` on older OS). **If you have a macOS 13 or 14 machine, confirm the app still launches there.** This is the single most important regression check.

---

## Build

```bash
cd /Users/raunekpratap/Desktop/wolfee-desktop-mac
git checkout feat/loom-recorder-phase1
cargo tauri dev          # or: cargo tauri build
```

- [ ] `cargo tauri dev` launches the app, tray icon appears.
- [ ] Tray menu shows a **🎬 Record Screen** entry under the `———` separator.
  - On macOS < 15 it reads **Record Screen (needs macOS 15)**, disabled.
  - When not linked it reads **Record Screen (link Wolfee first)**, disabled.

## Permissions

- [ ] First recording: macOS prompts for **Screen Recording** permission. Grant it (may require an app relaunch — macOS quirk).
- [ ] macOS prompts for **Microphone** permission. Grant it.
- [ ] Deny screen recording once → a "Screen-recording permission is required" notification appears and state returns to idle cleanly.

## Record → stop → local file

- [ ] Click **🎬 Record Screen** → notification "Recording starts in 3 seconds…" → ~3s later the tray title shows **● REC**.
- [ ] Tray menu now shows **⏹ Stop Recording**.
- [ ] Record ~30s of screen activity while speaking.
- [ ] Click **⏹ Stop Recording** → tray title shows **⬆ …**.
- [ ] A file `screen_<timestamp>.mp4` exists in
      `~/Library/Application Support/io.wolfee.desktop/recordings/` (it is deleted *after* a successful upload — to inspect it, kill the app before upload completes, or temporarily comment out the `remove_file` call in `lib.rs`).
- [ ] The MP4 plays in QuickTime: **has a video track** and **has an audio track** with your mic narration. Verify with:
      `ffprobe screen_*.mp4` (or QuickTime → Window → Show Movie Inspector).

## Upload → share link

- [ ] During upload the tray title shows **⬆ NN%** climbing.
- [ ] On success: a notification "Recording uploaded ✅" with the link; tray shows **✅ Recording uploaded — open & copy link**.
- [ ] The `wolfee.io/v/<shortId>` link is on the clipboard (Cmd-V to check).
- [ ] Clicking the tray's "open & copy link" row opens the video in the browser.
- [ ] The video appears in the **wolfee.io/videos** dashboard and the public `/v/<id>` page plays it with transcript.
- [ ] After ~12s the tray's Complete row auto-clears back to **🎬 Record Screen**.

## Error paths

- [ ] Stop with no network → "failed" notification, tray shows **❌ …**, the local MP4 is **kept** (not deleted). **Dismiss** clears the row.
- [ ] Record while not linked → blocked up front with a "Link Wolfee first" notification.
- [ ] Long recording (5+ min) → larger file still uploads; progress advances; no memory spike (the file streams from disk, never fully in RAM).

---

## Known limitations — Phase 1 scope

Deliberately deferred (decision rules in the build spec explicitly allow the simpler tray-driven path):

- **Primary display only.** No display picker — multi-monitor users always record display 1. Multi-display selection lands with the pre-record panel.
- **No webview UI.** No pre-record panel, no floating control bar, no countdown window — everything is tray-driven. (Bonus: a tray menu is never part of a screen capture, so there is no control-bar-exclusion problem to solve.)
- **No webcam** — Phase 2.
- **Countdown** is a notification + 3s delay, not an on-screen 3-2-1.
- **Upload progress** is shown in the tray menu-bar title (`⬆ NN%`), not a progress bar.
- Recording is **H.264 MP4, ≤1080p, 30fps**, aspect-matched to the display.

## If something fails

| Symptom | Look at |
|---|---|
| "needs macOS 15" on a 15+ Mac | `macos_supports_recording()` / `sw_vers` parsing in `screen_capture.rs` |
| Recording starts but file is empty / unplayable | `SCRecordingOutput` finalize — the `recording_did_finish` wait in `ScreenRecorder::stop()` |
| No audio in the MP4 | `with_captures_microphone` / `with_captures_audio` in `screen_capture.rs`; macOS mic TCC grant |
| `create video` 4xx | backend field names — `create_video()` in `uploader_v2.rs` |
| R2 PUT 403 | presigned-URL signed headers vs. what `upload_to_r2()` sends |
| App won't launch on macOS 13/14 | the `macos_15_0` feature — may need runtime weak-linking work |

Once this checklist passes: bump `version` to `0.8.0` in `Cargo.toml` + `tauri.conf.json`, merge to `main`, and run `node scripts/release.js`.
