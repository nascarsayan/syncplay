#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: bun run download -- <folder-name> <url>"
  exit 1
fi

FOLDER_NAME="$1"
URL="$2"

VIDEO_DIR="${VIDEO_DIR:-$(pwd)/videos}"
TARGET_DIR="${VIDEO_DIR}/${FOLDER_NAME}"

mkdir -p "$TARGET_DIR"

if ! command -v aria2c >/dev/null 2>&1; then
  echo "aria2c not found. Please install it (apt install -y aria2)."
  exit 1
fi

aria2c --seed-time=0 -d "$TARGET_DIR" "$URL"

if command -v bun >/dev/null 2>&1; then
  bun run subs -- "$FOLDER_NAME"
  bun run convert -- "$FOLDER_NAME"
elif [[ -x "$HOME/.bun/bin/bun" ]]; then
  "$HOME/.bun/bin/bun" run subs -- "$FOLDER_NAME"
  "$HOME/.bun/bin/bun" run convert -- "$FOLDER_NAME"
else
  echo "bun not found. Skipping conversion."
fi
