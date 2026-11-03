// 모델 선택 칩 — 목록의 출처는 라이브 세션이 알려주는 것 하나뿐이다(GET /api/sessions/:id/models).
//   프론트에 예비 목록이 없으므로, 못 받았을 때 무엇을 보여줄지가 이 파일의 절반이다. 세 가지 경우가 있다.
//     ① 받았다      — 온 그대로 나열한다. 'default'(계정 기본 모델)도 그 목록의 정식 항목이라 따로 만들지 않는다.
//     ② 세션이 잠들어 있다 — 물어볼 상대가 없다. 목록창을 열지 않고 왜 없는지만 알린다.
//     ③ 끝내 못 받았다   — 칩은 현재 모델을 정상 표시하고(현재 모델은 대화 기록에서 이미 안다),
//                       누르면 목록 대신 안내와 "다시 시도"를 보여준다.
//
// 칩·팝오버의 생김새는 공통 ChipPicker가 맡는다. 여기 남는 것은 이 피커만의 데이터와 위 세 갈래뿐이다.
import { actions, chromeSessionId, convoLoading, currentModel, currentModelInfo, modelList, paneView, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { C, FONT } from '../design/tokens'
import { ActionPill, ChipPicker, type ChipOption } from './ui'

export function ModelPicker({ compact, direction = 'down', roomId, tight }: { compact?: boolean; direction?: 'up' | 'down'; roomId?: string; tight?: boolean }) {
  const store = useStore()
  // 칸 안의 칩은 자기 세션 값을 본다(상단 도구 섬의 칩은 포커스 칸).
  const s = roomId ? paneView(store, roomId) : store
  const t = useT()
  const models = modelList(s)
  const label = currentModel(s)
  const cur = currentModelInfo(s)
  const asleep = s.modelsStatus === 'asleep'
  const failed = s.modelsStatus === 'failed'
  // 초기 replay 중엔 convos 파생 모델이 중간값(과거 응답 순서대로) → 자리표시자로 가리고 caught_up 후 실값 표시.
  //   목록을 가져오는 중(재시도 대기 포함)에도 같다. 실패로 굳은 뒤에는 자리표시자를 걷고 아는 값을 보여준다.
  const loading = convoLoading(s) || s.modelsStatus === 'loading'

  const options: ChipOption<string>[] = models.map((m) => ({
    value: m.value,
    title: m.displayName,
    subtitle: m.value,
  }))

  return (
    <ChipPicker
      options={options}
      value={undefined}
      // 체크 표시는 값이 아니라 "지금 쓰는 모델의 줄인가"로 맞춘다. 대화 스트림이 싣는 이름은 정식 id인데
      //   목록의 줄은 별칭이라, 둘 중 하나만 비교하면 어느 줄에도 체크가 안 붙는다.
      isActive={(v) => !!cur && v === cur.value}
      onPick={(value) => void actions.setModel(value, chromeSessionId(s))}
      onOpen={() => {
        if (!asleep) return true
        actions.showNotice({ title: t('session.model.asleepTitle'), message: t('session.model.asleepMsg') })
        return false
      }}
      panel={
        failed
          ? (close) => (
              <div style={{ padding: '12px 14px' }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: C.label, marginBottom: 6 }}>{t('session.model.failedTitle')}</div>
                <div style={{ fontSize: 11.5, color: C.label2, lineHeight: 1.55 }}>
                  {t('session.model.failedHintPre')}
                  <code style={{ fontFamily: FONT.mono, fontSize: 11 }}>/model</code>
                  {t('session.model.failedHintPost')}
                </div>
                <div style={{ fontSize: 11.5, color: C.label2, lineHeight: 1.55, marginTop: 6 }}>{t('session.model.failedRestart')}</div>
                <ActionPill
                  tone="outline"
                  style={{ marginTop: 10 }}
                  onClick={() => {
                    close()
                    // 모델 목록 REST는 실행 id 기준 — 방 id(dm:…)로 물으면 다시 시도가 늘 실패한다.
                    const id = chromeSessionId(s)
                    if (id) void actions.fetchModels(id)
                  }}
                >
                  {t('session.model.retry')}
                </ActionPill>
              </div>
            )
          : undefined
      }
      label={label}
      title={asleep ? t('session.model.asleepTitle') : failed ? t('session.model.failedTitle') : t('session.model.title', { count: models.length })}
      loading={loading}
      loadingLabel={t('session.model.checking')}
      skeletonWidth={44}
      compact={compact}
      direction={direction}
      align={roomId ? 'left' : undefined}
      labelMaxWidth={tight ? 72 : undefined}
      // 안내판은 목록보다 글이 길어 조금 더 넓어야 문장이 잘게 끊기지 않는다.
      minWidth={failed ? 264 : 216}
      subtitleMono
    />
  )
}
