use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopilotState {
    Idle,
    ShowingOverlay,
    Paused,
}

impl std::fmt::Display for CopilotState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Idle => write!(f, "idle"),
            Self::ShowingOverlay => write!(f, "showing-overlay"),
            Self::Paused => write!(f, "paused"),
        }
    }
}

pub struct CopilotStateMutex(pub Mutex<CopilotState>);

impl Default for CopilotStateMutex {
    fn default() -> Self {
        Self(Mutex::new(CopilotState::Idle))
    }
}
