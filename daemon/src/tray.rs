//! System-tray / menubar front (build with `--features tray`).
//!
//! This is what the packaged desktop app runs: double-click Keel.app (macOS)
//! or launch Keel from the Start Menu (Windows) and this module puts a small
//! icon in the menubar/tray while the real daemon — the CDP connection to the
//! user's own Chrome plus the loopback companion bridge — runs invisibly on a
//! background tokio runtime.
//!
//! Behavior contract (what makes the tray a polite guest):
//! - Launching Keel NEVER opens a Chrome window. The bridge starts on port
//!   8791 and a background poller silently attaches to a browser whose
//!   DevTools port is already answering. Until then the menu reads
//!   "Status: Waiting for Chrome…". Chrome is only ever started on demand,
//!   when a live-session tool call actually needs it.
//! - The menu always offers "Open Keel" — the companion web app opens in the
//!   default browser. The URL is baked in via KEEL_COMPANION_URL at compile
//!   time (packaging scripts), overridable at runtime, with a built-in
//!   fallback so the item never disappears.
//! - Relaunching the app while Keel is already running is a no-op plus
//!   feedback: the second instance detects the live bridge on port 8791,
//!   opens the companion app so the click visibly did something, and exits
//!   instead of fighting over the port.
//!
//! Platform notes:
//! - The tray/menu event loop must own the MAIN thread (a hard macOS
//!   requirement), so the async daemon work moves to a background runtime.
//! - On macOS the app runs with the Accessory activation policy (no Dock
//!   icon) — the .app bundle also sets LSUIElement for the same effect.
//! - The tray icon is generated in code (a Keel-orange dot) so the binary
//!   stays self-contained: no bundled asset files to load at runtime.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

use crate::cdp::Daemon;
use crate::http::BRIDGE_PORT;

/// Fallback companion URL so "Open Keel" always works, even in builds where
/// the packaging scripts didn't bake in KEEL_COMPANION_URL.
const DEFAULT_COMPANION_URL: &str =
    "https://app.audos.com/space/10a99f02-28e8-4834-ba8d-0af3b7561513";

/// The Keel companion web app. Runtime KEEL_COMPANION_URL wins, then the
/// value baked in at compile time by the packaging scripts, then the
/// built-in default.
fn companion_url() -> String {
    std::env::var("KEEL_COMPANION_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            option_env!("KEEL_COMPANION_URL")
                .map(str::to_string)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_COMPANION_URL.to_string())
}

enum UserEvent {
    Menu(MenuEvent),
    /// Emitted by the background poller: is a browser attached right now?
    BrowserStatus(bool),
}

/// True when another Keel daemon already owns the companion bridge port.
///
/// A plain TCP connect isn't proof (anything could squat on the port), so we
/// ask `/glide/tools` — a static endpoint that never touches the browser —
/// and look for the service's own vocabulary in the reply.
fn already_running() -> bool {
    use std::io::{Read, Write};
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], BRIDGE_PORT));
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let req = format!(
        "GET /glide/tools HTTP/1.1\r\nHost: 127.0.0.1:{BRIDGE_PORT}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut reply = String::new();
    let _ = stream.read_to_string(&mut reply);
    reply.contains("\"tools\"")
}

pub fn run(daemon: Arc<Daemon>) -> Result<()> {
    // Single instance: if a Keel daemon is already serving the bridge,
    // relaunching the app should give feedback, not a port clash. Open the
    // companion app (the closest thing to "focusing" a tray-only app) and
    // bow out; the original tray icon keeps running untouched.
    if already_running() {
        tracing::info!(
            "Keel is already running on port {BRIDGE_PORT} — opening the companion app instead"
        );
        open_in_browser(&companion_url());
        return Ok(());
    }

    // The daemon (companion bridge + silent browser attach) runs on a
    // background tokio runtime; the platform event loop below needs the
    // main thread.
    let runtime = tokio::runtime::Runtime::new()?;
    let daemon_bg = Arc::clone(&daemon);
    runtime.spawn(async move {
        if let Err(e) = crate::http::run(daemon_bg).await {
            tracing::error!("companion bridge stopped: {e:#}");
        }
    });

    // `mut` is only used by the macOS activation-policy call below.
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        // Menubar-only app: no Dock icon, no app switcher entry. tao 0.30 sets
        // the policy on the built event loop (before run), not on the builder.
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }

    // Menu events arrive on muda's own channel; forward them into the event
    // loop so ControlFlow::Wait still wakes up on clicks.
    let proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let _ = proxy.send_event(UserEvent::Menu(event));
    }));

    // Silent browser watcher: attach to a browser whose DevTools port is
    // already answering — NEVER launch one — and keep the status line honest.
    // Chrome only ever starts when a live-session tool call demands it.
    let status_proxy = event_loop.create_proxy();
    let daemon_poll = Arc::clone(&daemon);
    runtime.spawn(async move {
        let mut last: Option<bool> = None;
        loop {
            let connected = daemon_poll.attach_if_running().await;
            if last != Some(connected) {
                last = Some(connected);
                let _ = status_proxy.send_event(UserEvent::BrowserStatus(connected));
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });

    let menu = Menu::new();
    let open_item = MenuItem::new("Open Keel", true, None);
    menu.append(&open_item)?;
    menu.append(&PredefinedMenuItem::separator())?;
    let status_item = MenuItem::new("Status: Waiting for Chrome…", false, None);
    menu.append(&status_item)?;
    menu.append(&PredefinedMenuItem::separator())?;
    let quit_item = MenuItem::new("Quit Keel", true, None);
    menu.append(&quit_item)?;

    let open_id = open_item.id().clone();
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
                    .with_tooltip("Keel — waiting for Chrome")
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
            Event::UserEvent(UserEvent::BrowserStatus(connected)) => {
                let (status, tooltip) = if connected {
                    ("Status: Running", "Keel — connected to your browser")
                } else {
                    ("Status: Waiting for Chrome…", "Keel — waiting for Chrome")
                };
                status_item.set_text(status);
                if let Some(t) = &tray {
                    let _ = t.set_tooltip(Some(tooltip));
                }
            }
            Event::UserEvent(UserEvent::Menu(menu_event)) => {
                if menu_event.id == quit_id {
                    tray.take(); // remove the icon before exiting
                    *control_flow = ControlFlow::Exit;
                } else if menu_event.id == open_id {
                    open_in_browser(&companion_url());
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
