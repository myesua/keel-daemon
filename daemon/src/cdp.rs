//! Browser control core: connects to the user's real Chrome over the
//! Chrome DevTools Protocol (CDP) and implements the Keel tool set.
//!
//! No Playwright, no Electron, no sandboxed session: we ONLY attach to a
//! live, already-running browser whose DevTools port is answering. Keel
//! NEVER launches Chrome — the user starts Chrome themselves with
//! `--remote-debugging-port=9222` and Keel connects to it, so auth,
//! cookies, history and open tabs all stay exactly where they are.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use chromiumoxide::browser::Browser;
use chromiumoxide::cdp::browser_protocol::page::CaptureScreenshotFormat;
use chromiumoxide::page::{Page, ScreenshotParams};
use futures::StreamExt;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::js;

/// Chrome's conventional remote-debugging port. The user starts Chrome with
/// `--remote-debugging-port=9222`; Keel only ever attaches to it.
const DEFAULT_DEBUG_PORT: u16 = 9222;

pub struct Daemon {
    inner: Mutex<Inner>,
    pub debug_port: u16,
}

struct Inner {
    browser: Option<Browser>,
    tabs: HashMap<String, Page>,
    tab_order: Vec<String>,
    current_tab: Option<String>,
    next_tab_id: u64,
}

impl Daemon {
    pub fn new(debug_port: Option<u16>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                browser: None,
                tabs: HashMap::new(),
                tab_order: Vec::new(),
                current_tab: None,
                next_tab_id: 1,
            }),
            debug_port: debug_port.unwrap_or(DEFAULT_DEBUG_PORT),
        })
    }

    /// Attach to a browser whose DevTools port is already answering — and
    /// NEVER launch one. Returns whether a browser is connected afterwards.
    ///
    /// This is the probe the tray's status poller and the bridge's health
    /// endpoint use: checking on Chrome must not have the side effect of
    /// starting Chrome (Keel never starts Chrome, anywhere).
    pub async fn attach_if_running(self: &Arc<Self>) -> bool {
        {
            let mut inner = self.inner.lock().await;
            if let Some(browser) = inner.browser.as_mut() {
                if browser.version().await.is_ok() {
                    return true;
                }
                // The browser we were attached to is gone — forget it so a
                // fresh one can be adopted below (or launched later on demand).
                inner.browser = None;
                inner.tabs.clear();
                inner.tab_order.clear();
                inner.current_tab = None;
            }
        }

        let Ok(ws_url) = debugger_ws_url(self.debug_port).await else {
            return false;
        };
        let Ok((browser, mut handler)) = Browser::connect(ws_url).await else {
            return false;
        };
        tokio::spawn(async move { while handler.next().await.is_some() {} });

        let mut inner = self.inner.lock().await;
        inner.browser = Some(browser);
        tracing::info!("CDP connected to Chrome on port {}", self.debug_port);
        true
    }

    /// Attach to the user's already-running browser via its DevTools port.
    ///
    /// Keel NEVER launches Chrome. If nothing is listening on the debug port,
    /// this fails with instructions the companion UI can surface to the user.
    pub async fn ensure_connected(self: &Arc<Self>) -> Result<()> {
        {
            let mut inner = self.inner.lock().await;
            if let Some(browser) = inner.browser.as_mut() {
                // Cheap liveness check: version call fails once Chrome is gone.
                if browser.version().await.is_ok() {
                    return Ok(());
                }
                inner.browser = None;
                inner.tabs.clear();
                inner.tab_order.clear();
                inner.current_tab = None;
            }
        }

        let port = self.debug_port;
        let ws_url = debugger_ws_url(port).await.with_context(|| {
            format!(
                "Chrome is not reachable on the DevTools port. Start Chrome with \
                 --remote-debugging-port={port} and try again — Keel never launches \
                 Chrome for you."
            )
        })?;

        let (browser, mut handler) = Browser::connect(ws_url)
            .await
            .context("could not attach to the browser's DevTools socket")?;
        tokio::spawn(async move { while handler.next().await.is_some() {} });

        let mut inner = self.inner.lock().await;
        inner.browser = Some(browser);
        tracing::info!("CDP connected to Chrome on port {port}");
        Ok(())
    }

    async fn current_page(&self) -> Result<(String, Page)> {
        let inner = self.inner.lock().await;
        let id = inner
            .current_tab
            .clone()
            .ok_or_else(|| anyhow!("no Keel tab is open yet — call open_tab with a URL first"))?;
        let page = inner
            .tabs
            .get(&id)
            .cloned()
            .ok_or_else(|| anyhow!("current tab is gone — open a new one with open_tab"))?;
        Ok((id, page))
    }

    /// Dispatch a Keel tool call. Shared by the MCP stdio server and the
    /// local HTTP bridge so both brains use identical hands.
    pub async fn call_tool(self: &Arc<Self>, name: &str, args: &Value) -> Result<Value> {
        match name {
            "open_tab" => self.open_tab(args).await,
            "list_tabs" => self.list_tabs().await,
            "focus_tab" => self.focus_tab(args).await,
            "read_dom" => self.read_dom().await,
            "highlight_element" => self.highlight_element(args).await,
            "click_element" => self.click_element(args).await,
            "fill_input" => self.fill_input(args).await,
            "scroll" => self.scroll(args).await,
            "get_screenshot" => self.get_screenshot().await,
            other => bail!("unknown tool: {other}"),
        }
    }

    async fn open_tab(self: &Arc<Self>, args: &Value) -> Result<Value> {
        let url = require_str(args, "url")?;
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            bail!("url must start with http:// or https://");
        }
        self.ensure_connected().await?;

        let mut inner = self.inner.lock().await;
        let browser = inner.browser.as_ref().unwrap();
        let page = browser
            .new_page(url)
            .await
            .context("browser refused to open a new tab")?;
        // Bring the real tab to the front so the user watches the work live.
        let _ = page.bring_to_front().await;
        let _ = page
            .wait_for_navigation_response()
            .await;

        let tab_id = format!("tab{}", inner.next_tab_id);
        inner.next_tab_id += 1;
        inner.tabs.insert(tab_id.clone(), page.clone());
        inner.tab_order.push(tab_id.clone());
        inner.current_tab = Some(tab_id.clone());
        drop(inner);

        let title = page.get_title().await.ok().flatten().unwrap_or_default();
        let final_url = page.url().await.ok().flatten().unwrap_or_else(|| url.to_string());
        Ok(json!({
            "tab_id": tab_id,
            "url": final_url,
            "title": title,
            "note": "tab opened in the user's real browser and focused",
        }))
    }

    async fn list_tabs(self: &Arc<Self>) -> Result<Value> {
        let inner = self.inner.lock().await;
        let mut tabs = Vec::new();
        for id in &inner.tab_order {
            if let Some(page) = inner.tabs.get(id) {
                let url = page.url().await.ok().flatten().unwrap_or_default();
                let title = page.get_title().await.ok().flatten().unwrap_or_default();
                tabs.push(json!({
                    "tab_id": id,
                    "url": url,
                    "title": title,
                    "current": inner.current_tab.as_deref() == Some(id),
                }));
            }
        }
        Ok(json!({ "tabs": tabs }))
    }

    async fn focus_tab(self: &Arc<Self>, args: &Value) -> Result<Value> {
        let tab_id = require_str(args, "tab_id")?;
        let mut inner = self.inner.lock().await;
        let page = inner
            .tabs
            .get(tab_id)
            .cloned()
            .ok_or_else(|| anyhow!("no tab with id {tab_id}"))?;
        let _ = page.bring_to_front().await;
        inner.current_tab = Some(tab_id.to_string());
        Ok(json!({ "tab_id": tab_id, "focused": true }))
    }

    async fn read_dom(self: &Arc<Self>) -> Result<Value> {
        let (_, page) = self.current_page().await?;
        let raw: String = page
            .evaluate(js::READ_DOM)
            .await
            .context("page rejected the DOM read")?
            .into_value()
            .context("DOM read returned a non-string result")?;
        let parsed: Value = serde_json::from_str(&raw).context("DOM read returned invalid JSON")?;
        Ok(parsed)
    }

    async fn highlight_element(self: &Arc<Self>, args: &Value) -> Result<Value> {
        let selector = require_str(args, "selector")?;
        let label = args.get("label").and_then(Value::as_str).unwrap_or("Keel");
        let hold_ms = args.get("hold_ms").and_then(Value::as_u64).unwrap_or(1100);
        let (_, page) = self.current_page().await?;
        run_highlight(&page, selector, label, hold_ms).await?;
        Ok(json!({ "highlighted": selector, "label": label }))
    }

    async fn click_element(self: &Arc<Self>, args: &Value) -> Result<Value> {
        let selector = require_str(args, "selector")?;
        let label = args.get("label").and_then(Value::as_str).unwrap_or("Clicking");
        let (_, page) = self.current_page().await?;

        // The contract with the user: the highlight always lands BEFORE the
        // action so they can see exactly what is about to happen.
        run_highlight(&page, selector, label, 900).await?;
        tokio::time::sleep(Duration::from_millis(650)).await;

        let expr = format!(
            r#"(() => {{
  const el = document.querySelector({sel});
  if (!el) return JSON.stringify({{ ok: false, error: 'element not found' }});
  el.scrollIntoView({{ block: 'center' }});
  el.click();
  return JSON.stringify({{ ok: true, tag: el.tagName.toLowerCase() }});
}})()"#,
            sel = js_string(selector)
        );
        let raw: String = page.evaluate(expr).await?.into_value()?;
        let result: Value = serde_json::from_str(&raw)?;
        if result["ok"].as_bool() != Some(true) {
            bail!("click failed: {}", result["error"].as_str().unwrap_or("unknown"));
        }
        // Give SPAs a beat to react, then report where we ended up.
        tokio::time::sleep(Duration::from_millis(400)).await;
        let url = page.url().await.ok().flatten().unwrap_or_default();
        Ok(json!({ "clicked": selector, "url_after": url }))
    }

    async fn fill_input(self: &Arc<Self>, args: &Value) -> Result<Value> {
        let selector = require_str(args, "selector")?;
        let value = require_str(args, "value")?;
        let label = args.get("label").and_then(Value::as_str).unwrap_or("Filling");
        let (_, page) = self.current_page().await?;

        run_highlight(&page, selector, label, 900).await?;
        tokio::time::sleep(Duration::from_millis(650)).await;

        // Password and file inputs are refused here, unconditionally: those
        // moments belong to the user. The brain turns this into a pause point.
        let expr = format!(
            r#"(() => {{
  const el = document.querySelector({sel});
  if (!el) return JSON.stringify({{ ok: false, error: 'element not found' }});
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password' || type === 'file') {{
    return JSON.stringify({{ ok: false, pause_required: true, error: 'sensitive field: ' + type + ' inputs are user-only' }});
  }}
  el.scrollIntoView({{ block: 'center' }});
  el.focus();
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') {{
    const target = {val};
    let matched = false;
    for (const opt of el.options) {{
      if (opt.value === target || opt.textContent.trim() === target) {{
        el.value = opt.value; matched = true; break;
      }}
    }}
    if (!matched) return JSON.stringify({{ ok: false, error: 'no option matched' }});
  }} else if (el.isContentEditable) {{
    el.textContent = {val};
  }} else {{
    const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, {val}); else el.value = {val};
  }}
  el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  el.blur();
  return JSON.stringify({{ ok: true }});
}})()"#,
            sel = js_string(selector),
            val = js_string(value)
        );
        let raw: String = page.evaluate(expr).await?.into_value()?;
        let result: Value = serde_json::from_str(&raw)?;
        if result["pause_required"].as_bool() == Some(true) {
            return Ok(json!({
                "filled": false,
                "pause_required": true,
                "reason": result["error"].as_str().unwrap_or("sensitive field"),
            }));
        }
        if result["ok"].as_bool() != Some(true) {
            bail!("fill failed: {}", result["error"].as_str().unwrap_or("unknown"));
        }
        Ok(json!({ "filled": true, "selector": selector }))
    }

    async fn scroll(self: &Arc<Self>, args: &Value) -> Result<Value> {
        let (_, page) = self.current_page().await?;
        let dy = args.get("dy").and_then(Value::as_i64).unwrap_or(600);
        let raw: String = page
            .evaluate(format!(
                "(() => {{ window.scrollBy({{ top: {dy}, behavior: 'smooth' }}); return JSON.stringify({{ y: Math.round(scrollY) }}); }})()"
            ))
            .await?
            .into_value()?;
        Ok(serde_json::from_str(&raw)?)
    }

    async fn get_screenshot(self: &Arc<Self>) -> Result<Value> {
        let (_, page) = self.current_page().await?;
        let bytes = page
            .screenshot(
                ScreenshotParams::builder()
                    .format(CaptureScreenshotFormat::Png)
                    .build(),
            )
            .await
            .context("screenshot failed")?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let url = page.url().await.ok().flatten().unwrap_or_default();
        Ok(json!({
            "url": url,
            "mime": "image/png",
            "data_url": format!("data:image/png;base64,{b64}"),
        }))
    }
}

async fn run_highlight(page: &Page, selector: &str, label: &str, hold_ms: u64) -> Result<()> {
    page.evaluate(js::HIGHLIGHT_LIB).await.context("could not install highlighter")?;
    let expr = format!(
        r#"(() => {{
  const el = document.querySelector({sel});
  if (!el) return JSON.stringify({{ ok: false, error: 'element not found' }});
  window.__glideHighlight(el, {label}, {hold});
  return JSON.stringify({{ ok: true }});
}})()"#,
        sel = js_string(selector),
        label = js_string(label),
        hold = hold_ms
    );
    let raw: String = page.evaluate(expr).await?.into_value()?;
    let result: Value = serde_json::from_str(&raw)?;
    if result["ok"].as_bool() != Some(true) {
        bail!(
            "highlight failed for {selector}: {}",
            result["error"].as_str().unwrap_or("unknown")
        );
    }
    Ok(())
}

fn require_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("missing required argument: {key}"))
}

/// Serialize a Rust string as a safe JS string literal.
fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// Minimal loopback HTTP GET — enough to read /json/version off the
/// DevTools endpoint without dragging in a full HTTP client.
///
/// Chrome's DevTools server ignores `Connection: close` and keeps the
/// socket open, so we must parse Content-Length instead of reading to EOF,
/// and everything is wrapped in a hard timeout.
async fn loopback_get(port: u16, path: &str) -> Result<String> {
    let fut = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .with_context(|| format!("nothing listening on 127.0.0.1:{port}"))?;
        let req =
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        stream.write_all(req.as_bytes()).await?;

        let mut buf: Vec<u8> = Vec::with_capacity(4096);
        let mut chunk = [0u8; 4096];
        let (header_end, content_length) = loop {
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                bail!("DevTools endpoint closed the connection mid-response");
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&buf[..pos]);
                let len = headers
                    .lines()
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        k.eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse::<usize>().ok())?
                    })
                    .ok_or_else(|| anyhow!("DevTools response had no Content-Length"))?;
                break (pos + 4, len);
            }
            if buf.len() > 1_000_000 {
                bail!("DevTools response headers too large");
            }
        };
        while buf.len() < header_end + content_length {
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Ok(String::from_utf8_lossy(&buf[header_end..header_end + content_length.min(buf.len() - header_end)]).to_string())
    };
    tokio::time::timeout(Duration::from_secs(5), fut)
        .await
        .map_err(|_| anyhow!("DevTools endpoint on port {port} did not answer within 5s"))?
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn debugger_ws_url(port: u16) -> Result<String> {
    let body = loopback_get(port, "/json/version").await?;
    // Some Chrome builds send chunked bodies; find the JSON object directly.
    let start = body.find('{').ok_or_else(|| anyhow!("no JSON in /json/version response"))?;
    let end = body.rfind('}').ok_or_else(|| anyhow!("no JSON in /json/version response"))?;
    let parsed: Value = serde_json::from_str(&body[start..=end])?;
    parsed["webSocketDebuggerUrl"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| anyhow!("DevTools endpoint returned no webSocketDebuggerUrl"))
}

// NOTE: there is deliberately no launch_chrome() here. Keel connects to the
// user's already-running Chrome (started with --remote-debugging-port=9222)
// and must never open a browser window itself.
