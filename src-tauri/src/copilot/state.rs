use std::sync::Mutex;
use std::time::Instant;

use crate::copilot::transcribe::buffer::TranscriptBuffer;

/// Reason a Copilot session ended. Mirrors the closed enum the
/// backend's `POST /api/copilot/sessions/:id/end` accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEndReason {
    UserRequested,
    Failed,
    Timeout,
}

impl SessionEndReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::UserRequested => "user_requested",
            Self::Failed => "error",
            Self::Timeout => "timeout",
        }
    }
}

/// Top-level Copilot state machine. Sub-prompt 1 shipped Idle /
/// ShowingOverlay / Paused. Sub-prompt 2 adds the listening lifecycle
/// variants — they're mutually exclusive with ShowingOverlay/Paused at
/// runtime (the user can't be in a session AND have the overlay
/// dismissed; the overlay is the active surface during a session).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopilotState {
    /// No session, overlay hidden, hotkey idle. Default state.
    Idle,
    /// Overlay shown via ⌘⌥W, no session. Sub-prompt 1 surface.
    ShowingOverlay,
    /// User clicked Pause Copilot from the tray. Hotkey + moment
    /// detector (Sub-prompt 3) suppressed until resumed. Sub-prompt 1.
    Paused,

    // ── Sub-prompt 2 (Listening) lifecycle ─────────────────────────
    /// Session POST + JWT mint in flight.
    StartingSession {
        /// Client-generated UUID, included in POST /api/copilot/sessions.
        session_id: String,
    },
    /// Audio capture + Deepgram WS active.
    Listening {
        session_id: String,
        started_at: Instant,
    },
    /// WS dropped; reconnect attempts in flight. Audio capture keeps
    /// running and pushing into a bounded replay buffer.
    Reconnecting {
        session_id: String,
        attempt: u8,
    },
    /// `POST /api/copilot/sessions/:id/end` in flight. Audio capture
    /// already stopped.
    EndingSession {
        session_id: String,
        reason: SessionEndReason,
    },
}

impl std::fmt::Display for CopilotState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Idle => write!(f, "idle"),
            Self::ShowingOverlay => write!(f, "showing-overlay"),
            Self::Paused => write!(f, "paused"),
            Self::StartingSession { session_id } => write!(f, "starting-session({})", &session_id[..8.min(session_id.len())]),
            Self::Listening { session_id, .. } => write!(f, "listening({})", &session_id[..8.min(session_id.len())]),
            Self::Reconnecting { session_id, attempt } => write!(f, "reconnecting({}, attempt={attempt})", &session_id[..8.min(session_id.len())]),
            Self::EndingSession { session_id, reason } => write!(f, "ending-session({}, {})", &session_id[..8.min(session_id.len())], reason.as_str()),
        }
    }
}

pub struct CopilotStateMutex(pub Mutex<CopilotState>);

impl Default for CopilotStateMutex {
    fn default() -> Self {
        Self(Mutex::new(CopilotState::Idle))
    }
}

/// Tauri-managed state wrapper around the 90-s sliding-window
/// transcript buffer. Sub-prompt 3 reads via `app.state::<TranscriptBufferMutex>()`.
pub struct TranscriptBufferMutex(pub Mutex<TranscriptBuffer>);

impl Default for TranscriptBufferMutex {
    fn default() -> Self {
        Self(Mutex::new(TranscriptBuffer::with_default_window()))
    }
}

/// Tauri-managed state wrapper around the active audio capture handle.
/// `None` when no Copilot session is running. Set to `Some(capture)`
/// inside `start-copilot-session`; taken back out and stopped inside
/// `end-copilot-session`. Tokio Mutex (not std) because we hold the
/// guard across `await` points (CopilotAudioCapture::stop is async).
pub struct CopilotAudioCaptureMutex(
    pub tokio::sync::Mutex<Option<crate::copilot::audio::CopilotAudioCapture>>,
);

impl Default for CopilotAudioCaptureMutex {
    fn default() -> Self {
        Self(tokio::sync::Mutex::new(None))
    }
}
