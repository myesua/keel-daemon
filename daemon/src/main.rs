//! keel-daemon — Keel's hands on the user's real browser.
//!
//! A single lightweight binary with two faces (three when packaged):
//!   `keel`               → companion mode: local HTTP bridge on 127.0.0.1:8791
//!                           + attaches to the user's ALREADY-RUNNING Chrome
//!                           over CDP (port 9222). Keel never launches Chrome.
//!                           In the packaged desktop app (built with
//!                           `--features tray`) this same default mode also
//!                           puts a Keel icon in the menubar/system tray —
//!                           the daemon underneath is unchanged.
//!   `keel mcp`           → MCP stdio server for Claude (Claude Desktop /
//!                           Claude Code config: command = keel, args = ["mcp"]).
//!   `keel headless`      → (tray builds only) companion mode without the
//!                           tray icon — what plain `keel-daemon` does in a
//!                           terminal build. Useful for debugging the packaged app.
//!
//! No Playwright. No Electron. No sandbox. It attaches to the user's live
//! Chrome over the Chrome DevTools Protocol, so every tab it opens is a real
//! tab: the user watches the work happen, and auth/cookies/history persist
//! after the session ends. Firefox works too when started with
//! `--remote-debugging-port` (Firefox ships CDP compatibility); Safari is
//! not supported yet.

// Packaged (tray) Windows builds run as a GUI app so no console window
// flashes at launch. Piped stdio still works, so `keel-daemon mcp` under
// Claude Desktop is unaffected.
#![cfg_attr(all(target_os = "windows", feature = "tray"), windows_subsystem = "windows")]

mod cdp;
mod http;
mod js;
mod mcp;
#[cfg(feature = "tray")]
mod tray;

use anyhow::Result;

fn main() -> Result<()> {
    let arg = std::env::args().nth(1);
    let mcp_mode = arg.as_deref() == Some("mcp");

    // In MCP mode stdout is the protocol channel — logs must go to stderr.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                // The binary target is `keel`, so module paths are keel::…
                .unwrap_or_else(|_| "keel=info".into()),
        )
        .init();

    let debug_port = std::env::var("KEEL_DEBUG_PORT")
        .ok()
        .and_then(|p| p.parse().ok());
    let daemon = cdp::Daemon::new(debug_port);

    if mcp_mode {
        tracing::info!("keel-daemon starting as MCP stdio server");
        return tokio_runtime()?.block_on(mcp::run_stdio(daemon));
    }

    // Desktop-app build: default launch = tray icon + the exact same daemon.
    // The tray must own the main thread (macOS requirement), so it manages
    // its own background runtime.
    #[cfg(feature = "tray")]
    if arg.as_deref() != Some("headless") {
        tracing::info!("keel-daemon starting with system tray");
        return tray::run(daemon);
    }

    tracing::info!("keel-daemon starting companion bridge");
    tokio_runtime()?.block_on(async move {
        // Probe for an already-running Chrome so the first tool call is fast.
        // Never launch Chrome — if it isn't up, the bridge still serves and
        // health checks keep retrying the attach.
        if daemon.attach_if_running().await {
            tracing::info!("CDP connected");
        } else {
            tracing::warn!(
                "Chrome not connected — start Chrome with --remote-debugging-port={} \
                 and Keel will attach automatically",
                daemon.debug_port
            );
        }
        http::run(daemon).await
    })
}

fn tokio_runtime() -> Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?)
}
