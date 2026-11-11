#!/bin/bash
# Double-click this file to start Video Review (macOS).
# The first time, it installs Node.js if it's missing (asks for your Mac password).
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

echo ""
echo "  Video Review"
echo "  ------------"

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js isn't installed yet. Downloading the official installer from nodejs.org…"
  TMP="$(mktemp -d)"
  BASE="https://nodejs.org/dist/latest-v22.x"
  PKG="$(curl -fsSL "$BASE/SHASUMS256.txt" | awk '/\.pkg$/ {print $2; exit}')"
  SUM="$(curl -fsSL "$BASE/SHASUMS256.txt" | awk '/\.pkg$/ {print $1; exit}')"
  if [ -z "$PKG" ] || ! curl -fL --progress-bar "$BASE/$PKG" -o "$TMP/$PKG"; then
    echo "  Couldn't download Node.js. Install it from https://nodejs.org (LTS button), then double-click this file again."
    open "https://nodejs.org"; read -r -p "  Press Enter to close…"; exit 1
  fi
  if [ "$(shasum -a 256 "$TMP/$PKG" | awk '{print $1}')" != "$SUM" ]; then
    echo "  The download didn't match its checksum, so it wasn't installed. Please try again later."
    read -r -p "  Press Enter to close…"; exit 1
  fi
  echo "  Installing Node.js — type your Mac password when asked (nothing shows while you type)."
  sudo installer -pkg "$TMP/$PKG" -target / || { read -r -p "  Install failed. Press Enter to close…"; exit 1; }
  export PATH="/usr/local/bin:$PATH"
fi

echo "  Node.js $(node --version) ✓"
if command -v ffmpeg >/dev/null 2>&1; then echo "  ffmpeg ✓"; else echo "  ffmpeg not installed (optional — needed only for MP4 renders, see README)"; fi
echo ""
echo "  Starting… your browser will open. Keep this window open while you work."
echo "  To stop the app, close this window or press Ctrl+C."
echo ""
node server.js
