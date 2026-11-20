// 설정 > 계정과 보안의 「로그인한 기기」 묶음. 비밀번호 로그인 모드일 때만 보인다(PasswordSection과 같은 판단).
import { useEffect, useState } from 'react'
import type { AuthDevice } from '@shared/http'
import { api } from '../../lib/api'
import { setClientToken } from '../../lib/clientAuth'
import { deviceLabel } from '../../lib/deviceLabel'
import { errMsg } from '../../lib/errors'
import { fmtMonthDay, relTime } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { actions } from '../../lib/store'
import { C } from '../../design/tokens'
import { Button, Notice, NOTICE_TONE } from '../ui'
import { Group, GroupNote, GroupTitle, Sep, SkeletonRows } from './parts'
import { rowMin, useNarrow } from './settingsLayout'

type View = { phase: 'loading' } | { phase: 'hidden' } | { phase: 'failed' } | { phase: 'ready'; devices: AuthDevice[] }

export function DevicesSection() {
  const t = useT()
  const narrow = useNarrow()
  const [view, setView] = useState<View>({ phase: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    api.systemInfo()
      .then((r) => (r.authMode === 'password' ? api.authDevices().then((d) => ({ phase: 'ready', devices: d.devices }) as View) : ({ phase: 'hidden' }) as View))
      .then((v) => alive && setView(v), () => alive && setView({ phase: 'failed' }))
    return () => { alive = false }
  }, [attempt])

  if (view.phase === 'hidden') return null
  if (view.phase === 'loading') {
    return (
      <section style={{ marginTop: 24 }}>
        <GroupTitle>{t('settings.devices.title')}</GroupTitle>
        <SkeletonRows count={2} />
      </section>
    )
  }
  if (view.phase === 'failed') {
    return (
      <section style={{ marginTop: 24 }}>
        <GroupTitle>{t('settings.devices.title')}</GroupTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <Notice {...NOTICE_TONE.warn} fontSize={13} style={{ alignSelf: 'stretch' }}>{t('settings.devices.failed')}</Notice>
          <Button height={44} onClick={() => { setView({ phase: 'loading' }); setAttempt((n) => n + 1) }}>{t('settings.devices.retry')}</Button>
        </div>
      </section>
    )
  }

  const { devices } = view
  const name = (d: AuthDevice) => deviceLabel(d.userAgent) ?? t('settings.devices.unknown')
  const reload = () => api.authDevices().then((r) => setView({ phase: 'ready', devices: r.devices }), () => setView({ phase: 'failed' }))

  const signOut = (d: AuthDevice) => actions.showConfirm({
    tone: 'neutral',
    title: name(d),
    message: t('settings.devices.confirm.one', { device: name(d) }),
    confirmLabel: t('settings.devices.signOut'),
    onConfirm: () => void api.signOutDevice(d.id).then(reload, (e) => actions.showError(errMsg(e))),
  })
  const signOutOthers = () => actions.showConfirm({
    tone: 'danger',
    title: t('settings.devices.confirm.allTitle'),
    message: t('settings.devices.confirm.allBody'),
    confirmLabel: t('settings.devices.confirm.allAction'),
    onConfirm: () => void api.signOutOtherDevices().then((r) => {
      setClientToken(r.token)
      void actions.refreshPushState() // 세대 값이 바뀌어 이 기기의 알림 구독도 다시 등록해야 한다
      return reload()
    }, (e) => actions.showError(errMsg(e))),
  })

  return (
    <section style={{ marginTop: 24 }}>
      <GroupTitle>{t('settings.devices.title')}</GroupTitle>
      <Group>
        {devices.map((d, i) => {
          const day = fmtMonthDay(d.issuedAt)
          return (
            <div key={d.id}>
              {i > 0 && <Sep />}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '8px 16px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 15, color: C.label }}>
                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{name(d)}</span>
                    {d.current && <span style={{ flexShrink: 0, fontSize: 13, color: C.label2 }}>{t('settings.devices.current')}</span>}
                  </div>
                  <div style={{ marginTop: 2, fontSize: 13, color: C.label2 }}>
                    {d.lastSeenAt ? t('settings.devices.meta', { seen: relTime(d.lastSeenAt), day }) : t('settings.devices.metaNoSeen', { day })}
                  </div>
                </div>
                {!d.current && (
                  <Button type="button" tone="gray" height={narrow ? 44 : 32} paddingX={14} fontSize={14} onClick={() => signOut(d)}>{t('settings.devices.signOut')}</Button>
                )}
              </div>
            </div>
          )
        })}
      </Group>
      <GroupNote>{t('settings.devices.note')}</GroupNote>
      {devices.some((d) => !d.current) && (
        <div style={{ padding: '16px 16px 0' }}>
          <Button type="button" tone="danger" fullWidth height={44} onClick={signOutOthers}>{t('settings.devices.signOutOthers')}</Button>
        </div>
      )}
    </section>
  )
}
