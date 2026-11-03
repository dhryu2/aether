#!/bin/bash
# Aether 비밀번호 재설정. 프로그램 폴더는 이 파일이 있는 bin의 부모다.
APP="$(cd "$(dirname "$0")/.." && pwd)"
"$APP/node/bin/node" "$APP/server/index.mjs" --reset-password
