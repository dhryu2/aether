// 작업 삭제·초기화·복사본 버리기 확인. Esc·막 클릭 = 취소. 여는 순간 초점 = 취소.
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { actions, useStore } from '../lib/store'
import { sessionWorkTitle } from '../lib/workTitle'
import { relTime } from '../lib/format'
import { useT } from '../lib/i18n'
import { C, Z } from '../design/tokens'
import { AlertDialogBody, ModalCard, ModalShell } from './ui'

export function DeleteConfirmModal() {
  const s = useStore()
  const t = useT()
  const target = s.deleteTarget
  const isReset = s.deleteMode === 'reset'
  const isDiscard = s.deleteMode === 'discard'
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setError('')
    setBusy(false)
  }, [target])

  if (!target) return null
  const name = sessionWorkTitle(target, t('nav.session.untitled'))
  const rel = relTime(target.createdAt)
  const isDelete = !isReset && !isDiscard
  const confirm = async (purge = false) => {
    if (busy) return
    setBusy(true)
    setError('')
    const r = isReset
      ? await actions.resetSession(target.id)
      : isDiscard
        ? await actions.discardWorkspace(target.id, true)
        : await actions.deleteSession(target.id, purge)
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      return
    }
    actions.cancelDelete()
  }
  const base = isDiscard
    ? t('session.delete.discardMsg')
    : isReset
      ? t('session.delete.resetMsg')
      : t('session.delete.deleteMsg')
  const message = rel ? `${base} ${t('session.delete.activityAgo', { rel })}` : base
  const failKey = isDiscard
    ? 'session.delete.discardFailed'
    : isReset
      ? 'session.delete.resetFailed'
      : 'session.delete.deleteFailed'

  return (
    <ModalShell onClose={actions.cancelDelete} zIndex={Z.root.deleteConfirm} initialFocusRef={cancelRef}>
      <ModalCard variant="alert" data-window="delete">
        <AlertDialogBody
          tone={isReset || isDelete ? 'warn' : 'danger'}
          title={
            isDiscard
              ? t('session.delete.askDiscard', { name })
              : isReset
                ? t('session.delete.askReset', { name })
                : t('session.delete.askDelete', { name })
          }
          message={message}
          extra={
            <>
              {target.isolated && target.needsApply && !error && (
                <div className="flex items-start" style={{ gap: 6, marginTop: 10, fontSize: 13, lineHeight: 1.45, color: C.attn }}>
                  <AlertTriangle size={14} style={{ color: C.attn, flexShrink: 0, marginTop: 2 }} />
                  <span>{t('session.delete.copyDirty')}</span>
                </div>
              )}
              {isDelete && (
                <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.45, color: C.label2 }}>
                  <div>{t('session.delete.keepRecordHint')}</div>
                  <div style={{ marginTop: 4, color: C.del }}>{t('session.delete.purgeHint')}</div>
                </div>
              )}
              {error && (
                <div role="alert" data-session-opt="delete-error" style={{ marginTop: 10, fontSize: 13, lineHeight: 1.45, color: C.del }}>
                  {t(failKey, { error })}
                </div>
              )}
            </>
          }
          confirmLabel={isDiscard ? t('session.delete.discardConfirm') : isReset ? t('session.delete.resetConfirm') : t('session.delete.keepRecordConfirm')}
          secondary={isDelete ? { label: t('session.delete.purgeConfirm'), onClick: () => void confirm(true) } : undefined}
          cancelLabel={t('common.cancel')}
          onConfirm={() => void confirm()}
          onCancel={actions.cancelDelete}
          safeRef={cancelRef}
        />
      </ModalCard>
    </ModalShell>
  )
}
