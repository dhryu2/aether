/**
 * 디자인 토큰 경계 검사 — 정적 검사, 앱을 띄우지 않는다.
 *   실행: npx tsx web/test/tokens.test.ts
 *
 * 지키는 것은 하나다: **시각 값은 src/design/tokens.ts에만 적는다.**
 *
 * 왜 검사가 필요한가 — 이 저장소는 실제로 그 반대 상태였다. index.css에 토큰이 30개 있었는데
 * 24개는 아무도 참조하지 않았고, 화면 코드에는 색 리터럴이 795번 흩어져 서로 어긋나 있었다.
 * 같은 "경고 노랑"이 11가지, 같은 "옅은 하늘색"이 10가지였다. 한 번 정리해도 검사가 없으면
 * 다음 기능을 추가할 때 조용히 같은 자리로 돌아간다.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(WEB_DIR, 'src')

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++; else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail, null, 1)}`}`)
}

/** 주석 속 hex(예: "합침: #c4cad2")가 위반으로 잡히지 않게 지운 뒤 검사한다. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walk(abs, out)
    else if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(path.relative(SRC_DIR, abs))
  }
  return out
}

const tokensSrc = fs.readFileSync(path.join(SRC_DIR, 'design', 'tokens.ts'), 'utf8')
const cssSrc = fs.readFileSync(path.join(SRC_DIR, 'index.css'), 'utf8')

/* ── ① index.css의 @theme와 tokens.ts가 어긋나지 않는가 ──
   CSS는 TS를 import할 수 없어서 겹치는 소수의 값은 양쪽에 적을 수밖에 없다. 그 소수를 감시한다. */
const themeBlock = cssSrc.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
check('index.css에 @theme 블록이 있다', themeBlock.length > 0)

/** @theme 변수 이름 → tokens.ts의 새 이름(P) 키. 재설계 A부터 양쪽 모두 var(--c-…)를 가리킨다. */
const MIRRORED: Record<string, string> = {
  '--color-ink': 'label',
  '--color-text2': 'label2',
  '--color-line': 'sep',
  '--color-cyan-ink': 'tint',
}
const paletteBlock = tokensSrc.match(/const P = \{([\s\S]*?)\n\} as const/)?.[1] ?? ''
for (const [cssVar, tsKey] of Object.entries(MIRRORED)) {
  const cssVal = themeBlock.match(new RegExp(`${cssVar}\\s*:\\s*(var\\(--c-[\\w-]+\\))`))?.[1]
  const tsVal = paletteBlock.match(new RegExp(`\\b${tsKey}\\s*:\\s*'(var\\(--c-[\\w-]+\\))'`))?.[1]
  check(`${cssVar} == C.${tsKey}`, !!cssVal && cssVal === tsVal, { css: cssVal, ts: tsVal })
}

// 죽은 토큰이 다시 쌓이지 않게 — @theme에 넣었으면 CSS 어딘가가 실제로 읽어야 한다.
const themeVars = [...themeBlock.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])
const unusedTheme = themeVars.filter((v) => {
  if (v === '--font-sans' || v === '--font-mono') return false // Tailwind가 font-sans/font-mono 유틸리티를 만든다
  return !new RegExp(`var\\(${v}\\b`).test(cssSrc)
})
check('@theme에 아무도 안 읽는 변수가 없다', unusedTheme.length === 0, unusedTheme)

/* ── ② 색 두 벌(밝게·어둡게)이 짝을 이루는가, 새 이름이 겹치지 않는가 ──
   재설계 A(2026-09-27)부터 색 값은 index.css의 --c-* 변수에만 있다. tokens.ts는 그 변수를 가리킨다.
   어두운 블록에 한 변수를 빠뜨리면 어두운 화면에서만 그 자리가 밝은 색으로 남는다 — 눈으로는 늦게 발견된다. */
const lightBlock = cssSrc.match(/\n:root \{([\s\S]*?)\n\}/)?.[1] ?? ''
const darkBlock = cssSrc.match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n {2}\}/)?.[1] ?? ''
const varsOf = (block: string) => new Set([...block.matchAll(/(--c-[\w-]+)\s*:/g)].map((m) => m[1]))
const lightVars = varsOf(lightBlock)
const darkVars = varsOf(darkBlock)
check(`밝은 블록에 색 변수가 있다 (${lightVars.size}개)`, lightVars.size > 20)
check(
  '밝은 블록과 어두운 블록의 변수가 같다',
  [...lightVars].every((v) => darkVars.has(v)) && [...darkVars].every((v) => lightVars.has(v)),
  { 어둡게_없음: [...lightVars].filter((v) => !darkVars.has(v)), 밝게_없음: [...darkVars].filter((v) => !lightVars.has(v)) },
)

const entries = [...paletteBlock.matchAll(/^\s{2}(\w+)\s*:\s*'var\((--c-[\w-]+)\)'/gm)].map(([, k, v]) => [k, v] as const)
check(`새 이름(P)이 있다 (${entries.length}개)`, entries.length > 20)
const undefinedVars = entries.filter(([, v]) => !lightVars.has(v)).map(([k, v]) => `${k} → ${v}`)
check('새 이름이 가리키는 변수가 CSS에 전부 있다', undefinedVars.length === 0, undefinedVars)
const byVar = new Map<string, string[]>()
for (const [k, v] of entries) byVar.set(v, [...(byVar.get(v) ?? []), k])
const dupes = [...byVar.entries()].filter(([, ks]) => ks.length > 1)
check('같은 변수에 새 이름이 둘 이상 붙지 않았다', dupes.length === 0, Object.fromEntries(dupes))

const oldColorNames = ['ink', 'text2', 'muted', 'faint', 'codeInk', 'inkSoft', 'hint', 'white', 'surface1', 'surface2', 'surface3', 'codeDarkBg', 'codeDarkLine', 'line', 'lineSoft', 'lineDash', 'cyan', 'cyanInk', 'cyanBright', 'cyanSoft', 'cyanBorder', 'cyanBorderSoft', 'onCyan', 'violet', 'violetInk', 'violetBright', 'violetSoft', 'violetBox', 'violetBorder', 'violetBorderSoft', 'plan', 'planInk', 'planSoft', 'planBox', 'planBorder', 'green', 'greenSoft', 'greenBorder', 'red', 'redInk', 'redSoft', 'redBorder', 'redFaint', 'amber', 'amberInk', 'amberInkDeep', 'amberSoft', 'amberTint', 'amberBorder', 'amberBorderStrong', 'statusGreen', 'statusGray']
const oldInP = oldColorNames.filter((k) => entries.some(([name]) => name === k))
check(
  'C에는 새 이름만 있다(LEGACY 블록 없음)',
  !/const LEGACY\b/.test(tokensSrc) && /export const C = P\b/.test(tokensSrc) && oldInP.length === 0,
  oldInP,
)
const alphaBlock = tokensSrc.match(/export const alpha = \{([\s\S]*?)\n\} as const/)?.[1] ?? ''
const alphaKeys = [...alphaBlock.matchAll(/^\s{2}(\w+)\s*:/gm)].map((m) => m[1])
const oldAlpha = ['cyan', 'violet', 'plan', 'green', 'red', 'amber', 'white', 'text2', 'surface3', 'statusGreen', 'cyanInk'].filter((k) => alphaKeys.includes(k))
check(
  'alpha에 옛 이름(cyan, violet, plan, green, red, amber, white, text2, surface3, statusGreen, cyanInk)이 없다',
  alphaBlock.length > 0 && oldAlpha.length === 0,
  oldAlpha,
)

/* ── ③ 화면 코드에 색 리터럴이 남지 않았는가 ── */
const HEX_OR_RGBA = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(/

/**
 * 검사에서 빼는 파일 — 뺄 때는 반드시 이유를 적는다.
 * 이유 없이 목록이 길어지면 검사가 무의미해지므로, 새 항목을 넣기 전에 정말 토큰으로 표현할 수 없는지 먼저 따진다.
 */
const ALLOW: Record<string, string> = {
  'design/tokens.ts': '토큰의 정의 자리. 여기 말고는 색 리터럴이 있으면 안 된다.',
}

const offenders = walk(SRC_DIR)
  .filter((rel) => !(rel in ALLOW))
  .map((rel) => {
    const lines = stripComments(fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')).split('\n')
    const hits = lines
      .map((l, i) => (HEX_OR_RGBA.test(l) ? `${rel}:${i + 1}` : ''))
      .filter(Boolean)
    return hits
  })
  .flat()

check(`화면 코드에 색 리터럴 0건 (검사 ${walk(SRC_DIR).length}개 파일)`, offenders.length === 0, offenders.slice(0, 40))

// var() 색 뒤에 hex 두 자리를 붙여 투명도를 만드는 옛 버릇 — var(--c-tint)33은 무효한 색이라 조용히 사라진다.
const CONCAT_ALPHA = /\$\{C\.\w+\}[0-9a-fA-F]{2}\b/
const concat = walk(SRC_DIR)
  .map((rel) => stripComments(fs.readFileSync(path.join(SRC_DIR, rel), 'utf8')).split('\n').map((l, i) => (CONCAT_ALPHA.test(l) ? `${rel}:${i + 1}` : '')).filter(Boolean))
  .flat()
check('색 뒤에 글자를 이어 붙여 투명도를 만드는 곳 0건(alpha를 쓴다)', concat.length === 0, concat)

// 검사기가 헛돌지 않는지 스스로 반증 — 실제로 이런 코드를 잡아내는가.
check(
  '검사기가 색 리터럴을 실제로 잡는다(자기 반증)',
  HEX_OR_RGBA.test("style={{ color: '#8b95a3' }}") && HEX_OR_RGBA.test('background: rgba(20,23,28,.4)') && !HEX_OR_RGBA.test("color: C.muted") &&
    CONCAT_ALPHA.test('background: `${C.tint}33`') && !CONCAT_ALPHA.test('background: alpha.tint(0.2)'),
)

console.log(`\n${fail === 0 ? '✅' : '❌'} tokens: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
