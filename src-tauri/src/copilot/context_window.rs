//! Sub-prompt 4.5 (Cluely-style UX retune) context paste window.
//!
//! Programmatic Tauri 2 `WebviewWindowBuilder` — opens before each
//! Copilot session so the rep can paste 3 fields of context (about
//! self/company, about call, expected objections). Submitted context
//! is POSTed to the backend session-context endpoint and mirrored
//! into IntelligenceSessionState so all subsequent LLM prompts can
//! inject it.
//!
//! Window properties (per plan §2):
//!   - 600 × 500, system chrome (NOT frameless), resizable, always on
//!     top, content-protected (invisible during screen share)
//!   - URL: `index.html#/context` — single-bundle hash route into the
//!     same Vite project the overlay uses
//!   - Destroyed (not hidden) on submit/cancel — re-create on next
//!     session is cheap (~50ms) and eliminates stale-state risk
//!
//! Lifecycle: `open_context_window` is called from the
//! `start-copilot-session` action handler. The user submits or
//! cancels, which fires `submit_context` / `cancel_context` Tauri
//! commands defined in lib.rs. Both call `close_context_window` here.

use tauri::{AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const CONTEXT_WINDOW_LABEL: &str = "copilot-context";

const CONTEXT_WIDTH: f64 = 600.0;
const CONTEXT_HEIGHT: f64 = 500.0;

pub fn open_context_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(CONTEXT_WINDOW_LABEL) {
        // Already open (PO clicked Start Copilot Session twice rapidly).
        // Just bring it to front; don't recreate. set_focus is OK here
        // because the user expects the dialog to take focus — unlike
        // the overlay which deliberately avoids stealing focus.
        let _ = existing.set_focus();
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        CONTEXT_WINDOW_LABEL,
        WebviewUrl::App("index.html#/context".into()),
    )
    .title("Wolfee Copilot — Set Up Session")
    .decorations(true)
    .resizable(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .inner_size(CONTEXT_WIDTH, CONTEXT_HEIGHT)
    .visible(false)
    .build()?;

    // Same content protection as the overlay: a rep who pastes
    // context after starting screen-share shouldn't have prospects
    // see their notes about the call.
    if let Err(e) = window.set_content_protected(true) {
        log::error!("[Copilot] context_window: set_content_protected failed: {}", e);
    }

    position_center(&window);

    window.show()?;
    let _ = window.set_focus();

    log::info!("[Copilot] Context window opened");
    Ok(())
}

pub fn close_context_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(CONTEXT_WINDOW_LABEL) {
        match window.destroy() {
            Ok(_) => log::info!("[Copilot] Context window destroyed"),
            Err(e) => log::warn!("[Copilot] Context window destroy failed: {}", e),
        }
    }
}

pub fn is_context_window_open<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(CONTEXT_WINDOW_LABEL).is_some()
}

fn position_center<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let monitor = match window.current_monitor() {
        Ok(Some(m)) => m,
        _ => match window.primary_monitor() {
            Ok(Some(m)) => m,
            _ => {
                log::warn!("[Copilot] context_window: no monitor — using default position");
                return;
            }
        },
    };
    let monitor_size = monitor.size();
    let scale = monitor.scale_factor();
    let window_w_px = (CONTEXT_WIDTH * scale) as i32;
    let window_h_px = (CONTEXT_HEIGHT * scale) as i32;
    let x = (monitor_size.width as i32 - window_w_px) / 2;
    let y = (monitor_size.height as i32 - window_h_px) / 2;
    if let Err(e) = window.set_position(PhysicalPosition { x, y }) {
        log::warn!("[Copilot] context_window: set_position failed: {}", e);
    }
}
