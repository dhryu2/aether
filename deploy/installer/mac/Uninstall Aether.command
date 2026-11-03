#!/bin/bash
# Aether 제거. 서비스 해제, 설정 파일 삭제, 패키지 기록 삭제, 프로그램 폴더 삭제를 하고 데이터는 물어본다(기본 아니오).
# 프로그램 폴더는 이 파일이 있는 bin의 부모다. 안에서 이름으로 지정한 하위 폴더만 지운다.
main() {
  local APP LABEL="com.aether.app" UID_T PLIST CONFIG ans
  APP="$(cd "$(dirname "$0")/.." && pwd)"
  UID_T="$(id -u)"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  CONFIG="$HOME/Library/Application Support/Aether"

  # 엉뚱한 곳을 지우지 않도록, Aether 프로그램 폴더가 맞는지 먼저 본다.
  if [ ! -f "$APP/server/index.mjs" ]; then
    echo "Aether 프로그램 폴더가 아닙니다: $APP"; return 1
  fi
  echo "Aether를 제거합니다: $APP"

  # 폰 접속을 켜 둔 채 지우면 같은 포트의 다른 프로그램이 Tailscale 망에 열린다. 실패해도 제거는 계속한다.
  "$APP/node/bin/node" "$APP/server/index.mjs" --remote-off >/dev/null 2>&1 || true
  launchctl bootout "gui/$UID_T/$LABEL" >/dev/null 2>&1 || true
  # 서버가 완전히 내려갈 때까지 기다린다(최대 약 15초).
  local i=0
  while [ "$i" -lt 30 ] && launchctl print "gui/$UID_T/$LABEL" >/dev/null 2>&1; do sleep 0.5; i=$((i + 1)); done
  rm -f "$PLIST"
  # 우리 설정 폴더를 가리키는 링크일 때만 지운다.
  [ "$(readlink "$HOME/Desktop/Aether.webloc" 2>/dev/null)" = "$CONFIG/Aether.webloc" ] && rm -f "$HOME/Desktop/Aether.webloc"
  pkgutil --forget com.aether.app --volume "$HOME" >/dev/null 2>&1 || true

  launchctl bootout "gui/$UID_T/com.aether.updater" >/dev/null 2>&1 || true
  rm -rf "$CONFIG/updates"
  for d in bin node server web .old; do rm -rf "${APP:?}/$d"; done
  rmdir "$APP" 2>/dev/null || true

  if [ -d "$CONFIG" ]; then
    printf '설정과 기본 데이터(%s)도 지울까요? 대화 기록과 작업 중인 코드 복사본(worktrees)도 함께 지워집니다. [y/N] ' "$CONFIG"
    read -r ans
    case "$ans" in
      y|Y|yes|YES) rm -rf "$CONFIG"; echo "설정과 기본 데이터를 지웠습니다." ;;
      *) echo "설정과 데이터는 그대로 두었습니다." ;;
    esac
    echo "직접 정한 다른 위치의 데이터 폴더는 지우지 않았습니다."
  fi
  echo "제거를 마쳤습니다."
}
main "$@"
exit $?
