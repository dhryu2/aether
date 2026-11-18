#!/usr/bin/env bash
# 관리 앱 Aether.app 생성: manager/(Tauri 메뉴 막대 앱)에 서버 묶음(node, server, web)을 넣는다.
# 사용: build-installers.sh를 먼저 돌린 뒤 build-manager-app.sh
# 필요: cargo와 cargo-tauri(~/.cargo/bin), codesign, ditto(macOS).
# 기본은 임시 서명(ad-hoc)이다. 배포용이 아니다(Gatekeeper가 막고, 빌드마다 앱 신원이 바뀌어 권한을 다시 묻는다).
# 환경: AETHER_SIGN_IDENTITY(선택) = 서명 인증서 이름, AETHER_SIGN_KEYCHAIN(선택) = 그 인증서가 든 키체인 경로.
#       같은 인증서로 서명하면 다시 빌드해도 앱 신원이 같아 macOS 권한이 유지된다.
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
cp "$REPO/manager/src-tauri/resources/apply-update.sh" "$DEST/Aether.app/Contents/Resources/apply-update.sh"  # 서명 전에 넣는다
chmod 755 "$DEST/Aether.app/Contents/Resources/apply-update.sh"

codesign --force --deep --sign "${AETHER_SIGN_IDENTITY:--}" ${AETHER_SIGN_KEYCHAIN:+--keychain "$AETHER_SIGN_KEYCHAIN"} "$DEST/Aether.app"
codesign --verify --deep "$DEST/Aether.app"
echo "완료: $DEST/Aether.app"
du -sh "$DEST/Aether.app" | sed 's/^/  /'
