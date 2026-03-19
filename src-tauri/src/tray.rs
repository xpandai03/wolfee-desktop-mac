use tauri::{
    image::Image,
    AppHandle, Runtime,
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    Emitter,
};

use crate::state::RecordingState;

// Wolfee tray icon (template-style, 44x44 @2x)
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/trayTemplate.png");

fn tray_icon() -> Image<'static> {
    Image::from_bytes(TRAY_ICON_BYTES).expect("Failed to load tray icon")
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> Result<TrayIcon<R>, tauri::Error> {
    let icon = tray_icon();
    let tray = TrayIconBuilder::new()
        .tooltip("Wolfee Desktop")
        .icon(icon)
        .icon_as_template(true)
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

    // Icon stays as Wolfee wolf — state shown via title text

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
