#!/bin/bash
# 대기 중인 새 Aether.app(<설정 폴더>/update/Aether.app)으로 설치된 앱을 교체한다.
# 새 앱이 응답하지 않으면 이전 앱으로 되돌린다. 진행은 <설정 폴더>/update.log에 남긴다.
# 사용: apply-update.sh [--detach]   --detach는 새 세션에서 따로 돌려 바로 반환한다(호출한 프로세스가 앱 종료와 함께 죽어도 끝까지 간다).
# 환경(시험용 재정의): AETHER_APP_BASE, AETHER_UPDATE_APP, AETHER_UPDATE_PORT, AETHER_UPDATE_BACKUP,
#   AETHER_UPDATE_SKIP_VERIFY=1(서명 검사 생략), AETHER_UPDATE_OPEN(앱을 여는 명령), AETHER_UPDATE_HEALTH_WAIT(초, 기본 60)
CONF="${AETHER_APP_BASE:-$HOME/Library/Application Support/Aether}"
APP="${AETHER_UPDATE_APP:-/Applications/Aether.app}"
BACKUP="${AETHER_UPDATE_BACKUP:-$HOME/Library/Caches/Aether-previous-app}"
STAGED="$CONF/update/Aether.app"
LOG="$CONF/update.log"
OPEN="${AETHER_UPDATE_OPEN:-open}"
PORT="${AETHER_UPDATE_PORT:-$(plutil -extract port raw -o - "$CONF/config.json" 2>/dev/null)}"
PORT="${PORT:-8787}"

if [ "${1:-}" = "--detach" ] && [ -z "${AETHER_UPDATE_DETACHED:-}" ]; then
  [ -d "$STAGED" ] || { echo "적용할 업데이트가 없습니다: $STAGED" >&2; exit 1; }
  COPY="$(mktemp "${TMPDIR:-/tmp}/aether-apply-update.XXXXXX")" || exit 1
  cp "$0" "$COPY"
  AETHER_UPDATE_DETACHED="$COPY" nohup /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/bash "$COPY" >/dev/null 2>&1 </dev/null &
  exit 0
fi

mkdir -p "$CONF"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }
LOCKED="" MOVED=""
cleanup() { [ -n "$LOCKED" ] && rm -rf "$CONF/update.lock"; [ -n "${AETHER_UPDATE_DETACHED:-}" ] && rm -f "$AETHER_UPDATE_DETACHED"; }
trap cleanup EXIT

app_running() { pgrep -f "$APP/Contents/(MacOS|Resources/core)/" >/dev/null; }
quit_app() {
  pkill -TERM -f "$APP/Contents/MacOS/Aether" 2>/dev/null
  for _ in $(seq 1 60); do app_running || return 0; sleep 0.5; done
  pkill -KILL -f "$APP/Contents/" 2>/dev/null
  sleep 1
}
healthy() { curl -s -m 2 "http://127.0.0.1:$PORT/api/health" | grep -q '"ok":true'; }

fail() {
  if [ -n "$MOVED" ]; then
    log "새 앱이 정상으로 뜨지 않아 이전 앱으로 되돌립니다: $1"
    quit_app
    rm -rf "$APP"
    if mv "$BACKUP" "$APP"; then
      "$OPEN" "$APP"
      log "업데이트 실패: 이전 앱으로 되돌림"
    else
      log "업데이트 실패: 되돌리지 못했습니다. 이전 앱은 $BACKUP 에 있습니다"
    fi
  else
    log "업데이트 실패: $1"
  fi
  exit 1
}

# 락 폴더에 pid를 적는다. 잡기에 실패했는데 그 pid가 죽어 있으면 낡은 락이므로 지우고 한 번 다시 잡는다.
if ! mkdir "$CONF/update.lock" 2>/dev/null; then
  kill -0 "$(cat "$CONF/update.lock/pid" 2>/dev/null)" 2>/dev/null && { log "업데이트 실패: 이미 진행 중입니다"; exit 1; }
  rm -rf "$CONF/update.lock"
  mkdir "$CONF/update.lock" 2>/dev/null || { log "업데이트 실패: 이미 진행 중입니다"; exit 1; }
fi
echo $$ >"$CONF/update.lock/pid"
LOCKED=1
log "업데이트 시작"
[ -d "$STAGED" ] || fail "대기 중인 앱이 없습니다($STAGED)"
if [ "${AETHER_UPDATE_SKIP_VERIFY:-}" != 1 ]; then
  codesign --verify --deep --strict "$STAGED" 2>>"$LOG" || fail "새 앱의 서명 검사에 실패했습니다"
  log "서명 검사 통과"
fi

log "실행 중인 앱을 종료합니다"
quit_app
mkdir -p "$(dirname "$BACKUP")"
if [ -d "$APP" ]; then
  rm -rf "$BACKUP"
  [ -e "$BACKUP" ] && fail "백업 자리를 비우지 못했습니다"
  mv "$APP" "$BACKUP" 2>>"$LOG" || fail "이전 앱을 백업 자리로 옮기지 못했습니다"
  MOVED=1
elif [ -d "$BACKUP" ]; then
  MOVED=1  # 앱이 없으면 기존 백업을 지우지 않고 되돌림 대상으로 쓴다
fi
ditto "$STAGED" "$APP" 2>>"$LOG" || fail "새 앱을 복사하지 못했습니다"
log "새 앱을 엽니다"
"$OPEN" "$APP" 2>>"$LOG" || fail "새 앱을 열지 못했습니다"

for _ in $(seq 1 "$(( ${AETHER_UPDATE_HEALTH_WAIT:-60} * 2 ))"); do
  healthy && break
  sleep 0.5
done
healthy || fail "서버가 응답하지 않습니다"
rm -rf "$STAGED"
log "업데이트 완료"
