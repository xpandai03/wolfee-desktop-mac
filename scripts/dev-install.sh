#!/bin/bash
set -euo pipefail

APP_NAME="Wolfee Desktop"
APP_SRC="release/mac-arm64/${APP_NAME}.app"
APP_DEST="/Applications/${APP_NAME}.app"
STORE_DIR="$HOME/Library/Application Support/wolfee-desktop"

echo "══════════════════════════════════════"
echo "  Wolfee Desktop — Dev Install"
echo "══════════════════════════════════════"

# 1. Verify build exists
if [ ! -d "$APP_SRC" ]; then
  echo "ERROR: Build not found at $APP_SRC"
  echo "Run: npm run build && npx electron-builder --mac --arm64"
  exit 1
fi

# 2. Kill running instance
echo "[1/5] Killing running instances..."
killall "$APP_NAME" 2>/dev/null && echo "  Killed." || echo "  None running."
sleep 0.5

# 3. Remove old install
echo "[2/5] Removing old app from /Applications..."
rm -rf "$APP_DEST" && echo "  Removed." || echo "  Not found."

# 4. Clear Electron store (fresh pairing state)
echo "[3/5] Clearing Electron store..."
rm -rf "$STORE_DIR" && echo "  Cleared: $STORE_DIR" || echo "  Not found."

# 5. Clear quarantine + install
echo "[4/5] Installing new build..."
xattr -cr "$APP_SRC"
cp -R "$APP_SRC" "$APP_DEST"
echo "  Installed to $APP_DEST"

# 6. Launch
echo "[5/5] Launching..."
open "$APP_DEST"

echo ""
echo "Done. Check the menu bar for the Wolfee tray icon."
echo "══════════════════════════════════════"
