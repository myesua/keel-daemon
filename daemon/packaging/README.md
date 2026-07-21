# Packaging Keel as a desktop app

This folder turns the `keel-daemon` binary into the thing users actually download:

- **macOS** — `Keel.dmg`: open, drag Keel to Applications, launch. A Keel icon appears in the **menubar**; the daemon runs silently underneath. No Dock icon, no terminal.
- **Windows** — `KeelSetup.exe` (NSIS): install, launch. A Keel icon appears in the **system tray**, and Keel starts automatically at login.

The daemon itself is untouched: same CDP connection to the user's real Chrome, same loopback bridge on `127.0.0.1:8791`, same MCP server (`keel-daemon mcp`). The desktop app is only the tray shell compiled in with `--features tray` (the `tray-icon` + `tao` crates — a native event loop and an icon, **not** Electron, **not** a webview).

## The user experience these builds produce

1. Download Keel (one link).
2. Open the DMG / run the installer.
3. Launch — menubar/tray icon appears, daemon starts in the background.
4. Open the Keel web app — it's connected. Done.

## Building

Cross-compilation is impractical here (macOS needs `codesign`/`hdiutil`, Windows needs NSIS + the MSVC toolchain), so each installer is built on its own OS — locally or via the CI workflow in `ci/github-actions.yml`.

### macOS (run on a Mac)

```bash
cd daemon
KEEL_COMPANION_URL="https://your-keel-web-app-url" ./packaging/macos/build-macos.sh
# → dist/Keel.dmg (universal: Apple Silicon + Intel)
```

### Windows (run on Windows)

```powershell
cd daemon
$env:KEEL_COMPANION_URL = "https://your-keel-web-app-url"
powershell -ExecutionPolicy Bypass -File packaging\windows\build-windows.ps1
# → dist\KeelSetup.exe
```

`KEEL_COMPANION_URL` is optional; when set, the tray menu gets an "Open Keel" item that opens the web app.

### No Mac or Windows machine?

Push the `daemon/` folder to a GitHub repo, copy `ci/github-actions.yml` to `.github/workflows/release.yml`, and push a tag like `v0.1.0`. GitHub's hosted macOS and Windows runners build both installers, upload them as workflow artifacts, and publish them as assets on a GitHub Release for the tag.

## Code signing

Unsigned builds run, with first-launch friction you should know about:

| Platform | Unsigned experience | Fix |
|----------|--------------------|-----|
| macOS | Gatekeeper blocks the downloaded app; user must **right-click > Open** once (macOS 15+: approve under System Settings > Privacy & Security) | Sign + notarize (below) |
| Windows | SmartScreen shows "Windows protected your PC"; user clicks **More info > Run anyway** | Authenticode-sign `KeelSetup.exe` |

### macOS signing + notarization (removes all warnings)

1. Join the [Apple Developer Program](https://developer.apple.com/programs/) ($99/yr).
2. In Xcode (Settings > Accounts > Manage Certificates) create a **Developer ID Application** certificate.
3. Store notarization credentials once (use an [app-specific password](https://support.apple.com/102654)):

```bash
xcrun notarytool store-credentials keel-notary \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
```

4. Build signed + notarized:

```bash
KEEL_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
KEEL_NOTARY_PROFILE=keel-notary \
./packaging/macos/build-macos.sh
```

The script signs with the hardened runtime, submits the DMG to Apple, waits, and staples the ticket — the download then opens with zero warnings.

### Windows signing

Buy an Authenticode code-signing certificate (OV works; EV builds SmartScreen reputation fastest), then:

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /f yourcert.pfx /p <password> dist\KeelSetup.exe
```

## What's in this folder

| File | Purpose |
|------|---------|
| `macos/Info.plist` | App bundle manifest — `LSUIElement` makes Keel menubar-only (no Dock icon) |
| `macos/build-macos.sh` | Universal binary → `Keel.app` → signed/notarized `Keel.dmg` |
| `windows/keel-installer.nsi` | NSIS installer: install dir, Start Menu, login autostart, uninstaller |
| `windows/build-windows.ps1` | Release build → NSIS → `dist\KeelSetup.exe` |
| `ci/github-actions.yml` | Reference workflow that builds both installers on GitHub's runners |

## Uninstalling / debugging

- **macOS**: quit from the menubar icon, drag Keel.app to Trash. The browser profile at `~/.glide/chrome-profile` (the user's logins) is kept.
- **Windows**: Add/Remove Programs > Keel (or the Start Menu uninstall shortcut). The browser profile at `%USERPROFILE%\.glide` is kept.
- **Debugging the packaged app**: run the bundled binary with `headless` (`/Applications/Keel.app/Contents/MacOS/keel-daemon headless`) to get the daemon with terminal logs and no tray.
