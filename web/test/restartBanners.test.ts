/**
 * 대화 없이 이어진 재시작 알림(복원됨·중단됨)은 종류마다 한 줄로 합친다.
 * 실행: tsx --tsconfig tsconfig.app.json test/restartBanners.test.ts
 */
import { collapseRestartBanners, type StreamSeg } from '../src/lib/streamSegments'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const banner = (seq: number, variant: 'resumed' | 'stop', text: string): StreamSeg =>
  ({ kind: 'banner', key: `b-${seq}`, seq, convo: false, variant, text }) as StreamSeg
const user = (seq: number): StreamSeg => ({ kind: 'user', key: `u-${seq}`, seq, convo: true, text: '안녕' }) as StreamSeg
const texts = (segs: StreamSeg[]) => segs.map((s) => (s.kind === 'banner' || s.kind === 'user' ? s.text : s.kind))

// 중단됨·복원됨이 번갈아 3번 — 한 쌍으로 합쳐지고 횟수가 붙는다
const a: StreamSeg[] = []
for (let k = 0; k < 3; k++) a.push(banner(k * 2, 'stop', 'S'), banner(k * 2 + 1, 'resumed', 'R'))
collapseRestartBanners(a)
check('번갈아 3번 → 두 줄(첫 등장 순서 유지)', JSON.stringify(texts(a)) === JSON.stringify(['S (×3)', 'R (×3)']), texts(a))

// 한 번뿐이면 그대로(횟수 안 붙음)
const b: StreamSeg[] = [banner(1, 'stop', 'S'), banner(2, 'resumed', 'R')]
collapseRestartBanners(b)
check('한 번이면 그대로', JSON.stringify(texts(b)) === JSON.stringify(['S', 'R']), texts(b))

// 사이에 대화가 있으면 서로 합치지 않는다
const c: StreamSeg[] = [banner(1, 'resumed', 'R'), user(2), banner(3, 'resumed', 'R')]
collapseRestartBanners(c)
check('대화가 사이에 있으면 합치지 않음', JSON.stringify(texts(c)) === JSON.stringify(['R', '안녕', 'R']), texts(c))

console.log(`restartBanners: ${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
