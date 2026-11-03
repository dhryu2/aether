/** 새 버전 알림의 순수 로직 시험: 링크 검사, 버전별 한 번 판정, i18n 짝, 화면 연결. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UpdateStatusResponse } from '@shared/http'
import { runUpdateNotice, safeHttpUrl, shouldAnnounceUpdate, type UpdateNoticeDeps } from '../src/lib/updateNotice'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}
const HERE = path.dirname(fileURLToPath(import.meta.url))

check(safeHttpUrl('https://dl.example/aether') === 'https://dl.example/aether', 'https 통과')
check(safeHttpUrl('http://dl.example') !== null, 'http 통과')
check(safeHttpUrl('javascript:alert(1)') === null, 'javascript: 거절')
check(safeHttpUrl('data:text/html,x') === null && safeHttpUrl('file:///etc/passwd') === null, 'data:, file: 거절')
check(safeHttpUrl('not a url') === null && safeHttpUrl(undefined) === null && safeHttpUrl('') === null, '잘못된 값 거절')

const base = { enabled: true, current: '0.0.1', latest: '0.0.2', available: true, pageUrl: 'https://dl.example/aether' }
check(shouldAnnounceUpdate(base, null), '처음 보는 새 버전은 알린다')
check(!shouldAnnounceUpdate(base, '0.0.2'), '같은 버전은 다시 알리지 않는다')
check(shouldAnnounceUpdate(base, '0.0.1'), '더 새 버전이 나오면 다시 알린다')
check(!shouldAnnounceUpdate({ ...base, available: false }, null), '새 버전이 없으면 알리지 않는다')
check(!shouldAnnounceUpdate({ ...base, enabled: false }, null), '꺼져 있으면 알리지 않는다')
check(!shouldAnnounceUpdate({ ...base, pageUrl: 'javascript:x' }, null), '열 수 없는 링크면 알리지 않는다')
check(!shouldAnnounceUpdate({ ...base, pageUrl: undefined }, null), '링크가 없으면 알리지 않는다')

// 알림 흐름(runUpdateNotice): 한 번만, 저장 실패, 숨은 탭
function flow(over: Partial<UpdateNoticeDeps> & { status?: UpdateStatusResponse } = {}) {
  const store = new Map<string, string>()
  const shown: string[] = []
  const deps: UpdateNoticeDeps = {
    fetchStatus: async () => over.status ?? base,
    getSeen: () => store.get('seen') ?? null,
    setSeen: (v) => { store.set('seen', v) },
    isHidden: () => false,
    show: (s) => { shown.push(s.latest!) },
    ...over,
  }
  return { store, shown, deps }
}
{
  const f = flow()
  check(await runUpdateNotice(f.deps) === 'shown' && f.shown.join() === '0.0.2' && f.store.get('seen') === '0.0.2', '흐름: 새 버전을 보여 주고 기록한다')
  check(await runUpdateNotice(f.deps) === 'skipped' && f.shown.length === 1, '흐름: 같은 버전은 두 번째에 보여 주지 않는다')
}
{
  const f = flow({ setSeen: () => { throw new Error('quota') } })
  check(await runUpdateNotice(f.deps) === 'shown' && f.shown.length === 1, '흐름: 기록 저장이 실패해도 보여 준다')
}
{
  const f = flow({ getSeen: () => { throw new Error('denied') } })
  check(await runUpdateNotice(f.deps) === 'shown', '흐름: 기록 읽기가 실패해도 보여 준다')
}
{
  let hidden = true
  const f = flow({ isHidden: () => hidden })
  check(await runUpdateNotice(f.deps) === 'deferred' && f.shown.length === 0 && !f.store.has('seen'), '흐름: 숨은 탭이면 기록도 표시도 미룬다')
  hidden = false
  check(await runUpdateNotice(f.deps) === 'shown' && f.shown.length === 1, '흐름: 보이게 되면 다시 확인해 보여 준다')
}
{
  const f = flow({ fetchStatus: async () => { throw new Error('net') } })
  check(await runUpdateNotice(f.deps) === 'skipped' && f.shown.length === 0, '흐름: 확인 실패는 조용히 넘긴다')
}
{
  const f = flow({ status: { ...base, available: false } })
  check(await runUpdateNotice(f.deps) === 'skipped' && f.shown.length === 0, '흐름: 새 버전이 없으면 보여 주지 않는다')
}

const dict = fs.readFileSync(path.join(HERE, '../src/lib/i18n/settings.ts'), 'utf8')
for (const k of ['update.row.new', 'update.row.latest', 'update.row.download', 'update.row.note', 'update.toast.title', 'update.toast.message']) {
  check(new RegExp(`'${k}': \\{ ko: .*en: |'${k}': \\{\\n\\s+ko: [\\s\\S]*?en: `).test(dict), `i18n 한국어·영어 짝: ${k}`)
}
const sec = fs.readFileSync(path.join(HERE, '../src/components/settings/ServerInfoSection.tsx'), 'utf8')
check(/safeHttpUrl\(update\.pageUrl\)/.test(sec) && /noopener/.test(sec) && /<StackRow label=\{t\('update\.row\.download'\)/.test(sec), '설정 창 링크는 safeHttpUrl을 거치고 새 탭·noopener')
const store = fs.readFileSync(path.join(HERE, '../src/lib/store.ts'), 'utf8')
check(/actions\.checkUpdateNotice\(\)/.test(store) && /runUpdateNotice\(/.test(store) && /visibilitychange/.test(store), 'init이 새 버전 알림을 부른다')

console.log(`\n${fail === 0 ? '✅' : '❌'} updateNotice: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
