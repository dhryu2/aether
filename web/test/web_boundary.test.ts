/**
 * 프론트 경계 검사 (Phase 8d-3 완료 게이트 ①) — 정적 검사, 앱을 띄우지 않는다.
 *   실행: npx tsx web/test/web_boundary.test.ts
 *
 * 지키는 것은 하나다: **`web/src`는 provider 원본을 읽지 않는다.**
 * 모델이 만든 내용은 전부 정규화 계약(`AgentEvent`)에서만 온다. 원본을 한 군데라도 읽기 시작하면
 * 그 화면 요소는 Claude에서만 동작하고 다른 provider 세션에선 에러도 없이 조용히 빈다 — 그게 8d-3이
 * 없애려는 상태다.
 *
 * 서버 쪽 `test:boundary`와 달리 **허용 목록이 없다.** 8d-3은 예비 경로를 통째로 지웠으므로 "여기는
 * 예외"라고 적을 자리가 있으면 안 된다. 예외가 필요해지는 순간이 곧 설계 결정을 다시 해야 하는 순간이다.
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
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walk(abs, out)
    else if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(path.relative(WEB_DIR, abs))
  }
  return out
}

/** 주석 속 설명이 위반으로 잡히지 않게 라인·블록 주석을 지운 뒤 검사한다. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const files = walk(SRC_DIR)
check(`스캔 대상 파일 ${files.length}개(web/src 전체)`, files.length > 20)

const read = (rel: string) => stripComments(fs.readFileSync(path.join(WEB_DIR, rel), 'utf8'))

/**
 * 금지 패턴. 각각이 "원본을 읽는" 서로 다른 방식이다 — 하나만 막으면 나머지로 새어 나간다.
 *   - `SDKMessage`      : Claude 원본 타입을 다시 들여오는 것(수동 미러 부활)
 *   - `.msg`            : 봉투의 원본 본문 접근
 *   - `kind === 'sdk'`  : provider를 원본 태그로 판정
 *   - `AETHER_EVENT_FORMAT` : 8d-3에서 지운 예비 경로 스위치의 흔적
 *   - `/api/claude-auth`    : 8d-3 ④에서 지운 Claude 고정 인증 경로
 *   - Claude 원본 사용량 필드 : 사용량 응답을 provider 모양으로 읽던 자리(8d-3 ④에서 중립 스키마로 교체)
 */
const BANNED: { name: string; re: RegExp }[] = [
  { name: 'Claude 원본 타입(SDKMessage) 참조', re: /\bSDKMessage\b/ },
  { name: '봉투 원본 본문(.msg) 접근', re: /\.\s*msg\b|\bmsg\s*:/ },
  { name: "원본 태그로 provider 판정(kind === 'sdk')", re: /kind\s*[=!]==?\s*['"]sdk['"]/ },
  { name: '지운 예비 경로 스위치 흔적(AETHER_EVENT_FORMAT)', re: /AETHER_EVENT_FORMAT|eventFormat/ },
  { name: '지운 Claude 고정 인증 경로(/api/claude-auth)', re: /claude-auth/ },
  // 창 이름을 *읽는* 것(속성 접근)만 막는다. `usageLabels`의 라벨 조회표는 같은 이름이 문자열로 나오지만
  //   모르는 값을 그대로 통과시키는 표시용 표라서 결합이 아니다 — 다른 provider의 창도 이름 그대로 뜬다.
  { name: 'Claude 원본 사용량 필드 접근(rate_limits·subscription_type·.five_hour…)', re: /\brate_limits\b|\bsubscription_type\b|\.\s*(?:five_hour|seven_day)/ },
]

for (const { name, re } of BANNED) {
  const offenders = files.filter((rel) => re.test(read(rel)))
  check(`${name} 0건`, offenders.length === 0, offenders)
}

// 검사기가 헛돌지 않는지 스스로 반증 — 패턴이 실제로 이런 코드를 잡아내는가.
const decoy = stripComments(`
  const m = ev.msg as SDKMessage
  if (ev.kind === 'sdk') return m
`)
check(
  '검사기가 실제 위반 코드를 잡는다(자기 반증)',
  BANNED.slice(0, 3).every(({ re }) => re.test(decoy)),
)

// 계약은 한 벌만 있어야 한다 — server/web이 같은 파일을 본다.
const typesSrc = fs.readFileSync(path.join(SRC_DIR, 'lib', 'types.ts'), 'utf8')
const brainSrc = fs.readFileSync(path.join(SRC_DIR, 'lib', 'brain.ts'), 'utf8')
const segmentsSrc = fs.readFileSync(path.join(SRC_DIR, 'lib', 'streamSegments.ts'), 'utf8')
check("정규화 계약은 shared/ 한 벌만 참조한다", typesSrc.includes("from '@shared/agentEvent'"))
check("HTTP 응답 모양은 shared/http.ts 한 벌만 참조한다", typesSrc.includes("from '@shared/http'"))
check("Brain REST 응답 모양은 shared/brain.ts 한 벌만 참조한다", brainSrc.includes("from '@shared/brain'"))

const HTTP_TYPE_BODIES = [
  'UsageResponse',
  'LocalizedText',
  'PermissionPolicy',
  'ModelInfo',
  'MutationPreview',
  'PermissionRequest',
  'AetherEvent',
  'SessionListItem',
]
const httpBodyHits = HTTP_TYPE_BODIES.filter((name) => new RegExp(`export type ${name}\\s*=\\s*[{]`).test(typesSrc))
check(`웹이 HTTP 타입을 손으로 복제하지 않는다 (${HTTP_TYPE_BODIES.join(', ')})`, httpBodyHits.length === 0, httpBodyHits)

const BRAIN_TYPE_BODIES = ['SearchHit', 'MemoryResponse', 'SkillInfo', 'ActivityItem']
const brainBodyHits = BRAIN_TYPE_BODIES.filter((name) => new RegExp(`export type ${name}\\s*=\\s*[{]`).test(brainSrc))
check(`웹이 Brain REST 타입을 손으로 복제하지 않는다 (${BRAIN_TYPE_BODIES.join(', ')})`, brainBodyHits.length === 0, brainBodyHits)

const serverImportRe = /from\s+['"][^'"]*\/server(?:\/[^'"]*)?['"]|require\(\s*['"][^'"]*\/server/
const webServerHits = files.filter((rel) => serverImportRe.test(read(rel)))
check('web/src의 server/ import 0건', webServerHits.length === 0, webServerHits)
check('검사기가 웹→server import를 잡는다(자기 반증)', serverImportRe.test("import { x } from '../../../server/types'"))

check('세그먼트 빌더가 서버를 참조하지 않는다', !serverImportRe.test(segmentsSrc) && !segmentsSrc.includes('server/'))

// 화면 조립은 컴포넌트 밖의 순수 함수여야 한다(게이트 ②가 그걸 부를 수 있어야 하므로).
check('세그먼트 빌더가 lib/의 순수 모듈로 존재', fs.existsSync(path.join(SRC_DIR, 'lib', 'streamSegments.ts')))
check(
  '세그먼트 빌더는 React를 import하지 않는다(순수 함수 보장)',
  !/from\s+['"]react['"]/.test(segmentsSrc),
)

// 웹만의 소켓·묶음 REST가 생기면 실패. 대화 칸은 최대 4개(splitPane)다.
const wsRe = /\b(?:new\s+)?WebSocket\b/
const wsOffenders = files.filter((rel) => wsRe.test(read(rel)))
check('web/src의 WebSocket 0건', wsOffenders.length === 0, wsOffenders)
check('검사기가 웹소켓을 잡는다(자기 반증)', wsRe.test(stripComments('const s = new WebSocket("/ws")')))

const sseSrc = read(path.join('src', 'lib', 'sse.ts'))
check(
  '주의 통로가 GET /api/presence/stream EventSource다',
  /new EventSource\(\s*['"]\/api\/presence\/stream['"]\s*\)/.test(sseSrc),
)
check('주의 통로 모듈이 WebSocket을 쓰지 않는다', !wsRe.test(sseSrc))
check('대화 통로도 EventSource다', /new EventSource\(/.test(sseSrc))

const appSrc = read(path.join('src', 'App.tsx'))
const paneSrc = read(path.join('src', 'components', 'shell', 'ConversationPane.tsx'))
check('칸은 번호로 그린다', /data-split-pane=\{String\(index\)\}/.test(paneSrc))
check('세 번째 칸 이름 tertiary는 없다', !/\btertiary\b/.test(appSrc) && !/\btertiary\b/.test(paneSrc))
check('App이 칸을 목록으로 그린다', (appSrc.match(/<ConversationPane\b/g) ?? []).length === 1 && /visibleSessionIds\(/.test(appSrc))

const splitSrc = read(path.join('src', 'lib', 'splitPane.ts'))
check('넓은 창 선은 1100', /export const WIDE_MIN = 1100\b/.test(splitSrc))
check('보이는 칸 계산이 있다', /export function visibleSessionIds\b/.test(splitSrc))

const fanoutSrc = read(path.join('src', 'lib', 'fanoutStart.ts'))
check('묶음 시작이 있는 만들기 콜백을 쓴다', /opts\.create\(/.test(fanoutSrc))
check('묶음 시작이 새 REST 경로를 안 부른다', !/\/api\/(?:sessions\/)?(?:fanout|batch)\b/.test(fanoutSrc))

const composerSrc = read(path.join('src', 'components', 'composer', 'Composer.tsx'))
check('Composer가 채널 멘션을 가져오지 않는다', !/buildChannelMentions/.test(composerSrc))
check('Sidebar가 프로젝트 묶음을 쓴다', /sessionGroups/.test(read(path.join('src', 'components', 'Sidebar.tsx'))))

console.log(`\n${fail === 0 ? '✅' : '❌'} web_boundary: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
