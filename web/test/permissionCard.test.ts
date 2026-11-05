/**
 * 권한 카드와 입력창 위 승인 줄 — 서버 렌더로 실제 글자를 뽑아 본다.
 *   실행: npx tsx web/test/permissionCard.test.ts
 * 카드는 도구 인자를 모두 보여 줘야 한다(승인하는 사람이 실제로 실행될 값을 알아야 한다).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  cond ? pass++ : fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

;(globalThis as { React?: unknown }).React = React

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vite = await createServer({
  configFile: false,
  root: ROOT,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null },
})
const { PermissionCard } = await vite.ssrLoadModule('/src/components/PermissionCard.tsx')
const { reviewPermCard } = await vite.ssrLoadModule('/src/lib/permButtonsVisibility.ts')
const { PermissionQuickBar } = await vite.ssrLoadModule('/src/components/composer/PermissionQuickBar.tsx')

const card = (req: object) => renderToStaticMarkup(createElement(PermissionCard, { req }))
const text = (html: string) => html.replace(/<[^>]+>/g, '\n').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'")
const base = { id: 'p1', toolName: 'tool', displayName: '', toolUseID: 'u1' }

// 변경 미리보기가 없는 요청: 모든 키와 값이 글자에 있다.
const cases: [string, Record<string, unknown>][] = [
  ['mcp__chat__send_message', { channel: 'example-room', text: 'hello example' }],
  ['mcp__db__query', { sql: 'DELETE FROM example_table' }],
  ['mcp__fs__run', { path: '/tmp/example-outside/a.sh', command: 'rm -rf example-dir' }],
  ['Bash', { command: 'ls', description: 'list example', dangerouslyDisableSandbox: true }],
  ['commandExecution', { command: '', cwd: '/tmp/example-cwd', host: 'example.test', protocol: 'https' }],
  ['Write', { file_path: '/tmp/example-outside/out.txt', content: 'example body' }],
  ['grok_tool', { command: 'echo hi', extra_flag: 7 }],
]
for (const [tool, input] of cases) {
  const out = text(card({ ...base, toolName: tool, input }))
  const missing = Object.entries(input).flatMap(([k, v]) => [k, typeof v === 'string' ? v : String(v)]).filter((s) => s !== '' && !out.includes(s))
  check(`${tool}: 모든 인자가 카드에 보인다`, missing.length === 0, missing)
}
{
  const out = text(card({ ...base, toolName: 'x', input: { options: { a: [1, 2], b: null } } }))
  check('객체 값은 들여쓴 JSON으로 그린다', out.includes('"a": [') && out.includes('"b": null'), out)
}

// 변경 카드: 경고와 접힌 전체 인자.
const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
{
  const html = card({ ...base, toolName: 'Edit', input: { file_path: 'a.txt', old_string: 'a', new_string: 'b', replace_all: true }, mutation: { kind: 'edit', path: 'a.txt', hunks, replaceAll: true, additions: 1, deletions: 1 } })
  check('replaceAll 경고가 보인다', text(html).includes('Replaces every match') || text(html).includes('일치하는 곳을 모두 바꿔요'))
  const d = html.slice(html.indexOf('<details'), html.indexOf('</details>'))
  check('전체 인자는 details 안에 있고 닫힌 채 시작한다', d.includes('old_string') && d.includes('replace_all') && !/<details[^>]*open/.test(d))
}
// 비밀 경로: 어댑터 표시본에 내용이 남아 있어도 화면에 안 나온다.
{
  const out = text(card({ ...base, toolName: 'Write', input: { file_path: '.env', content: 'DUMMY-SECRET' }, mutation: { kind: 'write', path: '.env', redacted: true } }))
  check('비밀 경로의 인자는 그리지 않는다', !out.includes('DUMMY-SECRET'), out)
}
// 긴 경로는 잘리지 않는다.
{
  const long = '/tmp/example-outside/' + 'very-long-folder/'.repeat(8) + 'file.txt'
  const html = card({ ...base, toolName: 'Edit', input: { file_path: long }, mutation: { kind: 'edit', path: long, hunks } })
  check('긴 경로 전체가 나온다', text(html).includes(long))
  const i = html.indexOf(long)
  const tag = html.slice(html.lastIndexOf('<div', i), i)
  check('경로 줄은 말줄임(truncate) 없이 줄바꿈한다', !tag.includes('truncate'), tag)
}

// 승인 줄: 승인 버튼이 없고 카드 보기와 거부가 있다.
{
  const html = renderToStaticMarkup(createElement(PermissionQuickBar, { perm: { ...base, toolName: 'Bash', input: { command: 'ls' } }, isNarrow: true }))
  const out = text(html)
  check('승인 줄에 승인 버튼이 없다', !/>\s*(승인|Allow)\s*</.test(html.replace(/<[^>]+>/g, (m) => m + '')) && !out.split('\n').some((s) => s.trim() === '승인' || s.trim() === 'Allow'), out)
  check('승인 줄에 카드 보기와 거부가 있다', (out.includes('카드 보기') || out.includes('View card')) && (out.includes('거부') || out.includes('Deny')))
}

// 카드가 DOM에 없으면(오래 쌓여 잘린 경우) 창을 넓히는 이동으로 넘어간다.
{
  const jumps: unknown[][] = []
  reviewPermCard('gone', 7, 's1', (...a: unknown[]) => jumps.push(a))
  check('카드가 화면에 없으면 그 카드 seq로 이동을 요청한다', jumps.length === 1 && jumps[0][0] === 7 && jumps[0][1] === 's1', jumps)
  const fs = await import('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'src/components/stream/useStreamScroll.ts'), 'utf8')
  check('이동 대상 선택자에 .action-card가 있다', src.includes('[data-seq="${tseq}"] .action-card'))
  const narrow = renderToStaticMarkup(createElement(PermissionQuickBar, { perm: { ...base, toolName: 'Bash', input: { command: 'ls' } }, isNarrow: true }))
  check('좁은 화면의 승인 줄 버튼은 높이 44', narrow.includes('height:44px') && !narrow.includes('height:40px'), narrow.match(/height:\d+px/g))
  const long = text(card({ ...base, toolName: 'mcp__' + 'long_server_name__'.repeat(6) + 'tool', input: { a: 1 } }))
  const html = card({ ...base, toolName: 'mcp__' + 'x'.repeat(80), input: { a: 1 } })
  const i = html.indexOf('mcp__x')
  check('미리보기 없는 카드의 도구 이름 줄도 말줄임이 없다', !html.slice(html.lastIndexOf('<div', i), i).includes('truncate') && long.length > 0)
}

// 검토함도 쓰는 diff 표시: 수정 조각이면 줄 번호를 비우고, 수정 전 내용을 모르면 안내를 붙인다.
{
  const { UnifiedDiff } = await vite.ssrLoadModule('/src/components/UnifiedDiff.tsx')
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-aaa', '+bbb'] }
  const render = (m: object) => text(renderToStaticMarkup(createElement(UnifiedDiff, { m: { kind: 'edit', path: 'a.ts', hunks: [hunk], ...m } })))
  const plainRows = render({}).split('\n').map((x) => x.trim()).filter(Boolean)
  check('일반 diff는 줄 번호가 보인다', plainRows.includes('1'), plainRows)
  const fragRows = render({ fragment: true }).split('\n').map((x) => x.trim()).filter(Boolean)
  check('조각 diff는 줄 번호가 없다', !fragRows.includes('1') && fragRows.some((x) => x.includes('bbb')), fragRows)
  check('수정 전 모름 안내', render({ beforeUnknown: true }).includes('수정 전 내용이 기록에 없어'))
  check('일반 diff에는 그 안내가 없다', !render({}).includes('수정 전 내용이 기록에 없어'))
}

await vite.close()
console.log(`\n${fail === 0 ? '✅' : '❌'} permissionCard: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
