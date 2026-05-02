//! Wolfee Copilot module.
//!
//! Sub-prompt 1 (Foundation): content-protected overlay window + global hotkey.
//! Audio capture, LLM calls, CRM, and active-call detection arrive in
//! Sub-prompts 2 / 3 / 5 / 6 respectively.

pub mod audio;
pub mod hotkey;
pub mod state;
pub mod transcribe;
pub mod window;

use tauri::{AppHandle, Runtime};

/// Initialize Copilot for the running Tauri app.
///
/// Creates the (hidden) overlay window and registers the global hotkey.
/// State is managed externally — register `CopilotStateMutex` via
/// `app.manage(...)` in the builder.
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    window::create_overlay_window(app)?;
    hotkey::register(app)?;
    log::info!("[Copilot] Foundation initialized — overlay window + hotkey ready");
    Ok(())
}
