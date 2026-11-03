#!/bin/bash
# 앱 안 업데이트의 맥 설치 과정. 서버가 일회용 launchd 작업(com.aether.updater)으로 실행하므로 서버가 꺼져도 살아 있다.
# 사용: aether-update.sh <프로그램 폴더> <updates 폴더> <새 버전>
# 약속(server/update/install.ts): 새 서버는 뜨면 ok-<버전>을 쓰고, 되돌렸으면 rolled-back에 실패한 버전을 적는다.
set -u
APP="$1"
UPDATES="$2"
VERSION="$3"
OLD="$APP/.old"
LABEL="com.aether.app"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HEALTHY_WAIT_SECONDS="${AETHER_UPDATE_WAIT:-180}"

stop_service() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  local i=0
  while [ "$i" -lt 60 ] && launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; do
    sleep 0.5; i=$((i + 1))
  done
}

finish() {
  rm -f "$UPDATES/ok-$VERSION"
  launchctl bootout "$DOMAIN/com.aether.updater" >/dev/null 2>&1 || true
  exit 0
}

# 이번 실행에서 옮긴 이전 파일을 되돌리고 실패 표시를 남긴 뒤 이전 버전을 다시 띄운다. 하나라도 되돌리지 못하면 .old를 남긴다.
MOVED=0
roll_back() {
  echo "Aether 업데이트 실패: 이전 버전으로 되돌립니다." >&2
  stop_service
  if [ "$MOVED" = 1 ]; then
    local failed=0
    for d in bin node server web; do
      if [ -e "$OLD/$d" ]; then
        rm -rf "${APP:?}/$d"
        mv "$OLD/$d" "$APP/$d" || failed=1
      fi
    done
    [ "$failed" = 0 ] && rm -rf "$OLD"
  fi
  printf '%s' "$VERSION" > "$UPDATES/rolled-back"
  launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  finish
}

stop_service

# preinstall은 server/index.mjs가 없으면 이전 파일을 지우지 않는다. 옮겨 두면 설치가 실패해도 되돌릴 수 있다.
# 지난 .old가 일부라도 남아 있으면 되돌릴 때 정상 파일을 덮어쓰므로 옮기기 전에 멈춘다.
# shortcut: 전원이 꺼지는 등으로 설치가 중간에 끊긴 경우는 복구하지 않는다. 사용자가 설치 파일을 다시 실행하면 고쳐진다. 실제로 일어나면 시작 때 .old 복구를 더한다.
rm -rf "$OLD"
[ ! -e "$OLD" ] || roll_back
mkdir -p "$OLD" || roll_back
MOVED=1
for d in bin node server web; do
  mv "$APP/$d" "$OLD/$d" || roll_back
done

rm -f "$UPDATES/ok-$VERSION"
installer -pkg "$UPDATES/Aether-update.pkg" -target CurrentUserHomeDirectory || roll_back

i=0
while [ "$i" -lt "$HEALTHY_WAIT_SECONDS" ]; do
  if [ -e "$UPDATES/ok-$VERSION" ]; then
    rm -rf "$OLD"
    finish
  fi
  sleep 1; i=$((i + 1))
done
roll_back
