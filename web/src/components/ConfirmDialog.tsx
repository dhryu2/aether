// 범용 확인 창. 스토어(s.dialog)가 열고, 취소와 실행 버튼이 있다.
//   Esc·막 클릭 = 취소. 여는 순간 초점 = 취소. 겹침은 최상위라 다른 창 위에 뜬다.
import { useRef } from 'react'
import { actions, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { Z } from '../design/tokens'
import { AlertDialogBody, ModalCard, ModalShell } from './ui'

export function ConfirmDialog() {
  const s = useStore()
  const t = useT()
  const d = s.dialog
  const safeRef = useRef<HTMLButtonElement>(null)

  if (!d) return null
  const runConfirm = () => {
    const fn = d.onConfirm
    actions.closeDialog()
    fn?.()
  }

  return (
    <ModalShell onClose={actions.closeDialog} zIndex={Z.root.dialog} initialFocusRef={safeRef}>
      <ModalCard variant="alert" data-window="confirm">
        <AlertDialogBody
          tone={d.tone}
          title={d.title}
          message={d.message}
          confirmLabel={d.confirmLabel ?? t('common.confirm')}
          cancelLabel={t('common.cancel')}
          onConfirm={runConfirm}
          onCancel={actions.closeDialog}
          safeRef={safeRef}
          secondary={
            d.secondary && {
              label: d.secondary.label,
              onClick: () => {
                actions.closeDialog()
                d.secondary?.onClick()
              },
            }
          }
        />
      </ModalCard>
    </ModalShell>
  )
}
