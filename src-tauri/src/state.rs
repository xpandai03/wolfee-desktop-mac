use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingState {
    Idle,
    Recording,
    Stopping,
    Uploading,
    Complete,
}

/// User-visible status of the device-pairing flow.
///
/// Surfaces in the tray so the user sees what `auth::poll_link_status` is
/// actually doing — fixing the silent-failure UX gap (yesterday's diagnosis
/// §5.2 / T2). `JustLinked` is shown briefly after success then cleared
/// back to `Idle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkingStatus {
    Idle,
    InProgress,
    JustLinked,
    Failed,
}

/// User-visible status of the post-recording upload flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadStatus {
    Idle,
    InProgress,
    JustUploaded,
    SkippedNoAuth,
    Failed,
}

/// Loom-style screen recorder pipeline state (Phase 1).
///
/// Deliberately separate from `RecordingState` (the legacy audio
/// recorder): the two pipelines never share a lock, a tray row, or a
/// state transition, so re-lighting one cannot regress the other.
///
/// Flow: `Idle → Countdown → Recording → Stopping → Uploading →
/// Complete → Idle`. `Failed` is reachable from any active state and
/// is sticky until the user dismisses it or starts a new recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoomState {
    Idle,
    Countdown,
    Recording,
    Stopping,
    Uploading,
    /// Recording finished and saved locally, but the user isn't linked
    /// to a Wolfee account so it can't be uploaded yet. The Record tab
    /// surfaces an inline "Link account" action; linking auto-retries.
    NeedsLink,
    Complete,
    Failed,
}

impl std::fmt::Display for LoomState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Idle => write!(f, "idle"),
            Self::Countdown => write!(f, "countdown"),
            Self::Recording => write!(f, "recording"),
            Self::Stopping => write!(f, "stopping"),
            Self::Uploading => write!(f, "uploading"),
            Self::NeedsLink => write!(f, "needslink"),
            Self::Complete => write!(f, "complete"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

/// A finished recording waiting to be uploaded — kept so that linking
/// an account can retry the upload without re-recording.
#[derive(Debug, Clone)]
pub struct PendingUpload {
    pub path: String,
    pub duration_secs: f64,
    pub size_bytes: u64,
}

impl LoomState {
    /// True while a recording or upload is actively in flight — used to
    /// reject a second "Record Screen" click.
    pub fn is_busy(&self) -> bool {
        matches!(
            self,
            Self::Countdown | Self::Recording | Self::Stopping | Self::Uploading
        )
    }
}

impl std::fmt::Display for RecordingState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Idle => write!(f, "idle"),
            Self::Recording => write!(f, "recording"),
            Self::Stopping => write!(f, "stopping"),
            Self::Uploading => write!(f, "uploading"),
            Self::Complete => write!(f, "complete"),
        }
    }
}

impl RecordingState {
    pub fn can_transition_to(&self, next: RecordingState) -> bool {
        matches!(
            (self, next),
            (Self::Idle, RecordingState::Recording)
                | (Self::Recording, RecordingState::Stopping)
                | (Self::Stopping, RecordingState::Uploading)
                | (Self::Stopping, RecordingState::Idle)
                | (Self::Uploading, RecordingState::Complete)
                | (Self::Uploading, RecordingState::Idle)
                | (Self::Complete, RecordingState::Idle)
        )
    }
}

pub struct AppState {
    pub recording_state: Mutex<RecordingState>,
    pub auth_token: Mutex<Option<String>>,
    pub user_id: Mutex<Option<String>>,
    pub device_id: Mutex<String>,
    pub current_recording_path: Mutex<Option<String>>,
    pub recording_start_time: Mutex<Option<std::time::Instant>>,
    /// Linking flow status — drives the tray "🔄 Linking…" / "❌ Link failed" rows.
    pub linking_status: Mutex<LinkingStatus>,
    /// Upload flow status — drives the tray "🔄 Uploading…" / "✅ Uploaded" /
    /// "⚠️ Saved locally — link to upload" / "❌ Upload failed" rows.
    pub upload_status: Mutex<UploadStatus>,

    // ── Loom screen recorder (Phase 1) ──────────────────────────────
    /// Current Loom recorder pipeline state.
    pub loom_state: Mutex<LoomState>,
    /// Shareable wolfee.io/v/<shortId> URL of the most recent upload.
    pub loom_share_url: Mutex<Option<String>>,
    /// Human-readable error from the last failed Loom recording/upload.
    pub loom_error: Mutex<Option<String>>,
    /// A finished recording waiting on a linked account before it can
    /// upload. Set when a recording stops with no auth token; cleared
    /// once the upload completes (or is dismissed).
    pub loom_pending_upload: Mutex<Option<PendingUpload>>,
    /// Phase 1 Teleprompter — the user's script, staged by the panel
    /// before they click Start Recording. The `loom-record-screen`
    /// arm reads this after `ScreenRecorder::start` returns Ok and
    /// emits `copilot-teleprompter-open` to the overlay. Cleared on
    /// stop / discard / failure so a subsequent recording doesn't
    /// inherit a stale script.
    pub teleprompter_script: Mutex<Option<String>>,
    /// Phase 2 — active-paragraph font size in px (24 / 28 / 32).
    /// Set from the panel's segmented control; persists across
    /// recordings (preference, not session state).
    pub teleprompter_font_size: Mutex<i32>,
    /// Phase 3 — whether the overlay's auto-scroll timer is on by
    /// default when a recording starts. The footer pill can flip it
    /// mid-recording; this is just the starting value.
    pub teleprompter_auto_scroll: Mutex<bool>,
    /// Phase 3 — reading-pace words per minute for the auto-scroll
    /// timer. Range 80–220, default 130.
    pub teleprompter_wpm: Mutex<i32>,
}

impl AppState {
    pub fn transition_to(&self, next: RecordingState) -> Result<(), String> {
        let mut state = self.recording_state.lock().unwrap();
        if state.can_transition_to(next) {
            log::info!("[State] {} -> {}", *state, next);
            *state = next;
            Ok(())
        } else {
            let msg = format!("Invalid transition: {} -> {}", *state, next);
            log::warn!("[State] {}", msg);
            Err(msg)
        }
    }

    pub fn reset(&self) {
        let mut state = self.recording_state.lock().unwrap();
        log::info!("[State] Reset: {} -> idle", *state);
        *state = RecordingState::Idle;
    }

    pub fn current_state(&self) -> RecordingState {
        *self.recording_state.lock().unwrap()
    }

    pub fn set_linking_status(&self, s: LinkingStatus) {
        *self.linking_status.lock().unwrap() = s;
    }

    pub fn set_upload_status(&self, s: UploadStatus) {
        *self.upload_status.lock().unwrap() = s;
    }

    // ── Loom screen recorder helpers ────────────────────────────────

    pub fn loom_state(&self) -> LoomState {
        *self.loom_state.lock().unwrap()
    }

    pub fn set_loom_state(&self, s: LoomState) {
        log::info!("[Loom/State] -> {}", s);
        *self.loom_state.lock().unwrap() = s;
    }

    pub fn loom_share_url(&self) -> Option<String> {
        self.loom_share_url.lock().unwrap().clone()
    }
}
