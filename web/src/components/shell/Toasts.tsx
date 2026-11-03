// 떠 있는 알림 — 화면 위 가운데, 상단바 바로 아래에 잠깐 뜬다. 오류(s.error)와 일반 알림(s.notice) 두 가지.
//   예전 오류 알림은 화면 아래 20px에 반투명 빨강 면으로 떠서, 바닥에 뜬 입력창과 겹치면 글자가 비쳐 안 보였다.
//   apple-design 기준으로 다시 짰다: 불투명한 판, 색은 앞 아이콘에만, 들어온 방향(위)으로 나간다.
//   표시 시간은 사용자가 정했다 — 일반 6초, 오류 30초. 마우스를 올리거나 키보드 초점이 안에 있으면 멈춘다.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleAlert, Info, X } from 'lucide-react'
import { actions, useStore } from '../../lib/store'
import { useT } from '../../lib/i18n'
import { IconButton } from '../ui'
import { topBarInset } from '../topBarInset'
import { onCopyMenu } from '../contextMenuFor'
import { C, MS, Z } from '../../design/tokens'

const SHOW_MS = { notice: 6_000, error: 30_000 } as const
/** 실행 취소처럼 눌러야 하는 버튼이 달린 알림은 더 오래 둔다. */
const ACTION_SHOW_MS = 8_000
/** 나가는 움직임 길이 — index.css의 toast-out(--dur-out)과 같다. */
const LEAVE_MS = MS.out
/** 찾기 막대가 열려 있으면 그 아래로 내려 앉는다(막대 높이 약 50 + 틈 8). */
const FIND_BAR_CLEARANCE = 58

export function Toasts() {
  const s = useStore()
  if (!s.error && !s.notice) return null
  return (
    <div
      style={{
        position: 'fixed',
        top: `calc(${topBarInset(s.isNarrow)} + ${8 + (s.findOpen ? FIND_BAR_CLEARANCE : 0)}px)`,
        left: 'max(12px, env(safe-area-inset-left))',
        right: 'max(12px, env(safe-area-inset-right))',
        zIndex: Z.root.toast,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        // 알림 사이 빈 곳은 아래 화면을 누를 수 있게 둔다.
        pointerEvents: 'none',
      }}
    >
      {/* key = 글. 같은 자리에 다른 글이 오면 새 알림으로 다시 떠서 시간도 처음부터 잰다.
          같은 글이 다시 오면 key가 같다. 그 경우는 seq를 보고 Toast가 스스로 판단한다. */}
      {s.error && (
        <Toast key={`e:${s.error}`} kind="error" seq={s.errorSeq} icon={<CircleAlert size={18} />} iconColor={C.del} title={s.error} onDone={actions.clearError} />
      )}
      {s.notice && (
        <Toast
          key={`n:${s.notice.action ? `${s.noticeSeq}:` : ''}${s.notice.title}\n${s.notice.message ?? ''}`}
          kind="notice"
          seq={s.noticeSeq}
          icon={s.notice.icon ? <s.notice.icon size={18} /> : <Info size={18} />}
          iconColor={C.label3}
          title={s.notice.title}
          message={s.notice.message}
          action={s.notice.action}
          onDone={actions.clearNotice}
        />
      )}
    </div>
  )
}

function Toast({ kind, seq, icon, iconColor, title, message, action, onDone }: {
  kind: keyof typeof SHOW_MS
  /** 같은 글이 다시 들어올 때마다 바뀌는 번호 */
  seq: number
  icon: ReactNode
  iconColor: string
  title: string
  message?: string
  action?: { label: string; onClick: () => void }
  onDone: () => void
}) {
  const t = useT()
  // 우클릭 메뉴(문구 복사)가 떠 있는 동안은 저절로 사라지지 않는다. 메뉴를 닫으면 남은 시간부터 다시 센다.
  const menuOpen = useStore().contextMenu != null
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const [leaving, setLeaving] = useState(false)
  // 남은 시간. 멈췄다 다시 갈 때 처음부터가 아니라 남은 만큼만 기다린다.
  const showMs = action ? ACTION_SHOW_MS : SHOW_MS[kind]
  const remaining = useRef<number>(showMs)

  // 떠나는 도중 같은 글이 다시 오면 새 알림처럼 다시 내려온다. 시간은 떠날 때 처음 값으로 돌려 두었다.
  //   떠 있는 동안 같은 글이 다시 오는 경우는 건드리지 않는다 — 시계는 그대로 간다.
  const [seenSeq, setSeenSeq] = useState(seq)
  if (seq !== seenSeq) {
    setSeenSeq(seq)
    if (leaving) setLeaving(false)
  }

  useEffect(() => {
    if (hover || focus || leaving || menuOpen) return
    const started = Date.now()
    const id = window.setTimeout(() => setLeaving(true), remaining.current)
    return () => {
      window.clearTimeout(id)
      remaining.current = Math.max(0, remaining.current - (Date.now() - started))
    }
  }, [hover, focus, leaving, menuOpen])

  useEffect(() => {
    if (!leaving) return
    // 떠나는 도중 되살아날 수 있다. 그때 시간을 처음부터 재도록 미리 돌려 둔다.
    //   위 효과의 정리 함수가 먼저 돌아 남은 시간을 줄여 둔 뒤라서 여기서 덮어써도 된다.
    remaining.current = showMs
    // animationend를 기다리지 않는다 — '움직임 줄이기'면 애니메이션이 꺼져 그 사건이 오지 않는다.
    const id = window.setTimeout(onDone, LEAVE_MS)
    return () => window.clearTimeout(id)
  }, [leaving, onDone, showMs])

  return (
    <div
      // 오류는 곧바로 읽어 주고, 일반 알림은 하던 말을 끝낸 뒤 읽어 준다.
      role={kind === 'error' ? 'alert' : 'status'}
      className={`popover-surface ${leaving ? 'toast-out' : 'toast-in'}`}
      onContextMenu={onCopyMenu(message ? `${title}\n${message}` : title, t('menu.copyText'))}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false)
      }}
      style={{
        pointerEvents: 'auto',
        width: 'fit-content',
        maxWidth: 'min(440px, 100%)',
        minHeight: 44,
        // 한 줄이면 캡슐, 두 줄 이상이면 둥근 판이 된다.
        borderRadius: 22,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 6px 6px 14px',
      }}
    >
      <span className="inline-flex" style={{ color: iconColor, flexShrink: 0 }}>
        {icon}
      </span>
      <span className="min-w-0 flex-1" style={{ padding: '4px 0' }}>
        <span
          title={title}
          style={{
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: kind === 'error' ? 3 : 2,
            overflow: 'hidden',
            fontSize: 14,
            lineHeight: 1.4,
            fontWeight: message ? 600 : 500,
            color: C.label,
            overflowWrap: 'anywhere',
          }}
        >
          {title}
        </span>
        {message && (
          <span style={{ display: 'block', marginTop: 1, fontSize: 13, lineHeight: 1.4, color: C.label2 }}>{message}</span>
        )}
      </span>
      {action && (
        <button
          type="button"
          className="press hit-44"
          // 초점을 가져오지 않는다 — 눌러야 키보드·낭독기 초점이 이 버튼으로 온다.
          onClick={() => { action.onClick(); setLeaving(true) }}
          style={{
            flexShrink: 0,
            minHeight: 32,
            padding: '0 10px',
            border: 'none',
            background: 'transparent',
            borderRadius: 16,
            fontSize: 14,
            fontWeight: 600,
            color: C.tint,
            cursor: 'pointer',
          }}
        >
          {action.label}
        </button>
      )}
      <IconButton label={t('common.close')} onClick={() => setLeaving(true)} size={32} color={C.label3} lift={false} className="press icon-ghost hit-44">
        <X size={15} />
      </IconButton>
    </div>
  )
}
