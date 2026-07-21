//! MCP (Model Context Protocol) stdio server.
//!
//! Speaks JSON-RPC 2.0 over stdin/stdout so Claude (Claude Desktop, Claude
//! Code, or any MCP client) can use the daemon as its hands on the user's
//! real browser. Implements initialize / tools/list / tools/call.

use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::cdp::Daemon;

pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "open_tab",
            "description": "Open a NEW TAB in the user's real, already-running browser at the given URL and focus it. Auth, cookies and history are the user's own — nothing is sandboxed. Returns a tab_id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "http(s) URL to open" }
                },
                "required": ["url"]
            }
        },
        {
            "name": "list_tabs",
            "description": "List the tabs Keel has opened this session, with URLs and titles.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "focus_tab",
            "description": "Bring a previously opened Keel tab to the front and make it current.",
            "inputSchema": {
                "type": "object",
                "properties": { "tab_id": { "type": "string" } },
                "required": ["tab_id"]
            }
        },
        {
            "name": "read_dom",
            "description": "Read the LIVE DOM of the current tab: every interactive element (inputs, selects, buttons, links) with a stable selector, label, current value, options, required flag and visibility, plus page headings and captcha detection. Passwords and file inputs are marked sensitive and their values are never read.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "highlight_element",
            "description": "Inject a visual highlight (orange border + glow + label) over an element in the user's real tab so they can see what is about to happen. Always call this before acting on an element the user hasn't seen highlighted yet.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector": { "type": "string", "description": "CSS selector, usually the [data-glide-id=…] selector from read_dom" },
                    "label": { "type": "string", "description": "Short label shown above the highlight, e.g. 'Filling: Email'" },
                    "hold_ms": { "type": "number", "description": "How long the highlight stays visible (default 1100ms)" }
                },
                "required": ["selector"]
            }
        },
        {
            "name": "click_element",
            "description": "Click an element on the live page. The element is highlighted first (the user sees it), then clicked. Never click a final submit button without the user's explicit confirmation in the companion.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector": { "type": "string" },
                    "label": { "type": "string", "description": "Label shown in the highlight, e.g. 'Clicking: Next'" }
                },
                "required": ["selector"]
            }
        },
        {
            "name": "fill_input",
            "description": "Type a value into a form field on the live page (input, textarea, select, contenteditable). The field is highlighted first. Password and file inputs are REFUSED by the daemon and returned as pause_required — those moments belong to the user.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "selector": { "type": "string" },
                    "value": { "type": "string" },
                    "label": { "type": "string", "description": "Label shown in the highlight, e.g. 'Filling: Full name'" }
                },
                "required": ["selector", "value"]
            }
        },
        {
            "name": "scroll",
            "description": "Scroll the current tab vertically by dy pixels (negative scrolls up). Returns the new scroll position.",
            "inputSchema": {
                "type": "object",
                "properties": { "dy": { "type": "number", "description": "Pixels to scroll (default 600)" } }
            }
        },
        {
            "name": "get_screenshot",
            "description": "Capture a PNG screenshot of the current tab's viewport, returned as a data URL.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

pub async fn run_stdio(daemon: Arc<Daemon>) -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut lines = BufReader::new(stdin).lines();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let resp = json!({
                    "jsonrpc": "2.0", "id": null,
                    "error": { "code": -32700, "message": format!("parse error: {e}") }
                });
                write_msg(&mut stdout, &resp).await?;
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req.get("method").and_then(Value::as_str).unwrap_or("");

        // Notifications (no id) get no response.
        if req.get("id").is_none() {
            continue;
        }

        let resp = match method {
            "initialize" => json!({
                "jsonrpc": "2.0", "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "keel-daemon", "version": env!("CARGO_PKG_VERSION") }
                }
            }),
            "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            "tools/list" => json!({
                "jsonrpc": "2.0", "id": id,
                "result": { "tools": tool_definitions() }
            }),
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                let args = req["params"]["arguments"].clone();
                match daemon.call_tool(name, &args).await {
                    Ok(result) => json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": {
                            "content": [{ "type": "text", "text": result.to_string() }],
                            "isError": false
                        }
                    }),
                    Err(e) => json!({
                        "jsonrpc": "2.0", "id": id,
                        "result": {
                            "content": [{ "type": "text", "text": json!({ "error": e.to_string() }).to_string() }],
                            "isError": true
                        }
                    }),
                }
            }
            other => json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": format!("method not found: {other}") }
            }),
        };
        write_msg(&mut stdout, &resp).await?;
    }
    Ok(())
}

async fn write_msg(stdout: &mut tokio::io::Stdout, msg: &Value) -> Result<()> {
    stdout.write_all(msg.to_string().as_bytes()).await?;
    stdout.write_all(b"\n").await?;
    stdout.flush().await?;
    Ok(())
}
