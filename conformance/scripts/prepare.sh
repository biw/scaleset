#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_root"

if command -v pnpm >/dev/null 2>&1; then
  pnpm_command=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  pnpm_command=(corepack pnpm)
else
  echo "pnpm (or Corepack) is required to prepare conformance tests." >&2
  exit 1
fi

"${pnpm_command[@]}" install --frozen-lockfile

if ! command -v go >/dev/null 2>&1; then
  echo "Go is required for conformance tests. Install Go, then rerun pnpm test:conformance." >&2
  exit 1
fi

go version
(
  cd conformance/go
  go mod download
)
