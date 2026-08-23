#!/usr/bin/env bash
# Build a standalone AitherShell CLI binary using Bun's native compiler.
# Requires: bun (https://bun.sh)
#
# Usage:
#   ./build-standalone.sh                  # Build for current platform
#   ./build-standalone.sh --target linux   # Cross-compile for linux-x64

set -euo pipefail
cd "$(dirname "$0")"

TARGET=""
OUTFILE="dist/aither-shell"

case "${1:-}" in
  --target)
    case "${2:-}" in
      linux)   TARGET="bun-linux-x64" ;;
      macos)   TARGET="bun-darwin-arm64" ;;
      windows) TARGET="bun-windows-x64"; OUTFILE="dist/aither-shell.exe" ;;
      *)       echo "Unknown target: ${2:-}. Use: linux, macos, windows"; exit 1 ;;
    esac
    ;;
esac

mkdir -p dist

echo "Installing dependencies..."
bun install

if [ -n "$TARGET" ]; then
  echo "Building for $TARGET..."
  bun build --compile --target="$TARGET" src/main.ts --outfile "$OUTFILE"
else
  echo "Building for current platform..."
  bun build --compile src/main.ts --outfile "$OUTFILE"
fi

echo "Built: $OUTFILE"
ls -lh "$OUTFILE"
