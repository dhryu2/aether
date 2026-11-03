/** provider 중립 슬래시 명령 목록·입력 순수 로직 — React/모델 호출 없음. */
import { buildSlashCmds, parseSlashCommand, withBriefAlias } from '../src/lib/slashCommands'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}

const commands = buildSlashCmds(
  ['event-only'],
  [
    { name: 'model', description: { byLocale: { ko: '모델 변경', en: 'Change model' } }, argumentHint: {}, startsTurn: false },
    { name: 'compact', description: { text: 'compact from provider' }, argumentHint: {}, startsTurn: false },
    { name: 'review', description: { byLocale: { ko: '코드 리뷰', en: 'Code review' } }, argumentHint: { text: '[target]' }, aliases: ['code-review'], startsTurn: true },
    { name: 'find', description: { byLocale: { ko: '이 세션에서 찾기', en: 'Find in this session' } }, argumentHint: {}, startsTurn: false, uiAction: 'find' },
    { name: 'clear', description: { byLocale: { ko: '대화 컨텍스트 초기화', en: 'Clear conversation context' } }, argumentHint: {}, startsTurn: false },
    { name: 'rename', description: { byLocale: { ko: '세션 이름 바꾸기', en: 'Rename this session' } }, argumentHint: {}, aliases: ['title'], startsTurn: false, uiAction: 'rename' },
    { name: 'status', description: { byLocale: { ko: '사용량·세션 상태', en: 'Usage and session status' } }, argumentHint: {}, aliases: ['context'], startsTurn: false, uiAction: 'status' },
    { name: 'new', description: { byLocale: { ko: '새 작업 만들기', en: 'Start a new work item' } }, argumentHint: {}, startsTurn: false, uiAction: 'newSession' },
  ],
  'ko',
  { model: 'gpt-a · gpt-b' },
)

check(commands.map((c) => c.name).join(',') === 'model,compact,review,find,clear,rename,status,new,event-only', 'REST 카탈로그가 정본이고 이벤트 이름은 뒤에 보강된다', commands)
check(commands.find((c) => c.name === 'find')?.uiAction === 'find', '화면 동작은 명령 이름이 아니라 uiAction으로 표시한다')
check(parseSlashCommand('/find', commands)?.uiAction === 'find', '파서가 화면 동작을 함께 돌려준다')
check(commands.find((c) => c.name === 'clear')?.uiAction === undefined, '/clear는 화면 초기화가 아니다')
check(parseSlashCommand('/clear', commands)?.uiAction === undefined, '/clear는 실행 API로 보낸다')
check(parseSlashCommand('/title 작업', commands)?.uiAction === 'rename', '별칭 /title도 rename 화면 동작이다')
check(parseSlashCommand('/context', commands)?.uiAction === 'status', '별칭 /context도 status 화면 동작이다')
check(parseSlashCommand('/new', commands)?.uiAction === 'newSession', '/new는 새 작업 창이다')
check(commands.find((c) => c.name === 'model')?.arg === 'gpt-a · gpt-b', 'Aether 공통 명령의 실제 인자 힌트를 보강한다')
check(commands.find((c) => c.name === 'review')?.desc === '코드 리뷰', '화면은 provider 번역표에서 현재 언어만 고른다')
check(commands.find((c) => c.name === 'review')?.aliases.includes('code-review') === true, 'provider 별칭을 보존한다')
check(parseSlashCommand('/review base main', commands)?.startsTurn === true, '턴 명령의 실행 성격을 목록에서 가져온다')
check(parseSlashCommand('/code-review commit abc', commands)?.name === 'code-review', '직접 입력한 별칭을 provider에 그대로 넘긴다')
check(parseSlashCommand('/plugin:inspect target', commands)?.name === 'plugin:inspect', 'provider 네임스페이스 명령도 공통 파서가 보존한다')
const unknown = parseSlashCommand('/not-real hello', commands)
check(unknown?.name === 'not-real' && unknown.startsTurn === false, '목록에 없는 명령도 일반 메시지로 바꾸지 않고 명령 API로 보낸다', unknown)
check(parseSlashCommand('hello /compact', commands) === null, '평범한 메시지 안의 슬래시는 명령으로 오인하지 않는다')

const withBrief = withBriefAlias(commands, '브리프 만들기')
check(withBrief.slice(0, commands.length).map((c) => c.name).join(',') === commands.map((c) => c.name).join(','), '브리프 별칭은 서버 목록 순서를 바꾸지 않는다')
check(withBrief.at(-1)?.cmd === '/브리프' && withBrief.at(-1)?.brief === true && withBrief.at(-1)?.name === '브리프', '보이는 별칭은 /브리프다')
check(withBrief.filter((c) => c.brief).length === 1, '별칭은 하나다')
check(withBriefAlias(withBrief, '다시').length === withBrief.length, '별칭을 두 번 붙이지 않는다')
const briefParsed = parseSlashCommand('/브리프 오류 리스트', withBrief)
check(briefParsed?.brief === true && briefParsed.arguments === '오류 리스트' && briefParsed.name === '브리프', '별칭과 뒤 글을 한 브리프로 나눈다', briefParsed)
const briefLine = parseSlashCommand('/브리프\n새로 생긴 오류', withBrief)
check(briefLine?.brief === true && briefLine.arguments === '새로 생긴 오류', '줄바꿈 뒤도 별칭이다', briefLine)
const notAlias = parseSlashCommand('/agent-brief 오류', withBrief)
check(notAlias?.brief !== true && notAlias?.name === 'agent-brief', '코드 식별자로 시작하는 글은 별칭이 아니다', notAlias)
check(!withBrief.some((c) => c.cmd === '/agent-brief' || c.name === 'agent-brief'), '메뉴에 코드 식별자를 올리지 않는다')

console.log(`\n${fail ? '❌' : '✅'} slash commands: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
