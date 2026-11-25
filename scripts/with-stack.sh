#!/usr/bin/env bash
# Run a command against a throwaway stack: a freshly seeded data dir, the API and Vite on free ports.
# Your own data/ folder and any running dev servers are left alone.
# Usage: scripts/with-stack.sh <command...>   (the command sees WEB_URL, API_URL and ANNOLAB_DATA_DIR)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }

DATA="$(mktemp -d "${TMPDIR:-/tmp}/annolab-stack.XXXXXX")"
API_PORT="$(free_port)"
WEB_PORT="$(free_port)"
export ANNOLAB_DATA_DIR="$DATA"
export API_URL="http://127.0.0.1:${API_PORT}"
export WEB_URL="http://127.0.0.1:${WEB_PORT}"

PIDS=()
cleanup() {
  local status=$?
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && wait "$p" 2>/dev/null || true; done
  rm -rf "$DATA"
  exit "$status"
}
trap cleanup EXIT INT TERM

(cd "$ROOT/backend" && uv run python -m annolab.seed >/dev/null)
(cd "$ROOT/backend" && exec uv run uvicorn annolab.main:create_app --factory --host 127.0.0.1 --port "$API_PORT" --log-level warning) &
PIDS+=($!)
(cd "$ROOT/web" && ANNOLAB_API="$API_URL" exec npx vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort --logLevel warn) &
PIDS+=($!)

for _ in $(seq 1 100); do
  curl -sf -o /dev/null "$WEB_URL/api/health" && curl -sf -o /dev/null "$WEB_URL/" && break
  sleep 0.2
done
curl -sf -o /dev/null "$WEB_URL/api/health" || { echo "stack did not start" >&2; exit 1; }
echo "stack: api $API_URL, web $WEB_URL, data $DATA"

(cd "$ROOT" && bash -c "$*")
