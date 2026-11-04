// 설정 > 계정과 보안의 「보안」 묶음. 비밀번호 로그인 모드일 때만 보인다(서버가 알려 준 로그인 방식으로 판단).
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { api } from '../../lib/api'
import { setClientToken } from '../../lib/clientAuth'
import { useT } from '../../lib/i18n'
import { validatePasswordForm, type PasswordField, type PasswordFormError } from '../../lib/passwordForm'
import { C, R } from '../../design/tokens'
import { Button, EmptyState } from '../ui'
import { errMsg } from '../../lib/errors'
import { actions, getState } from '../../lib/store'
import { Group, GroupNote, GroupTitle, Sep, SkeletonRows, TextRow } from './parts'
import { rowMin, useNarrow, useReloginProviders } from './settingsLayout'

const FIELDS: readonly { field: PasswordField; label: string; autoComplete: string }[] = [
  { field: 'current', label: 'settings.password.current', autoComplete: 'current-password' },
  { field: 'next', label: 'settings.password.next', autoComplete: 'new-password' },
  { field: 'confirm', label: 'settings.password.confirm', autoComplete: 'new-password' },
]

export function PasswordSection() {
  const t = useT()
  const narrow = useNarrow()
  const id = useId()
  const [mode, setMode] = useState<'loading' | 'hidden' | 'password' | 'failed'>('loading')
  const [values, setValues] = useState<Record<PasswordField, string>>({ current: '', next: '', confirm: '' })
  const [error, setError] = useState<{ field: PasswordField; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const relogin = useReloginProviders()
  const refs = useRef<Record<PasswordField, HTMLInputElement | null>>({ current: null, next: null, confirm: null })

  useEffect(() => {
    let alive = true
    api.systemInfo().then((r) => alive && setMode(r.authMode === 'password' ? 'password' : 'hidden'), () => alive && setMode('failed'))
    return () => { alive = false }
  }, [])
  // 비밀번호 로그인도 아니고 다시 로그인할 서비스도 없으면 칸이 텅 비므로 안내 한 줄을 둔다.
  if (mode === 'hidden') return relogin.length > 0 ? null : <EmptyState title={t('settings.account.empty')} color={C.label2} />
  if (mode === 'loading') {
    return (
      <section>
        <GroupTitle>{t('settings.section.security')}</GroupTitle>
        <SkeletonRows count={3} />
      </section>
    )
  }
  if (mode === 'failed') {
    return (
      <section>
        <GroupTitle>{t('settings.section.security')}</GroupTitle>
        <GroupNote>{t('settings.info.failed')}</GroupNote>
      </section>
    )
  }

  const fail = (field: PasswordField, text: string) => {
    setError({ field, text })
    refs.current[field]?.focus()
  }

  const requestLogout = () => actions.showConfirm({
    tone: 'neutral',
    title: t('settings.logout.confirm.title'),
    message: t('settings.logout.confirm.body'),
    confirmLabel: t('settings.logout.action'),
    onConfirm: () => void (async () => {
      try {
        // 로그아웃한 기기로 알림이 계속 가지 않게, 로그인이 살아 있을 때 구독부터 지운다.
        if (getState().pushEnabled) await actions.disablePush()
        await api.logout()
        setClientToken(undefined)
        window.location.reload()
      } catch (e) {
        actions.showError(errMsg(e))
      }
    })(),
  })

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setDone(false)
    const bad: PasswordFormError | null = validatePasswordForm(values)
    if (bad) return fail(bad.field, t(`settings.password.err.${bad.code}`))
    setError(null)
    setBusy(true)
    try {
      const r = await api.changePassword(values.current, values.next)
      setClientToken(r.token)
      void actions.refreshPushState() // 새 로그인 자격으로 이 기기의 알림 구독을 다시 등록
      setValues({ current: '', next: '', confirm: '' })
      setDone(true)
    } catch (err) {
      const status = (err as { status?: number } | null)?.status
      if (status === 403) fail('current', t('settings.password.err.wrong'))
      else if (status === 429) fail('current', t('settings.password.err.locked'))
      else fail('current', t('settings.password.err.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <GroupTitle>{t('settings.section.security')}</GroupTitle>
      <form onSubmit={onSubmit} noValidate>
        <Group>
          {FIELDS.map(({ field, label, autoComplete }, i) => {
            const invalid = error?.field === field
            return (
              <div key={field}>
                {i > 0 && <Sep />}
                <label style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '0 16px' }}>
                  <span style={{ flexShrink: 0, width: narrow ? 120 : 140, fontSize: 15, color: C.label }}>{t(label)}</span>
                  <input
                    ref={(el) => { refs.current[field] = el }}
                    type="password"
                    name={field === 'current' ? 'current-password' : 'new-password'}
                    autoComplete={autoComplete}
                    value={values[field]}
                    onChange={(ev) => setValues((v) => ({ ...v, [field]: ev.target.value }))}
                    aria-invalid={invalid || undefined}
                    aria-describedby={[field === 'next' && `${id}-note`, invalid && `${id}-error`].filter(Boolean).join(' ') || undefined}
                    style={{ flex: 1, minWidth: 0, height: 36, border: 'none', borderRadius: R.field, background: 'transparent', fontSize: 15, fontFamily: 'inherit', color: C.label, textAlign: 'right' }}
                  />
                </label>
              </div>
            )
          })}
        </Group>
        {error && (
          <p id={`${id}-error`} role="alert" style={{ margin: '8px 0 0', padding: '0 16px', fontSize: 13, color: C.del }}>{error.text}</p>
        )}
        <p role="status" style={{ margin: done ? '8px 0 0' : 0, padding: '0 16px', fontSize: 13, color: C.label2 }}>{done ? t('settings.password.done') : ''}</p>
        <div style={{ padding: '12px 16px 0' }}>
          <Button type="submit" tone="primary" fullWidth disabled={busy}>
            {busy ? t('settings.password.busy') : t('settings.password.submit')}
          </Button>
        </div>
      </form>
      <p id={`${id}-note`} style={{ fontSize: 13, color: C.label2, lineHeight: 1.45, margin: '8px 0 0', padding: '0 16px' }}>{t('settings.password.note')}</p>
      <GroupNote><span style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>{t('settings.password.forgot')}</span></GroupNote>
      <div style={{ marginTop: 24 }}>
        <Group>
          <TextRow onClick={requestLogout}>{t('settings.logout.action')}</TextRow>
        </Group>
        <GroupNote>{t('settings.logout.note')}</GroupNote>
      </div>
    </section>
  )
}
