#!/usr/bin/env bash
# 배포용 dmg 생성: build-manager-app.sh가 만든 Aether.app을 담아 끌어 넣기 형식으로 묶는다.
# 사용: build-manager-app.sh를 먼저 돌린 뒤 build-mac-dmg.sh. 결과: build/installers/Aether-<버전>-mac-arm64.dmg
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/build/installers"
VERSION="$(node -p "require('$REPO/server/package.json').aetherReleaseVersion")"
APP="$OUT/Aether-$VERSION-mac-arm64-app/Aether.app"
DMG="$OUT/Aether-$VERSION-mac-arm64.dmg"
[ -d "$APP" ] || { echo "앱이 없습니다($APP). scripts/build-manager-app.sh를 먼저 실행하세요." >&2; exit 1; }

WORK="$(mktemp -d)"; MNT="$(mktemp -d)"
TMP_DMG="$OUT/.Aether-$VERSION-tmp.dmg"  # hdiutil은 .dmg로 끝나지 않으면 이름을 바꾼다
trap 'hdiutil detach "$MNT" -quiet 2>/dev/null || true; rm -rf "$WORK" "$MNT" "$TMP_DMG"' EXIT
ditto "$APP" "$WORK/Aether.app"  # 심볼릭 링크와 실행 권한을 그대로 지킨다
ln -s /Applications "$WORK/Applications"
hdiutil create -volname Aether -srcfolder "$WORK" -format UDZO -ov "$TMP_DMG" >/dev/null  # 점검을 통과한 뒤에만 정식 이름을 붙인다

# 자체 점검: 만든 dmg를 열어 안의 앱 서명이 멀쩡한지 확인한다.
hdiutil attach "$TMP_DMG" -nobrowse -readonly -noautoopen -mountpoint "$MNT" >/dev/null
codesign --verify --deep --strict "$MNT/Aether.app"
hdiutil detach "$MNT" -quiet
mv -f "$TMP_DMG" "$DMG"
echo "완료: $DMG"
du -sh "$DMG" | sed 's/^/  /'
