// 설정 > 서버 정보의 「폰에서 쓰기」. 서버가 tailscale serve로 HTTPS 주소를 열고 닫는다.
// 이 기능을 쓸 수 없는 서버(비밀번호 로그인이 아니거나 옛 버전)에서는 묶음째 보이지 않는다.
import { useCallback, useEffect, useState } from 'react'
import type { RemoteAccessResponse } from '@shared/http'
import { ExternalLink } from 'lucide-react'
import { api } from '../../lib/api'
import { errMsg } from '../../lib/errors'
import { useT } from '../../lib/i18n'
import { actions } from '../../lib/store'
import { safeHttpUrl } from '../../lib/updateNotice'
import { C } from '../../design/tokens'
import { Button } from '../ui'
import { Group, GroupNote, GroupTitle, Sep, StackRow, TextRow } from './parts'
import { rowMin, useNarrow } from './settingsLayout'

const DOWNLOAD_URL = 'https://tailscale.com/download'
const POLL_MS = 3000

export function RemoteAccessSection() {
  const t = useT()
  const narrow = useNarrow()
  const [remote, setRemote] = useState<RemoteAccessResponse | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    api.remoteAccess().then((r) => alive && setRemote(r), () => undefined)
    return () => { alive = false }
  }, [])
  // 허용 페이지는 다른 곳에서 끝나므로, 기다리는 동안만 결과를 다시 본다.
  const consent = remote?.state === 'consent'
  useEffect(() => {
    if (!consent) return
    const timer = setInterval(() => { api.remoteAccess().then(setRemote, () => undefined) }, POLL_MS)
    return () => clearInterval(timer)
  }, [consent])
  const act = useCallback(async (call: () => Promise<RemoteAccessResponse>) => {
    setBusy(true)
    try { setRemote(await call()) } catch (e) { actions.showError(errMsg(e)) } finally { setBusy(false) }
  }, [])
  if (!remote || remote.state === 'unsupported') return null

  const open = (url: string) => window.open(url, '_blank', 'noopener,noreferrer')
  const requestOff = () => actions.showConfirm({
    tone: 'warn',
    title: t('settings.remote.confirm.title'),
    message: t('settings.remote.confirm.body'),
    confirmLabel: t('settings.remote.turnOff'),
    onConfirm: () => void act(api.disableRemoteAccess),
  })
  const view = {
    off: { value: t('settings.remote.off'), label: t('settings.remote.turnOn'), run: () => void act(api.enableRemoteAccess), primary: true, note: t('settings.remote.note.off') },
    on: { value: t('settings.remote.on'), label: t('settings.remote.turnOff'), run: requestOff, primary: false, note: t('settings.remote.note.on') },
    consent: { value: t('settings.remote.waiting'), label: t('settings.remote.cancel'), run: () => void act(api.disableRemoteAccess), primary: false, note: t('settings.remote.note.waiting') },
    noTailscale: { value: t('settings.remote.noTailscale'), label: t('settings.remote.recheck'), run: () => void act(api.remoteAccess), primary: false, note: t('settings.remote.note.noTailscale') },
    offline: { value: t('settings.remote.offline'), label: t('settings.remote.recheck'), run: () => void act(api.remoteAccess), primary: false, note: t('settings.remote.note.offline') },
    conflict: { value: t('settings.remote.conflict'), label: t('settings.remote.recheck'), run: () => void act(api.remoteAccess), primary: false, note: t('settings.remote.note.conflict') },
  }[remote.state]
  const consentLink = safeHttpUrl(remote.consentUrl)

  return (
    <section style={{ marginTop: 24 }}>
      <GroupTitle>{t('settings.remote.title')}</GroupTitle>
      <Group>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '4px 16px' }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{t('settings.remote.row')}</span>
          <span role="status" style={{ fontSize: 15, color: C.label2 }}>{view.value}</span>
          <Button type="button" tone={view.primary ? 'primary' : 'gray'} height={narrow ? 44 : 32} paddingX={14} fontSize={14} disabled={busy} onClick={view.run}>{view.label}</Button>
        </div>
        {remote.url && (
          <>
            <Sep />
            <StackRow label={t('settings.remote.url')} value={<a href={remote.url} target="_blank" rel="noopener noreferrer" style={{ color: C.tint }}>{remote.url}</a>} copy={remote.url} />
          </>
        )}
        {consentLink && (
          <>
            <Sep />
            <TextRow onClick={() => open(consentLink)}>
              {t('settings.remote.consent')}
              <ExternalLink size={16} aria-hidden color={C.label3} />
            </TextRow>
          </>
        )}
        {remote.state === 'noTailscale' && (
          <>
            <Sep />
            <TextRow onClick={() => open(DOWNLOAD_URL)}>
              {t('settings.remote.download')}
              <ExternalLink size={16} aria-hidden color={C.label3} />
            </TextRow>
          </>
        )}
        {remote.error && (
          <>
            <Sep />
            <StackRow label={t('settings.remote.manual')} value={<span style={{ fontVariantLigatures: 'none' }}>{remote.command}</span>} copy={remote.command} />
          </>
        )}
      </Group>
      {remote.error && <GroupNote><span style={{ color: C.attn }}>{t('settings.remote.error', { detail: remote.error })}</span></GroupNote>}
      <GroupNote>{view.note}</GroupNote>
    </section>
  )
}
