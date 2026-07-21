# =============================================================================
# Keel — Windows installer packager
#
# Builds the tray build of keel-daemon.exe and wraps it in an NSIS
# installer (KeelSetup.exe): install, launch, tray icon appears, done.
#
# Run this ON WINDOWS (PowerShell) with Rust and NSIS installed:
#   - Rust:  https://rustup.rs  (MSVC toolchain)
#   - NSIS:  winget install NSIS.NSIS   (or https://nsis.sourceforge.io)
#
#   cd daemon
#   powershell -ExecutionPolicy Bypass -File packaging\windows\build-windows.ps1
#
# Output: dist\KeelSetup.exe
#
# Environment knobs (optional):
#   KEEL_COMPANION_URL   Web-app URL baked into the tray's "Open Keel" menu
#                        item (read at compile time by src/tray.rs).
#
# Code signing (optional, kills the SmartScreen warning):
#   After building, sign both binaries with your Authenticode cert:
#     signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
#       /f yourcert.pfx /p <password> dist\KeelSetup.exe
#   Unsigned installers still work — users click "More info > Run anyway"
#   on the SmartScreen prompt the first time.
# =============================================================================
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DaemonDir = Resolve-Path (Join-Path $ScriptDir "..\..")
$Dist = Join-Path $DaemonDir "dist"

Set-Location $DaemonDir
New-Item -ItemType Directory -Force -Path $Dist | Out-Null

Write-Host "==> Building keel-daemon.exe (release, --features tray)"
cargo build --release --features tray
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

# NSIS picks the exe up from the script's own directory.
Copy-Item "target\release\keel-daemon.exe" (Join-Path $ScriptDir "keel-daemon.exe") -Force

Write-Host "==> Building KeelSetup.exe with NSIS"
$makensis = Get-Command makensis -ErrorAction SilentlyContinue
if (-not $makensis) {
    $candidates = @(
        "$env:ProgramFiles\NSIS\makensis.exe",
        "${env:ProgramFiles(x86)}\NSIS\makensis.exe"
    )
    $makensis = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $makensis) { throw "NSIS not found - install it with: winget install NSIS.NSIS" }
} else {
    $makensis = $makensis.Source
}

& $makensis (Join-Path $ScriptDir "keel-installer.nsi")
if ($LASTEXITCODE -ne 0) { throw "makensis failed" }

Move-Item (Join-Path $ScriptDir "KeelSetup.exe") (Join-Path $Dist "KeelSetup.exe") -Force
Remove-Item (Join-Path $ScriptDir "keel-daemon.exe") -Force

Write-Host ""
Write-Host "Done: $Dist\KeelSetup.exe"
Write-Host "Users: run the installer, launch Keel, the tray icon appears - no terminal."
