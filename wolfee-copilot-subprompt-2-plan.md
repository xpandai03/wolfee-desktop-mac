# Wolfee Copilot Sub-prompt 2 (Listening) — Execution Plan

Author: planning agent. Status: read-only, **zero code changed, not committed.**
Audience: PO (review tomorrow morning) and the future execution agent.

---

## 0 — Status & relationship to prior work

- **Sub-prompt 1 (Foundation):** ✅ shipped. 6 commits ending `bad1005`, plus the post-test bug-fix commit `4cd0754`. Content-protected overlay window, ⌘⌥W hotkey, Vite/React/Tailwind frontend pipeline at `overlay/`, tray menu refactor (Copilot section above Notes section).
- **Backend pairing:** ✅ verified end-to-end after three iterations (final fix `90a0223` on WOLFEE-MVP). Postgres-backed `device_link_tokens` (migration `0005`).
- **This plan:** locked decisions for the Listening layer + open decisions PO must resolve before execution.

Audit / design refs reused unchanged:
- [audit §2.2](../WOLFEE-MVP/wolfee-copilot-architecture-audit-2026-05-01.md) — existing `recorder.rs` audio path (ffmpeg + BlackHole loopback). Sub-prompt 2 ships a **parallel** audio stack; recorder is untouched.
- [audit §5](../WOLFEE-MVP/wolfee-copilot-architecture-audit-2026-05-01.md) — audio pipeline Options A/B/C. **Option C locked**: short-lived Deepgram JWT minted by Wolfee backend, desktop streams direct to Deepgram WebSocket.
- [design doc §6 — Sub-prompt 2 row](../WOLFEE-MVP/wolfee-copilot-v1-design-2026-05-02.md): "macOS ScreenCaptureKit audio capture + mic capture via cpal, audio routing to Deepgram (Option C JWT direct stream), transcript buffering in Rust with last-90-s sliding window. 64 h."

What this plan adds beyond the design doc: actual file paths, crate selections, struct shapes, endpoint contracts, error/reconnection policy, permission integration with Sub-prompt 1's existing surface, and a concrete file-change inventory.

---

## 1 — Architecture overview

```
   ┌─────────────────────────────────────────────────────────────────┐
   │                       Wolfee Desktop (Rust)                     │
   │                                                                 │
   │  ┌──────────────────┐      ┌──────────────────┐                 │
   │  │ ScreenCaptureKit │      │ cpal mic input   │                 │
   │  │ (system audio)   │      │ (CoreAudio)      │                 │
   │  │ 48 kHz f32 mono  │      │ N kHz f32 mono   │                 │
   │  └────────┬─────────┘      └────────┬─────────┘                 │
   │           │ tokio::mpsc              │ tokio::mpsc              │
   │           ▼                          ▼                          │
   │     ┌─────────────────────────────────────┐                     │
   │     │ resampler + interleaver             │                     │
   │     │  → 16 kHz int16 stereo (L=mic R=sys)│                     │
   │     └────────┬────────────────────────────┘                     │
   │              │                                                  │
   │              │ WebSocket frames (250 ms each, ~8 KB)            │
   │              ▼                                                  │
   │   ┌──────────────────────────────────────┐                      │
   │   │  Deepgram WS client (tokio-tungstenite)                     │
   │   │  wss://api.deepgram.com/v1/listen                           │
   │   │   ?model=nova-3&multichannel=true&...                       │
   │   │  Authorization: Bearer <30-min JWT>                         │
   │   └────────┬─────────────────────────────────────────────────┐  │
   │            │ JSON transcript events (partial + final)        │  │
   │            ▼                                                 │  │
   │   ┌──────────────────────────────┐                           │  │
   │   │ TranscriptBuffer (Rust)      │ ─────► Sub-prompt 3 reads │  │
   │   │ 90-s sliding window, finals  │        (rolling summary,  │  │
   │   │ only, per-channel labels     │         moment detector,  │  │
   │   └──────────────────────────────┘         suggestion gen)   │  │
   └────────────┬────────────────────────────────────────────────────┘
                │                                                    
                │  POST /api/copilot/sessions/:id/deepgram-token
                │  Authorization: Bearer <device-token>
                ▼                                                    
   ┌──────────────────────────────────────────────────────────────┐ 
   │              Wolfee backend (Express, WOLFEE-MVP)            │
   │                                                              │
   │  POST /api/copilot/sessions             → create session     │
   │  POST /api/copilot/sessions/:id/deepgram-token              │
   │       → Deepgram /v1/auth/grant, return short-lived JWT      │
   │  POST /api/copilot/sessions/:id/end     → mark ended         │
   │                                                              │
   │  copilot_sessions table (migration 0006)                     │
   └──────────────────────────────────────────────────────────────┘
```

Key invariants:
1. Audio never leaves the desktop except as a Deepgram-bound stream — Wolfee backend never sees audio bytes.
2. Deepgram API key never leaves the backend — desktop sees only short-lived JWTs.
3. Transcript stays RAM-only (per locked Decision 20). No disk persistence in V1.
4. Sub-prompt 1's overlay/hotkey/tray work is **read-only context** here. Sub-prompt 2 adds new modules under `src-tauri/src/copilot/audio/`, `transcribe/`, `session/`. Nothing in `copilot/window.rs`, `copilot/hotkey.rs`, `copilot/state.rs` changes except `state.rs` gains a few new states.

---

## 2 — macOS audio capture

**Locked: Option B (ScreenCaptureKit for system audio + cpal for mic, two parallel subsystems).**

### Why this option vs the alternatives

| Option | Pro | Con | Verdict |
|---|---|---|---|
| **A.** SCK for both system + mic via single `SCStream` | One subsystem, Apple-native | SCK's mic path is less mature; the Rust crates expose system-audio capture far more cleanly than mic | rejected |
| **B.** SCK system audio + cpal mic | ✅ Best Rust ecosystem support, simpler each, well-tested cpal | Two permission prompts; two subsystems to manage | **LOCKED** |
| **C.** cpal-only with BlackHole loopback | No new framework | UX hostile (BlackHole install), conflicts with existing recorder which already uses BlackHole | rejected |
| **D.** Audio Aggregate Device (Core Audio) | Single stream | User must configure via Audio MIDI Setup — completely unacceptable for non-power-users | rejected |

### Crates

- **`screencapturekit = "0.3"`** (Rust binding for SCK) — verify latest at execution time. Alternative `objc2-screen-capture-kit` if `screencapturekit` is missing features we need; that one's lower-level but always current.
- **`cpal = "0.15"`** — already widely used in the Rust audio ecosystem.
- **`tokio = "1"`** — already in `Cargo.toml`.
- **`tokio-tungstenite = "0.24"`** — for the Deepgram WebSocket. **NEW.**
- **`rubato = "0.16"`** — sample-rate conversion (system audio is 48 kHz, mic is device-native, Deepgram wants 16 kHz). **NEW.**
- **`bytes = "1"`** — efficient buffer slicing in the resampler/interleaver. **NEW.**

(Final crate version pinning happens at execution time — this list is intent, not a `Cargo.toml` patch.)

### Rust module shape

New directory: `wolfee-desktop/src-tauri/src/copilot/audio/`

```rust
// audio/mod.rs — public interface
pub struct CopilotAudioCapture {
    system: SystemAudioStream,    // wraps SCStream
    mic:    MicAudioStream,       // wraps cpal::Stream
    out:    tokio::sync::mpsc::Sender<AudioFrame>, // → Deepgram client
    state:  CaptureState,         // Idle | Capturing | Stopping
}

impl CopilotAudioCapture {
    pub async fn start(session_id: String, sender: Sender<AudioFrame>) -> Result<Self, AudioError>;
    pub async fn stop(self) -> Result<(), AudioError>;
}

pub enum AudioError {
    PermissionDenied(PermissionKind),  // surface to UI for Sub-prompt 6
    DeviceUnavailable,
    Transient(String),                  // recoverable, log + retry
}

pub enum PermissionKind { ScreenRecording, Microphone }

pub struct AudioFrame {
    pub pcm_s16le_stereo: Vec<i16>,    // L=mic, R=system, 16 kHz, ~250 ms = 8000 samples
    pub captured_at: std::time::Instant,
}
```

File split:
- `audio/mod.rs` — public types, lifecycle, error handling
- `audio/system_macos.rs` — `#[cfg(target_os = "macos")]` SCStream setup, audio-only filter, sample-buffer callback
- `audio/mic.rs` — cpal default-input setup, sample callback (cross-platform-ready for future Windows/iOS)
- `audio/mux.rs` — resample 48 kHz / native → 16 kHz, interleave L=mic R=system, frame chunking
- `audio/permissions.rs` — `CGRequestScreenCaptureAccess()` wrapper + cpal mic probe

### Sample rates + frame size

- ScreenCaptureKit emits 48 kHz `Float32` typically.
- cpal default input is device-native (44.1 / 48 kHz on most Macs). Use the device's preferred rate and resample.
- Both downsampled to **16 kHz `int16` mono per channel** before interleaving (Deepgram `linear16` codec). Saves bandwidth (~32 kB/s vs ~192 kB/s) and Deepgram does not improve quality at higher rates for speech.
- Frame size: **250 ms** = 4,000 samples per channel = 8,000 samples interleaved = 16,000 bytes per frame. Matches Deepgram's recommended chunk cadence and keeps the transcript update interval responsive.

### Device-change handling (mid-call)

User plugs in AirPods, swaps to a different mic, etc. mid-session.

- **cpal:** the mic `Stream` ends with an `error` callback when the underlying device disappears. We listen, log, then re-acquire `default_input_device()` and start a new stream. Audible gap during the swap is acceptable (sub-second).
- **ScreenCaptureKit:** stable across device swaps because it captures system-routing output, not a specific device. No action needed.

This logic lives in `audio/mic.rs` as a supervisor task. Bounded retry: 3 attempts in 5 s, then surface `AudioError::DeviceUnavailable`.

### Permissions (interim — Sub-prompt 2 doesn't own onboarding)

- ScreenCaptureKit triggers macOS "Screen Recording" TCC prompt on first capture attempt. We call `CGRequestScreenCaptureAccess()` upfront so the prompt fires deliberately, not mid-stream.
- cpal triggers "Microphone" TCC prompt on first input-device open. Already prompted by the existing recorder when the user has used Notes; for fresh users we'll prompt at session-start.
- Both are gated by the user; if denied, `AudioError::PermissionDenied` flows up. Sub-prompt 2 surfaces this as a Tauri event the overlay catches and renders a generic "Open System Settings → Privacy & Security" message with a deep link via `tauri-plugin-opener`. **No fancy onboarding flow** — that's Sub-prompt 6.

---

## 3 — Stream interleaving + speaker labeling

**Locked: Option B (single Deepgram WebSocket, mux client-side, `multichannel=true`).**

### Why one WS not two

- **Cost:** Deepgram bills by audio minute. Two WebSocket connections = 2× transcribed minutes. One stereo stream with `multichannel=true` is billed once.
- **Time-alignment:** transcripts on the same WS share Deepgram's timing reference, so interleaving the rep's and prospect's turns into a chronological view is trivial. Two separate WSs would drift.
- **Backpressure:** one connection means one place to handle disconnects. Sub-prompt 5 simpler too.

### Format on the wire

`?encoding=linear16&sample_rate=16000&channels=2&multichannel=true&model=nova-3&language=en-US&punctuate=true&interim_results=true&endpointing=300`

- `multichannel=true` → Deepgram returns transcript events with `channel_index: 0` (mic = rep) or `channel_index: 1` (system = prospect)
- `interim_results=true` → both partial (`is_final=false`) and final (`is_final=true`) transcripts arrive. We **only** push finals into the buffer (see §6) — Sub-prompt 3's moment detector should never fire on a partial that gets revised.
- `endpointing=300` → 300 ms of silence ends an utterance; balances responsiveness vs split-mid-sentence.
- `punctuate=true` → adds commas/periods, useful for moment-detector LLM input.

### Speaker label naming convention — **OPEN (N1)**

Recommendation: **`rep`** (mic, channel 0) and **`prospect`** (system, channel 1). Matches sales-call vocabulary and the design doc's prose ("rep" / "prospect"). Two alternatives noted in §11.

Labels live in the transcript buffer entries — propagated to Sub-prompt 3 (moment detector, suggestion gen) and Sub-prompt 4 (UI display).

---

## 4 — Deepgram integration

**Locked: Option A (short-lived JWT minted by Wolfee backend) — per audit §5 lock.**

### Backend endpoint contract

```
POST /api/copilot/sessions/:sessionId/deepgram-token
  Authorization: Bearer <device-auth-token>
  →  200 { "jwt": "eyJ...", "expiresAt": "2026-05-02T22:00:00Z" }
     401 { "error": "..." }   (device auth failed)
     404 { "error": "session not found" }
     503 { "error": "deepgram upstream failed" }   (we tried /v1/auth/grant, got non-200)
```

Backend file: `WOLFEE-MVP/server/lib/copilot/deepgramAuth.ts` (NEW)

```typescript
export async function mintDeepgramJwt(): Promise<{ jwt: string; expiresAt: Date }> {
  const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttl_seconds: 3600 }), // 60 min default — see Open Decision N2
  });
  if (!res.ok) throw new DeepgramAuthError(`grant failed: ${res.status}`);
  const body = await res.json(); // { access_token: "...", expires_in: 3600 }
  return {
    jwt: body.access_token,
    expiresAt: new Date(Date.now() + body.expires_in * 1000),
  };
}
```

Pattern mirrors `server/lib/calendar/microsoftCalendar.ts`'s direct-fetch shape (no Deepgram SDK — keep one HTTP client style).

### Desktop usage

```rust
// session/deepgram_token.rs
pub struct DeepgramToken { pub jwt: String, pub expires_at: chrono::DateTime<Utc> }

pub async fn fetch(backend: &str, device_token: &str, session_id: &str) -> Result<DeepgramToken>;
```

### WebSocket connect

`tokio_tungstenite::connect_async` to `wss://api.deepgram.com/v1/listen?<query>` with `Authorization: Bearer <jwt>` header.

### Refresh policy

- Token TTL: **60 minutes** (per Open Decision N2 default).
- Refresh trigger: when `expires_at - now < 5 min`, fetch a new token and reconnect the WS. Concurrent reconnect logic already needed for §5; refresh just triggers the same path.
- Backend env var: **`DEEPGRAM_API_KEY`** (NEW in `.env.example`).

### Failure handling

- `mintDeepgramJwt` fails (Deepgram outage, key revoked, etc.) → backend returns 503 → desktop logs error, surfaces `AudioError::Transient`, retries once after 5 s. If second retry fails, ends the session with a tray notification.
- Cost cap (Open Decision N3): per-user daily minute budget enforced backend-side. Out of scope for code in Sub-prompt 2 if PO prefers; flagging as decision.

---

## 5 — WebSocket reconnection + error handling

**Locked: Option C (hybrid auto-reconnect with user notification on persistent failure).**

### Behavior

1. WS drops (network blip, Deepgram restart, packet loss). Audio capture keeps running and pushing into a bounded `VecDeque<AudioFrame>` (capacity = ~5 s = 20 frames).
2. Reconnect attempt fires immediately. Exponential backoff: 0.5 s, 1 s, 2 s, 4 s, capped at 8 s.
3. On successful reconnect, replay buffered frames in order, then resume live streaming.
4. If 4 successive attempts fail (~16 s total), surface a non-modal status row in the tray:
   `⚠️ Live transcription paused — reconnecting…` (clickable: opens the overlay so the user can see what's happening).
5. After 60 s of failed reconnects, end the session with `❌ Lost connection to transcription service` and require the user to re-start.

### State surface

Add to `CopilotState` (currently `Idle / ShowingOverlay / Paused`):

```rust
pub enum CopilotState {
    Idle,
    ShowingOverlay,
    Paused,
    // NEW (Sub-prompt 2):
    StartingSession,           // session POST in flight, JWT mint in flight
    Listening { session_id, started_at },
    Reconnecting { session_id, attempt: u8 },
    EndingSession { reason: SessionEndReason },
}

pub enum SessionEndReason { UserRequested, Failed(String) }
```

### Buffer math

Audio-frame buffer during reconnect: 20 frames × 250 ms each = **5 s of replayable audio**. Anything older than 5 s is dropped. This matches Deepgram's tolerance for replays — you can stream a few seconds of past audio and Deepgram will produce coherent transcripts. Beyond that, alignment quality degrades.

### Open: notification UX (N4)

The "reconnecting" tray row is intentionally generic. Sub-prompt 6 may upgrade to a toast notification via `tauri-plugin-notification`. Sub-prompt 2 ships tray-only.

---

## 6 — Transcript buffer architecture

**Locked: Option C (per-channel `VecDeque<Utterance>` with merged-time-ordered read view).**

### Why per-channel

The moment detector (Sub-prompt 3) wants questions like "did the rep ask a question and the prospect went silent?" Per-channel buffers make the silence-detection trivial (just check the prospect channel's last utterance timestamp).

A single merged `Vec` would force re-grouping by channel on every read.

### Data structure

```rust
// transcribe/buffer.rs

pub struct Utterance {
    pub channel: ChannelLabel,          // Rep | Prospect
    pub started_at_ms: u64,             // Deepgram's start-of-utterance timestamp (ms since session start)
    pub ended_at_ms: u64,               // Deepgram's end timestamp
    pub text: String,                   // final transcript only — partials never enter
    pub confidence: f32,                // for debugging / Sub-prompt 3 filtering
    pub recorded_at: std::time::Instant,
}

pub enum ChannelLabel { Rep, Prospect }

pub struct TranscriptBuffer {
    rep:      VecDeque<Utterance>,
    prospect: VecDeque<Utterance>,
    window_ms: u64,                     // 90_000 = 90 s
}

impl TranscriptBuffer {
    pub fn append(&mut self, u: Utterance);     // prunes channel queue down to window
    pub fn merged_view(&self) -> Vec<&Utterance>;  // chronological, both channels
    pub fn last_n_seconds(&self, n: u64) -> Vec<&Utterance>;
    pub fn last_rep_question_age_ms(&self) -> Option<u64>; // for moment detector
}
```

Capacity: 90 s × ~12 utterances/min = ~18 utterances per channel. Trivial memory. No need for size-cap fallback; time-pruning is exact.

### Partial vs final policy

- Deepgram emits both partials (`is_final=false`) and finals (`is_final=true`).
- **Only finals enter the buffer.** Partials would cause Sub-prompt 3's moment detector to fire on noise that gets revised away. Partials are still useful for transcript-display UX in Sub-prompt 4 — those will read a separate `LiveTranscript` channel via Tauri events, not the buffer.

### Storage location

`Arc<Mutex<TranscriptBuffer>>` managed via `app.manage(...)` — same pattern as `AppState` and `CopilotStateMutex`. Sub-prompt 3 reads via `app.state::<TranscriptBufferMutex>()`.

### Expose to overlay (live transcript view)

Out of Sub-prompt 2 scope; flagged for Sub-prompt 4 (Overlay UI polish). In Sub-prompt 2 we emit a Tauri event (`transcript-chunk`) on every final + partial so the eventual overlay code can subscribe; the event payload is lightweight (one utterance JSON).

---

## 7 — Backend endpoints + schema additions

### New file: `WOLFEE-MVP/server/lib/copilot/index.ts`

Re-exports the JWT minter, session helpers, and any future Copilot logic. Mirrors the existing `server/lib/meetings/index.ts` shape.

### New file: `WOLFEE-MVP/server/lib/copilot/deepgramAuth.ts`

`mintDeepgramJwt()` per §4.

### New endpoints (registered in `server/routes.ts` in a fenced `// ████████ COPILOT ████████` block)

```
POST /api/copilot/sessions
  Auth: requireDeviceAuth
  Body: {} (V1 — could carry meeting-context hints later)
  Returns: { sessionId: string, startedAt: timestamp }
  Side effects: INSERT into copilot_sessions (userId, deviceId, startedAt)

POST /api/copilot/sessions/:sessionId/deepgram-token
  Auth: requireDeviceAuth
  Validates: session belongs to (userId, deviceId) of caller, session not ended
  Returns: { jwt: string, expiresAt: timestamp }
  Side effects: none (Deepgram tracks JWT issuance internally)

POST /api/copilot/sessions/:sessionId/end
  Auth: requireDeviceAuth
  Body: { reason?: "user_requested" | "error" | "timeout" }
  Returns: { sessionId, durationSeconds }
  Side effects: UPDATE copilot_sessions SET endedAt = now(), endReason = ?
```

(Optional V1 — keep on shelf, add only if observability needs it):
```
POST /api/copilot/sessions/:sessionId/heartbeat
  → keeps the session alive, telemetry only
```

### New schema — migration `0006_add_copilot_sessions.sql`

In `WOLFEE-MVP/shared/schema.ts`:

```typescript
export const copilotSessions = pgTable("copilot_sessions", {
  id: text("id").primaryKey(),                                 // session UUID, generated client-side
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull(),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  endReason: text("end_reason"),                               // "user_requested" | "error" | "timeout"
  durationSeconds: integer("duration_seconds"),
  // V1: NO transcript columns — RAM only per Decision 20
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

Indexes: `userId`, `(userId, startedAt DESC)` for usage telemetry.

### Auth middleware reuse

`requireDeviceAuth` at [routes.ts:5003](../WOLFEE-MVP/server/routes.ts#L5003) — pre-existing, already used by `/api/meetings/import/desktop`. **No changes needed.**

### Env var addition

`WOLFEE-MVP/.env.example`:
```
DEEPGRAM_API_KEY=
```

PO action item: provision a Deepgram project + API key, set in Railway env. (Open Decision N5.)

---

## 8 — Permission flow (interim)

**Locked: Option A (Sub-prompt 2 ships minimal inline permission probe; Sub-prompt 6 polishes UX).**

### What Sub-prompt 2 ships

1. On `Start Copilot Session` (new tray menu item — see §12), call `audio::permissions::ensure()` first.
2. Probe order: **mic → screen recording**. Mic prompt is less alarming; if user grants mic and denies screen recording, we still know which gate to message about.
3. If a permission is missing, fire a Tauri event `copilot-permission-needed` with payload `{ kind: "Microphone" | "ScreenRecording" }`.
4. The overlay window listens for this event and renders a minimal modal: *"Wolfee Copilot needs <permission> to listen to your call. Open System Settings → Privacy & Security → <Section>."* with a button that opens the deep link via `tauri-plugin-opener`:
   - `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`
   - `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
5. After the user grants and clicks "Try again" in the modal, the session-start path retries `audio::permissions::ensure()`.

This is functional but visually unpolished. Sub-prompt 6 will replace the modal with the proper onboarding flow per the design doc's Section 9.

### Why not just attempt + handle errors

Because if we attempt audio capture before checking perms, ScreenCaptureKit silently fails on macOS Sonoma+ (no audio frames arrive, no error) — we'd lose the ability to surface a clear "you need to grant permission" message.

### macOS APIs used

- Microphone probe: cpal opens an input stream briefly and catches the `PermissionDenied` error. (Or `AVCaptureDevice.requestAccess(for: .audio)` if cpal's error reporting is unreliable; verify at execution.)
- Screen recording probe: `CGRequestScreenCaptureAccess()` / `CGPreflightScreenCaptureAccess()` from CoreGraphics. Both are stable APIs since macOS 10.15.

---

## 9 — Recorder coexistence (interim)

**Locked: technically allowed; show a soft warning if the other is running.**

### Why not block

The two audio paths don't share resources:
- Existing recorder (`recorder.rs`): ffmpeg child process reading mic + BlackHole loopback (system audio via the user's loopback driver).
- Sub-prompt 2 Copilot capture: `cpal` mic input + `ScreenCaptureKit` system audio.

Both can technically run simultaneously without device contention — cpal opens the mic non-exclusively, and ScreenCaptureKit doesn't touch the BlackHole device.

### What ships in Sub-prompt 2

When the user starts a Copilot session while the recorder is recording (or vice versa), show a **soft warning** in the overlay/tray:

> *"Notes recorder is running. Copilot will listen alongside it. Stop the recorder if you want to free up resources."*

No hard block. No auto-stop. PO's final coexistence policy (Decision N6 in the design doc) lands in Sub-prompt 6/7.

### State observation

Read `state.recording_state` (from existing `AppState`). If `RecordingState::Recording`, show the warning text. Conversely, if a Copilot session is active and the user clicks `Start Recording`, show the same warning before transitioning the recorder state.

This is ~15 LOC across `lib.rs` and the overlay component. Not a full state-machine merge.

---

## 10 — Effort breakdown

Sums to **~62 hours** of focused agent work. Within the 64 h ± 10 design-doc target.

| Section | Work | Hours |
|---|---|---|
| §2 macOS audio capture | SCK system audio + cpal mic + resample/mux + permissions probe | 18 |
| §4 Deepgram WS client + JWT fetch + session lifecycle | tokio-tungstenite client, multichannel parsing, JWT refresh | 12 |
| §5 Reconnection logic | Exp backoff, ring buffer, replay, tray status integration | 5 |
| §6 Transcript buffer + state additions | TranscriptBuffer + 4 new CopilotState variants + Tauri events | 6 |
| §7 Backend endpoints + schema | 3 routes + 1 migration + lib/copilot/* | 7 |
| §8 Permission flow (interim) | Probe APIs + Tauri event + bare modal in overlay | 4 |
| §9 Recorder coexistence | Soft-warning text + state-read in 2 spots | 2 |
| Testing + 24 h soak | Unit tests for buffer + manual end-to-end calls + soak | 8 |
| **Total** | | **62** |

Confidence: best 50 h, likely 62 h, worst 80 h. Worst case driven by ScreenCaptureKit's Rust crate maturity — if `screencapturekit-rs` lacks a feature we need (e.g., audio-only filter), we drop to `objc2-screen-capture-kit` and write more glue code. Adds 10-15 hr.

---

## 11 — Open decisions for PO

### N1 — Speaker label naming convention

**Recommendation:** `rep` (mic) and `prospect` (system audio). Matches sales-call vocabulary already used in the design doc's prose (§3 hybrid model: "the rep's question and the prospect's silence"). Propagates to Sub-prompt 3's moment-detector prompts and Sub-prompt 4's transcript UI.

**Alternatives:** `user/speakers`, `you/them`, `me/them`. PO confirms or picks alternative.

**Why this matters:** locking now avoids rename across 6 files later.

---

### N2 — Deepgram JWT TTL

**Recommendation:** 60 minutes (3600 s) per token.

**Tradeoff:**
- 15 min — more secure, requires mid-call refresh complexity in Sub-prompt 2 (forces working refresh+reconnect path even on a 30-min call).
- 60 min (recommended) — covers most calls without refresh; for longer calls, refresh logic is shared with §5 reconnection so no extra code.
- 4 hr — simplest desktop code, but a leaked token has a 4 h blast radius.

**Why this matters:** affects refresh-logic complexity. If PO picks 15 min, add ~3 h to estimate.

---

### N3 — Per-user Deepgram cost cap

**Recommendation:** **soft cap at 4 h/day per user**, surfaced via tray notification when reached. Hard cap at 8 h/day (refuses new sessions).

**Why:** at $0.0043/min Nova-3, 8 h/day = $2.06/user/day = ~$60/user/month at sustained heavy use. Without a cap, a single buggy session that doesn't end could spin up unbounded cost.

**Alternatives:**
- No cap (defer to billing, add post-V1) — risky.
- Hard cap only (no soft warning) — abrupt UX.

**Implementation cost:** ~3 h backend (a `daily_minutes_used` column on `copilot_sessions` aggregate, a check in the JWT-mint endpoint). Not in §10's 62 h estimate. If PO wants this, add to scope.

**Why this matters:** Deepgram-cost guardrails should ship with V1, not later.

---

### N4 — Reconnect notification UX

**Recommendation:** tray-only status row in Sub-prompt 2. Upgrade to `tauri-plugin-notification` toast in Sub-prompt 6.

**Alternative:** ship the toast now (~2 h extra). PO decides whether mid-call notifications are too disruptive.

---

### N5 — Deepgram account ownership + provisioning

**Action item, not really a decision:** PO needs to:
1. Create a Deepgram account if one doesn't exist (or use existing).
2. Provision a project for "Wolfee Copilot V1".
3. Generate an API key with scope: `usage:read`, `usage:write`, `tokens:write`.
4. Add `DEEPGRAM_API_KEY=...` to Railway env vars.

This is a hard prerequisite for execution — without the env var, the JWT mint fails at runtime.

**Why this matters:** can be done in parallel with execution; just needs to be done before merge / first end-to-end test.

---

### N6 — Session UUID generation: client or server?

**Recommendation:** client-side (desktop generates UUID via `uuid::Uuid::new_v4()`, includes in `POST /api/copilot/sessions`).

**Tradeoff:**
- Client-side — desktop can start the session locally without waiting for the round-trip; backend `INSERT` is idempotent on the UUID PK; if backend POST fails the session can be retried with the same ID without duplicate rows.
- Server-side — backend mints UUID and returns it. Forces a round-trip before audio capture starts. Slightly cleaner ID auditability but slows session start by ~80 ms.

**Why this matters:** affects when audio capture can start. With client-side IDs, capture can begin in parallel with the session POST.

---

### N7 — End-of-session policy when user quits the app

**Recommendation:** call `POST /api/copilot/sessions/:id/end` with `reason: "timeout"` if the desktop crashes or quits without explicitly ending. Implement via Tauri's `app.on_window_event` handler that detects shutdown.

**Alternative:** leave sessions open in DB; backend-side cron sweeps stale sessions after 6 h of no activity. Simpler client, more backend cleanup.

**Why this matters:** affects how `copilot_sessions.endedAt` gets populated reliably. Also affects telemetry queries Sub-prompt 7 will run.

---

### N8 — Should backend persist transcript chunks for telemetry?

**Recommendation:** **NO for V1** (per locked Decision 20 from design doc). Chat with PO if there's any debugging case that justifies opt-in persistence.

**Open if:** PO needs forensic logs to debug Sub-prompt 3's moment detector accuracy in Sub-prompt 7's beta. If yes, add `copilot_session_transcripts` table behind a per-user opt-in flag.

**Why this matters:** privacy + storage cost. Recommend keeping the V1 lock.

---

## 12 — Files to create / modify

### Wolfee desktop (`/Users/raunekpratap/Desktop/wolfee-desktop/`)

**NEW:**
- `src-tauri/src/copilot/audio/mod.rs` — public interface, lifecycle
- `src-tauri/src/copilot/audio/system_macos.rs` — ScreenCaptureKit
- `src-tauri/src/copilot/audio/mic.rs` — cpal
- `src-tauri/src/copilot/audio/mux.rs` — resample + interleave
- `src-tauri/src/copilot/audio/permissions.rs` — TCC probes
- `src-tauri/src/copilot/transcribe/mod.rs` — public interface
- `src-tauri/src/copilot/transcribe/deepgram.rs` — WS client (tokio-tungstenite)
- `src-tauri/src/copilot/transcribe/buffer.rs` — TranscriptBuffer + Utterance
- `src-tauri/src/copilot/session/mod.rs` — session lifecycle
- `src-tauri/src/copilot/session/api.rs` — Wolfee backend HTTP calls (start, jwt, end)
- `src-tauri/src/copilot/session/state.rs` — new CopilotState variants

**MODIFY:**
- `src-tauri/Cargo.toml` — add `screencapturekit`, `cpal`, `tokio-tungstenite`, `rubato`, `bytes` (5 deps)
- `src-tauri/src/copilot/mod.rs` — export new submodules; `init()` becomes `init_foundation()` and a new `init_listening()` is invoked from a session-start handler
- `src-tauri/src/copilot/state.rs` — extend `CopilotState` with the 4 new variants from §5; add `TranscriptBufferMutex` managed-state wrapper
- `src-tauri/src/lib.rs` — `.manage(TranscriptBufferMutex::default())`; new wolfee-action handlers `start-copilot-session`, `end-copilot-session`; soft-warning state checks for §9
- `src-tauri/src/tray.rs` — new menu items `Start Copilot Session` / `End Copilot Session` (replacing the placeholder "Set Up Copilot…" only when authed); session status row when `Listening` / `Reconnecting`
- `src-tauri/capabilities/default.json` — verify `core:event:default` is present (probably already is from Sub-prompt 1) for the permission Tauri event
- `entitlements.plist` — verify `com.apple.security.device.audio-input` present (from existing); no changes needed for ScreenCaptureKit (TCC handles it)
- `overlay/src/CopilotOverlay.tsx` — listen for `copilot-permission-needed` Tauri event, render the bare modal from §8; listen for `transcript-chunk` for live transcript prep (display polish in Sub-prompt 4)

**NOT TOUCHED (sacred — Sub-prompt 1 work):**
- `src-tauri/src/copilot/window.rs`, `hotkey.rs`
- `src-tauri/src/recorder.rs`, `uploader.rs`, `auth.rs`, existing `state.rs` (only adding fields, not modifying existing ones)
- `tauri.conf.json`
- `overlay/` build configuration

### Wolfee backend (`/Users/raunekpratap/Desktop/WOLFEE-MVP/`)

**NEW:**
- `server/lib/copilot/index.ts` — module exports
- `server/lib/copilot/deepgramAuth.ts` — `mintDeepgramJwt()`
- `server/lib/copilot/sessions.ts` — `createSession`, `endSession` helpers (Drizzle queries)
- `migrations/0006_add_copilot_sessions.sql` — `copilot_sessions` table

**MODIFY:**
- `server/routes.ts` — add `// ████████ COPILOT ████████` fenced block with 3 endpoints from §7
- `shared/schema.ts` — add `copilotSessions` table definition
- `server/storage.ts` — add `createCopilotSession`, `endCopilotSession`, `getCopilotSessionById` helpers
- `.env.example` — add `DEEPGRAM_API_KEY=`

**NOT TOUCHED:**
- Existing `routes.ts` blocks for devices, meetings, calendars
- `requireDeviceAuth` middleware
- Anything under `client/` (overlay UI is in the desktop repo, not the web client)

---

## 13 — Acceptance tests

For the execution agent to verify before declaring Sub-prompt 2 done.

### Backend

- [ ] `pnpm db:migrate` runs `0006_add_copilot_sessions.sql` cleanly against a fresh DB
- [ ] `POST /api/copilot/sessions` with valid `Authorization: Bearer <device-token>` returns `{sessionId, startedAt}` with 200
- [ ] Same call with bad token returns 401
- [ ] `POST /api/copilot/sessions/:id/deepgram-token` returns a valid JWT (decode + check `iss`/`exp` claims)
- [ ] `mintDeepgramJwt()` errors are surfaced as 503, not 500 — log the underlying Deepgram error
- [ ] `POST /api/copilot/sessions/:id/end` updates `endedAt` and `endReason`
- [ ] No `copilot_sessions` row missing the FK relationship

### Desktop — audio capture

- [ ] `cargo check` passes with the 5 new deps
- [ ] `pnpm tauri build --bundles app` produces a notarizable .app
- [ ] First-run mic permission prompt fires when user clicks `Start Copilot Session`
- [ ] First-run screen-recording prompt fires after mic granted
- [ ] If user denies either, the `copilot-permission-needed` Tauri event fires and the overlay's bare modal appears
- [ ] mic capture survives unplugging+replugging the default input device (re-acquires within 5 s)

### Desktop — Deepgram pipeline

- [ ] WebSocket connects to `wss://api.deepgram.com/v1/listen?...` with multichannel + linear16 params
- [ ] Audio frames sent at 250 ms cadence (verify via Wireshark or Deepgram dashboard)
- [ ] Final transcripts arrive within 1-2 s of speech
- [ ] `channel_index=0` transcripts → labeled `Rep`; `channel_index=1` → `Prospect`
- [ ] Mid-session network drop (kill WiFi for 5 s) → reconnects automatically; tray briefly shows reconnecting
- [ ] 60 s of network outage → session ends cleanly with "❌ Lost connection" status

### Desktop — transcript buffer

- [ ] After 90+ s of session, oldest utterance has been pruned from buffer
- [ ] `merged_view()` returns chronological order across both channels
- [ ] Partials never enter the buffer (verified via test that emits a partial then a final — buffer length increases by exactly 1)

### Desktop — state machine + UX

- [ ] `CopilotState` transitions: Idle → StartingSession → Listening → EndingSession → Idle, all logged
- [ ] Tray status row updates in real time as state changes
- [ ] Soft-warning text appears when starting Copilot while recorder is running, and vice versa
- [ ] Recorder still works end-to-end (regression test of the existing Notes flow)
- [ ] Sub-prompt 1's overlay window + ⌘⌥W still work unchanged

### 24-hour soak

- [ ] Run a 30-minute session, end cleanly. Repeat 4× over 24 hours. Verify no memory growth in the desktop process beyond ~50 MB above baseline. Verify all 4 sessions appear in `copilot_sessions` with correct `endedAt`.

---

## End of plan

**Total scope:** ~62 h focused agent work (likely), 80 h worst case.
**Files:** 11 new + 8 modified across 2 repos.
**Locked decisions:** 8 (one per major section).
**Open decisions for PO:** 8 (N1–N8), of which N1, N2, N3, N5 are blocking before execution starts.

No code modified. Plan not committed. Ready for PO review.
