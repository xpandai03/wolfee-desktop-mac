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
}
