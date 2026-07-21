//! System-tray / menubar front (build with `--features tray`).
//!
//! This is what the packaged desktop app runs: double-click Keel.app (macOS)
//! or launch Keel from the Start Menu (Windows) and this module puts a small
//! icon in the menubar/tray while the real daemon — the CDP connection to the
//! user's own Chrome plus the loopback companion bridge — runs invisibly on a
//! background tokio runtime. The daemon's behavior is IDENTICAL to running
//! `keel-daemon` in a terminal; the tray is only a launcher and an off switch.
//!
//! Platform notes:
//! - The tray/menu event loop must own the MAIN thread (a hard macOS
//!   requirement), so the async daemon work moves to a background runtime.
//! - On macOS the app runs with the Accessory activation policy (no Dock
//!   icon) — the .app bundle also sets LSUIElement for the same effect.
//! - The tray icon is generated in code (a Keel-orange dot) so the binary
//!   stays self-contained: no bundled asset files to load at runtime.

use std::sync::Arc;

use anyhow::Result;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

use crate::cdp::Daemon;
use crate::http::BRIDGE_PORT;

/// The Keel companion web app. Baked in at compile time via the
/// KEEL_COMPANION_URL env var (the packaging scripts set it), and
/// overridable at runtime with the same variable.
fn companion_url() -> Option<String> {
    std::env::var("KEEL_COMPANION_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| option_env!("KEEL_COMPANION_URL").map(str::to_string))
}

enum UserEvent {
    Menu(MenuEvent),
}

pub fn run(daemon: Arc<Daemon>) -> Result<()> {
    // The daemon (CDP + companion bridge) runs on a background tokio runtime;
    // the platform event loop below needs the main thread.
    let runtime = tokio::runtime::Runtime::new()?;
    let daemon_bg = Arc::clone(&daemon);
    runtime.spawn(async move {
        if let Err(e) = daemon_bg.ensure_connected().await {
            tracing::warn!("browser not connected yet: {e}");
        }
        if let Err(e) = crate::http::run(daemon_bg).await {
            tracing::error!("companion bridge stopped: {e:#}");
        }
    });

    let mut builder = EventLoopBuilder::<UserEvent>::with_user_event();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopBuilderExtMacOS};
        // Menubar-only app: no Dock icon, no app switcher entry.
        builder.with_activation_policy(ActivationPolicy::Accessory);
    }
    let event_loop = builder.build();

    // Menu events arrive on muda's own channel; forward them into the event
    // loop so ControlFlow::Wait still wakes up on clicks.
    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let _ = proxy.send_event(UserEvent::Menu(event));
    }));

    let menu = Menu::new();
    let status_item = MenuItem::new(
        format!("Keel is running — bridge on 127.0.0.1:{BRIDGE_PORT}"),
        false,
        None,
    );
    menu.append(&status_item)?;

    let open_url = companion_url();
    let open_item = open_url
        .as_ref()
        .map(|_| MenuItem::new("Open Keel", true, None));
    if let Some(item) = &open_item {
        menu.append(item)?;
    }

    menu.append(&PredefinedMenuItem::separator())?;
    let quit_item = MenuItem::new("Quit Keel", true, None);
    menu.append(&quit_item)?;

    let open_id = open_item.as_ref().map(|i| i.id().clone());
    let quit_id = quit_item.id().clone();

    // Created lazily inside the loop: on macOS the tray icon must be built
    // after the event loop has started (NewEvents::Init).
    let mut tray: Option<TrayIcon> = None;

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                match TrayIconBuilder::new()
                    .with_menu(Box::new(menu.clone()))
                    .with_tooltip("Keel — connected to your browser")
                    .with_icon(keel_icon())
                    .build()
                {
                    Ok(t) => tray = Some(t),
                    Err(e) => {
                        tracing::error!("could not create the tray icon: {e:#}");
                        *control_flow = ControlFlow::Exit;
                    }
                }
            }
            Event::UserEvent(UserEvent::Menu(menu_event)) => {
                if menu_event.id == quit_id {
                    tray.take(); // remove the icon before exiting
                    *control_flow = ControlFlow::Exit;
                } else if Some(&menu_event.id) == open_id.as_ref() {
                    if let Some(url) = &open_url {
                        open_in_browser(url);
                    }
                }
            }
            _ => {}
        }
    });
}

/// Open a URL with the platform's default handler — no extra crates needed.
fn open_in_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    if let Err(e) = result {
        tracing::warn!("could not open {url}: {e}");
    }
}

/// Draw the tray icon in code: a Keel-orange (#ec6f2c) disc with a small
/// white dot offset toward the upper right — a nod to the highlight overlay
/// the daemon paints on live pages. 32×32 RGBA.
fn keel_icon() -> Icon {
    const SIZE: u32 = 32;
    let (cx, cy, r) = (15.5f32, 15.5f32, 14.0f32);
    let (dx, dy, dr) = (20.0f32, 11.0f32, 4.5f32);
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (fx, fy) = (x as f32, y as f32);
            let dist = ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt();
            let dot = ((fx - dx).powi(2) + (fy - dy).powi(2)).sqrt();
            if dist <= r {
                // Anti-alias the disc edge over the final pixel.
                let alpha = ((r - dist).clamp(0.0, 1.0) * 255.0) as u8;
                if dot <= dr {
                    rgba.extend_from_slice(&[0xff, 0xff, 0xff, alpha]);
                } else {
                    rgba.extend_from_slice(&[0xec, 0x6f, 0x2c, alpha]);
                }
            } else {
                rgba.extend_from_slice(&[0, 0, 0, 0]);
            }
        }
    }
    Icon::from_rgba(rgba, SIZE, SIZE).expect("static icon dimensions are valid")
}
