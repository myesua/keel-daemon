# keel-daemon

Keel's hands on your real browser. A single lightweight Rust binary (`keel`) that:

- attaches to your **already-running Chrome** over the Chrome DevTools Protocol (CDP, port 9222) using the `chromiumoxide` crate — no Playwright, no Electron, no sandboxed copy of your browser. **Keel never launches Chrome**: you start Chrome with `--remote-debugging-port=9222` and Keel connects to it;
- opens **real tabs** in that browser and works on the **live page** while you watch;
- **highlights every element** (orange border + glow + label) *before* touching it;
- **refuses** password and file inputs at the daemon level — those come back as `pause_required` so the agent hands the moment to you;
- runs as a **local MCP server** so Claude is the brain and this binary is the hands;
- also exposes a tiny loopback HTTP bridge (`127.0.0.1:8791`) that the Keel companion web app calls directly.

Session state persists by design: the tabs are your tabs. Auth, cookies, and history live in the browser profile, exactly where they were.

## Desktop app (what users actually install)

Nobody should need a terminal. The `packaging/` folder wraps this same binary into native installers:

- **macOS** — `Keel.dmg`: drag to Applications, launch, a Keel icon appears in the **menubar** and the daemon runs silently underneath. Built by `packaging/macos/build-macos.sh` (universal binary, optional code-signing + notarization).
- **Windows** — `KeelSetup.exe`: install, launch, a Keel icon appears in the **system tray** and Keel starts at login. Built by `packaging/windows/build-windows.ps1` (NSIS).

User flow: download → open installer → launch → open the Keel web app, it's connected. The tray shell is the `tray` cargo feature (`tray-icon` + `tao` — a native event loop and an icon, NOT Electron, NOT a webview); the daemon underneath is byte-for-byte the same logic as the CLI build. See [`packaging/README.md`](packaging/README.md) for build, signing, and CI instructions.

## Build (CLI, from source)

```bash
cd daemon
cargo build --release
# binary at target/release/keel

# desktop-app build (adds the menubar/tray shell):
cargo build --release --features tray
# on Linux the tray build needs GTK headers: apt install libgtk-3-dev
```

A tray build launched with no arguments shows the tray icon; `keel headless` runs it exactly like the CLI build (useful for debugging), and `keel mcp` is unchanged.

## Run — companion mode (default)

```bash
./keel-daemon
```

What happens on start (this is the whole "tray app" job — invisible plumbing):

1. The companion bridge starts at `http://127.0.0.1:8791` (`/keel/health`, `/keel/tools`, `/keel/call`; the old `/glide/*` paths remain as aliases). Loopback is exempt from mixed-content blocking, so the https-served companion UI can reach it. It binds to 127.0.0.1 only — nothing outside your machine can touch it.
2. It looks for a browser already listening on the CDP debug port (`9222` by default, override with `KEEL_DEBUG_PORT`) and attaches when one answers. **It never launches Chrome** — if Chrome isn't running with remote debugging, the daemon simply reports "Chrome not connected" and keeps polling.

To let Keel attach, start Chrome yourself with the flag:

```bash
# macOS
open -a "Google Chrome" --args --remote-debugging-port=9222
# Linux
google-chrome --remote-debugging-port=9222
```

(Chrome 136+ blocks CDP on the default profile for security; if your Chrome refuses the flag, add `--user-data-dir=$HOME/.keel-chrome` to use a dedicated profile.)

## Run — MCP mode (Claude as the brain)

```bash
./keel mcp
```

Speaks MCP (JSON-RPC 2.0) over stdio. Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "keel": {
      "command": "/path/to/keel",
      "args": ["mcp"]
    }
  }
}
```

## Tools

| Tool | What it does |
|------|--------------|
| `open_tab` | Opens a new tab in your real browser at a URL and focuses it |
| `list_tabs` | Lists the tabs Keel opened this session |
| `focus_tab` | Brings a Keel tab to the front |
| `read_dom` | Reads the live DOM: interactive elements with stable selectors, labels, values, options, required flags; page headings; captcha detection |
| `highlight_element` | Injects the visual highlight overlay onto an element — always before acting |
| `click_element` | Highlights, waits a beat, then clicks |
| `fill_input` | Highlights, then types into a field; **password/file inputs are refused** (`pause_required`) |
| `scroll` | Scrolls the page |
| `get_screenshot` | PNG screenshot of the current tab as a data URL |

## Cross-browser

- **Chrome / Chromium / Brave / Edge** — primary targets, fully supported.
- **Firefox** — start it with `firefox --remote-debugging-port=9222`; Firefox ships CDP compatibility, so attachment works the same way. Considered experimental.
- **Safari** — deferred (no CDP).

## Design constraints (deliberate)

- No Playwright, no Electron — both are CPU-heavy and create sandboxed sessions that lose your auth and history.
- No server-side scraping — the page the agent reads is the page on your screen.
- The highlight always lands **before** the action. If you didn't see it highlighted, Keel didn't touch it.
- Passwords, file uploads, captchas, payments: yours. The daemon enforces the first two mechanically; the brain enforces the rest.
