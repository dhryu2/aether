/**
 * 작업 대기열 화면 — 작업 상태 글자 계산과 QueueBody 서버 렌더.
 *   실행: npx tsx web/test/taskQueue.test.ts
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
const { queueItemStatus, queueFull } = await vite.ssrLoadModule('/src/lib/taskQueue.ts')
const { QueueBody } = await vite.ssrLoadModule('/src/components/brain/QueueView.tsx')

// 상태 글자: 서버 state + 그 세션의 실시간 상태
check('waiting은 그대로', queueItemStatus('waiting') === 'waiting')
check('done·failed·cut은 실시간 상태와 무관', queueItemStatus('done', { attention: 'waiting' }) === 'done' && queueItemStatus('failed') === 'failed' && queueItemStatus('cut') === 'cut')
check('running + running', queueItemStatus('running', { attention: 'running' }) === 'running')
check('running + background', queueItemStatus('running', { attention: 'background' }) === 'running')
check('running + 실시간 정보 없음', queueItemStatus('running') === 'running')
check('running + 승인 대기', queueItemStatus('running', { attention: 'waiting', attentionKind: 'permission' }) === 'approval')
check('running + 한도 막힘', queueItemStatus('running', { attention: 'waiting', attentionKind: 'rate_limit' }) === 'limit')
check('running + 자동 재개 예약', queueItemStatus('running', { attention: 'idle', autoResume: { action: { type: 'handoff' }, attempts: 0, at: 1 } }) === 'limit')
check('자동 재개가 at 없이 포기 상태면 한도 대기가 아니다', queueItemStatus('running', { attention: 'idle', autoResume: { action: { type: 'handoff' }, attempts: 3, gaveUp: true } }) === 'running')

const mk = (n: number, state: string) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, sessionId: `s${i}`, text: `글 ${i}`, state, addedAt: 1 }))
check('가득 참: 기다림·도는 것만 센다', queueFull({ items: mk(10, 'waiting'), maxItems: 10 }) && !queueFull({ items: mk(10, 'done'), maxItems: 10 }) && !queueFull({ items: mk(9, 'waiting'), maxItems: 10 }))

// QueueBody 렌더
const text = (html: string) => html.replace(/<[^>]+>/g, '\n')
const base = { run: 'stopped', limitHours: 4, limitChoices: [1, 2, 4, 8, 12], items: [], maxItems: 10 }
const noop = () => {}
const render = (q: object | null, extra: object = {}, sessions: object[] = []) =>
  renderToStaticMarkup(createElement(QueueBody, { q, failed: false, narrow: false, sessions, onRetry: noop, onStart: noop, onStop: noop, onRemove: noop, onOpen: noop, ...extra }))

{
  const out = text(render(base))
  check('빈 상태 문구', out.includes('아직 맡긴 작업이 없어요') || out.includes('No queued tasks yet'))
  check('기다리는 작업이 없으면 시작 양식이 없다', !out.includes('승인이 필요하면') && !out.includes('stops where approval'))
}
{
  const out = text(render(null, { failed: true }))
  check('읽기 실패면 다시 시도 버튼', out.includes('다시 시도') || out.includes('Try again'))
}
{
  const q = { ...base, items: mk(1, 'waiting') }
  const out = text(render(q, {}, [{ id: 's0', displayName: '예시 작업', permissionMode: 'manual' }]))
  check('시작 양식에 안내 문장이 늘 보인다', out.includes('승인이 필요하면 그 자리에서 멈춰요') || out.includes('stops where approval is needed'))
  check('시작 버튼과 시간 상한이 있다', (out.includes('시작') || out.includes('Start')) && (out.includes('4시간') || out.includes('4 h')))
  check('세션 제목과 권한 모드 이름이 있다', out.includes('예시 작업') && (out.includes('수동') || out.includes('Manual')))
  check('기다리는 작업에는 빼기가 있다', out.includes('빼기') || out.includes('Remove'))
}
{
  const q = { ...base, run: 'running', deadlineAt: Date.now() + 3_600_000, items: [...mk(1, 'running').map((x) => ({ ...x, id: 'r' })), ...mk(1, 'waiting').map((x) => ({ ...x, id: 'w', sessionId: 'sx' }))] }
  const out = text(render(q, {}, [{ id: 's0', displayName: '돌고 있는 세션', permissionMode: 'auto', attention: 'waiting', attentionKind: 'permission' }]))
  check('도는 중이면 멈추기와 옆 글', (out.includes('멈추기') || out.includes('Stop')) && (out.includes('도는 작업은 끝까지 돌아요') || out.includes('keeps going')))
  check('도는 중이면 시작 양식이 없다', !out.includes('승인이 필요하면'))
  check('승인 대기 글자', out.includes('승인을 기다려요') || out.includes('Waiting for approval'))
  check('지워진 세션 표시', out.includes('지워진 세션') || out.includes('Deleted session'))
  const html = render(q, {}, [{ id: 's0', displayName: '돌고 있는 세션', permissionMode: 'auto' }])
  check('빼기는 돌지 않는 작업에만(2개 중 1개)', (text(html).match(/빼기|Remove/g) ?? []).length === 1)
  check('지워진 세션에는 열기가 없다(2개 중 1개)', (text(html).match(/열기|Open/g) ?? []).length === 1)
}
{
  const q = { ...base, items: mk(10, 'waiting') }
  check('가득 차면 안내 한 줄', /10개까지|up to 10/.test(text(render(q))))
  check('멈춘 이유가 보인다(사람이 멈춘 경우 제외)', /모두 마쳤어요|All done/.test(text(render({ ...base, stopReason: 'all_done' }))) && !/모두 마쳤어요|All done/.test(text(render({ ...base, stopReason: 'manual' }))))
}

await vite.close()
console.log(`\n${fail === 0 ? '✅' : '❌'} taskQueue: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
