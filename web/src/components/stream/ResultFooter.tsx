// W12 결과 푸터
// 표시: 완료/실패 · 이 답변이 생성한 출력 토큰 · 소요시간 · 완료시각. ctx%는 상단 툴바(UsageChip)에 있으므로 푸터에선 제외.
//   ts = 이 turn_completed 이벤트의 수신 시각(envelope.ts) — 답변이 끝난 시점.
//   8d-3: provider 원본(result 메시지) 대신 정규화 계약을 받는다. 못 채우는 값은 그 표시만 빠진다.
import { memo } from 'react'
import { X } from 'lucide-react'
import type { TurnCompleted } from '../../lib/types'
import { fmtDateTime, tokensShort } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { C } from '../../design/tokens'
import chamdingUrl from '../../assets/chamding-idle.webp'

export const ResultFooter = memo(function ResultFooter({ turn, ts }: { turn: TurnCompleted; ts: number }) {
  const t = useT()
  const failed = turn.status !== 'ok'
  const errors = turn.errors ?? []
  const overloaded = failed && errors.some((e) => /529|overload/i.test(e))
  const outTok = turn.outputTokens
  const secs = turn.durationMs == null ? null : (turn.durationMs / 1000).toFixed(1)
  const when = fmtDateTime(ts)
  return (
    // tabular-nums = 0부터 9까지의 폭을 같게. 토큰 수·소요 초·시각이 바뀔 때 옆 항목이 밀리지 않는다.
    //   재설계 4단계: 본문 글꼴이다. 소요 초·날짜는 사람이 읽는 수치라 고정폭을 쓰지 않는다.
    <div className="self-stretch tabular-nums flex flex-wrap items-center" style={{ fontSize: 12, color: C.label3, rowGap: 6, columnGap: 14, padding: '2px 0' }}>
      <span className="inline-flex items-center" style={{ gap: 4, fontWeight: 500, color: failed ? C.del : C.ok }}>
        {failed ? <X size={12} /> : <img src={chamdingUrl} width={13} height={13} alt="" style={{ display: 'block', objectFit: 'contain' }} />} {failed ? t('stream.result.failed') : t('stream.result.success')}
      </span>
      {outTok != null && <span>{t('stream.result.tokens', { tok: tokensShort(outTok) })}</span>}
      {secs != null && <span>{secs}s</span>}
      {when && <span style={{ marginLeft: 'auto' }}>{when}</span>}
      {failed && errors.length > 0 && (
        <span style={{ color: C.del, flexBasis: '100%' }}>
          {overloaded ? t('stream.result.overloaded') : ''}
          {errors.join(' · ')}
        </span>
      )}
    </div>
  )
})
