#!/usr/bin/env bash
set -euo pipefail

if command -v pnpm >/dev/null 2>&1; then
  exec pnpm test:unit:watch
fi

if command -v corepack >/dev/null 2>&1; then
  exec corepack pnpm test:unit:watch
fi

echo "pnpm or Corepack is required to run the test watcher." >&2
exit 1
