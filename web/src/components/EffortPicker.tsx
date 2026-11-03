// 추론 강도 선택 칩 — 누르면 지금 모델이 지원하는 단계를 나열하고, 고르면 즉시 바뀐다.
//   단계 목록의 출처는 모델 목록에 실려 오는 값 하나뿐이다(supportedEfforts). 프론트에 적어 둔 예비 목록은 없다.
//   그래서 강도를 지원하지 않는 모델이거나 목록을 아직/끝내 못 받은 상태에서는 칩 자체가 뜨지 않는다.
//
// 화면 구성은 ModelPicker와 함께 공통 ChipPicker가 맡는다(원래 두 파일이 같은 본문을 각자 갖고 있었다).
import { actions, chromeSessionId, convoLoading, currentEffort, currentModelInfo, paneView, supportedEfforts, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { effortDescription } from '../lib/effortLabels'
import { ChipPicker, type ChipOption } from './ui'
import type { SessionEffort } from '../lib/types'

export function EffortPicker({ compact, direction = 'down', roomId }: { compact?: boolean; direction?: 'up' | 'down'; roomId?: string }) {
  const store = useStore()
  // 칸 안의 칩은 자기 세션 값을 본다(상단 도구 섬의 칩은 포커스 칸).
  const s = roomId ? paneView(store, roomId) : store
  const t = useT()
  const efforts = supportedEfforts(s)
  const cur = currentEffort(s)
  // 설명의 출처는 모델 목록에 실려 오는 표 하나뿐이다(8i). 화면에 예비 표를 두지 않는다.
  const descriptions = currentModelInfo(s)?.supportedEffortDescriptions
  // 초기 replay 중엔 모델·effort 파생값이 중간값 → 자리표시자로 가리고 caught_up 후 실값 표시(숨김 판정도 보류 — 칩 pop-in/out 방지).
  //   모델 목록을 가져오는 중에도 같다 — 강도 목록이 그 응답에 실려 오기 때문이다.
  const loading = convoLoading(s) || s.modelsStatus === 'loading'
  // "우리가 모르는 것"과 "이 모델은 강도를 지원하지 않는다"는 다르다. 뒤는 아는 것이라 칩을 숨겨도 된다.
  //   모르는 경우는 셋이다 — 세션이 잠들었거나, 목록을 끝내 못 받았거나, 목록은 받았는데 지금 도는 모델이
  //   그 목록에 없거나(모델 이름이 목록의 철자와 안 맞을 때. 2026-07-30에 실제로 겪었다).
  //   어느 쪽이든 지금 설정값은 세션 메타에서 이미 아니까, 모델 칩과 똑같이 값은 보여주고 고르기만 막는다.
  //   여기서 칩을 통째로 숨기면 사용자가 설정한 값이 화면에서 조용히 사라진다.
  const unmatched = s.modelsStatus === 'ok' && !currentModelInfo(s)
  const unknown = s.modelsStatus === 'asleep' || s.modelsStatus === 'failed' || unmatched

  if (!loading && efforts.length === 0 && !(unknown && cur)) return null

  const label = cur || t('session.effort.default')

  const options: ChipOption<SessionEffort>[] = efforts.map((e) => ({
    value: e,
    title: e,
    subtitle: effortDescription(descriptions?.[e], s.locale),
  }))

  return (
    <ChipPicker
      options={options}
      value={(cur || undefined) as SessionEffort | undefined}
      onPick={(value) => void actions.setEffort(value, chromeSessionId(s))}
      onOpen={() => {
        if (!unknown) return true
        actions.showNotice({
          title: t('session.effort.lockedTitle'),
          message: t(s.modelsStatus === 'asleep' ? 'session.effort.asleepMsg' : unmatched ? 'session.effort.unmatchedMsg' : 'session.effort.failedMsg'),
        })
        return false
      }}
      label={compact ? t('session.effort.compactLabel', { label }) : label}
      title={unknown ? t('session.effort.lockedTitle') : t('session.effort.title', { level: cur || t('session.effort.default'), count: efforts.length })}
      loading={loading}
      loadingLabel={t('session.effort.checking')}
      skeletonWidth={compact ? 52 : 36}
      compact={compact}
      direction={direction}
      align={roomId ? 'left' : undefined}
      minWidth={200}
    />
  )
}
