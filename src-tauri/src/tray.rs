use tauri::{
    image::Image,
    AppHandle, Runtime,
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    Emitter,
};

use crate::state::RecordingState;

/// Generate a 22x22 circle icon as raw RGBA bytes.
/// macOS menu bar icons are typically 22x22 (or 18x18) at 1x.
fn make_circle_icon(r: u8, g: u8, b: u8) -> Vec<u8> {
    let size: u32 = 22;
    let mut pixels = Vec::with_capacity((size * size * 4) as usize);
    let cx = size as f32 / 2.0;
    let cy = size as f32 / 2.0;
    let radius = (size as f32 / 2.0) - 2.0;

    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist <= radius {
                pixels.extend_from_slice(&[r, g, b, 255]);
            } else if dist <= radius + 1.0 {
                // Anti-aliased edge
                let alpha = ((radius + 1.0 - dist) * 255.0) as u8;
                pixels.extend_from_slice(&[r, g, b, alpha]);
            } else {
                pixels.extend_from_slice(&[0, 0, 0, 0]);
            }
        }
    }
    pixels
}

fn icon_for_state(state: RecordingState) -> Image<'static> {
    let (r, g, b) = match state {
        RecordingState::Recording => (255, 59, 48),   // Red
        RecordingState::Stopping => (255, 149, 0),     // Orange
        RecordingState::Uploading => (0, 122, 255),    // Blue
        RecordingState::Complete => (52, 199, 89),     // Green
        RecordingState::Idle => (142, 142, 147),       // Gray
    };
    let pixels = make_circle_icon(r, g, b);
    Image::new_owned(pixels, 22, 22)
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> Result<TrayIcon<R>, tauri::Error> {
    let icon = icon_for_state(RecordingState::Idle);
    let tray = TrayIconBuilder::new()
        .tooltip("Wolfee Desktop")
        .icon(icon)
        .menu(&build_menu(app, RecordingState::Idle, false)?)
        .on_menu_event(move |app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .build(app)?;

    Ok(tray)
}

pub fn update_tray_menu<R: Runtime>(
    tray: &TrayIcon<R>,
    app: &AppHandle<R>,
    state: RecordingState,
    is_authenticated: bool,
) {
    if let Ok(menu) = build_menu(app, state, is_authenticated) {
        let _ = tray.set_menu(Some(menu));
    }

    // Update icon color based on state
    let icon = icon_for_state(state);
    let _ = tray.set_icon(Some(icon));

    // Update tooltip
    let tooltip = match state {
        RecordingState::Recording => "Wolfee — Recording...",
        RecordingState::Stopping => "Wolfee — Saving...",
        RecordingState::Uploading => "Wolfee — Uploading...",
        RecordingState::Complete => "Wolfee — Uploaded!",
        RecordingState::Idle => "Wolfee Desktop",
    };
    let _ = tray.set_tooltip(Some(tooltip));

    // Set visible title text next to tray icon (macOS menu bar)
    let title = match state {
        RecordingState::Recording => Some("REC"),
        RecordingState::Stopping => Some("..."),
        RecordingState::Uploading => Some("UP"),
        RecordingState::Complete => None,
        RecordingState::Idle => None,
    };
    let _ = tray.set_title(title);
}

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: RecordingState,
    is_authenticated: bool,
) -> Result<Menu<R>, tauri::Error> {
    let menu = Menu::new(app)?;

    // Always show auth status at top
    if !is_authenticated {
        let link = MenuItem::with_id(app, "link", "Link with Wolfee...", true, None::<&str>)?;
        menu.append(&link)?;
        let sep = MenuItem::with_id(app, "sep0", "—", false, None::<&str>)?;
        menu.append(&sep)?;
    }

    match state {
        RecordingState::Recording => {
            let status = MenuItem::with_id(app, "status", "● Recording", false, None::<&str>)?;
            menu.append(&status)?;
            let stop = MenuItem::with_id(app, "stop", "Stop Recording  ⌘⌥Space", true, None::<&str>)?;
            menu.append(&stop)?;
        }
        RecordingState::Stopping => {
            let status = MenuItem::with_id(app, "status", "Saving recording...", false, None::<&str>)?;
            menu.append(&status)?;
        }
        RecordingState::Uploading => {
            let status = MenuItem::with_id(app, "status", "↑ Uploading to Wolfee...", false, None::<&str>)?;
            menu.append(&status)?;
        }
        RecordingState::Complete => {
            let status = MenuItem::with_id(app, "status", "✓ Uploaded!", false, None::<&str>)?;
            menu.append(&status)?;
            let open_meeting = MenuItem::with_id(app, "open_meeting", "Open in Wolfee", true, None::<&str>)?;
            menu.append(&open_meeting)?;
        }
        RecordingState::Idle => {
            if is_authenticated {
                let start = MenuItem::with_id(app, "start", "Start Recording  ⌘⌥Space", true, None::<&str>)?;
                menu.append(&start)?;
            } else {
                let start = MenuItem::with_id(app, "start", "Start Recording (no upload — link first)", true, None::<&str>)?;
                menu.append(&start)?;
            }
        }
    }

    let sep1 = MenuItem::with_id(app, "sep1", "—", false, None::<&str>)?;
    menu.append(&sep1)?;

    let open_wolfee = MenuItem::with_id(app, "open", "Open Wolfee", true, None::<&str>)?;
    menu.append(&open_wolfee)?;

    let sep2 = MenuItem::with_id(app, "sep2", "—", false, None::<&str>)?;
    menu.append(&sep2)?;

    let quit = MenuItem::with_id(app, "quit", "Quit Wolfee", true, None::<&str>)?;
    menu.append(&quit)?;

    Ok(menu)
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "start" => {
            log::info!("[Tray] Start Recording clicked");
            let _ = app.emit("wolfee-action", "start-recording");
        }
        "stop" => {
            log::info!("[Tray] Stop Recording clicked");
            let _ = app.emit("wolfee-action", "stop-recording");
        }
        "open" => {
            log::info!("[Tray] Open Wolfee clicked");
            let _ = app.emit("wolfee-action", "open-wolfee");
        }
        "open_meeting" => {
            log::info!("[Tray] Open Meeting clicked");
            let _ = app.emit("wolfee-action", "open-meeting");
        }
        "link" => {
            log::info!("[Tray] Link clicked");
            let _ = app.emit("wolfee-action", "link-account");
        }
        "quit" => {
            log::info!("[Tray] Quit clicked");
            app.exit(0);
        }
        _ => {}
    }
}
