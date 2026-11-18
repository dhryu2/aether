#!/usr/bin/env bash
# 관리 앱 Aether.app 생성: manager/(Tauri 메뉴 막대 앱)에 서버 묶음(node, server, web)을 넣는다.
# 사용: build-installers.sh를 먼저 돌린 뒤 build-manager-app.sh
# 필요: cargo와 cargo-tauri(~/.cargo/bin), codesign, ditto(macOS).
# 서명 신원이 없어 임시 서명(ad-hoc)으로 만든다. 배포용이 아니다(Gatekeeper가 막고, 빌드마다 권한을 다시 묻는다).
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
export COPYFILE_DISABLE=1

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/build/installers"
VERSION="$(node -p "require('$REPO/server/package.json').aetherReleaseVersion")"
CORE="$OUT/Aether-$VERSION-mac-arm64"
DEST="$OUT/Aether-$VERSION-mac-arm64-app"

[ -f "$CORE/server/index.mjs" ] || { echo "서버 묶음이 없습니다($CORE). scripts/build-installers.sh를 먼저 실행하세요." >&2; exit 1; }
echo "서버 묶음: $CORE"
sed 's/^/  /' "$CORE/server/BUILD_INFO.txt"

(cd "$REPO/manager/src-tauri" && cargo tauri build --bundles app)

rm -rf "$DEST"; mkdir -p "$DEST"
ditto "$REPO/manager/src-tauri/target/release/bundle/macos/Aether.app" "$DEST/Aether.app"
# Tauri resources 설정 대신 직접 복사한다: node_modules의 심볼릭 링크와 실행 권한을 그대로 지킨다.
ditto "$CORE" "$DEST/Aether.app/Contents/Resources/core"
rm -rf "$DEST/Aether.app/Contents/Resources/core/bin"  # pkg 전용(삭제·업데이트 스크립트)

codesign --force --deep --sign - "$DEST/Aether.app"
codesign --verify --deep "$DEST/Aether.app"
echo "완료: $DEST/Aether.app"
du -sh "$DEST/Aether.app" | sed 's/^/  /'
