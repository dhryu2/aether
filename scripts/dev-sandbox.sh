#!/bin/sh
# 격리 시험 환경: 임시 데이터 폴더 + 운영(8787)이 아닌 포트의 서버와 웹 개발 서버를 함께 띄운다.
# 운영 DB·세션 폴더·서버는 건드리지 않는다. Ctrl+C로 둘 다 내리고 임시 폴더를 지운다.
# 사용: scripts/dev-sandbox.sh  (포트 바꾸기: SANDBOX_API_PORT=8799 SANDBOX_WEB_PORT=5199)
set -eu
API_PORT="${SANDBOX_API_PORT:-8799}"
WEB_PORT="${SANDBOX_WEB_PORT:-5199}"
[ "$API_PORT" != 8787 ] || { echo "운영 포트(8787)는 쓸 수 없다" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$DATA"' EXIT INT TERM
echo "시험 데이터: $DATA / 서버 :$API_PORT / 화면 http://127.0.0.1:$WEB_PORT"
(cd "$ROOT/server" && exec env -u AETHER_CONFIG -u AETHER_DB_PATH AETHER_DATA_DIR="$DATA" PORT="$API_PORT" npm start) &
(cd "$ROOT/web" && AETHER_DEV_API="http://127.0.0.1:$API_PORT" exec npx vite --port "$WEB_PORT" --strictPort) &
wait
