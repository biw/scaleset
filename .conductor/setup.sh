#!/usr/bin/env bash
set -euo pipefail

if command -v pnpm >/dev/null 2>&1; then
  exec pnpm install --frozen-lockfile
fi

if command -v corepack >/dev/null 2>&1; then
  exec corepack pnpm install --frozen-lockfile
fi

echo "pnpm or Corepack is required to set up this workspace." >&2
exit 1
