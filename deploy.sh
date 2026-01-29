#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$ROOT_DIR"

git pull --ff-only origin master

# Install deps (none currently, but keeps it future-proof)
if [ -f bun.lock ] || [ -f package.json ]; then
  ~/.bun/bin/bun install
fi

sudo systemctl restart syncplay
