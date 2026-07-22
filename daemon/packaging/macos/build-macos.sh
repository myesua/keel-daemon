#!/usr/bin/env bash
# =============================================================================
# Keel — macOS desktop app packager
#
# Turns the keel-daemon Rust binary into a double-clickable Keel.app
# (menubar app, no Dock icon, no terminal) and wraps it in a drag-to-
# Applications .dmg installer.
#
# Run this ON A MAC (Xcode command-line tools + Rust required):
#
#   cd daemon
#   ./packaging/macos/build-macos.sh
#
# Output: dist/Keel.dmg  (and dist/Keel.app)
#
# Environment knobs (all optional):
#   KEEL_COMPANION_URL    Web-app URL baked into the tray's "Open Keel" menu
#                         item (e.g. https://your-keel-space-url).
#   KEEL_SIGN_IDENTITY    "Developer ID Application: Your Name (TEAMID)".
#                         When set, the .app and .dmg are code-signed with the
#                         hardened runtime (required for notarization).
#   KEEL_NOTARY_PROFILE   notarytool keychain profile name. When set (and the
#                         build is signed), the .dmg is submitted to Apple
#                         notarization and stapled. Create the profile once:
#                           xcrun notarytool store-credentials keel-notary \
#                             --apple-id you@example.com --team-id TEAMID \
#                             --password <app-specific-password>
#   KEEL_ICON_PNG         Path to a square PNG (1024x1024 ideal) for the app
#                         icon. Defaults to downloading the Keel brand icon.
#
# Unsigned builds work fine for personal use, but Gatekeeper will quarantine
# the download: users must right-click the app > Open (once), or you notarize.
# See packaging/README.md for the full signing/notarization walkthrough.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST="$DAEMON_DIR/dist"
APP="$DIST/Keel.app"
DMG="$DIST/Keel.dmg"
BRAND_ICON_URL="https://storage.googleapis.com/audos-images/brand-icons/c7e389be-8dfa-4d8f-895c-158fb5f0d828.mono.png"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this script must run on macOS (it needs lipo, codesign, hdiutil, iconutil)." >&2
  exit 1
fi

cd "$DAEMON_DIR"
rm -rf "$APP" "$DMG"
mkdir -p "$DIST"

# ---------------------------------------------------------------------------
# 1. Build a universal (Apple Silicon + Intel) release binary with the tray.
#    KEEL_COMPANION_URL is read at compile time by src/tray.rs.
# ---------------------------------------------------------------------------
echo "==> Building keel-daemon (release, --features tray, universal)"
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

cargo build --release --features tray --target aarch64-apple-darwin
cargo build --release --features tray --target x86_64-apple-darwin

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create \
  target/aarch64-apple-darwin/release/keel \
  target/x86_64-apple-darwin/release/keel \
  -output "$APP/Contents/MacOS/keel"

cp "$SCRIPT_DIR/Info.plist" "$APP/Contents/Info.plist"

# ---------------------------------------------------------------------------
# 2. App icon: PNG -> .icns via sips + iconutil (no extra tooling).
# ---------------------------------------------------------------------------
ICON_PNG="${KEEL_ICON_PNG:-$DIST/keel-icon.png}"
if [[ ! -f "$ICON_PNG" ]]; then
  echo "==> Downloading brand icon"
  curl -fsSL "$BRAND_ICON_URL" -o "$ICON_PNG" || true
fi
if [[ -f "$ICON_PNG" ]]; then
  echo "==> Generating AppIcon.icns"
  ICONSET="$DIST/AppIcon.iconset"
  rm -rf "$ICONSET" && mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512; do
    sips -z "$size" "$size" "$ICON_PNG" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$ICON_PNG" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$ICONSET"
else
  echo "warning: no icon PNG available — the app will use the generic icon." >&2
fi

# ---------------------------------------------------------------------------
# 3. Code-sign (hardened runtime) when an identity is provided.
# ---------------------------------------------------------------------------
if [[ -n "${KEEL_SIGN_IDENTITY:-}" ]]; then
  echo "==> Code-signing with: $KEEL_SIGN_IDENTITY"
  codesign --force --options runtime --timestamp \
    --sign "$KEEL_SIGN_IDENTITY" "$APP/Contents/MacOS/keel"
  codesign --force --options runtime --timestamp \
    --sign "$KEEL_SIGN_IDENTITY" "$APP"
  codesign --verify --deep --strict "$APP"
else
  # Ad-hoc signature so Apple Silicon will run the binary at all.
  echo "==> No KEEL_SIGN_IDENTITY set — ad-hoc signing (unsigned distribution)"
  codesign --force --deep --sign - "$APP"
fi

# ---------------------------------------------------------------------------
# 4. DMG: Keel.app + an /Applications symlink, classic drag-to-install.
# ---------------------------------------------------------------------------
echo "==> Building Keel.dmg"
STAGE="$DIST/dmg-stage"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/Keel.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Keel" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

if [[ -n "${KEEL_SIGN_IDENTITY:-}" ]]; then
  codesign --force --timestamp --sign "$KEEL_SIGN_IDENTITY" "$DMG"
fi

# ---------------------------------------------------------------------------
# 5. Notarize + staple (signed builds only).
# ---------------------------------------------------------------------------
if [[ -n "${KEEL_NOTARY_PROFILE:-}" && -n "${KEEL_SIGN_IDENTITY:-}" ]]; then
  echo "==> Submitting to Apple notarization (this can take a few minutes)"
  xcrun notarytool submit "$DMG" --keychain-profile "$KEEL_NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  xcrun stapler staple "$DMG"
  echo "==> Notarized and stapled."
elif [[ -n "${KEEL_SIGN_IDENTITY:-}" ]]; then
  echo "note: signed but NOT notarized — set KEEL_NOTARY_PROFILE to notarize."
else
  cat <<'EOF'
note: UNSIGNED build. Users who download this DMG must right-click
Keel.app > Open the first time (Gatekeeper). To ship without that friction:
  1. Join the Apple Developer Program ($99/yr).
  2. Create a "Developer ID Application" certificate in Xcode.
  3. Re-run with KEEL_SIGN_IDENTITY and KEEL_NOTARY_PROFILE set.
See packaging/README.md for the step-by-step.
EOF
fi

echo
echo "Done: $DMG"
