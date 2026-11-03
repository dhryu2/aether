/** 앱 안 업데이트 진행 화면의 판정 시험: 단계, 완료·되돌림, 지연, 연결 끊김, i18n 짝. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UpdateInstallState, UpdateStatusResponse } from '@shared/http'
import { decideUpdateStep, UPDATE_SLOW_MS, type UpdateFlowInput, type UpdateProbe } from '../src/lib/updateFlow'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}
const HERE = path.dirname(fileURLToPath(import.meta.url))

const st = (install: UpdateInstallState, over: Partial<UpdateStatusResponse> = {}): UpdateProbe => ({
  kind: 'status',
  status: { enabled: true, current: '0.0.1', latest: '0.0.2', available: true, canInstall: true, install, ...over },
})
const run = (probe: UpdateProbe, over: Partial<UpdateFlowInput> = {}) =>
  decideUpdateStep({ probe, wasDown: false, elapsedMs: 0, fromVersion: '0.0.1', targetVersion: '0.0.2', ...over }).step
const full = (probe: UpdateProbe, over: Partial<UpdateFlowInput> = {}) =>
  decideUpdateStep({ probe, wasDown: false, elapsedMs: 0, fromVersion: '0.0.1', targetVersion: '0.0.2', ...over })

check(run(st({ phase: 'checking' })) === 'checking', 'checking 단계')
const d = full(st({ phase: 'downloading', version: '0.0.2', received: 5, total: 10 }))
check(d.step === 'downloading' && d.received === 5 && d.total === 10, 'downloading 단계는 진행량을 싣는다', d)
check(run(st({ phase: 'installing', version: '0.0.2' })) === 'installing', 'installing 단계')
check(run({ kind: 'down' }, { wasDown: true }) === 'installing', '연결이 끊기면 설치 중으로 본다')
check(run({ kind: 'down' }, { wasDown: true, elapsedMs: UPDATE_SLOW_MS + 1 }) === 'slow', '210초를 넘기면 지연')
check(run({ kind: 'down' }, { wasDown: true, elapsedMs: UPDATE_SLOW_MS }) === 'installing', '210초 정각까지는 지연 아님')
check(run(st({ phase: 'installing', version: '0.0.2' }), { elapsedMs: UPDATE_SLOW_MS + 1 }) === 'slow', 'installing도 지연이 된다')
check(run(st({ phase: 'downloading', version: '0.0.2', received: 1, total: 2 }), { elapsedMs: UPDATE_SLOW_MS + 1 }) === 'downloading', '다운로드 중에는 지연으로 바꾸지 않는다')
check(run(st({ phase: 'idle' }, { current: '0.0.2' }), { wasDown: true }) === 'reload', '서버 버전이 목표와 같으면 새로 고침')
check(run({ kind: 'health', version: '0.0.2', unauthorized: true }, { wasDown: true }) === 'reload', '조회가 401이어도 health 버전으로 완료 판정')
check(run({ kind: 'health', version: '0.0.1', unauthorized: true }) === 'installing', 'health가 옛 버전이고 끊긴 적 없으면 계속 기다림')
check(full({ kind: 'health', version: '0.0.1', unauthorized: true }, { wasDown: true }).step === 'rolledBack', '조회가 401일 때 끊겼다가 health가 옛 버전이면 되돌림')
check(run({ kind: 'health', version: '0.0.1', unauthorized: false }, { wasDown: true }) === 'installing', '단순 조회 실패에서는 health가 옛 버전이어도 기다린다')
check(run({ kind: 'health', version: '0.0.3', unauthorized: false }, { wasDown: true, targetVersion: undefined }) === 'reload', '목표를 몰라도 끊겼다 다른 버전으로 돌아오면 새로 고침')
check(run({ kind: 'health', version: '0.0.3', unauthorized: false }, { wasDown: false, targetVersion: undefined }) === 'installing', '목표를 모르고 끊긴 적도 없으면 새로 고치지 않는다')
check(run(st({ phase: 'idle' }, { current: '0.0.1' }), { wasDown: true, targetVersion: undefined }) === 'rolledBack', '목표를 몰라도 같은 버전이면 새로 고치지 않는다')
check(run(st({ phase: 'idle' }, { current: '0.0.3' }), { wasDown: false, targetVersion: undefined }) === 'checking', '목표를 모르고 끊긴 적 없으면 버전이 달라도 새로 고치지 않는다')
const f = full(st({ phase: 'failed', reason: 'disk' }))
check(f.step === 'failed' && f.reason === 'disk', 'failed는 이유를 싣는다', f)
const rb = full(st({ phase: 'idle' }, { rolledBackVersion: '0.0.2' }), { wasDown: true })
check(rb.step === 'rolledBack' && rb.kind === 'rolledBack', 'rolledBackVersion이 목표와 같으면 되돌림')
const un = full(st({ phase: 'idle' }), { wasDown: true })
check(un.step === 'rolledBack' && un.kind === 'unfinished', '끊겼다 옛 버전으로 돌아왔고 기록이 없으면 마치지 못한 되돌림')
check(run(st({ phase: 'idle' })) === 'checking', '끊긴 적 없는 idle은 시작 직전으로 보고 기다림')
check(run(st({ phase: 'idle' }, { rolledBackVersion: '0.0.0' })) === 'checking', '목표가 아닌 옛 되돌림 기록은 무시')
check(run(st({ phase: 'idle' }, { current: '0.0.1' }), { targetVersion: undefined }) === 'checking', '목표를 모르면 완료로 보지 않는다')

const dict = fs.readFileSync(path.join(HERE, '../src/lib/i18n/settings.ts'), 'utf8')
for (const k of ['update.row.install', 'update.row.checkNow', 'update.row.unknown', 'update.row.rolledBack', 'update.confirm.title', 'update.confirm.body', 'update.confirm.running', 'update.confirm.action',
  'update.progress.title', 'update.progress.preparing', 'update.progress.downloading', 'update.progress.installing', 'update.progress.size', 'update.progress.cancel',
  'update.slow.title', 'update.slow.body', 'update.slow.check', 'update.fail.title', 'update.fail.network', 'update.fail.verify', 'update.fail.disk', 'update.fail.backup', 'update.fail.handoff',
  'update.fail.rolledBack', 'update.fail.unfinished', 'update.fail.retry', 'update.fail.manual', 'update.manual', 'update.done', 'update.toast.messageInstall']) {
  check(new RegExp(`'${k}': \\{ ko: .*en: |'${k}': \\{\\n\\s+ko: [\\s\\S]*?en: `).test(dict), `i18n 한국어·영어 짝: ${k}`)
}
check(!/내려받/.test(dict.split('\n').filter((l) => l.includes("'update.")).join('\n')), 'update.* 문구에 「내려받기」를 쓰지 않는다')

console.log(`\n${fail === 0 ? '✅' : '❌'} updateFlow: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
