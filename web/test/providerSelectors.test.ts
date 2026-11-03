/**
 * 모델·provider 선택자 테스트.
 *   실행: npx tsx web/test/providerSelectors.test.ts   (src 밖이라 앱 빌드 tsc -b에 미포함)
 *
 * 지키는 것은 셋이다.
 *
 * ① **모델·추론 강도 목록의 출처는 라이브 세션이 알려준 것 하나뿐이다.** 예전엔 프론트에 예비 목록을
 *    적어 두고 응답이 없으면 그걸 보여줬다. 그 목록은 실제 계정이 쓸 수 있는 것과 조용히 어긋났고,
 *    어긋나도 화면은 멀쩡해 보였다. 못 받았으면 빈 손이어야 한다.
 *
 * ② **지금 쓰는 모델을 목록에서 찾을 때는 별칭과 정식 id를 둘 다 본다.** 목록의 줄은 별칭('haiku')인데
 *    대화 스트림이 싣는 이름은 정식 id('claude-haiku-4-5-20251001')다. 한쪽만 비교하면 어느 줄에도
 *    체크 표시가 붙지 않는다.
 *
 * ③ **화면에 쓰는 모델 이름은 목록이 준 사람이 읽는 이름이고, 목록이 없으면 원문 그대로다.**
 *    이름을 짧게 줄이려면 모델 이름의 생김새를 알아야 하는데, 그 지식을 프론트에 두지 않기로 했다.
 *
 * 선택자는 상태를 인자로 받는 순수 함수라 스토어를 띄우지 않고 부른다.
 */
import {
  activeProviderId,
  activeProviderName,
  canReauthProvider,
  clampEffort,
  currentModel,
  currentModelInfo,
  defaultNewSessionProvider,
  effortOrder,
  isSessionAsleep,
  modelList,
  permissionBadgeKind,
  providerName,
  showProviderTag,
  supportedEfforts,
} from '../src/lib/store'
import type { State } from '../src/lib/store'
import type { ModelInfo, ProviderList, SessionListItem } from '../src/lib/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}
function eq(name: string, got: unknown, want: unknown) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want })
}

// 실측한 응답 그대로(2026-07-30). haiku만 강도 항목이 없다.
//   Fable 줄을 눈여겨봐라 — 변종 표시 `[1m]`이 다른 줄과 반대로 *고르는 이름* 쪽에 붙어 있다.
//   같은 응답 안에서도 위치가 일정하지 않다는 증거라 픽스처에 그대로 남긴다.
const MODELS: ModelInfo[] = [
  { value: 'default', displayName: 'Default (recommended)', isDefault: true, resolvedModel: 'claude-opus-5[1m]', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus[1m]', displayName: 'Opus (1M context)', isDefault: false, resolvedModel: 'claude-opus-5[1m]', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-fable-5[1m]', displayName: 'Fable', isDefault: false, resolvedModel: 'claude-fable-5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', displayName: 'Sonnet', isDefault: false, resolvedModel: 'claude-sonnet-5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', displayName: 'Haiku', isDefault: false, resolvedModel: 'claude-haiku-4-5-20251001' },
]

// Codex는 `default`라는 별칭을 만들지 않고, 각 모델 줄의 표시로 계정 기본을 알려 준다.
const CODEX_MODELS: ModelInfo[] = [
  { value: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', isDefault: false, resolvedModel: 'gpt-5.4-mini', supportedEffortLevels: ['low', 'medium'] },
  { value: 'gpt-5.6-terra', displayName: 'GPT-5.6 terra', isDefault: true, resolvedModel: 'gpt-5.6-terra', supportedEffortLevels: ['medium', 'high'] },
]

const PROVIDERS: ProviderList = [
  { id: 'claude', displayName: 'Claude', authSupported: true },
  { id: 'codex', displayName: 'MockProvider', authSupported: false },
]

// 세 번째 항목은 이름 분기가 아니라 카탈로그 소비를 고정한다. id·표시 이름은 서버가 준 그대로다.
const THREE: ProviderList = [
  ...PROVIDERS,
  { id: 'third', displayName: 'ThirdName', authSupported: true },
]

const session = (id: string, provider: string, model = ''): SessionListItem =>
  ({ id, provider, model, cwd: '/x', displayName: id, permissionMode: 'manual', status: 'active', createdAt: 0 }) as SessionListItem

/** 선택자가 읽는 만큼만 채운 상태(부분 State). 스토어 인스턴스를 띄우지 않는다. */
const st = (o: Record<string, unknown>) =>
  ({ sessions: [], activeId: null, convos: {}, defaultModel: '', providers: null, availableModels: null, reloginEnabled: true, ...o }) as unknown as State

/** 세션 하나를 열어 둔 상태 — 그 세션이 쓰는 모델 이름과 받아 둔 목록을 준다. */
const open = (model: string, models: ModelInfo[] | null) =>
  st({ sessions: [session('s1', 'claude', model)], activeId: 's1', availableModels: models })

// ── ① 목록의 출처는 하나뿐이다 ──
eq('목록을 못 받았으면 고를 수 있는 모델은 없다', modelList(open('haiku', null)), [])
eq('목록이 비어 왔어도 없는 것으로 본다', modelList(open('haiku', [])), [])
eq('받은 목록은 그대로 보여준다', modelList(open('haiku', MODELS)).map((m) => m.value), ['default', 'opus[1m]', 'claude-fable-5[1m]', 'sonnet', 'haiku'])
check(
  '계정 기본 모델은 SDK 목록의 정식 항목이라 따로 만들어 붙이지 않는다',
  modelList(open('haiku', MODELS)).filter((m) => m.value === 'default').length === 1,
)

// ── ② 별칭과 정식 id를 둘 다 대조한다 ──
eq('별칭으로 찾는다', currentModelInfo(open('haiku', MODELS))?.value, 'haiku')
eq('스트림이 싣는 정식 id로도 같은 줄을 찾는다', currentModelInfo(open('claude-haiku-4-5-20251001', MODELS))?.value, 'haiku')
eq('대소문자는 무시한다', currentModelInfo(open('CLAUDE-SONNET-5', MODELS))?.value, 'sonnet')
eq('별칭이 정확히 맞으면 그 줄이 이긴다', currentModelInfo(open('opus[1m]', MODELS))?.value, 'opus[1m]')
// 두 줄이 같은 정식 id를 가리키면(계정 기본 모델과 그 모델을 직접 고른 줄) 구체적인 이름 쪽으로 간다.
//   스트림이 주는 이름만으로는 둘을 구분할 수 없는데, 'Opus (1M context)'를 골라 놓고 다음 턴부터 칩이
//   '기본(권장)'으로 바뀌면 사용자는 자기 선택이 취소된 줄로 오해한다.
eq('같은 정식 id를 가리키는 줄이 둘이면 구체적인 이름 쪽', currentModelInfo(open('claude-opus-5[1m]', MODELS))?.value, 'opus[1m]')
eq('목록에 없는 모델은 못 찾는다(억지로 끼워 맞추지 않는다)', currentModelInfo(open('sol5.6', MODELS)), null)
eq('목록이 없으면 찾을 수 없다', currentModelInfo(open('haiku', null)), null)

// ── ②-1. 변종 표시(`[1m]`)만 다른 같은 모델 ──
//   2026-07-30 실제로 겪은 일이다. Claude가 같은 모델을 두 철자로 말한다 — 목록에서는 정식 이름을
//   'claude-opus-5[1m]'이라 하고, 대화 중 "지금 이 모델로 답한다"고 알릴 때는 'claude-opus-5'라고 한다.
//   못 알아보면 모델 칩이 날 이름을 그대로 뱉고, 강도 목록은 그 줄에 실려 오므로 강도 칩이 통째로 사라진다.
eq('스트림이 변종 표시를 떼고 말해도 같은 줄을 찾는다', currentModelInfo(open('claude-opus-5', MODELS))?.value, 'opus[1m]')
eq('그 경우에도 칩에는 사람이 읽는 이름이 나온다', currentModel(open('claude-opus-5', MODELS)), 'Opus (1M context)')
check('그 경우에도 강도 목록을 안다', supportedEfforts(open('claude-opus-5', MODELS)).length === 5)
// 반대 방향 — 변종 표시가 고르는 이름 쪽에 붙은 줄(Fable)도 양쪽으로 다 찾아진다.
eq('고르는 이름에 변종 표시가 붙은 줄도 정식 이름으로 찾는다', currentModelInfo(open('claude-fable-5', MODELS))?.value, 'claude-fable-5[1m]')
eq('그 줄은 고르는 이름 그대로도 찾아진다', currentModelInfo(open('claude-fable-5[1m]', MODELS))?.value, 'claude-fable-5[1m]')
// 표시만 떼는 것이지 이름이 다르면 여전히 남이다 — 느슨하게 맞춰서 엉뚱한 줄을 잡으면 안 된다.
eq('이름 자체가 다르면 표시를 떼도 못 찾는다', currentModelInfo(open('claude-opus-6', MODELS)), null)

// ── ②-2. 모델을 한 번도 고르지 않은 세션(방금 만든 세션이 그렇다) ──
//   세션을 만들 때 모델을 안 고르면 서버는 모델 이름을 빈 값으로 둔다. 대화가 없으니 스트림이 알려주는
//   이름도 없다. 그런데 그건 "모른다"가 아니라 "계정 기본으로 돈다"는 뜻이고, 목록의 기본 표시가 그
//   줄을 가리킨다. 이 줄을 안 쓰면 새 세션은 모델 칩이 '—'가 되고 강도 칩은 통째로 사라진다.
eq('모델을 안 고른 세션은 목록의 계정 기본 줄로 본다', currentModelInfo(open('', MODELS))?.value, 'default')
eq('그 경우 칩에는 같은 모델을 직접 가리키는 줄의 이름이 나온다', currentModel(open('', MODELS)), 'Opus (1M context)')
check('그 경우에도 강도 목록을 안다', supportedEfforts(open('', MODELS)).length === 5)
eq('Codex 모양도 기본 표시만으로 계정 기본 줄을 찾는다', currentModelInfo(open('', CODEX_MODELS))?.value, 'gpt-5.6-terra')
eq('Codex 모양도 기본 모델 칩에 사람이 읽는 이름을 쓴다', currentModel(open('', CODEX_MODELS)), 'GPT-5.6 terra')
eq('Codex 모양도 기본 모델 줄의 강도 목록을 쓴다', supportedEfforts(open('', CODEX_MODELS)), ['medium', 'high'])
eq('목록을 못 받았으면 계정 기본이 무엇인지도 모른다', currentModelInfo(open('', null)), null)
eq('그때는 예전처럼 자리만 표시한다', currentModel(open('', null)), '—')

// ── ③ 화면에 쓰는 이름 ──
eq('목록이 있으면 사람이 읽는 이름을 쓴다', currentModel(open('claude-haiku-4-5-20251001', MODELS)), 'Haiku')
eq('목록이 없으면 세션이 쓰는 이름을 그대로 보여준다', currentModel(open('claude-haiku-4-5-20251001', null)), 'claude-haiku-4-5-20251001')
eq('모델을 아직 모르면 자리만 표시한다', currentModel(st({})), '—')

// ── ④ 추론 강도도 같은 응답에서만 온다 ──
eq('강도 목록은 그 모델 줄에 실려 온 것뿐', supportedEfforts(open('sonnet', MODELS)), ['low', 'medium', 'high', 'xhigh', 'max'])
eq('강도 항목이 없는 모델은 빈 배열(칩 자체가 숨는다)', supportedEfforts(open('haiku', MODELS)), [])
eq('목록을 못 받았으면 강도도 모른다', supportedEfforts(open('sonnet', null)), [])
eq('강도 순서는 목록에 있는 모든 모델의 단계를 합친 것', effortOrder(open('haiku', MODELS)), ['low', 'medium', 'high', 'xhigh', 'max'])
eq('목록이 없으면 순서도 없다', effortOrder(open('haiku', null)), [])

// clamp는 "지원하면 그대로, 아니면 순서상 가장 가까운 지원값". 지원 목록이 비면 아무 값도 못 준다.
const ORDER = ['low', 'medium', 'high', 'xhigh', 'max']
eq('지원하는 값은 그대로', clampEffort('high', ['low', 'medium', 'high'], ORDER), 'high')
eq('지원 밖이면 가장 가까운 지원값으로 내린다', clampEffort('max', ['low', 'medium', 'high'], ORDER), 'high')
eq('동률이면 위 단계를 고른다', clampEffort('high', ['medium', 'xhigh'], ORDER), 'xhigh')
eq('지원 목록이 비면 고를 값이 없다', clampEffort('high', [], ORDER), null)
eq('순서에 없는 값은 위치를 몰라 손대지 않는다', clampEffort('ultracode', ['low', 'medium'], ORDER), null)

// ── ⑤ provider 목록은 표시 이름 용도만 남았다(모델·강도와 무관) ──
const two = st({ sessions: [session('s1', 'claude'), session('s2', 'codex')], activeId: 's2', providers: PROVIDERS })
eq('활성 세션의 provider id', activeProviderId(two), 'codex')
eq('활성 세션의 표시 이름', activeProviderName(two), 'MockProvider')
eq('세션이 없으면 빈 값(목록 첫 항목으로 짐작하지 않는다)', activeProviderId(st({ providers: PROVIDERS })), '')
eq('목록에 없는 provider는 id 그대로 보여준다', providerName(st({ providers: PROVIDERS }), 'unregistered'), 'unregistered')
eq('목록을 못 받았으면 id가 그대로 보인다', providerName(st({ providers: null }), 'claude'), 'claude')

// ── ⑥ 승인 배지는 provider가 계산한 전면 우회도 강한 표시로 합친다 ──
const partialPolicy = { bypassAll: false, autoApproveRules: 1, sources: ['user' as const] }
eq('자동승인 규칙은 부분 우회 배지', permissionBadgeKind('manual', partialPolicy), 'partial')
eq(
  '설정 defaultMode의 전면 우회도 세션 생성 플래그와 같은 강한 배지',
  permissionBadgeKind('manual', { ...partialPolicy, bypassAll: true, autoApproveMode: 'bypassPermissions' }),
  'all',
)
eq('세션 생성 전면 우회 플래그가 최우선', permissionBadgeKind('full', null), 'all')
eq('우회가 없으면 배지 없음', permissionBadgeKind('manual', { bypassAll: false, autoApproveRules: 0, sources: [] }), null)

// ── ⑦ 서버 목록 상태로 잠든 세션 판정 ──
eq('active 세션은 잠들지 않았다', isSessionAsleep([session('s1', 'claude')], 's1'), false)
eq('ended 세션은 잠들었다', isSessionAsleep([{ ...session('s1', 'claude'), status: 'ended' }], 's1'), true)
eq('interrupted 세션은 잠들었다', isSessionAsleep([{ ...session('s1', 'claude'), status: 'interrupted' }], 's1'), true)
eq('crashed 세션은 잠들었다', isSessionAsleep([{ ...session('s1', 'claude'), status: 'crashed' }], 's1'), true)
eq('corrupted 세션은 깨울 수 없다', isSessionAsleep([{ ...session('s1', 'claude'), status: 'corrupted' }], 's1'), false)
eq('목록에 없는 세션은 판정 근거가 없다', isSessionAsleep([session('s1', 'claude')], 'missing'), false)

// ── ⑧ 새 세션의 기본 서비스와 세션 꼬리표 (8h) ──
// 새 세션은 지금 열려 있는 세션과 같은 서비스로 미리 골라 둔다 — 대개 하던 일을 이어서 하나 더 여는 것이다.
eq(
  '열린 세션이 있으면 그 서비스를 기본으로 고른다',
  defaultNewSessionProvider(st({ sessions: [session('s1', 'codex')], activeId: 's1', providers: PROVIDERS })),
  'codex',
)
eq('열린 세션이 없으면 등록된 첫 서비스', defaultNewSessionProvider(st({ providers: PROVIDERS })), 'claude')
eq(
  '열린 세션의 서비스가 서버 목록에 없으면 첫 서비스로 떨어진다',
  defaultNewSessionProvider(st({ sessions: [session('s1', 'gone')], activeId: 's1', providers: PROVIDERS })),
  'claude',
)
// 목록을 아직 못 받았으면 이름을 지어내지 않는다 — 서버가 자기 기본값으로 만든다.
eq('목록을 못 받았으면 빈 값', defaultNewSessionProvider(st({ sessions: [session('s1', 'claude')], activeId: 's1' })), '')

// 꼬리표는 고를 것이 둘 이상일 때만 단다. 하나뿐이면 모든 세션이 같아서 정보를 더하지 않는다.
eq('서비스가 둘이면 세션에 꼬리표를 단다', showProviderTag(st({ providers: PROVIDERS })), true)
eq('서비스가 하나뿐이면 꼬리표를 안 단다', showProviderTag(st({ providers: [PROVIDERS[0]] })), false)
eq('목록을 못 받았으면 꼬리표를 안 단다', showProviderTag(st({})), false)

// ── ⑩ 세 번째 카탈로그 항목도 같은 선택자를 탄다 (10f) ──
eq('서비스가 셋이면 꼬리표를 단다', showProviderTag(st({ providers: THREE })), true)
eq('세 번째 표시 이름은 카탈로그', providerName(st({ providers: THREE }), 'third'), 'ThirdName')
eq(
  '열린 세 번째 세션을 기본으로 고른다',
  defaultNewSessionProvider(st({ sessions: [session('s3', 'third')], activeId: 's3', providers: THREE })),
  'third',
)
eq('세 번째도 인증 지원이면 그린다', canReauthProvider(st({ providers: THREE, reloginEnabled: true }), 'third'), true)

// ── ⑨ 재인증 버튼을 그릴까 (8h) ──
// 눌러도 아무것도 못 하는 버튼은 안내가 아니라 함정이다. 못 한다는 것을 **아는** 경우에만 감춘다.
eq('인증을 지원하는 서비스면 그린다', canReauthProvider(st({ providers: PROVIDERS, reloginEnabled: true }), 'claude'), true)
eq('인증 구현이 없는 서비스면 안 그린다', canReauthProvider(st({ providers: PROVIDERS, reloginEnabled: true }), 'codex'), false)
eq('서버가 원격 재로그인을 껐으면 안 그린다', canReauthProvider(st({ providers: PROVIDERS, reloginEnabled: false }), 'claude'), false)
eq('목록을 못 받아 모르면 감추지 않는다(유일한 복구 통로)', canReauthProvider(st({ reloginEnabled: true }), 'claude'), true)

console.log(`\n${fail === 0 ? '✅' : '❌'} providerSelectors: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
