// 설정 > 서버의 「백업」 칸. DB 백업을 만들고, 복원을 예약한다(실제 교체는 다음 서버 시작 때).
// 결과는 토스트가 아니라 칸 안에 남긴다. 종류와 상태는 색이 아니라 글자로 표시한다.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArchiveRestore } from 'lucide-react'
import type { BackupItem, BackupListResponse } from '@shared/http'
import { actions } from '../../lib/store'
import { api } from '../../lib/api'
import { bytes, fmtShortDateTime } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { C } from '../../design/tokens'
import { Button, EmptyState, Notice, NOTICE_TONE, Skeleton } from '../ui'
import { Group, GroupNote, GroupTitle, Sep } from './parts'
import { rowMin, useNarrow } from './settingsLayout'

type State = { phase: 'loading' | 'failed' | 'ready'; data: BackupListResponse | null }
const at = (b: BackupItem) => fmtShortDateTime(Date.parse(b.createdAt))

export function BackupView() {
  const t = useT()
  const narrow = useNarrow()
  const [state, setState] = useState<State>({ phase: 'loading', data: null })
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  // 늦게 도착한 응답을 버리기 위한 번호(req()는 취소 신호를 받지 않는다).
  const seq = useRef(0)

  useEffect(() => {
    const mine = ++seq.current
    api.backups().then(
      (data) => { if (mine === seq.current) setState({ phase: 'ready', data }) },
      () => { if (mine === seq.current) setState({ phase: 'failed', data: null }) },
    )
  }, [attempt])

  const apply = useCallback((data: BackupListResponse) => { ++seq.current; setState({ phase: 'ready', data }) }, [])

  const create = async () => {
    setBusy(true)
    setMessage('')
    try {
      await api.createBackup()
      apply(await api.backups())
      setMessage(t('settings.backup.created'))
    } catch (e) {
      setMessage((e as { status?: number }).status === 409 ? t('settings.backup.busy') : t('settings.backup.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  const askRestore = (b: BackupItem) => {
    actions.showConfirm({
      tone: 'danger',
      icon: ArchiveRestore,
      title: t('settings.backup.confirmTitle'),
      message: t('settings.backup.confirmMsg', { at: at(b) }),
      confirmLabel: t('settings.backup.confirmLabel'),
      onConfirm: async () => {
        setMessage('')
        try {
          apply(await api.scheduleRestore(b.id))
        } catch {
          setMessage(t('settings.backup.scheduleFailed'))
        }
      },
    })
  }

  const cancel = async () => {
    setMessage('')
    try {
      apply(await api.cancelRestore())
    } catch {
      setMessage(t('settings.backup.cancelFailed'))
    }
  }

  const data = state.data
  const pendingItem = data?.pending ? data.items.find((b) => b.id === data.pending!.id) : undefined
  const last = data?.last

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
      <div role="status" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {data?.pending && (
        <Notice {...NOTICE_TONE.info} fontSize={13}>
          <span style={{ flex: 1, minWidth: 0 }}>{t('settings.backup.pending', { at: pendingItem ? at(pendingItem) : data.pending.id })}</span>
          <Button height={44} onClick={cancel} style={{ marginLeft: 12, flexShrink: 0 }}>{t('settings.backup.cancel')}</Button>
        </Notice>
      )}
      {last && (
        <Notice {...(last.ok ? NOTICE_TONE.info : NOTICE_TONE.warn)} fontSize={13}>
          {last.ok ? t('settings.backup.result.ok', { safety: last.safetyId ?? '' }) : t(`settings.backup.result.${last.code ?? 'io'}`)}
        </Notice>
      )}
      </div>

      <section>
        <Button
          tone="primary"
          height={44}
          onClick={create}
          disabled={busy || !!data?.running}
          aria-busy={busy}
          style={{ width: '100%' }}
        >
          {busy ? t('settings.backup.creating') : t('settings.backup.create')}
        </Button>
        <GroupNote>{t('settings.backup.note')}</GroupNote>
        <div role="status" aria-live="polite" style={{ fontSize: 13, color: C.label2, padding: message ? '8px 16px 0' : 0 }}>{message}</div>
      </section>

      {state.phase === 'loading' && (
        <div aria-busy="true">
          <Group>
            {[0, 1, 2].map((i) => (
              <div key={i}>
                {i > 0 && <Sep />}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px' }}>
                  <Skeleton width="60%" height={14} />
                  <Skeleton width="30%" height={12} />
                </div>
              </div>
            ))}
          </Group>
        </div>
      )}

      {state.phase === 'failed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <Notice {...NOTICE_TONE.warn} fontSize={13} style={{ alignSelf: 'stretch' }}>{t('settings.backup.failed')}</Notice>
          <Button height={44} onClick={() => { setState({ phase: 'loading', data: null }); setAttempt((n) => n + 1) }}>{t('settings.backup.retry')}</Button>
        </div>
      )}

      {data && data.items.length === 0 && <EmptyState title={t('settings.backup.empty')} color={C.label2} />}

      {data && data.items.length > 0 && (
        <section>
        <GroupTitle trailing={<span className="tabular-nums" style={{ fontSize: 13, color: C.label3 }}>{t('settings.backup.count', { n: data.items.length })}</span>}>
          {t('settings.backup.listTitle')}
        </GroupTitle>
        <Group>
          {data.items.map((b, i) => (
            <div key={b.id}>
              {i > 0 && <Sep />}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '4px 16px' }}>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 0' }}>
                  <span className="tabular-nums" style={{ fontSize: 15, color: C.label }}>{at(b)}</span>
                  <span className="tabular-nums" style={{ fontSize: 13, color: C.label2 }}>{t(`settings.backup.kind.${b.kind}`)} · {bytes(b.sizeBytes)}</span>
                </span>
                {data.pending?.id === b.id
                  ? <span style={{ fontSize: 13, fontWeight: 600, color: C.tint }}>{t('settings.backup.scheduled')}</span>
                  : <Button tone="gray" height={44} onClick={() => askRestore(b)}>{t('settings.backup.restore')}</Button>}
              </div>
            </div>
          ))}
        </Group>
        </section>
      )}
    </div>
  )
}
