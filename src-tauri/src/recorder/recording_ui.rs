//! In-recording UI windows (recorder — iteration 4).
//!
//! Two small content-protected webview windows:
//!
//! - **Countdown** (`#/countdown`) — a 3-2-1 overlay shown centered on
//!   screen before capture starts.
//! - **Control bar** (`#/control-bar`) — a floating bar (timer +
//!   pause / restart / stop / discard) shown for the duration of a
//!   recording.
//!
//! Both are `set_content_protected(true)` so ScreenCaptureKit excludes
//! them from the recording — the opposite of the webcam bubble.
//!
//! All open/close calls are dispatched onto the main thread via
//! `run_on_main_thread`, so they are safe to invoke from the
//! background task that drives the recording flow.

use tauri::{
    AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder,
};

pub const COUNTDOWN_LABEL: &str = "countdown";
pub const CONTROL_BAR_LABEL: &str = "control-bar";

const COUNTDOWN_SIZE: f64 = 260.0;
const CONTROL_BAR_W: f64 = 340.0;
const CONTROL_BAR_H: f64 = 64.0;

// ── Countdown ───────────────────────────────────────────────────────

/// Show the 3-2-1 countdown overlay (centered, hidden from capture).
pub fn open_countdown<R: Runtime>(app: &AppHandle<R>) {
    let a = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Err(e) = build_countdown(&a) {
            log::error!("[Countdown] build failed: {e}");
        }
    }) {
        log::error!("[Countdown] dispatch failed: {e}");
    }
}

/// Destroy the countdown overlay.
pub fn close_countdown<R: Runtime>(app: &AppHandle<R>) {
    destroy(app, COUNTDOWN_LABEL);
}

fn build_countdown<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(COUNTDOWN_LABEL).is_some() {
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        app,
        COUNTDOWN_LABEL,
        WebviewUrl::App("index.html#/countdown".into()),
    )
    .title("Wolfee")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(false)
    .inner_size(COUNTDOWN_SIZE, COUNTDOWN_SIZE)
    .visible(false)
    .build()?;

    // Hidden from the recording — viewers shouldn't see "3 2 1".
    if let Err(e) = window.set_content_protected(true) {
        log::warn!("[Countdown] set_content_protected failed: {e}");
    }
    // Purely visual: clicks pass straight through to whatever is behind,
    // so the countdown can never be dismissed or interrupted by a click.
    if let Err(e) = window.set_ignore_cursor_events(true) {
        log::warn!("[Countdown] set_ignore_cursor_events failed: {e}");
    }
    center(&window, COUNTDOWN_SIZE, COUNTDOWN_SIZE);
    window.show()?;
    Ok(())
}

// ── Control bar ─────────────────────────────────────────────────────

/// Show the floating recording control bar (bottom-center, hidden from
/// capture).
pub fn open_control_bar<R: Runtime>(app: &AppHandle<R>) {
    let a = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Err(e) = build_control_bar(&a) {
            log::error!("[ControlBar] build failed: {e}");
        }
    }) {
        log::error!("[ControlBar] dispatch failed: {e}");
    }
}

/// Destroy the control bar.
pub fn close_control_bar<R: Runtime>(app: &AppHandle<R>) {
    destroy(app, CONTROL_BAR_LABEL);
}

fn build_control_bar<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(CONTROL_BAR_LABEL).is_some() {
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(
        app,
        CONTROL_BAR_LABEL,
        WebviewUrl::App("index.html#/control-bar".into()),
    )
    .title("Wolfee Recording")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .focused(false)
    .inner_size(CONTROL_BAR_W, CONTROL_BAR_H)
    .visible(false)
    .build()?;

    // Content-protected so the bar itself is never in the recording.
    if let Err(e) = window.set_content_protected(true) {
        log::warn!("[ControlBar] set_content_protected failed: {e}");
    }

    // Remember where the user drags it: persist the position on every
    // move so the next recording reopens the bar in the same spot.
    window.on_window_event(|event| {
        if let tauri::WindowEvent::Moved(pos) = event {
            let _ = std::fs::write(
                control_bar_pos_file(),
                format!("{},{}", pos.x, pos.y),
            );
        }
    });

    position_control_bar(&window);
    window.show()?;
    Ok(())
}

/// File holding the control bar's last dragged position ("x,y").
fn control_bar_pos_file() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("io.wolfee.desktop")
        .join("controlbar.pos")
}

// ── Shared helpers ──────────────────────────────────────────────────

fn destroy<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let a = app.clone();
    let label = label.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = a.get_webview_window(&label) {
            let _ = window.destroy();
        }
    });
}

fn center<R: Runtime>(window: &tauri::WebviewWindow<R>, w: f64, h: f64) {
    if let Ok(Some(m)) = window.primary_monitor() {
        let scale = m.scale_factor();
        let size = m.size();
        let pos = m.position();
        let x = pos.x + ((size.width as i32) - (w * scale) as i32) / 2;
        let y = pos.y + ((size.height as i32) - (h * scale) as i32) / 2;
        let _ = window.set_position(PhysicalPosition { x, y });
    }
}

/// Place the control bar: top-center by default (below the menu bar,
/// clear of bottom-anchored utility apps like Wispr Flow), or the
/// user's last dragged position if it's still on-screen.
fn position_control_bar<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let Ok(Some(m)) = window.primary_monitor() else {
        return;
    };
    let scale = m.scale_factor();
    let size = m.size();
    let pos = m.position();
    let wp = (CONTROL_BAR_W * scale) as i32;
    let hp = (CONTROL_BAR_H * scale) as i32;

    let default_x = pos.x + ((size.width as i32) - wp) / 2;
    let default_y = pos.y + (36.0 * scale) as i32;

    // Restore the saved position only if it still lands on-screen, so a
    // stale value (e.g. monitor unplugged) can't strand the bar.
    let restored = std::fs::read_to_string(control_bar_pos_file())
        .ok()
        .and_then(|s| {
            let mut parts = s.trim().split(',');
            let x: i32 = parts.next()?.trim().parse().ok()?;
            let y: i32 = parts.next()?.trim().parse().ok()?;
            let on_screen = x + wp > pos.x
                && x < pos.x + size.width as i32
                && y + hp > pos.y
                && y < pos.y + size.height as i32;
            if on_screen {
                Some((x, y))
            } else {
                None
            }
        });

    let (x, y) = restored.unwrap_or((default_x, default_y));
    let _ = window.set_position(PhysicalPosition { x, y });
}
