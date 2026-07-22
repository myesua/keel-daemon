# Keel daemon — test results (v0.1.5)

Run with `cd daemon && ./tests/run-tests.sh` on Linux x86_64 (rustc 1.97.1,
Google Chrome headless for the CDP test). All five required behavior tests
pass — 19/19 checks, 0 failures.

| # | Test | Result | Evidence |
|---|------|--------|----------|
| 1 | HTTP bridge starts, `GET /keel/health` answers | PASS | `{"status":"ok","ok":true,"service":"keel-daemon","version":"0.1.5","browser_connected":false,"debug_port":9222}` |
| 2 | `GET /keel/tools` returns tool list | PASS | 9 tools (`open_tab`, `list_tabs`, `focus_tab`, `read_dom`, `highlight_element`, `click_element`, `fill_input`, `scroll`, `get_screenshot`) |
| 3 | Daemon does NOT open Chrome | PASS | 0 chrome processes before and after daemon start; log shows `Chrome not connected — start Chrome with --remote-debugging-port=9222…`; bridge still serves on 8791 |
| 4 | Tray icon + menu items | PASS* | Tray build compiles; startup log prints `tray menu: ["Keel — Chrome not connected", "Open Keel", "CDP Status: Not Connected", separator, "Quit Keel"]` (run under Xvfb) |
| 5 | CDP attaches when Chrome runs with `--remote-debugging-port=9222` | PASS | `curl localhost:9222/json` returns the tab list; daemon logs `CDP connected to Chrome on port 9222`; `/keel/health` flips to `"browser_connected":true` |

\* Test 4 caveat, reported honestly: this suite runs on headless Linux, so the
menu structure is verified via the daemon's own startup log (and the source),
not by observing a real macOS menubar. Confirming the icon visually in the
macOS menubar requires launching the packaged `Keel.app` on a Mac.

## Behavior guarantees verified

- The daemon **never launches Chrome** — `launch_chrome()` was deleted from
  the codebase entirely (`daemon/src/cdp.rs` now only *attaches* to a browser
  whose DevTools port answers).
- Default CDP port is **9222** (Chrome's conventional
  `--remote-debugging-port=9222`), overridable with `KEEL_DEBUG_PORT`.
- Bridge endpoints are canonical under `/keel/*` with `/glide/*` kept as
  compatible aliases for older companion builds.
