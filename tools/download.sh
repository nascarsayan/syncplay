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

aria2c -d "$TARGET_DIR" "$URL"
