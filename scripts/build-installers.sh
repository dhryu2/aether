#!/usr/bin/env bash
# 설치 파일 생성: 윈도우 Aether-<버전>-win-x64.exe, 맥 Aether-<버전>-mac-arm64.pkg, 2단계 시험용 zip과 smoke.mjs.
# 사용: build-installers.sh [--no-secret-compare]   (기본은 저장소 server/.env 또는 AETHER_BUILD_ENV의 비밀 값이 묶음에 섞였는지 대조하고, 그 파일이 없으면 멈춘다)
# 환경: AETHER_UPDATE_URL(선택) = 다운로드 사이트 주소. 있으면 설치본이 그 주소로 새 버전을 확인한다.
# 필요: node, npm, rsync, curl, makensis(brew install makensis), pkgbuild·productbuild(macOS).
# 운영 web/dist·server/data·.env는 건드리지 않는다: git이 아는 파일만 임시 폴더로 복사해 거기서 빌드한다.
set -euo pipefail
unset NODE_ENV  # 상위 환경이 production이면 npm이 개발 의존성(vite, esbuild)을 빼 버린다
export COPYFILE_DISABLE=1  # tar·cp가 확장 속성을 ._ 파일로 풀어 놓지 않게 한다

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/build/installers"
CACHE="$REPO/build/cache"
# shellcheck disable=SC1091
source "$REPO/deploy/installer/node-version.env"
VERSION="$(node -p "require('$REPO/server/package.json').aetherReleaseVersion")"

command -v makensis >/dev/null || { echo "makensis가 없습니다. 'brew install makensis'로 설치한 뒤 다시 실행하세요." >&2; exit 1; }
for t in pkgbuild productbuild; do
  command -v "$t" >/dev/null || { echo "$t가 없습니다. 맥 패키지는 macOS에서만 만들 수 있습니다." >&2; exit 1; }
done
# makensis는 소스의 한글을 로캘로 읽는다. UTF-8이 아니면 "Bad text encoding"으로 실패한다.
export LC_ALL=en_US.UTF-8

WORK="$(mktemp -d)"
# 실패하면 임시 폴더와 반쯤 만들어진 결과물을 지운다(이전 성공본과 헷갈리지 않게).
trap 'rc=$?; rm -rf "$WORK"; if [ "$rc" -ne 0 ]; then rm -f "$OUT/Aether-$VERSION-win-x64.exe" "$OUT/Aether-$VERSION-mac-arm64.pkg"; fi; exit "$rc"' EXIT
mkdir -p "$OUT" "$CACHE"
rm -f "$OUT/Aether-$VERSION-win-x64.exe" "$OUT/Aether-$VERSION-mac-arm64.pkg"
INST="$REPO/deploy/installer"

# 빌드 기록: 어느 커밋에서 만들었는지 묶음에 남긴다. 커밋 안 한 변경이 있으면 경고하고 기록에도 적는다.
BUILD_COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
BUILD_DIRTY="clean"
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=normal 2>/dev/null)" ]; then
  BUILD_DIRTY="dirty(커밋 안 한 변경 있음)"
  echo "경고: 작업 폴더에 커밋하지 않은 변경이 있습니다. 이 빌드는 커밋 $BUILD_COMMIT 만으로 재현되지 않습니다." >&2
fi

NOCMP=""
case "${1:-}" in
  "") ;;
  --no-secret-compare) NOCMP="--no-secret-compare" ;;
  *) echo "알 수 없는 옵션: $1 (사용: build-installers.sh [--no-secret-compare])" >&2; exit 2 ;;
esac
# 오래 걸리는 빌드 전에 대조용 .env가 있는지 먼저 본다(값은 읽지 않는다).
BUILD_ENV="${AETHER_BUILD_ENV:-$REPO/server/.env}"
if [ -z "$NOCMP" ] && [ ! -f "$BUILD_ENV" ]; then
  echo "비밀 값을 대조할 .env가 없습니다($BUILD_ENV). AETHER_BUILD_ENV로 경로를 지정하거나, 생략하려면 --no-secret-compare를 쓰세요." >&2
  exit 1
fi

echo "[1/9] 소스 복사"
# 빌드에 필요한 폴더만 복사한다(deploy/installer 등은 원본에서 직접 읽는다). 작업 폴더에서 지운 추적 파일은 뺀다.
(cd "$REPO" && git ls-files -z -co --exclude-standard -- server web shared \
  | while IFS= read -r -d '' f; do if [ -e "$f" ]; then printf '%s\0' "$f"; fi; done \
  | rsync -a --from0 --files-from=- "$REPO/" "$WORK/src/")

echo "[2/9] 의존성 설치(빌드용)"
(cd "$WORK/src/web" && npm ci --silent) || { echo "경고: web npm ci 실패(네트워크 또는 lock 불일치). 위 메시지를 확인하세요." >&2; exit 1; }
(cd "$WORK/src/server" && npm ci --silent)

echo "[3/9] 화면 빌드"
(cd "$WORK/src/web" && npx vite build --outDir "$WORK/web-dist" --emptyOutDir >/dev/null)

# 새 버전 확인 주소: 빌드 때 AETHER_UPDATE_URL이 있으면 소스의 package.json에 넣는다. esbuild가 start.ts의 package.json을 묶음에 박고
# 같은 파일을 묶음 폴더로도 복사하므로 반드시 그 앞에서 넣는다. 없으면 꺼진 채로 빌드된다.
# 값은 설치본이 보는 곳에 평문으로 남으므로 사용자 이름·비밀번호·질의·조각이 든 주소는 거절한다(server/update/check.ts와 같은 규칙).
if [ -n "${AETHER_UPDATE_URL:-}" ]; then
  node -e '
    const fs = require("fs"); const f = process.argv[1];
    let u; try { u = new URL(process.env.AETHER_UPDATE_URL.trim()); } catch { u = null; }
    if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) { console.error("AETHER_UPDATE_URL은 사용자 이름·비밀번호·질의·조각이 없는 http 또는 https 주소여야 합니다."); process.exit(1); }
    if (u.protocol === "http:" && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) console.error("경고: 루프백이 아닌 http 주소입니다. 설치 파일이 중간에서 바뀔 수 있으니 실제 배포는 https를 쓰세요.");
    const j = JSON.parse(fs.readFileSync(f, "utf8")); j.aetherUpdateUrl = u.href.replace(/\/+$/, ""); fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  ' "$WORK/src/server/package.json"
else
  echo "경고: AETHER_UPDATE_URL이 없어 새 버전 확인이 꺼진 설치본이 만들어집니다." >&2
fi

# 앱 안 업데이트는 이 공개키로 서명을 확인한다. 공개키라 저장소에 둔다. 개인키는 build-site.mjs만 쓰고 저장소와 사이트 밖에 있다.
node -e '
  const fs = require("fs"); const [f, keyFile] = process.argv.slice(1);
  const j = JSON.parse(fs.readFileSync(f, "utf8")); j.aetherUpdatePublicKey = fs.readFileSync(keyFile, "utf8").trim(); fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
' "$WORK/src/server/package.json" "$INST/update-public-key.txt"

echo "[4/9] 서버 묶음"
mkdir -p "$WORK/server"
(cd "$WORK/src/server" && npx esbuild start.ts --bundle --platform=node --format=esm --target=node24 \
  --external:@anthropic-ai/claude-agent-sdk --external:node-pty \
  --banner:js="import { createRequire as __aetherCreateRequire } from 'node:module'; const require = __aetherCreateRequire(import.meta.url);" \
  --sourcemap --metafile="$WORK/meta.json" --outfile="$WORK/server/index.mjs" --log-level=warning)
# 소스맵은 묶음 밖에 따로 둔다(실행 중에는 쓰지 않는다). 오류 위치 추적용.
mkdir -p "$OUT/sourcemaps" && mv "$WORK/server/index.mjs.map" "$OUT/sourcemaps/Aether-$VERSION-index.mjs.map"
# 번들에 합쳐져 node_modules에서 사라지는 패키지의 라이선스 고지를 모은다.
(cd "$WORK/src/server" && node "$INST/bundle-tools.mjs" notices "$WORK/meta.json" "$WORK/server/THIRD_PARTY_NOTICES.txt")
cp "$WORK/src/server/db/schema.sql" "$WORK/src/server/package.json" "$WORK/src/server/package-lock.json" "$WORK/server/"
fetch_node() { # $1=파일명 $2=기대 해시
  local f="$CACHE/$1"
  [ -f "$f" ] || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$1" -o "$f"
  echo "$2  $f" | shasum -a 256 -c - >/dev/null || { echo "Node 해시 불일치: $1" >&2; rm -f "$f"; exit 1; }
}

build_target() { # $1=이름(win-x64) $2=npm os $3=npm cpu
  local name="$1" os="$2" cpu="$3"
  local dir="$OUT/Aether-$VERSION-$name"
  echo "[5/9] 대상 $name: 운영 의존성"
  rm -rf "$dir"; mkdir -p "$dir/server" "$dir/web" "$dir/node"
  cp -R "$WORK/server/." "$dir/server/"
  cp -R "$WORK/web-dist" "$dir/web/dist"
  (cd "$dir/server" && npm ci --omit=dev --os="$os" --cpu="$cpu" --ignore-scripts --silent)

  echo "[6/9] 대상 $name: 크기 줄이기"
  # 번들에 합친 패키지는 node_modules에 필요 없다. 밖에 둔 두 패키지와 그 의존성만 남긴다.
  node "$INST/bundle-tools.mjs" prune "$dir/server" @anthropic-ai/claude-agent-sdk node-pty
  # SDK는 pathToClaudeCodeExecutable이 없을 때만 플랫폼 패키지를 찾는다. 서버가 항상 경로를 넘긴다.
  rm -rf "$dir"/server/node_modules/@anthropic-ai/claude-agent-sdk-*
  find "$dir/server/node_modules/node-pty/prebuilds" -mindepth 1 -maxdepth 1 ! -name "$os-$cpu" -exec rm -rf {} +
  find "$dir/server/node_modules/node-pty/prebuilds" -name "*.pdb" -delete  # 디버그 심볼
  # node-pty의 빌드 전용 소스(deps, third_party)는 두 OS 모두 필요 없다.
  # 윈도우는 winpty.dll을 계속 배포하므로 deps 안에 있던 고지를 먼저 옮긴다.
  [ "$os" = win32 ] && cp "$dir/server/node_modules/node-pty/deps/winpty/LICENSE" "$dir/server/node_modules/node-pty/LICENSE.winpty"
  rm -rf "$dir/server/node_modules/node-pty/deps" "$dir/server/node_modules/node-pty/third_party"
  # SDK의 sdk.mjs가 참조하지 않는 파일(grep으로 확인함)은 지운다.
  rm -f "$dir/server/node_modules/@anthropic-ai/claude-agent-sdk/bridge.mjs" "$dir/server/node_modules/@anthropic-ai/claude-agent-sdk/browser-sdk.js"
  # --ignore-scripts로 설치하면 node-pty의 spawn-helper에 실행 권한이 안 붙어 PTY 실행(로그인 등)이 posix_spawnp 오류로 실패한다.
  if [ "$os" != win32 ]; then
    find "$dir/server/node_modules/node-pty/prebuilds" -name spawn-helper -exec chmod 755 {} +
  fi

  # 네이티브 파일이 없어도 서버는 뜨고 로그인 때에야 실패하므로 여기서 막는다.
  local pty="$dir/server/node_modules/node-pty/prebuilds/$os-$cpu"
  for f in "$pty/pty.node" "$dir/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs" "$dir/server/index.mjs"; do
    [ -s "$f" ] || { echo "필수 파일이 없습니다($name): $f" >&2; exit 1; }
  done
  if [ "$os" != win32 ] && [ ! -x "$pty/spawn-helper" ]; then
    echo "필수 파일이 없습니다($name): $pty/spawn-helper" >&2; exit 1
  fi
  if [ "$os" = win32 ]; then
    for f in conpty.node conpty_console_list.node conpty/conpty.dll conpty/OpenConsole.exe; do
      [ -s "$pty/$f" ] || { echo "윈도우 conpty 파일이 없습니다: $pty/$f" >&2; exit 1; }
    done
  fi

  echo "[7/9] 대상 $name: Node 실행 파일"
  if [ "$os" = win32 ]; then
    fetch_node "node-v$NODE_VERSION-win-x64.zip" "$NODE_SHA_WIN_X64"
    unzip -p "$CACHE/node-v$NODE_VERSION-win-x64.zip" "node-v$NODE_VERSION-win-x64/node.exe" > "$dir/node/AetherNode.exe"
  else
    fetch_node "node-v$NODE_VERSION-darwin-arm64.tar.gz" "$NODE_SHA_DARWIN_ARM64"
    mkdir -p "$dir/node/bin"
    tar -xzf "$CACHE/node-v$NODE_VERSION-darwin-arm64.tar.gz" -C "$dir/node/bin" --strip-components=2 "node-v$NODE_VERSION-darwin-arm64/bin/node"
    chmod 755 "$dir/node/bin/node"
  fi

  echo "[8/9] 대상 $name: 설치 프로그램 재료"
  if [ "$os" = win32 ]; then
    # 감시 프로그램은 묶음 안(bin)에 넣는다. 설치 exe와 시험용 zip이 같은 것을 쓴다.
    mkdir -p "$dir/bin"
    makensis -V2 -WX -DOUTFILE="$dir/bin/AetherHost.exe" "$INST/windows/host.nsi"
    cp "$INST/windows/reset-password.cmd" "$dir/bin/"
  else
    mkdir -p "$dir/bin"
    cp "$INST/mac/Uninstall Aether.command" "$dir/bin/" && chmod 755 "$dir/bin/Uninstall Aether.command"
    cp "$INST/mac/Reset Aether Password.command" "$dir/bin/" && chmod 755 "$dir/bin/Reset Aether Password.command"
    cp "$INST/mac/aether-update.sh" "$dir/bin/" && chmod 755 "$dir/bin/aether-update.sh"
  fi

  printf 'commit: %s\nworktree: %s\nversion: %s\ntarget: %s\nbuilt: %s\n' "$BUILD_COMMIT" "$BUILD_DIRTY" "$VERSION" "$name" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dir/server/BUILD_INFO.txt"
  if [ -n "$(find "$dir" -name '._*' -print -quit)" ]; then
    echo "묶음에 ._ 파일이 섞였습니다($name):" >&2; find "$dir" -name '._*' >&2; exit 1
  fi

  echo "[9/9] 대상 $name: 비밀 검사와 패키징"
  # 묶음에 비밀·운영 데이터가 섞이면 여기서 빌드를 멈춘다.
  node "$INST/check-bundle.mjs" "$dir" ${NOCMP:+"$NOCMP"} --env "$BUILD_ENV" || { echo "묶음 검사에 실패했습니다($name)." >&2; exit 1; }
  if [ "$os" = win32 ]; then
    makensis -V2 -WX -DVERSION="$VERSION" -DSRC="$dir" -DOUTFILE="$OUT/Aether-$VERSION-$name.exe" "$INST/windows/aether.nsi"
  else
    local scripts="$WORK/pkgscripts"
    rm -rf "$scripts"; mkdir -p "$scripts"
    cp -R "$INST/mac/scripts/." "$scripts/"
    cp "$INST/mac/com.aether.app.plist.template" "$scripts/"
    pkgbuild --root "$dir" --identifier com.aether.app --version "$VERSION" --install-location /Applications/Aether \
      --compression latest --min-os-version 13.5 \
      --scripts "$scripts" "$WORK/Aether-component.pkg" >/dev/null
    # pkgbuild는 관리자 인증(auth="root")을 요구하는 패키지를 만든다. 사용자 영역 설치이므로 none으로 바꿔 다시 묶는다.
    pkgutil --expand "$WORK/Aether-component.pkg" "$WORK/component-x"
    sed 's/ auth="root"/ auth="none"/' "$WORK/component-x/PackageInfo" > "$WORK/PackageInfo.new"
    mv "$WORK/PackageInfo.new" "$WORK/component-x/PackageInfo"
    rm -f "$WORK/Aether-component.pkg"
    pkgutil --flatten "$WORK/component-x" "$WORK/Aether-component.pkg"
    sed "s/__VERSION__/$VERSION/g" "$INST/mac/distribution.xml" > "$WORK/distribution.xml"
    grep -q "version=\"$VERSION\"" "$WORK/distribution.xml" && ! grep -q "__VERSION__" "$WORK/distribution.xml" || { echo "distribution.xml의 버전 치환에 실패했습니다." >&2; exit 1; }
    productbuild --distribution "$WORK/distribution.xml" --package-path "$WORK" "$OUT/Aether-$VERSION-$name.pkg" >/dev/null
  fi
}

build_target win-x64 win32 x64
build_target mac-arm64 darwin arm64

cp "$REPO/deploy/installer/smoke.mjs" "$OUT/smoke.mjs"
rm -f "$OUT/Aether-$VERSION-win-x64.zip"
(cd "$OUT/Aether-$VERSION-win-x64" && zip -qr "$OUT/Aether-$VERSION-win-x64.zip" .)
echo "완료: $OUT"
du -sh "$OUT"/Aether-"$VERSION"-* | sed 's/^/  /'
