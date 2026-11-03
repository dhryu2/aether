/**
 * 사용자의 결정을 기다리는 카드의 껍데기 — 권한 카드·질문 카드·계획 카드가 함께 쓴다.
 *
 * 세 카드는 바깥 면·머리·'해결됨' 줄이 같다. 그래서 그 세 부분만 여기로 모았다.
 * 본문(diff·명령 미리보기 / 선택지 목록 / 계획 글)은 서로 전혀 다르므로 각 카드가 그대로 갖고 있다 — 억지로 합치면
 * 조건 분기만 늘어난다.
 *
 * 재설계 4단계: 카드는 내용이라 유리가 아니라 불투명한 면이다. 강조색 테두리·머리 그라데이션·
 * 끝없이 숨쉬는 번짐을 지웠다. 기다림은 머리의 주황 아이콘 타일이 알린다(목록·종 알림과 같은 색). 카드는 안쪽 여백
 * 18(폰 16)에 자식을 14 간격으로 쌓는다 — 자식은 자기 바깥 여백을 갖지 않는다.
 */
import { useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { C, R, alpha } from '../../design/tokens'
import { useStore } from '../../lib/store'
import { IconTile } from '../ui'

/**
 * 결정이 어떻게 났는지 — 결정되는 순간 바깥으로 퍼지는 고리의 색이다.
 * 승인은 초록, 거부·취소는 빨강, 답변·수정 요청은 파랑이다. 기다리는 동안의 주황과 다른 색이어야
 * "방금 무슨 일이 일어났다"가 읽힌다(index.css card-settle 주석).
 */
export type ActionResult = 'allow' | 'deny' | 'answer' | 'revise'
const RESULT_RING: Record<ActionResult, string> = {
  allow: alpha.ok(0.55),
  deny: alpha.del(0.5),
  answer: alpha.tint(0.55),
  revise: alpha.tint(0.55),
}

/** 카드 바깥 면. 등장할 때 한 번 떠오르고(card-in), 결정되는 순간 결과 색 고리가 한 번 퍼진다(card-settle). */
export function ActionCard({ pending, result, className, children }: { pending: boolean; result: ActionResult; className?: string; children: ReactNode }) {
  const narrow = useStore().isNarrow
  // 결정되는 순간을 화면에서 실제로 본 카드만 한 번 움직인다(card-settle).
  //   과거 대화를 다시 불러올 때 지난 카드들은 처음부터 결정된 채로 태어나므로 아무 일도 일어나지 않는다.
  //   이 구분이 없으면 세션을 열 때마다 지난 카드가 전부 한꺼번에 번쩍인다.
  //   판정은 "이전 prop과 비교해 렌더 중에 상태를 고친다"는 React 공식 패턴을 쓴다(effect가 아니다 —
  //   effect로 하면 한 프레임 늦게 시작해 애니메이션 앞머리가 잘린다).
  const [wasPending, setWasPending] = useState(pending)
  const [settled, setSettled] = useState(false)
  if (wasPending !== pending) {
    setWasPending(pending)
    if (wasPending) setSettled(true)
  }

  const style = {
    borderRadius: narrow ? R.card : R.cardLg,
    padding: narrow ? 16 : 18,
    gap: 14,
    // 결정되는 순간 바깥으로 퍼지는 고리의 색.
    '--settle-ring': RESULT_RING[result],
  } as CSSProperties

  const motion = pending ? ' card-in' : settled ? ' card-settle' : ''
  return (
    <div className={'action-card self-stretch flex flex-col' + motion + (className ? ` ${className}` : '')} style={style}>
      {children}
    </div>
  )
}

/**
 * 카드 머리 — 아이콘 타일 + 호출부가 넣는 내용(제목 블록, 오른쪽 수치 등).
 * 답을 기다리는 동안 타일은 주황(기다림), 끝난 뒤에는 회색이다.
 */
export function ActionCardHeader({ pending, icon, children }: { pending: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center" style={{ gap: 12 }}>
      <IconTile size={32} radius={9} background={pending ? C.attnSoft : C.fill} color={pending ? C.attn : C.label3}>
        {icon}
      </IconTile>
      {children}
    </div>
  )
}

/** 카드 제목 블록 — 제목(16) + 아래 한 줄(12.5). 아래 줄이 경로·도구 이름처럼 기계 문자열이면 mono. */
export function ActionCardTitle({ title, sub, subMono, subTitle }: { title: ReactNode; sub?: ReactNode; subMono?: boolean; subTitle?: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div style={{ fontSize: 16, fontWeight: 600, color: C.label, letterSpacing: '-0.01em' }}>{title}</div>
      {sub != null && sub !== '' && (
        <div className={subMono ? 'font-mono truncate' : 'truncate'} style={{ fontSize: subMono ? 12 : 12.5, color: C.label2, marginTop: 1 }} title={subTitle}>
          {sub}
        </div>
      )}
    </div>
  )
}

/**
 * 이미 답한 카드의 맨 아래 결과 줄(허용됨/거부됨/답변함) — 색 띠가 아니라 색 글자 한 줄이다(기호 ✓·✕는 문구에 있다).
 * ⚠️ 이 줄은 카드의 맨 마지막 자식이어야 한다. 결정 순간 아래에서 밀고 올라오는 움직임(index.css settle-in)이
 * 카드의 마지막 자식을 고른다.
 */
export function ActionCardFooter({ color, children }: { color: string; children: ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 500, color, minWidth: 0 }}>{children}</div>
}

/** 카드 맨 아래 버튼 줄. 폰은 폭을 나눠 채우고, 컴퓨터는 오른쪽에 모은다. */
export function ActionCardActions({ narrow, children, divRef }: { narrow: boolean; children: ReactNode; divRef?: Ref<HTMLDivElement> }) {
  return (
    <div ref={divRef} className="flex items-center" style={{ gap: 10, justifyContent: narrow ? 'stretch' : 'flex-end', flexWrap: 'wrap' }}>
      {children}
    </div>
  )
}
