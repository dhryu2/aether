#!/bin/bash
# apply-update.sh 시험. 임시 폴더와 빈 포트만 쓴다(운영 앱·데이터·8787은 건드리지 않는다).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
export AETHER_APP_BASE="$T/conf" AETHER_UPDATE_APP="$T/Aether.app" AETHER_UPDATE_BACKUP="$T/prev" AETHER_UPDATE_PORT="$PORT"
export AETHER_UPDATE_SKIP_VERIFY=1 AETHER_UPDATE_HEALTH_WAIT=3 TMPDIR="$T"
mkdir -p "$AETHER_APP_BASE"
cat >"$T/open.sh" <<'OPEN'
#!/bin/bash
nohup "$1/Contents/MacOS/Aether" >/dev/null 2>&1 </dev/null &
OPEN
chmod +x "$T/open.sh"; export AETHER_UPDATE_OPEN="$T/open.sh"
trap 'pkill -f "$T/" 2>/dev/null; rm -rf "$T"' EXIT

# 가짜 앱: node 스크립트. $2=new면 /api/health에 답하고, dead면 아무것도 띄우지 않는다.
mkapp() { # $1=경로 $2=old|new|dead
  mkdir -p "$1/Contents/MacOS"
  if [ "$2" = dead ]; then printf '#!/bin/bash\nexit 0\n' >"$1/Contents/MacOS/Aether"
  else printf '#!/usr/bin/env node\nrequire("http").createServer((q,r)=>r.end(JSON.stringify({ok:true,v:"%s"}))).listen(+process.env.AETHER_UPDATE_PORT,"127.0.0.1");\n' "$2" >"$1/Contents/MacOS/Aether"; fi
  chmod +x "$1/Contents/MacOS/Aether"; echo "$2" >"$1/VERSION"
}
fails=0
check() { if eval "$2"; then echo "통과: $1"; else echo "실패: $1"; fails=$((fails+1)); fi; }
last() { tail -n1 "$AETHER_APP_BASE/update.log"; }
wait_log() { for _ in $(seq 1 100); do last 2>/dev/null | grep -q '업데이트 \(완료\|실패\)' && return 0; sleep 0.2; done; return 1; }

# 1) 성공: 옛 앱이 떠 있는 상태에서 새 앱으로 바뀐다
mkapp "$AETHER_UPDATE_APP" old; "$AETHER_UPDATE_OPEN" "$AETHER_UPDATE_APP"; sleep 1
mkapp "$AETHER_APP_BASE/update/Aether.app" new
bash "$HERE/apply-update.sh"; rc=$?
check "성공: 종료코드 0" '[ $rc -eq 0 ]'
check "성공: 새 앱으로 교체" '[ "$(cat "$AETHER_UPDATE_APP/VERSION")" = new ]'
check "성공: 대기 앱 삭제" '[ ! -e "$AETHER_APP_BASE/update/Aether.app" ]'
check "성공: 새 앱 응답" 'curl -s "http://127.0.0.1:$PORT/api/health" | grep -q "\"v\":\"new\""'
check "성공: 로그 끝" '[ "$(last | cut -d" " -f3-)" = "업데이트 완료" ]'
check "성공: 백업에 옛 앱" '[ "$(cat "$AETHER_UPDATE_BACKUP/VERSION")" = old ]'

# 2) 실패: 새 앱이 안 뜨면 옛 앱으로 되돌린다
mkapp "$AETHER_APP_BASE/update/Aether.app" dead
bash "$HERE/apply-update.sh"; rc=$?
check "실패: 종료코드 1" '[ $rc -eq 1 ]'
check "실패: 옛 앱(new 버전 표시)으로 복구" '[ "$(cat "$AETHER_UPDATE_APP/VERSION")" = new ]'
sleep 1
check "실패: 복구한 앱이 응답" 'curl -s "http://127.0.0.1:$PORT/api/health" | grep -q "\"v\":\"new\""'
check "실패: 로그 끝" '[ "$(last | cut -d" " -f3-)" = "업데이트 실패: 이전 앱으로 되돌림" ]'
check "실패: 락 폴더 없음" '[ ! -e "$AETHER_APP_BASE/update.lock" ]'

# 3) --detach: 즉시 반환하고 뒤에서 끝까지 간다. 앱이 안 떠 있어도 된다.
pkill -f "$T/Aether.app/" ; sleep 1
mkapp "$AETHER_UPDATE_APP" old; mkapp "$AETHER_APP_BASE/update/Aether.app" new
: >"$AETHER_APP_BASE/update.log"
bash "$HERE/apply-update.sh" --detach; rc=$?
check "detach: 즉시 반환 코드 0" '[ $rc -eq 0 ]'
wait_log
check "detach: 새 앱으로 교체" '[ "$(cat "$AETHER_UPDATE_APP/VERSION")" = new ]'
check "detach: 로그 끝" '[ "$(last | cut -d" " -f3-)" = "업데이트 완료" ]'
check "detach: 임시 복사본 삭제" '[ -z "$(ls "$T"/aether-apply-update.* 2>/dev/null)" ]'

# 3-1) 앱 없음 + 백업 있음 + 새 앱 실패: 백업을 지우지 않고 앱 자리로 복구한다. 낡은 락(죽은 pid)도 치우고 진행한다.
pkill -f "$T/Aether.app/" ; sleep 1
rm -rf "$AETHER_UPDATE_APP"; rm -rf "$AETHER_UPDATE_BACKUP"; mkapp "$AETHER_UPDATE_BACKUP" old
mkapp "$AETHER_APP_BASE/update/Aether.app" dead
mkdir "$AETHER_APP_BASE/update.lock"; echo 99999999 >"$AETHER_APP_BASE/update.lock/pid"
bash "$HERE/apply-update.sh"; rc=$?
check "앱 없음: 종료코드 1" '[ $rc -eq 1 ]'
check "앱 없음: 백업이 앱 자리로 복구" '[ "$(cat "$AETHER_UPDATE_APP/VERSION")" = old ]'
check "앱 없음: 낡은 락을 치우고 진행(로그 끝 되돌림)" '[ "$(last | cut -d" " -f3-)" = "업데이트 실패: 이전 앱으로 되돌림" ]'
pkill -f "$T/Aether.app/" ; rm -rf "$AETHER_APP_BASE/update"

# 4) 대기 앱이 없으면 오류
bash "$HERE/apply-update.sh" --detach 2>/dev/null; check "대기 앱 없음: detach 오류" '[ $? -eq 1 ]'

[ $fails -eq 0 ] && echo "전부 통과" || { echo "실패 $fails건"; exit 1; }
