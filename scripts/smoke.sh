#!/usr/bin/env bash
# Start the API on a port, hit the main endpoints with curl, then stop it.
# Usage: scripts/smoke.sh [port]   (expects a seeded data/ folder)
set -euo pipefail
PORT="${1:-8000}"
BASE="http://127.0.0.1:${PORT}/api"
cd "$(dirname "$0")/../backend"

if curl -s -o /dev/null "http://127.0.0.1:${PORT}/api/health"; then
  echo "port ${PORT} is already in use; pass another port" >&2
  exit 1
fi

uv run uvicorn annolab.main:create_app --factory --host 127.0.0.1 --port "$PORT" --log-level warning &
PID=$!
cleanup() { local status=$?; kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; exit "$status"; }
trap cleanup EXIT

for _ in $(seq 1 50); do
  curl -s -o /dev/null "$BASE/health" && break
  sleep 0.2
done

check() {  # name, expected status, curl args...
  local name="$1" want="$2"; shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  printf '%-28s %s\n' "$name" "$got"
  [ "$got" = "$want" ] || { echo "expected $want" >&2; exit 1; }
}

TOKEN=$(curl -s -X POST "$BASE/auth/login" -H 'content-type: application/json' \
  --data '{"email":"admin@annolab.dev","password":"annolab"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
AUTH=(-H "Authorization: Bearer $TOKEN")

check "health" 200 "$BASE/health"
check "me" 200 "${AUTH[@]}" "$BASE/auth/me"
check "projects" 200 "${AUTH[@]}" "$BASE/projects"
check "stats 1" 200 "${AUTH[@]}" "$BASE/projects/1/stats"
check "items 1" 200 "${AUTH[@]}" "$BASE/projects/1/items?status=in_review"
check "media range" 206 "${AUTH[@]}" -H "Range: bytes=0-1023" "$BASE/items/1/media"
check "media token query" 200 "$BASE/items/1/media?token=$TOKEN"
check "consensus 1" 200 "${AUTH[@]}" "$BASE/items/1/consensus"
check "prelabel 1" 200 "${AUTH[@]}" -X POST "$BASE/items/1/prelabel"
check "export coco" 200 "${AUTH[@]}" "$BASE/projects/2/export?format=coco"
check "export yolo" 200 "${AUTH[@]}" "$BASE/projects/2/export?format=yolo"
check "export jsonl" 200 "${AUTH[@]}" "$BASE/projects/4/export?format=jsonl"
check "activity" 200 "${AUTH[@]}" "$BASE/projects/1/activity"
check "no token" 401 "$BASE/projects"
echo "smoke ok on port ${PORT}"
