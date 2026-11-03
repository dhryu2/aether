#!/bin/bash
# 격리 서버. 라이브 8787과 .env는 읽지 않는다. 포트는 8790만 쓴다.
# Playwright는 이 스크립트를 준비 단계보다 먼저 실행한다. 임시 폴더는 여기서 만든다. DB는 그 폴더 안 SQLite 파일이다.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
RUNTIME="$HERE/.runtime"
STATE="$RUNTIME/state.json"
DATA_DIR=""
WORK_DIR=""
CLEAN=0

cleanup() {
  if [ "$CLEAN" != 1 ]; then
    return
  fi
  if [ -n "$DATA_DIR" ] && [ "${DATA_DIR#/}" != "$DATA_DIR" ]; then
    rm -rf "$DATA_DIR"
  fi
  if [ -n "$WORK_DIR" ] && [ "${WORK_DIR#/}" != "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
  rm -rf "$RUNTIME"
}

# 기동에 실패하면 여기서 지운다. 시험이 끝나면 Playwright가 프로세스 묶음을 죽이고, 그 정리는 global-teardown.ts가 한다.
trap cleanup EXIT

if lsof -nP -iTCP:8790 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "8790 포트가 이미 쓰이고 있다. 라이브 8787은 건드리지 말고, 8790만 비운 뒤 다시 돌린다." >&2
  exit 1
fi

if [ ! -f "$ROOT/web/dist/index.html" ]; then
  echo "web/dist가 없다. e2e에서 npm test를 돌리면 웹 빌드가 먼저 된다." >&2
  exit 1
fi

DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aether-e2e-data.XXXXXX")"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aether-e2e-work.XXXXXX")"
mkdir -p "$WORK_DIR/notes" "$RUNTIME"
CLEAN=1

DB_FILE="$DATA_DIR/aether.sqlite"
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({dataDir:process.argv[2], workDir:process.argv[3], db:process.argv[4]}))' "$STATE" "$DATA_DIR" "$WORK_DIR" "$DB_FILE"

export AETHER_DB_PATH="$DB_FILE"
export PORT=8790
export AETHER_HOST=127.0.0.1
export AETHER_AUTH_MODE=off
export AETHER_DATA_DIR="$DATA_DIR"
export AETHER_PROJECT_ROOT="$WORK_DIR"
export AETHER_WEB_DIST="$ROOT/web/dist"
export AETHER_SEARCH_SUMMARIZE=0
export AETHER_SERVE_STATIC=1

cd "$ROOT/server"
# exec를 쓰지 않는다. 프로세스가 스스로 끝나면 위의 EXIT 정리가 돌게 두기 위해서다.
node --import tsx "$HERE/server-entry.ts"
