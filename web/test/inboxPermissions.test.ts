/**
 * 알림 목록의 승인 요청 줄 — 서버 렌더로 단추·고르기 상자 유무를 본다.
 *   실행: npx tsx web/test/inboxPermissions.test.ts
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
const { InboxPermissions } = await vite.ssrLoadModule('/src/components/InboxPermissions.tsx')

const base = { toolName: 'tool', displayName: '', toolUseID: 'u' }
const plain = { ...base, id: 'p1', toolKind: 'bash', input: { command: 'ls -la' } }
const mut = { ...base, id: 'p2', toolKind: 'file_change', input: { file_path: '/x/a.txt' }, mutation: { kind: 'write', path: '/x/a.txt', additions: 3, deletions: 1 } }
const render = (requests: object[], showCheck: boolean) =>
  renderToStaticMarkup(createElement(InboxPermissions, { requests, selected: new Set(), onToggle() {}, showCheck, onResolve() {}, onOpen() {}, narrow: false }))

const a = render([plain], true)
check('바로 승인 요청: 승인·거부 단추와 인자 전문', a.includes('data-inbox-permission="p1"') && a.includes('ls -la') && (a.match(/<button/g) ?? []).length === 2, a)
check('showCheck 참이면 고르기 상자', a.includes('type="checkbox"'))
check('showCheck 거짓이면 고르기 상자 없음', !render([plain], false).includes('type="checkbox"'))
const b = render([mut], true)
check('mutation 요청: 단추는 "세션에서 보기" 하나, 고르기 상자 없음', (b.match(/<button/g) ?? []).length === 1 && b.includes('세션에서 보기') && !b.includes('checkbox'), b)
check('mutation 요청: 경로와 줄 수', b.includes('/x/a.txt') && b.includes('+3') && b.includes('-1'))
const noPreview = render([{ ...base, id: 'p3', toolKind: 'file_change', input: { path: '/x/b.txt' } }], true)
check('file_change 요청(미리보기 없음): 승인·거부 단추 없고 "세션에서 보기"와 안내만', (noPreview.match(/<button/g) ?? []).length === 1 && noPreview.includes('세션에서 보기') && noPreview.includes('전체 내용은 세션에서') && !noPreview.includes('checkbox'), noPreview)
check('decisionReason이 있으면 바로 승인 줄에도 보인다', render([{ ...plain, decisionReason: '이유 문구' }], true).includes('이유 문구'))

await vite.close()
console.log(`\n${fail === 0 ? '✅' : '❌'} inboxPermissions: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
