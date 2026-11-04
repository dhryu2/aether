/**
 * 확인 창의 속 — 제목(무슨 일이 일어나는지) + 설명 + (선택)덧붙임 + 취소/실행.
 * 아이콘 타일은 두지 않는다. 취소는 늘 왼쪽이고, 여는 순간 초점을 받는다.
 */
import type { ReactNode, Ref } from 'react'
import { C } from '../../design/tokens'
import { Button } from './Button'
import { useModalFrame } from './useModalFrame'

export type DialogTone = 'danger' | 'warn' | 'neutral'

export function AlertDialogBody({
  tone,
  title,
  message,
  extra,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  safeRef,
  secondary,
}: {
  tone: DialogTone
  title: ReactNode
  message: ReactNode
  /** 설명 아래 한 줄(반영 안 된 변경, 오류). */
  extra?: ReactNode
  confirmLabel: ReactNode
  cancelLabel: ReactNode
  onConfirm: () => void
  onCancel: () => void
  /** 취소 버튼. 여는 순간 초점. */
  safeRef?: Ref<HTMLButtonElement>
  /** 실행 옆의 위험 행동 하나 더(완전 삭제). 좁으면 버튼이 줄을 바꾼다. */
  secondary?: { label: ReactNode; onClick: () => void }
}) {
  const { titleId, descId } = useModalFrame()
  return (
    <div>
      <h2 id={titleId} style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.35, color: C.label }}>
        {title}
      </h2>
      <p id={descId} style={{ margin: '8px 0 0', fontSize: 15, color: C.label2, lineHeight: 1.5, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
        {message}
      </p>
      {extra}
      <div className="flex" style={{ gap: 10, marginTop: 18, flexWrap: secondary ? 'wrap' : undefined }}>
        <Button ref={safeRef} tone="gray" grow height={44} fontSize={secondary ? 13 : 15} onClick={onCancel} style={secondary ? { whiteSpace: 'nowrap' } : undefined}>
          {cancelLabel}
        </Button>
        <Button tone={tone === 'neutral' ? 'primary' : tone} grow height={44} fontSize={secondary ? 13 : 15} onClick={onConfirm} style={secondary ? { whiteSpace: 'nowrap' } : undefined}>
          {confirmLabel}
        </Button>
        {secondary && (
          <Button tone="danger" grow height={44} fontSize={secondary ? 13 : 15} onClick={secondary.onClick} style={{ whiteSpace: 'nowrap' }}>
            {secondary.label}
          </Button>
        )}
      </div>
    </div>
  )
}
