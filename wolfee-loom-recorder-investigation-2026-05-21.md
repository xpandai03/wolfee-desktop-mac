# Wolfee Loom-Style Recorder — Codebase Investigation & Architecture Proposal

**Date:** 2026-05-21
**Author:** Investigation pass (no code written, no files modified)
**Scope:** Desktop app (`wolfee-desktop-mac`) only. Web app / Chrome extension / pricing / branding explicitly out of scope.
**Status:** Investigation + planning. Architecture is a proposal for review, not a locked decision.

---

## 0. Executive Summary

The desktop app is a **Tauri v2** macOS-only app (Rust backend `src-tauri/`, React/Vite overlay `overlay/`). It has two recording-adjacent subsystems:

1. **Standalone recorder** (`recorder.rs` + `uploader.rs`) — **audio-only**, shells out to `ffmpeg`, produces a stereo WAV, uploads it as a single multipart POST. **Currently un-surfaced in the UI** (tray entries were removed in "Sub-prompt 6.0"; the code is preserved but dead).
2. **Copilot audio pipeline** (`copilot/audio/*`) — a mature, **fully native-Rust** capture stack: `cpal` for mic, `ScreenCaptureKit` for system audio, `rubato` for resample/mux. Live transcription via Deepgram WebSocket. **No video.**

### The five findings that shape the architecture

1. **🔴 The bundled `ffmpeg` sidecar is broken for distribution.** `src-tauri/binaries/ffmpeg-aarch64-apple-darwin` is only 421 KB because it is *not* a static binary — it is the developer's Homebrew `ffmpeg` CLI, dynamically linked against ~60 dylibs under `/opt/homebrew/Cellar/ffmpeg/7.1.1_3/...`. It fails with `dyld: Library not loaded` on any machine without that exact Homebrew install — **including this dev machine today** (Homebrew ffmpeg has since been upgraded/removed). The 2026-05-01 diagnosis assumed "ffmpeg ships correctly"; it does not. **This very likely explains the original "recorder doesn't record meetings" symptom.** → *Do not build the Loom recorder on the ffmpeg sidecar.*
2. **The screen-capture infrastructure already exists and is proven.** The `screencapturekit` crate (v1.5) is already a dependency and works in production for audio. The **same crate and the same `SCStream` also deliver video** (`SCStreamOutputType::Screen` → `CMSampleBuffer`/`CVPixelBuffer`). The app currently just doesn't attach a video handler. Screen capture is an *extension*, not a greenfield build.
3. **The webcam is genuinely new.** ScreenCaptureKit cannot capture a webcam. Webcam needs a separate `AVCaptureDevice`/`AVCaptureSession` (AVFoundation). This also adds a **third permission prompt** (camera) the app has never requested.
4. **The upload path cannot handle video.** `uploader.rs` reads the *entire file into RAM*, sends one multipart POST, 200 MB hard cap, 120 s timeout, no chunking, no resume, no progress. A 10-minute screen+webcam recording is 250–400 MB; 30 minutes can exceed 1 GB. This must be rebuilt.
5. **Real-time H.264 encoding is available natively and for free.** macOS gives hardware H.264/HEVC via VideoToolbox, and `AVAssetWriter` wraps encode+mux into a finished `.mp4` with almost no manual work. This is the right encoder — not ffmpeg.

### Recommended architecture (one line)

> **Screen** captured natively (extend the existing `ScreenCaptureKit` integration) → encoded by `AVAssetWriter`; **webcam** captured + encoded + previewed entirely inside a Tauri webview via `getUserMedia` + `MediaRecorder`; **audio** reuses the Copilot `cpal`+SCK pipeline; **two separate video files** uploaded via **presigned R2 multipart** and composited **in the web player** (Loom's model). Drop ffmpeg entirely.

---

# PART A — Existing Recording Infrastructure

## A1. The standalone recorder (`recorder.rs`, 276 lines)

### What it captures
**Audio only.** Despite the diagnosis doc mentioning a `screenRecorder.ts` in the *old Electron* build, the current Tauri `recorder.rs` has **no video path whatsoever**. It produces a stereo WAV: `pcm_s16le`, 16 kHz, L = mic / R = system loopback.

### End-to-end flow

| Stage | Detail | Location |
|---|---|---|
| Trigger | Tauri **event** `"wolfee-action"` with payload `"start-recording"` / `"stop-recording"` (there are **no `#[tauri::command]`s anywhere in the app** — everything is event-driven) | `lib.rs:1449`, `lib.rs:1495` |
| State guard | `AppState` FSM: `Idle → Recording → Stopping → Uploading → Complete → Idle` | `state.rs:50-63` |
| Resolve ffmpeg | `FFMPEG_PATH` env → `<exe_dir>/ffmpeg` sidecar → `"ffmpeg"` on `$PATH` | `recorder.rs:33-54` |
| Device detection | Shells out `ffmpeg -f avfoundation -list_devices true -i ""`, keyword-matches loopback device names (`blackhole`, `loopback`, `soundflower`, `virtual`, `multi-output`, `loomaudiodevice`) | `recorder.rs:217-260` |
| Capture | Spawns `ffmpeg` as a `tokio::process::Child`, stdin piped | `recorder.rs:56-85` |
| Output dir | `~/Library/Application Support/io.wolfee.desktop/recordings/recording_<ISO-timestamp>.wav` | `recorder.rs:15-19` |
| Stop | Writes `"q"` to ffmpeg stdin, 5 s graceful wait, else `child.kill()` | `recorder.rs:87-141` |
| Upload | `uploader::upload_recording()` → `POST {backend}/api/meetings/import/desktop`; deletes local file on success, keeps it on failure | `lib.rs:1516-1605` |

### The exact ffmpeg command

**Dual capture** (loopback device present):
```
ffmpeg -f avfoundation -i :<mic_idx>
       -f avfoundation -i :<loopback_idx>
       -filter_complex "[0:a][1:a]amerge=inputs=2"
       -ac 2 -ar 16000 -c:a pcm_s16le -f wav -y <out.wav>
```
**Mic-only fallback** (no loopback device): single `-i :0`, `-ac 1`.

→ Pure audio. `avfoundation` is used *only* as an audio demuxer here; the `:N` syntax (no leading screen index) selects an audio device. No `-f avfoundation -i "1:0"` screen syntax is present.

### Upload metadata (`UploadMetadata`, `uploader.rs:7-17`)
```json
{ "source": "desktop_recorder", "detectedPlatform": "desktop",
  "startTime": "<rfc3339>", "endTime": "<rfc3339>", "duration": <seconds f64> }
```
Sent as a `metadata` text field alongside the `file` part. Backend responds `{ "id": <i64> }`; the desktop derives `{backend}/meetings/{id}` as the "open in Wolfee" URL.

### UI interaction
The recorder is **no longer surfaced**. `tray.rs:349-356` documents that "Sub-prompt 6.0" removed the Start/Stop Recording menu items — *"The desktop app is Copilot-only at the user-facing layer; the recorder.rs module is preserved for future re-wiring."* The `RecordingState` enum, the `wolfee-action` handlers, and `recorder.rs` itself are all intact and reachable — they just have no button. **A Loom recorder can re-light this exact path** (event → state machine → tray status rows) without inventing new plumbing.

## A2. The Copilot audio pipeline — what is reusable

The Copilot stack (`copilot/audio/`, `~1450` lines) is the **most valuable reusable asset in the repo**. It is fully native Rust, no ffmpeg, production-tested.

| Module | Role | Reusable for Loom? |
|---|---|---|
| `audio/mic.rs` | `cpal` default-input capture, device-native rate, mono downmix, **device-change supervisor** (3 retries/5 s — survives AirPods unplug) | ✅ **Directly.** Best mic source for any recording mode. |
| `audio/system_macos.rs` | `ScreenCaptureKit` system-audio capture, 48 kHz f32 mono, excludes own-process audio | ✅ **Directly** for "capture computer audio." |
| `audio/mux.rs` | `rubato` resample to 16 kHz + interleave to stereo `i16` | ⚠️ **Partially.** Tuned for Deepgram's 16 kHz wire format + has an echo-suppression gate. A recorder wants 44.1/48 kHz AAC, not 16 kHz speech PCM. Reuse the *pattern*, retune the *rates*. |
| `audio/permissions.rs` | TCC probes — `ensure_microphone()`, `ensure_screen_recording()`, silent `probe_*()` for the onboarding wizard | ✅ **Directly.** Add a `probe_camera()` sibling (the AVFoundation `authorizationStatusForMediaType` FFI is already demonstrated in `probe_microphone()`). |
| `transcribe/deepgram.rs` | **Live streaming** Deepgram WS client | ❌ Not directly — see §B7. |

### Is the ScreenCaptureKit integration video-capable?
**The API is; the current code is not.** `system_macos.rs:111-116` builds an `SCStreamConfiguration` with only `with_captures_audio(true)` and audio sample-rate options. The handler at line 125-132 explicitly **discards every non-audio buffer**:
```rust
if of_type != SCStreamOutputType::Audio { return; }
```
The `screencapturekit` crate (and the underlying `SCStream`) fully supports video: set `width`/`height`/`pixel_format`/`minimum_frame_interval` on the configuration and attach a handler for `SCStreamOutputType::Screen`, which delivers `CMSampleBuffer`s backed by `CVPixelBuffer`/`IOSurface`. **No new crate is required for screen *capture*.**

### Can the mux pipeline be extended to carry a video track?
**No — and it shouldn't be.** `mux.rs` is an audio sample-rate-conversion + interleaver, not a container muxer. Video muxing (timestamps, keyframes, codec config) belongs in `AVAssetWriter` (§B4/B7). The mux *task pattern* (mpsc channels + a pump task draining capture callbacks) is the right shape and should be **mirrored** for video, but the audio mux code itself is not the video path.

## A3. Upload infrastructure (`uploader.rs`, 119 lines) — and why it fails for video

| Property | Current behaviour | Verdict for video |
|---|---|---|
| Transfer | Single `multipart::Form` POST | ❌ |
| Memory | **`tokio::fs::read()` loads the whole file into RAM** before sending | ❌ A 1 GB recording = 1 GB RAM spike |
| Size cap | `MAX_FILE_SIZE = 200 MB` hard reject | ❌ 10-min screen+webcam ≈ 250–400 MB |
| Timeout | 120 s fixed | ❌ 400 MB on a 10 Mbps uplink ≈ 5+ min |
| Progress | None | ❌ No UX feedback |
| Resume | None — failure keeps the local file, full re-upload only | ❌ |
| Streaming | `reqwest` is built with the `stream` feature (`Cargo.toml:19`) but `uploader.rs` doesn't use it | ⚠️ The capability is paid-for but unused |
| Auth | `Authorization: Bearer <token>`; accepts `wf_…` API keys or device tokens | ✅ Reusable as-is |
| Endpoint | `POST /api/meetings/import/desktop` → `{ "id": <i64> }` | ⚠️ New endpoints needed (§B8) |

**Conclusion:** auth handling and the error-to-tray-status mapping are reusable; the *transfer mechanism* must be rebuilt for large files (§B8).

---

# PART B — What's Needed for Loom-Style Recording

## B4. Simultaneous screen + webcam capture on macOS

There is **no single API** that captures both. They are two independent subsystems:

| Source | macOS API | Rust path |
|---|---|---|
| Screen / window / display | **ScreenCaptureKit** (`SCStream`, video output) | `screencapturekit` crate v1.5 — **already a dependency** |
| Webcam | **AVFoundation** — `AVCaptureDevice` + `AVCaptureSession` | `nokhwa` crate, *or* webview `getUserMedia`, *or* `objc2` FFI |
| Mic / system audio | `cpal` / ScreenCaptureKit audio | **already implemented** (`copilot/audio/`) |
| Encode + mux | **VideoToolbox** (HW H.264/HEVC) via **`AVAssetWriter`** | `objc2`/`objc2-av-foundation` FFI, *or* `cidre`, *or* webview `MediaRecorder` |

### Rust crate availability (researched, with realism flags)

- **`screencapturekit` v1.5** — *already in `Cargo.toml`.* Safe bindings, supports screen + window + display + audio capture, sync & async APIs, video frames as `CMSampleBuffer`. **Low complexity** — incremental change to existing code.
- **`nokhwa` v0.10** — cross-platform webcam capture; macOS backend uses `AVCaptureDevice`/`AVCaptureSession`. Caveats from its own docs: must call `nokhwa_initialize` first, **FPS adjustment is non-functional on macOS**, errors if camera permission isn't pre-granted. Last meaningful commit ~April 2025 — maintained but not fast-moving. Gives **raw frames** (you still need to encode them). **Medium complexity.**
- **`cidre`** (yury/cidre) — broad, hand-written Apple bindings: ScreenCaptureKit, AVFoundation, VideoToolbox, CoreMedia, `AVAssetWriter`. The only crate that covers the *whole* native pipeline. **Medium-high complexity** — lower-level, sparse docs, would be a second SCK binding alongside the existing crate (the two can coexist).
- **`objc2` + `objc2-av-foundation` + `objc2-screen-capture-kit`** — raw-ish FFI. `objc2` is **already a dependency** (used in `window.rs` and `permissions.rs`). **High complexity** for a full encoder, but fine for a *thin, focused* `AVAssetWriter` wrapper.
- **No mature pure-Rust VideoToolbox crate.** Hardware H.264 means either `AVAssetWriter` (which uses VideoToolbox internally — recommended) or direct `VTCompressionSession` FFI (avoid).

### Encoding — can we do real-time H.264 on macOS?
**Yes, easily, in hardware.** `AVAssetWriter` + an `AVAssetWriterInput` with `AVVideoCodecTypeH264`/`HEVC` accepts `CMSampleBuffer`s straight from ScreenCaptureKit, hardware-encodes via VideoToolbox, and writes a finished, streamable `.mp4`/`.mov` — encode *and* mux in one component. This is what virtually every native Mac screen recorder uses. **ffmpeg is not needed and should not be used** (and the bundled one is broken — see Finding 1).

### How Loom does it on Mac (and what we copy)
Loom's native Mac app: **ScreenCaptureKit** for screen + **AVFoundation `AVCaptureDevice`** for webcam + **hardware H.264 (VideoToolbox/`AVAssetWriter`)**. Critically, **Loom keeps the screen and webcam as separate video tracks** and composites the round webcam bubble **at playback time in the web player** — which is why a Loom viewer can move, resize, or hide the bubble *after* the recording exists. **We copy this exactly** (§B5, §B7): it removes real-time compositing entirely from the desktop app.

## B5. Recording modes

| Mode | Screen | Webcam | Audio | New capture work |
|---|---|---|---|---|
| **Screen only** | SCK video | — | mic (+ optional system) | Screen video capture + `AVAssetWriter` |
| **Screen + webcam (bubble)** | SCK video | AVCapture/webview | mic (+ optional system) | Above **+** webcam capture, **as a separate file** |
| **Webcam only** | — | AVCapture/webview | mic | Webcam capture only |
| **Audio only** | — | — | mic (+ system) | **Already exists** (`recorder.rs`) — modernise to AAC/M4A |

**Where the webcam bubble lives: in the *player*, not the recording.** During recording the user sees a live webcam **preview** (a small circular always-on-top Tauri window). The actual webcam video is recorded as its **own file** and uploaded separately; the web player draws the bubble overlay. This means the desktop never does pixel compositing — see decision rule "If compositing webcam PiP is complex → upload separate streams." It is complex; we upload separate streams.

## B6. Recording UI / UX

The existing standalone recorder UI is **only tray menu rows** — there is no recorder window. That is insufficient for Loom-style UX. New surfaces needed (all are Tauri webview windows, the pattern `copilot/window.rs` already establishes):

| Surface | Purpose | Build on |
|---|---|---|
| **Pre-record panel** | Mode picker, screen/window selector, camera/mic dropdowns, "Start" | New small webview window |
| **Webcam preview bubble** | Circular always-on-top live `getUserMedia` preview while recording | Clone `copilot/window.rs` (transparent + always-on-top + `visible_on_all_workspaces` + elevated `NSWindow` level are all already solved there) |
| **Recording control bar** | Timer, pause, stop, "discard" — small floating bar | New webview window; **must be excluded from the screen capture** via SCK's window-exclusion filter so it doesn't appear in the video |
| **Countdown** | 3-2-1 before capture | Transient overlay, can reuse the preview window |
| **Tray** | Recording-state rows + a new "Record a video…" entry | `tray.rs` — re-light the removed recorder section pattern |

**Screen/window selection:** ScreenCaptureKit gives this nearly for free. `SCShareableContent` enumerates displays + windows + apps; macOS 14+ also offers the system `SCContentSharingPicker`. `SCContentFilter` can target one display, one window, or a display *minus excluded windows* (used to hide our own control bar). Multi-monitor "record this specific screen" = pick the right `SCDisplay`. **No custom picker needed for v1** beyond a simple list.

**Tray integration:** add a "Record a Video…" entry and reuse `RecordingState` rows for live status (the FSM and tray-row rendering already exist in `state.rs`/`tray.rs`).

## B7. Video processing pipeline

| Step | Recommendation |
|---|---|
| **Encoding** | Real-time HW H.264 via `AVAssetWriter` (screen) and `MediaRecorder`/`AVCaptureMovieFileOutput` (webcam). No post-process encode pass. |
| **Compositing** | **None on desktop.** Screen and webcam upload as separate files; the web player composites the bubble (Loom model). |
| **Container** | `.mp4` (H.264 video + AAC audio). Encode `+faststart`/fragmented so the player can stream before full download. |
| **Audio** | Mic (+ optional system) mux straight into the **screen** file's audio track via a second `AVAssetWriterInput`. Webcam file is video-only. |
| **Transcription** | **Server-side, after upload.** Wolfee already has a Deepgram account + integration. But `transcribe/deepgram.rs` is a *live streaming* WS client minting per-session JWTs — **not reusable** for a finished file. The backend should run Deepgram's **pre-recorded/batch** API on the uploaded audio. Desktop's only job: upload, and report `transcript: "pending"`. |
| **Thumbnail** | **Server-side.** Backend extracts a frame from the uploaded MP4. (Optional later: desktop grabs one `CVPixelBuffer` → JPEG to make the dashboard tile appear instantly.) |

## B8. Upload & backend integration

### Strategy: presigned multipart direct to R2
A 10-min screen+webcam recording is **250–400 MB**; 30 min can exceed **1 GB** (§Risks). The current path cannot do this. Recommended:

1. Desktop `POST`s recording metadata → backend creates a recording row + returns **presigned S3-style multipart-upload part URLs** for R2.
2. Desktop **streams file parts from disk** directly to R2 (use `reqwest`'s already-enabled `stream` feature — no whole-file `read()`), 5–10 MB parts, 2–3 in parallel.
3. Per-part success → resumable: a failed part retries without re-sending the whole file; progress = parts completed / total.
4. Desktop `POST`s "complete" → backend finalises the R2 multipart upload and kicks off transcription + thumbnail jobs.

Direct-to-R2 keeps large media off the Node backend entirely. Screen and webcam files each get their own multipart upload.

### What the desktop expects from the API (the web-app investigation will spec the backend)
- An endpoint to **create a recording** and mint presigned part URLs.
- An endpoint to **complete/abort** a multipart upload.
- Reuse the existing `Authorization: Bearer` device-token / `wf_` API-key scheme.
- A response carrying the shareable recording URL (mirroring today's `{backend}/meetings/{id}`).

### Metadata to send
`duration`, `width`/`height` per file, `recordingMode` (`screen` | `screen_webcam` | `webcam` | `audio`), `hasScreen`, `hasWebcam`, `hasSystemAudio`, `screenFileKey`, `webcamFileKey`, `recordingStartedAt` + per-file start offset (for player A/V sync of the two tracks), `fps`, `codec`, app `version`, `deviceId`.

---

# PART C — Architecture Proposal

## C9. Proposed architecture

### Reuse vs. build-new

| Reuse as-is | Reuse with changes | Build new |
|---|---|---|
| `cpal` mic capture (`audio/mic.rs`) incl. device-change supervisor | `audio/mux.rs` — retune from 16 kHz speech PCM to 44.1/48 kHz recording audio | Screen **video** capture (extend `system_macos.rs` / new `screen_video.rs`) |
| SCK system-audio capture (`audio/system_macos.rs`) | `uploader.rs` — replace single-POST with presigned multipart streaming | `AVAssetWriter` encoder/muxer wrapper (`objc2` FFI) |
| TCC permission probes (`audio/permissions.rs`) | `tray.rs` — re-light a recorder section | Webcam capture + preview (webview `getUserMedia`/`MediaRecorder`) |
| Auth / device-link (`auth.rs`) | `state.rs` `RecordingState` FSM — extend for new modes | Pre-record panel, control bar, webcam bubble, countdown windows |
| `wolfee-action` event bus + `spawn_async` task pattern | `copilot/window.rs` window helpers — clone for new windows | New backend client for create-recording / multipart-complete |
| Recordings dir (`~/Library/Application Support/io.wolfee.desktop/recordings/`) | | |

### Recommended capture pipeline (the hybrid)

```
┌─ SCREEN ───────────────────────────────────────────────┐
│ ScreenCaptureKit SCStream (video)                       │
│   → CMSampleBuffer/CVPixelBuffer callback               │
│   → AVAssetWriterInput (video, H.264, VideoToolbox HW)  │
│ cpal mic  ─┐                                            │
│ SCK sysaud ┴→ resample/mix → AVAssetWriterInput (audio) │
│   ⇒  screen_<ts>.mp4   (H.264 + AAC)                    │
└─────────────────────────────────────────────────────────┘
┌─ WEBCAM (in the Tauri webview) ─────────────────────────┐
│ getUserMedia(camera) → <video> live preview (bubble)    │
│                      → MediaRecorder → webcam blob      │
│   ⇒  webcam_<ts>.mp4   (H.264)                          │
└─────────────────────────────────────────────────────────┘
        both files ⇒ presigned R2 multipart upload
        web player composites the bubble at playback
```

**Why hybrid (the key decision).** WKWebView's `getDisplayMedia` (screen capture in the webview) is unreliable on macOS, and the app *already has a proven native SCK + screen-recording-permission flow* — so **screen stays native**. But `getUserMedia` for the **webcam** is solid in WKWebView, and routing the webcam through the webview gives **three things for free**: the live preview bubble (`<video>` element), the encoding (`MediaRecorder`), and **single-camera-ownership** (no contention between a Rust `AVCaptureDevice` and a preview consumer). This isolates *all* genuinely new native code to one path: **screen video → `AVAssetWriter`.**

> **Alternative (fully native, defer):** capture the webcam in Rust via `nokhwa`/`AVCaptureMovieFileOutput`. Higher quality control and no webview-encoder quirks, but more native code and a camera-preview-bridging problem. Recommend only if webview `MediaRecorder` quality proves inadequate in testing.

> **Sub-decision — SCK crate:** keep `screencapturekit` v1.5 for capture (Copilot audio already depends on it; don't risk that path) and add a **thin `objc2`-based `AVAssetWriter` wrapper** for encode/mux. Adopting `cidre` wholesale is cleaner in theory but is a second SCK binding and a bigger surface to learn — not worth it for a solo founder unless the thin FFI wrapper proves painful.

### Local storage strategy
- Same dir as today: `~/Library/Application Support/io.wolfee.desktop/recordings/`.
- Write **directly to disk during capture** (`AVAssetWriter` streams to a file; `MediaRecorder` chunks flushed to disk) — never hold the recording in RAM (fixes a current `uploader.rs` flaw).
- Cleanup: delete on confirmed upload (today's behaviour, `lib.rs:1556`); keep on failure for resume; add a startup sweep for orphaned files older than N days.

### Tauri integration points
- **Events:** new `wolfee-action` payloads — `"open-recorder"`, `"start-loom-recording"` (structured JSON with mode/source), `"stop-loom-recording"`, `"discard-recording"`. Matches the existing structured-action dispatch (`lib.rs:386` `handle_structured_action`).
- **State:** extend `RecordingState` (or add a parallel `LoomRecordingState`) — capturing / paused / processing / uploading, with mode metadata.
- **Windows:** 3–4 new webview windows via `copilot/window.rs`-style helpers.
- **Permissions:** add `NSCameraUsageDescription` to `Info.plist` and `com.apple.security.device.camera` to `entitlements.plist`; add `probe_camera()` to `permissions.rs`.
- **Tray:** new "Record a Video…" entry + status rows.
- **Capabilities:** `src-tauri/capabilities/default.json` already grants `shell`, `notification`, `clipboard`, `store` — webview `getUserMedia` needs the camera/mic TCC grants (OS-level), not a Tauri capability.

## C10. Phased build plan

### Phase 1 — MVP: Screen-only recorder (the demo use case)
- Extend SCK to capture screen **video**; `AVAssetWriter` → `screen.mp4` with mic audio.
- Display picker (list `SCShareableContent.displays`), 3-2-1 countdown, floating control bar (excluded from capture), stop.
- Presigned **multipart streaming upload** to R2 (replaces `uploader.rs`); progress in the tray.
- New backend endpoints: create-recording, complete-upload.
- **Ships the single highest-value mode** (product demos, meeting recaps) and proves the encode + upload spine end-to-end.

### Phase 2 — Webcam
- Webcam preview bubble window + `getUserMedia`/`MediaRecorder` → `webcam.mp4`.
- Modes: webcam-only, screen+webcam (two files, shared start timestamp).
- Camera permission prompt + `probe_camera()` onboarding status.
- Player-side bubble compositing is web-app scope.

### Phase 3 — Polish
- Specific-**window** capture + `SCContentSharingPicker`; pause/resume; mic/system-audio toggles.
- Server-side transcription + thumbnail wired into the dashboard.
- Modernise the legacy audio-only recorder to AAC/M4A on the new upload path; long-recording memory/disk hardening; resume-on-relaunch.

## Risks & unknowns

| Risk | Assessment |
|---|---|
| **🔴 Broken ffmpeg sidecar** | The bundled `ffmpeg` is Homebrew-dynamic-linked and fails on end users (Finding 1). The Loom recorder avoids it by design; **separately, the legacy audio recorder is likely broken in production for the same reason** — flag for the team. |
| **Permission prompts** | Screen+webcam = **3 prompts**: mic, screen recording, **camera (new)**. Sequence them deliberately (the `permissions.rs` "mic first" ordering logic is the template). macOS 15 also re-nags for screen-recording consent periodically. |
| **Performance** | Simultaneous SCK screen capture + HW H.264 encode is light (VideoToolbox is dedicated silicon); webview `MediaRecorder` for the webcam is the heavier consumer. Expect meaningful battery draw on long recordings; cap default screen capture at 1080p/30 fps. |
| **File sizes** | Screen 1080p H.264 ≈ 1.5–3 MB/min (low-motion) to ~4–5 MB/min (high-motion); webcam 720p ≈ ~9 MB/min. **10 min screen+webcam ≈ 250–400 MB; 30 min ≈ 0.8–1.4 GB.** Mandates chunked/resumable upload and disk-streamed capture. |
| **A/V sync of two files** | Screen (native) and webcam (webview) are captured by different subsystems — clock-drift risk. Mitigate with a shared monotonic start timestamp + per-file offset in metadata; the player aligns. Loom proves this is workable. |
| **Tauri v2 / WKWebView** | `getUserMedia` is fine in WKWebView; `getDisplayMedia` is **not** reliable — hence native screen capture. `MediaRecorder` codec/quality on WebKit needs a real-device check early in Phase 2. The control bar window must be excluded from SCK capture. |
| **External display / lid close** | If the captured `SCDisplay` disappears mid-recording the `SCStream` errors. Needs a supervisor like `mic.rs`'s (graceful stop + finalise the partial file rather than lose it). |
| **Long recordings (30 min+)** | Must stream to disk continuously; finalising a large `AVAssetWriter` file on stop can take seconds — show a "processing…" state. |

---

## Acceptance-test checklist (investigation deliverable)

- [x] **Standalone recorder fully documented** — capture flow, exact ffmpeg command, upload path, backend endpoint (§A1).
- [x] **Copilot audio pipeline assessed for reusability** — per-module reuse table; SCK confirmed video-capable, currently audio-only (§A2).
- [x] **Upload infrastructure documented with limits** — in-RAM read, 200 MB cap, 120 s timeout, no chunk/resume/progress (§A3).
- [x] **macOS screen+webcam capture researched** — SCK (have it) + AVFoundation (new); `screencapturekit`/`nokhwa`/`cidre`/`objc2` crates assessed with complexity flags (§B4).
- [x] **All recording modes documented** with required APIs (§B5).
- [x] **Video processing pipeline proposed** — HW H.264, no desktop compositing, server-side transcription/thumbnail (§B7).
- [x] **Upload strategy for large files proposed** — presigned R2 multipart, disk-streamed, resumable (§B8).
- [x] **Architecture proposal** — reuse table, hybrid capture pipeline, storage, upload, Tauri integration (§C9).
- [x] **Phased build plan** — MVP screen-only → webcam → polish (§C10).
- [x] **Risks & unknowns identified** — permissions, performance, file sizes, Tauri limits, the broken ffmpeg (§Risks).

**Sources (macOS API / crate research):** [screencapturekit-rs](https://github.com/doom-fish/screencapturekit-rs) · [screencapturekit on crates.io](https://crates.io/crates/screencapturekit) · [nokhwa](https://github.com/l1npengtul/nokhwa) · [cidre](https://github.com/yury/cidre)
