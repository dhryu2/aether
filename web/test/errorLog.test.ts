/**
 * 오류 기록 화면 순수 함수 시험.
 *   실행: npx tsx web/test/errorLog.test.ts
 */
import assert from 'node:assert/strict'
import type { ErrorGroupDetailResponse, ErrorGroupSummary } from '../../shared/errors'
import { NEXT_PERIOD, componentLabel, errorCopyText } from '../src/lib/errorLog'

const t = (key: string) => `T(${key})`
assert.equal(componentLabel('session', t), 'T(settings.errorLog.component.session)')
assert.equal(componentLabel('zzz', t), 'zzz', '모르는 이름은 원문')

const summary: ErrorGroupSummary = { fingerprint: 'f'.repeat(64), message: '요약', component: 'session', operation: 'op.run', source: 'server', count: 3, lastAt: '2026-10-30T01:00:00.000Z' }
const detail: ErrorGroupDetailResponse = {
  fingerprint: summary.fingerprint, count: 3, firstAt: '2026-10-29T01:00:00.000Z', lastAt: summary.lastAt, sessionIds: [],
  latest: {
    id: 'i', occurred_at: summary.lastAt, severity: 'error', source: 'server', component: 'session', operation: 'op.run', code: 'E_X',
    message: '전체 메시지 본문', stack: 'Error: x\n    at foo (bar.ts:1:1)', request_id: 'req-1', session_id: null, release: 'r1', provider: null, model: null,
    context: { key: 'value' },
  },
}
const text = errorCopyText(summary, detail)
for (const part of ['전체 메시지 본문', 'at foo (bar.ts:1:1)', '"key": "value"', 'session / op.run', 'Count: 3', '2026-10-29T01:00:00.000Z', '2026-10-30T01:00:00.000Z', 'E_X', 'req-1']) {
  assert.ok(text.includes(part), part)
}
const noStack = errorCopyText(summary, { ...detail, latest: { ...detail.latest, stack: null } })
assert.ok(!noStack.includes('Stack:'), '스택이 없으면 스택 칸도 없다')

assert.equal(NEXT_PERIOD['24h'], '7d')
assert.equal(NEXT_PERIOD['7d'], 'all')
assert.equal(NEXT_PERIOD.all, null)
console.log('✅ errorLog: 위치 이름·복사 글·기간 넓히기')
