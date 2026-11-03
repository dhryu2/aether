#!/usr/bin/env bash
# Codex app-server 프로토콜 타입 생성 (Phase 8a — D11)
#
# `codex app-server generate-ts`로 server/codex/protocol/ 에 타입을 생성한다.
# 산출물은 vendored 취급: 수동 편집 금지, 전부 커밋, CLI 버전 변경 시 재생성+diff 검토(R1 게이트).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/codex/protocol"
VERSION="$(codex --version)"

rm -rf "$OUT"
mkdir -p "$OUT"
codex app-server generate-ts --out "$OUT"

# 버전 핀 기록 (재생성 게이트의 기준)
cat > "$OUT/VERSION.md" <<EOF
# Codex 프로토콜 타입 — vendored (수동 편집 금지)

- 생성 CLI: \`$VERSION\`
- 생성 명령: \`server/scripts/gen-codex-types.sh\`
- 생성일: $(date +%Y-%m-%d)
- 규칙: CLI 버전 변경 시 이 스크립트로 재생성하고 diff를 검토한다(계획 문서 R1/D11).
EOF

COUNT="$(find "$OUT" -name '*.ts' | wc -l | tr -d ' ')"
echo "생성 완료: $OUT (.ts $COUNT개, $VERSION)"
