//! Deepgram WebSocket client (Sub-prompt 2 — Listening, Phase 3).
//!
//! Owns the audio frame `Receiver` coming out of CopilotAudioCapture's
//! mux pump. Mints a Deepgram JWT via the backend, opens the WS,
//! forwards 16 kHz s16 stereo frames as Binary messages, and parses
//! the multichannel transcript JSON back into Utterances. Finals
//! enter `TranscriptBuffer` (Sub-prompt 3 reads it for moment
//! detection); partials + finals both emit `transcript-chunk` Tauri
//! events for the overlay UI in Sub-prompt 4.
//!
//! Resilience (plan §5 Option C — hybrid):
//! - audio capture keeps running through a disconnect; up to 20 frames
//!   (~5 s) buffered in a `VecDeque` for replay on reconnect
//! - exponential backoff: 0.5s, 1s, 2s, 4s, 8s capped
//! - after 4 attempts (~16 s) tray flips to `⚠️ Reconnecting…`
//! - after 60 s of failed reconnects the session ends with
//!   `PersistentFailure`; the wrapper emits both
//!   `copilot-session-failed` (for UI toast) and `wolfee-action:
//!   end-copilot-session` (so the lib.rs handler tears down capture +
//!   notifies backend)
//!
//! JWT refresh (plan §4):
//! - check every 60 s; when `expires_at - now < 5 min` we close the WS
//!   gracefully and re-mint, then reconnect with the fresh token
//!
//! Runtime ownership: spawned on `tauri::async_runtime::spawn` (NOT
//! raw `tokio::spawn`). See the comment on `lib.rs::start-copilot-
//! session` and the 2026-05-02 verification report for the runtime-
//! cancellation lesson learned in Phase 5.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::net::TcpStream;
use tokio::sync::mpsc::Receiver;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::copilot::audio::AudioFrame;
use crate::copilot::session::api::{SessionApi, SessionApiError};
use crate::copilot::state::{CopilotState, CopilotStateMutex, TranscriptBufferMutex};
use crate::copilot::transcribe::buffer::{ChannelLabel, Utterance};

/// URL params locked in plan §3. Audio format must match what the mux
/// pump produces (16 kHz int16 stereo, multichannel so each channel
/// gets its own transcript).
const DEEPGRAM_WS_URL: &str = "wss://api.deepgram.com/v1/listen\
    ?encoding=linear16\
    &sample_rate=16000\
    &channels=2\
    &multichannel=true\
    &model=nova-3\
    &language=en-US\
    &punctuate=true\
    &interim_results=true\
    &endpointing=300";

const REPLAY_BUFFER_CAP: usize = 20; // ~5 s at 250 ms cadence
const PERSISTENT_FAILURE_TIMEOUT: Duration = Duration::from_secs(60);
const RECONNECT_TRAY_THRESHOLD: u32 = 4;
const BACKOFFS_MS: [u64; 5] = [500, 1_000, 2_000, 4_000, 8_000];
const JWT_REFRESH_THRESHOLD: Duration = Duration::from_secs(5 * 60);
const JWT_CHECK_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub enum DeepgramClientError {
    /// Initial JWT mint failed — never made it to listening. Caller
    /// should end the session cleanly.
    Auth(SessionApiError),
    /// Initial WS handshake failed (most often: bad JWT, wrong scopes,
    /// upstream Deepgram outage). Non-recoverable for this attempt.
    InitialConnect(String),
    /// 60 s of failed reconnects after a previously-good connection.
    PersistentFailure,
}

impl std::fmt::Display for DeepgramClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Auth(e) => write!(f, "auth: {e}"),
            Self::InitialConnect(s) => write!(f, "initial connect: {s}"),
            Self::PersistentFailure => {
                write!(f, "persistent failure (60s of failed reconnects)")
            }
        }
    }
}

impl std::error::Error for DeepgramClientError {}

/// Tauri event payload for both partials and finals — Sub-prompt 4
/// will subscribe and render the live transcript in the overlay.
#[derive(Debug, Clone, Serialize)]
pub struct TranscriptChunkPayload {
    pub session_id: String,
    pub channel: &'static str,
    pub is_final: bool,
    pub transcript: String,
    pub confidence: f32,
    pub started_at_ms: u64,
    pub ended_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct CopilotSessionFailedPayload {
    session_id: String,
    reason: String,
}

/// Top-level Deepgram message envelope. We only act on `Results`;
/// `Metadata` / `SpeechStarted` / `UtteranceEnd` types are ignored.
#[derive(Debug, Deserialize)]
struct DeepgramMessage {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    #[serde(default)]
    channel_index: Vec<u32>,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    start: f64,
    #[serde(default)]
    is_final: bool,
    channel: Option<DeepgramChannel>,
}

#[derive(Debug, Deserialize)]
struct DeepgramChannel {
    alternatives: Vec<DeepgramAlternative>,
}

#[derive(Debug, Deserialize)]
struct DeepgramAlternative {
    transcript: String,
    #[serde(default)]
    confidence: f32,
}

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Reason an active WS session ended — drives the next iteration of
/// the outer reconnect loop in `run_client`.
enum SessionOutcome {
    /// Audio rx closed → caller stopped capture → exit cleanly.
    AudioRxClosed,
    /// JWT is in the refresh window → graceful reconnect with a fresh
    /// token.
    JwtRefreshNeeded,
    /// WS errored or remote-closed → backoff + reconnect.
    Disconnected(String),
}

pub struct DeepgramClient;

impl DeepgramClient {
    /// Spawn the long-running client task. The returned `JoinHandle`
    /// resolves to `()` — terminal failures are surfaced via the
    /// `copilot-session-failed` and `wolfee-action: end-copilot-session`
    /// Tauri events instead, so the caller can drop the handle.
    pub fn spawn<R: Runtime>(
        session_id: String,
        api: Arc<SessionApi>,
        audio_rx: Receiver<AudioFrame>,
        app_handle: AppHandle<R>,
    ) -> tauri::async_runtime::JoinHandle<()> {
        tauri::async_runtime::spawn(async move {
            let result =
                run_client(session_id.clone(), api, audio_rx, app_handle.clone()).await;
            match result {
                Ok(()) => {
                    log::info!("[Copilot/dg] client exited cleanly");
                }
                Err(e) => {
                    log::error!("[Copilot/dg] client failed: {}", e);
                    let _ = app_handle.emit(
                        "copilot-session-failed",
                        &CopilotSessionFailedPayload {
                            session_id: session_id.clone(),
                            reason: format!("{}", e),
                        },
                    );
                    // Trigger the same teardown path as the user
                    // clicking End Copilot Session — stops capture,
                    // notifies backend, returns state to Idle.
                    let _ = app_handle.emit("wolfee-action", "end-copilot-session");
                }
            }
        })
    }
}

async fn run_client<R: Runtime>(
    session_id: String,
    api: Arc<SessionApi>,
    mut audio_rx: Receiver<AudioFrame>,
    app_handle: AppHandle<R>,
) -> Result<(), DeepgramClientError> {
    let mut replay: VecDeque<AudioFrame> = VecDeque::with_capacity(REPLAY_BUFFER_CAP);
    let mut reconnect_started: Option<Instant> = None;
    let mut attempt: u32 = 0;
    let mut is_initial = true;

    loop {
        // ── 1. Mint JWT ─────────────────────────────────────────
        let token = match api.fetch_deepgram_token(&session_id).await {
            Ok(t) => t,
            Err(e) => {
                if is_initial {
                    return Err(DeepgramClientError::Auth(e));
                }
                log::warn!("[Copilot/dg] reconnect JWT mint failed: {}", e);
                backoff_and_check_persistent(
                    &mut attempt,
                    &mut reconnect_started,
                    &session_id,
                    &app_handle,
                    &mut audio_rx,
                    &mut replay,
                )
                .await?;
                continue;
            }
        };

        let expires_at = chrono::DateTime::parse_from_rfc3339(&token.expires_at)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now() + chrono::Duration::seconds(3600));
        log::info!(
            "[Copilot/dg] JWT minted, expires_at={} (soft_cap_hit={}, minutes_used_today={})",
            token.expires_at,
            token.soft_cap_hit,
            token.minutes_used_today
        );
        if token.soft_cap_hit {
            log::warn!(
                "[Copilot/dg] daily 4-hour soft cap reached \
                 (minutes_used_today={}); session continues but cost \
                 cap is in play",
                token.minutes_used_today
            );
        }

        // ── 2. Connect WS ───────────────────────────────────────
        let ws = match connect_deepgram(&token.jwt).await {
            Ok(ws) => ws,
            Err(e) => {
                if is_initial {
                    return Err(DeepgramClientError::InitialConnect(e));
                }
                log::warn!("[Copilot/dg] reconnect WS connect failed: {}", e);
                backoff_and_check_persistent(
                    &mut attempt,
                    &mut reconnect_started,
                    &session_id,
                    &app_handle,
                    &mut audio_rx,
                    &mut replay,
                )
                .await?;
                continue;
            }
        };
        log::info!("[Copilot/dg] connected to Deepgram");

        // Recovered from a reconnect → tell the tray we're listening
        // again. Replay log fires before frames go out so timing is
        // visible in case the replay itself fails.
        if reconnect_started.is_some() {
            log::info!(
                "[Copilot/dg] reconnected, replaying {} buffered frames",
                replay.len()
            );
            transition_back_to_listening(&app_handle, &session_id);
        }
        reconnect_started = None;
        attempt = 0;
        is_initial = false;

        // ── 3. Run send/recv loop ───────────────────────────────
        let outcome = run_ws_session(
            ws,
            &mut audio_rx,
            &mut replay,
            &app_handle,
            &session_id,
            expires_at,
        )
        .await;

        match outcome {
            SessionOutcome::AudioRxClosed => return Ok(()),
            SessionOutcome::JwtRefreshNeeded => {
                log::info!("[Copilot/dg] JWT refresh window — minting new token");
                continue;
            }
            SessionOutcome::Disconnected(reason) => {
                log::warn!("[Copilot/dg] WS disconnected ({}) — reconnecting", reason);
                if reconnect_started.is_none() {
                    reconnect_started = Some(Instant::now());
                }
                backoff_and_check_persistent(
                    &mut attempt,
                    &mut reconnect_started,
                    &session_id,
                    &app_handle,
                    &mut audio_rx,
                    &mut replay,
                )
                .await?;
                continue;
            }
        }
    }
}

async fn connect_deepgram(jwt: &str) -> Result<WsStream, String> {
    let mut request = DEEPGRAM_WS_URL
        .into_client_request()
        .map_err(|e| e.to_string())?;
    let auth = format!("Bearer {}", jwt)
        .parse()
        .map_err(|e: tokio_tungstenite::tungstenite::http::header::InvalidHeaderValue| {
            e.to_string()
        })?;
    request.headers_mut().insert("authorization", auth);

    let (ws, _resp) = connect_async(request).await.map_err(|e| e.to_string())?;
    Ok(ws)
}

async fn run_ws_session<R: Runtime>(
    ws: WsStream,
    audio_rx: &mut Receiver<AudioFrame>,
    replay: &mut VecDeque<AudioFrame>,
    app_handle: &AppHandle<R>,
    session_id: &str,
    expires_at: DateTime<Utc>,
) -> SessionOutcome {
    let (mut ws_sink, mut ws_stream) = ws.split();

    // Drain anything we buffered while disconnected. If a replay frame
    // fails to send we put it back at the front and report Disconnected
    // so the outer loop will retry after a backoff.
    while let Some(frame) = replay.pop_front() {
        let bytes = encode_frame(&frame);
        if let Err(e) = ws_sink.send(Message::Binary(bytes)).await {
            replay.push_front(frame);
            return SessionOutcome::Disconnected(format!("replay send: {e}"));
        }
    }

    let mut jwt_check = tokio::time::interval(JWT_CHECK_INTERVAL);
    jwt_check.tick().await; // skip the immediate first tick

    // 5-second rolling diagnostic on the bytes leaving for Deepgram.
    // Mirrors the Phase 5 spawn_frame_logger (now removed) but at the
    // WS-send boundary instead of the mux output, so we can confirm
    // that what Deepgram receives actually has L=mic populated. If
    // mic_nonzero is true here but no `final (user, ...)` lines come
    // back, the mux's L/R interleave is wrong; if mic_nonzero is
    // false, the mic stream itself is bad.
    let mut diag_count: u64 = 0;
    let mut diag_bytes: u64 = 0;
    let mut diag_mic_nonzero = false;
    let mut diag_sys_nonzero = false;
    let mut diag_last_log = Instant::now();

    loop {
        tokio::select! {
            biased;

            frame = audio_rx.recv() => {
                match frame {
                    Some(f) => {
                        // Diagnostic: scan even-indexed samples (L = mic =
                        // user) and odd-indexed (R = system audio =
                        // speakers). Break early once both channels seen.
                        for (i, &s) in f.pcm_s16le_stereo.iter().enumerate() {
                            if s != 0 {
                                if i % 2 == 0 { diag_mic_nonzero = true; }
                                else { diag_sys_nonzero = true; }
                                if diag_mic_nonzero && diag_sys_nonzero { break; }
                            }
                        }
                        diag_count += 1;
                        diag_bytes += (f.pcm_s16le_stereo.len() * 2) as u64;
                        if diag_last_log.elapsed().as_secs() >= 5 {
                            log::info!(
                                "[Copilot/dg] ws-send frames in last 5s: {} ({} KB), \
                                 mic_nonzero={}, system_nonzero={}",
                                diag_count,
                                diag_bytes / 1024,
                                diag_mic_nonzero,
                                diag_sys_nonzero
                            );
                            diag_count = 0;
                            diag_bytes = 0;
                            diag_mic_nonzero = false;
                            diag_sys_nonzero = false;
                            diag_last_log = Instant::now();
                        }

                        let bytes = encode_frame(&f);
                        // Buffer for replay BEFORE sending so a send-time
                        // disconnect doesn't lose the in-flight frame.
                        push_replay(replay, f);
                        if let Err(e) = ws_sink.send(Message::Binary(bytes)).await {
                            return SessionOutcome::Disconnected(format!("send: {e}"));
                        }
                        // Successful send → drop the in-flight copy from replay.
                        replay.pop_back();
                    }
                    None => {
                        let _ = ws_sink.send(Message::Close(None)).await;
                        return SessionOutcome::AudioRxClosed;
                    }
                }
            }

            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_message(&text, app_handle, session_id);
                    }
                    Some(Ok(Message::Close(_))) => {
                        return SessionOutcome::Disconnected("server close".into());
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = ws_sink.send(Message::Pong(p)).await;
                    }
                    Some(Ok(_)) => {
                        // Pong / Binary / Frame — no-op
                    }
                    Some(Err(e)) => {
                        return SessionOutcome::Disconnected(format!("recv: {e}"));
                    }
                    None => {
                        return SessionOutcome::Disconnected("stream ended".into());
                    }
                }
            }

            _ = jwt_check.tick() => {
                let remaining = expires_at.signed_duration_since(Utc::now());
                let needs_refresh = remaining
                    .to_std()
                    .map(|d| d < JWT_REFRESH_THRESHOLD)
                    .unwrap_or(true); // already expired
                if needs_refresh {
                    let _ = ws_sink.send(Message::Close(None)).await;
                    return SessionOutcome::JwtRefreshNeeded;
                }
            }
        }
    }
}

fn push_replay(replay: &mut VecDeque<AudioFrame>, frame: AudioFrame) {
    if replay.len() >= REPLAY_BUFFER_CAP {
        replay.pop_front();
    }
    replay.push_back(frame);
}

fn encode_frame(frame: &AudioFrame) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(frame.pcm_s16le_stereo.len() * 2);
    for s in &frame.pcm_s16le_stereo {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}

fn handle_message<R: Runtime>(text: &str, app_handle: &AppHandle<R>, session_id: &str) {
    let msg: DeepgramMessage = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            log::debug!("[Copilot/dg] message parse failed ({}): {}", e, text);
            return;
        }
    };

    if msg.msg_type.as_deref() != Some("Results") {
        return;
    }

    let Some(channel) = msg.channel else { return };
    let Some(alt) = channel.alternatives.into_iter().next() else { return };

    if alt.transcript.trim().is_empty() {
        return;
    }

    let channel_idx = msg.channel_index.first().copied().unwrap_or(0);
    let Some(channel_label) = ChannelLabel::from_deepgram_channel_index(channel_idx) else {
        return;
    };

    let started_at_ms = (msg.start * 1000.0) as u64;
    let ended_at_ms = ((msg.start + msg.duration) * 1000.0) as u64;

    let payload = TranscriptChunkPayload {
        session_id: session_id.to_string(),
        channel: channel_label.as_str(),
        is_final: msg.is_final,
        transcript: alt.transcript.clone(),
        confidence: alt.confidence,
        started_at_ms,
        ended_at_ms,
    };

    if let Err(e) = app_handle.emit("transcript-chunk", &payload) {
        log::warn!("[Copilot/dg] transcript-chunk emit failed: {}", e);
    }

    if msg.is_final {
        log::info!(
            "[Copilot/dg] final ({}, {:.2}): {}",
            channel_label.as_str(),
            alt.confidence,
            alt.transcript
        );
        let utterance = Utterance {
            channel: channel_label,
            started_at_ms,
            ended_at_ms,
            text: alt.transcript,
            confidence: alt.confidence,
            recorded_at: Instant::now(),
        };
        if let Ok(mut buf) = app_handle.state::<TranscriptBufferMutex>().0.lock() {
            buf.append(utterance);
        }
    }
}

/// Sleep for the next backoff interval while still draining audio
/// frames into the replay buffer. Returns `Err(PersistentFailure)` if
/// the 60 s window has elapsed; `Ok(())` otherwise so the caller
/// retries.
async fn backoff_and_check_persistent<R: Runtime>(
    attempt: &mut u32,
    reconnect_started: &mut Option<Instant>,
    session_id: &str,
    app_handle: &AppHandle<R>,
    audio_rx: &mut Receiver<AudioFrame>,
    replay: &mut VecDeque<AudioFrame>,
) -> Result<(), DeepgramClientError> {
    *attempt += 1;
    let started = *reconnect_started.get_or_insert_with(Instant::now);

    if started.elapsed() >= PERSISTENT_FAILURE_TIMEOUT {
        log::error!(
            "[Copilot/dg] persistent failure after {}s, ending session",
            started.elapsed().as_secs()
        );
        return Err(DeepgramClientError::PersistentFailure);
    }

    if *attempt >= RECONNECT_TRAY_THRESHOLD {
        transition_to_reconnecting(app_handle, session_id, *attempt);
    }

    let backoff_idx = ((*attempt as usize).saturating_sub(1)).min(BACKOFFS_MS.len() - 1);
    let backoff = Duration::from_millis(BACKOFFS_MS[backoff_idx]);
    log::info!(
        "[Copilot/dg] reconnect attempt {} after {}ms backoff",
        attempt,
        backoff.as_millis()
    );

    drain_during_sleep(audio_rx, replay, backoff).await;
    Ok(())
}

fn transition_to_reconnecting<R: Runtime>(
    app_handle: &AppHandle<R>,
    session_id: &str,
    attempt: u32,
) {
    let state_mutex = app_handle.state::<CopilotStateMutex>();
    let mut s = state_mutex.0.lock().unwrap();
    if !matches!(*s, CopilotState::Reconnecting { .. }) {
        *s = CopilotState::Reconnecting {
            session_id: session_id.to_string(),
            attempt: attempt.min(u8::MAX as u32) as u8,
        };
        drop(s);
        // Ask lib.rs to repaint the tray now that the state moved.
        let _ = app_handle.emit("wolfee-action", "refresh-copilot-tray");
    }
}

fn transition_back_to_listening<R: Runtime>(app_handle: &AppHandle<R>, session_id: &str) {
    let state_mutex = app_handle.state::<CopilotStateMutex>();
    let mut s = state_mutex.0.lock().unwrap();
    if matches!(*s, CopilotState::Reconnecting { .. }) {
        *s = CopilotState::Listening {
            session_id: session_id.to_string(),
            started_at: Instant::now(),
        };
        drop(s);
        let _ = app_handle.emit("wolfee-action", "refresh-copilot-tray");
    }
}

async fn drain_during_sleep(
    audio_rx: &mut Receiver<AudioFrame>,
    replay: &mut VecDeque<AudioFrame>,
    duration: Duration,
) {
    let deadline = Instant::now() + duration;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return;
        }
        tokio::select! {
            biased;
            frame = audio_rx.recv() => {
                match frame {
                    Some(f) => push_replay(replay, f),
                    None => return, // capture stopped — outer loop will exit
                }
            }
            _ = tokio::time::sleep(remaining) => return,
        }
    }
}
