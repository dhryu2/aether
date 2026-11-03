// 스트림에 끼어드는 알림 줄들 — 상태 알림·인증 만료.
//   재설계 4단계(0단계 조사 6번 — 알림 상자가 대화보다 눈에 띄었다): 본문 폭 가득한 색 상자를 걷었다.
//   알림은 아이콘 하나 + 글 한 줄이고, 색은 아이콘에만 쓴다. 누를 것(재인증)만 파랑 글자다.
import { memo, type ReactNode } from 'react'
import { ArrowLeftRight, Check, History, KeyRound, Square, TriangleAlert, X } from 'lucide-react'
import type { BannerVariant } from '../../lib/streamSegments'
import { useT } from '../../lib/i18n'
import { C } from '../../design/tokens'
import { RecordLine, Spinner } from '../ui'

/**
 * 알림 한 줄 — 왼쪽 색 아이콘, 오른쪽 글. 글이 길면 아이콘 옆에서 여러 줄로 접힌다.
 * `strong`이면 글을 본문색으로(경고·멈춤 — 지나치면 안 되는 것), 아니면 보조색으로(정보).
 */
function NoticeLine({ icon, iconColor, strong, children, action }: { icon: ReactNode; iconColor: string; strong?: boolean; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start" style={{ alignSelf: 'stretch', gap: 8, fontSize: 13.5, lineHeight: 1.5, color: strong ? C.label : C.label2 }}>
      <span className="inline-flex" style={{ color: iconColor, flexShrink: 0, marginTop: 3 }}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        {children}
        {action}
      </span>
    </div>
  )
}

/** 알림 줄 끝의 누를 것 — 파랑 글자 버튼. 폰에서 누르는 범위는 hit-44가 넓힌다. */
function LineAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="press hit-44" style={{ marginLeft: 8, fontSize: 13.5, fontWeight: 600, color: C.tint, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', whiteSpace: 'nowrap' }}>
      {children}
    </button>
  )
}

/**
 * W7 notice 알림을 세 무게로 나눈다(감사 F3 — 무해한 기록까지 노란 상자에 담겨 진짜 경고가 묻혔다).
 *   기록 — 가운데 회색 한 줄(RecordLine). 대화 기록 압축·이전 맥락으로 이어가기·새로 시작.
 *   정보 — 회색 전환 아이콘 + 보조색 글. 지금 어떤 모델이 도는지.
 *   경고 — 주황 경고 삼각형 + 본문색 글. 한도 임박·안전장치 자동 전환처럼 사용자가 지나치면 안 되는 것.
 *   멈춤 — 빨강 네모 + 본문색 글.
 *   어떤 사건이 어느 변형이 되는지는 streamSegments.ts가 정한다.
 */
type NoticeLook = { kind: 'record' } | { kind: 'line'; icon: ReactNode; iconColor: string; strong: boolean }

const NOTICE: Record<BannerVariant, NoticeLook> = {
  // 압축과 이어가기가 같은 변형(resumed)으로 오므로 아이콘도 하나다 — 둘 다 "기록" 시계로 보인다.
  resumed: { kind: 'record' },
  no_context: { kind: 'record' },
  stop: { kind: 'line', icon: <Square size={12} fill="currentColor" strokeWidth={0} />, iconColor: C.del, strong: true },
  model: { kind: 'line', icon: <ArrowLeftRight size={15} />, iconColor: C.label3, strong: false },
  warn: { kind: 'line', icon: <TriangleAlert size={15} />, iconColor: C.attn, strong: true },
  // 둘 다 지금 어떤 모델이 도는지 알리는 정보성 안내이므로 model과 같은 계열로 표시한다.
  // 넓은 권한을 몰래 유지하지 않고 수동으로 내렸다는 알림이라 지나치면 안 된다 — 경고와 같은 모양.
  permission_lowered: { kind: 'line', icon: <TriangleAlert size={15} />, iconColor: C.attn, strong: true },
  distill_model: { kind: 'line', icon: <ArrowLeftRight size={15} />, iconColor: C.label3, strong: false },
}

export const NoticeBanner = memo(function NoticeBanner({ variant, text }: { variant: BannerVariant; text: string }) {
  const n = NOTICE[variant]
  if (n.kind === 'record') return <RecordLine icon={<History size={12} style={{ flexShrink: 0 }} />}>{text}</RecordLine>
  return (
    <NoticeLine icon={n.icon} iconColor={n.iconColor} strong={n.strong}>
      {text}
    </NoticeLine>
  )
})

/** provider 명령의 공통 진행 알림. 명령 이름을 보지 않고 상태·문구만 렌더한다. */
export const CommandOperationBanner = memo(function CommandOperationBanner({ state, text }: { state: 'started' | 'completed' | 'failed'; text: string }) {
  const icon =
    state === 'started' ? <Spinner size={13} thickness={2} color={C.label3} track={C.sep} /> : state === 'completed' ? <Check size={15} /> : <X size={15} />
  const color = state === 'completed' ? C.ok : state === 'failed' ? C.del : C.label3
  return (
    <NoticeLine icon={icon} iconColor={color} strong={state === 'failed'}>
      {text}
    </NoticeLine>
  )
})

// 인증 만료 알림 — 본문 + '재인증'(원격 재로그인 창 열기). 사용자가 지나치면 안 되므로 경고와 같은 무게다.
//   8h: 그 서비스에 다시 로그인할 통로가 없으면 버튼 없이 안내만 남긴다(눌러도 안 되는 버튼을 그리지 않는다).
export const AuthExpiredBanner = memo(function AuthExpiredBanner({ text, onReauth }: { text: string; onReauth?: () => void }) {
  const t = useT()
  return (
    <NoticeLine icon={<KeyRound size={15} />} iconColor={C.attn} strong action={onReauth && <LineAction onClick={onReauth}>{t('stream.authExpired.reauth')}</LineAction>}>
      {text}
    </NoticeLine>
  )
})
