#!/usr/bin/env bash
# Source (don't run) before a release: `source scripts/load-release-env.sh`
# Loads .env.release and inflates the Tauri signing key from disk.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env.release"

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ Missing $ENV_FILE — see .env.release.example or BUILD.md"
  return 1 2>/dev/null || exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

if [ ! -s "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]; then
  echo "✗ Signing key missing/empty: $TAURI_SIGNING_PRIVATE_KEY_PATH"
  echo "  Restore from 1Password before building."
  return 1 2>/dev/null || exit 1
fi

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")"

echo "✓ Release env loaded — APPLE_ID=$APPLE_ID, R2_BUCKET=$R2_BUCKET"
echo "  Tauri key: $(wc -c < "$TAURI_SIGNING_PRIVATE_KEY_PATH" | tr -d ' ') bytes"
