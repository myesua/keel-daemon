//! Local HTTP bridge for the Keel companion UI.
//!
//! The companion (a web app) talks to this daemon at http://127.0.0.1:8791.
//! Loopback endpoints are exempt from mixed-content blocking in Chrome, so
//! an https-served companion can call the local daemon directly. CORS is
//! wide open because the server only binds to 127.0.0.1 — nothing off the
//! user's machine can ever reach it.

use std::sync::Arc;

use anyhow::Result;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;

use crate::cdp::Daemon;
use crate::mcp::tool_definitions;

pub const BRIDGE_PORT: u16 = 8791;

pub async fn run(daemon: Arc<Daemon>) -> Result<()> {
    let app = Router::new()
        .route("/glide/health", get(health))
        .route("/glide/tools", get(tools))
        .route("/glide/call", post(call))
        .layer(CorsLayer::permissive())
        .with_state(daemon);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", BRIDGE_PORT)).await?;
    tracing::info!("companion bridge listening on http://127.0.0.1:{BRIDGE_PORT}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(daemon): State<Arc<Daemon>>) -> Json<Value> {
    // Probe only — a health check must never launch Chrome as a side effect.
    let connected = daemon.attach_if_running().await;
    Json(json!({
        "ok": true,
        "service": "keel-daemon",
        "version": env!("CARGO_PKG_VERSION"),
        "browser_connected": connected,
        "debug_port": daemon.debug_port,
    }))
}

async fn tools() -> Json<Value> {
    Json(json!({ "tools": tool_definitions() }))
}

#[derive(serde::Deserialize)]
struct CallBody {
    tool: String,
    #[serde(default)]
    args: Value,
}

async fn call(
    State(daemon): State<Arc<Daemon>>,
    Json(body): Json<CallBody>,
) -> (StatusCode, Json<Value>) {
    match daemon.call_tool(&body.tool, &body.args).await {
        Ok(result) => (StatusCode::OK, Json(json!({ "ok": true, "result": result }))),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e.to_string() })),
        ),
    }
}
