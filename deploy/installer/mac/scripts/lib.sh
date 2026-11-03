#!/bin/bash
# preinstall·postinstall이 같이 쓰는 위치 계산. 다른 곳에서 source해서 쓴다(직접 실행하지 않는다).
# 시험용: AETHER_PKG_HOME이 있으면 그 폴더를 사용자 홈으로 본다.
LABEL="com.aether.app"

if [ -n "${AETHER_PKG_HOME:-}" ]; then
  HOME_DIR="$AETHER_PKG_HOME"
  TARGET_USER="$(id -un)"
elif [ "$(id -u)" = "0" ]; then
  # 설치 프로그램이 관리자 권한으로 스크립트를 돌린 경우: 지금 로그인한 사용자의 홈을 쓴다.
  TARGET_USER="$(stat -f %Su /dev/console)"
  HOME_DIR="$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')"
else
  TARGET_USER="$(id -un)"
  HOME_DIR="${HOME:-}"
  # HOME이 비어 있으면 계정 정보에서 읽는다.
  [ -n "$HOME_DIR" ] || HOME_DIR="$(dscl . -read "/Users/$TARGET_USER" NFSHomeDirectory | sed 's/^NFSHomeDirectory: //')"
fi
TARGET_UID="$(id -u "$TARGET_USER")"

# 설치 위치는 사용자 홈의 Applications/Aether로 고정한다(설치 프로그램이 넘기는 $2는 믿지 않는다).
APP="$HOME_DIR/Applications/Aether"
PLIST="$HOME_DIR/Library/LaunchAgents/$LABEL.plist"
CONFIG_DIR="$HOME_DIR/Library/Application Support/Aether"
# 설치본의 임시 폴더. 같은 계정의 다른 Aether(운영 서버)와 임시 폴더를 나눠 서로의 배경 작업 폴더를 지우지 않게 한다.
TMP_DIR="$CONFIG_DIR/tmp"

# 관리자 권한으로 돌았다면 만든 파일의 주인을 사용자로 돌린다.
own() { if [ "$(id -u)" = "0" ] && [ -z "${AETHER_PKG_HOME:-}" ]; then chown "$TARGET_USER" "$@" 2>/dev/null || true; fi; }

# 실행 중인 서비스를 멈추고 완전히 내려갈 때까지(최대 약 15초) 기다린다. 없으면 바로 돌아온다.
stop_service() {
  launchctl bootout "gui/$TARGET_UID/$LABEL" >/dev/null 2>&1 || true
  local i=0
  while [ "$i" -lt 30 ] && launchctl print "gui/$TARGET_UID/$LABEL" >/dev/null 2>&1; do
    sleep 0.5; i=$((i + 1))
  done
}
