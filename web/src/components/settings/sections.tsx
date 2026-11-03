// 설정의 묶음 중 사용량을 뺀 것들. 사용량은 SessionStatus가 그린다.
import { useEffect, useRef, useState } from 'react'
import { Power } from 'lucide-react'
import { actions, useStore } from '../../lib/store'
import { TRANSCRIPT_VIEWS } from '../../lib/transcriptView'
import { api } from '../../lib/api'
import { errMsg } from '../../lib/errors'
import { t, useT, LOCALES, LOCALE_LABELS } from '../../lib/i18n'
import { C } from '../../design/tokens'
import { SegmentedControl, Switch } from '../ui'
import type { AutoResumeSettings } from '@shared/http'
import { Group, GroupNote, GroupTitle, Sep, TextRow } from './parts'
import { rowMin, useNarrow, useReloginProviders } from './settingsLayout'

function hardRefresh() {
  const done = () => location.reload()
  if ('caches' in window) {
    caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).then(done, done)
  } else {
    done()
  }
}

function requestRestart() {
  actions.showConfirm({
    tone: 'danger',
    icon: Power,
    title: t('settings.restart.confirmTitle'),
    message: t('settings.restart.confirmMsg'),
    confirmLabel: t('common.restart'),
    onConfirm: async () => {
      try {
        await api.restartServer()
        actions.closeSettings()
        actions.showNotice({ icon: Power, title: t('settings.restart.requestedTitle'), message: t('settings.restart.requestedMsg') })
      } catch (e) {
        actions.showError(`${t('settings.restart.failTitle')}: ${errMsg(e)}`)
      }
    },
  })
}

function Name({ children }: { children: string }) {
  return <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{children}</span>
}

/**
 * 쉬는 세션 잠재우기 대기 시간. 불러오지 못하면(옛 서버: 404) 비활성이고, 저장하는 동안도 비활성이다.
 * 저장은 서버 응답을 받은 뒤에 화면 값을 바꾸고, 실패하면 오류만 띄운다.
 */
function IdleSleepRow() {
  const t = useT()
  const narrow = useNarrow()
  const [cfg, setCfg] = useState<{ minutes: number; choices: number[] } | undefined>(undefined) // undefined=불러오는 중이거나 실패
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let alive = true
    api.getIdleSleep().then((v) => alive && setCfg(v), () => {})
    return () => { alive = false }
  }, [])
  const save = (next: string) => {
    if (!cfg || saving) return // 키보드로 들어와도 불러오기 전과 저장 중에는 보내지 않는다
    setSaving(true)
    api.putIdleSleep(Number(next)).then(setCfg, (e) => actions.showError(errMsg(e))).finally(() => setSaving(false))
  }
  const pad = narrow ? '0 12px' : '0 10px'
  return (
    <div style={{ marginTop: 24 }}>
      <Group>
        <div
          style={{
            display: 'flex',
            flexDirection: narrow ? 'column' : 'row',
            alignItems: narrow ? 'stretch' : 'center',
            gap: narrow ? 8 : 12,
            minHeight: narrow ? undefined : 44,
            padding: narrow ? '10px 16px' : '0 16px',
            opacity: cfg && !saving ? 1 : 0.5,
            pointerEvents: cfg && !saving ? undefined : 'none',
          }}
        >
          <Name>{t('settings.idleSleep.title')}</Name>
          <SegmentedControl
            size="compact"
            fullWidth={narrow}
            items={[15, 30, 60, 0].map((m) => ({ value: String(m), label: m === 0 ? t('settings.idleSleep.off') : t('settings.idleSleep.minutes', { n: m }) }))}
            value={String(cfg?.minutes ?? '')}
            onChange={save}
            itemPadding={pad}
            itemHeight={narrow ? 44 : 28}
            itemMinWidth={narrow ? 44 : undefined}
          />
        </div>
      </Group>
      <GroupNote>{t('settings.idleSleep.note')}</GroupNote>
    </div>
  )
}

export function GeneralSection({ hideTitle }: { hideTitle?: boolean }) {
  const s = useStore()
  const t = useT()
  const narrow = useNarrow()
  const pad = narrow ? '0 12px' : '0 10px'
  const itemHeight = narrow ? 44 : 28
  return (
    <section>
      {!hideTitle && <GroupTitle>{t('settings.section.general')}</GroupTitle>}
      <Group>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '0 16px' }}>
          <Name>{t('settings.language.title')}</Name>
          <SegmentedControl
            size="compact"
            items={LOCALES.map((loc) => ({ value: loc, label: LOCALE_LABELS[loc] }))}
            value={s.locale}
            onChange={actions.setLocale}
            itemPadding={pad}
            itemHeight={itemHeight}
            itemMinWidth={narrow ? 44 : undefined}
            style={{ flexShrink: 0 }}
          />
        </div>
        <Sep />
        <div
          style={{
            display: 'flex',
            flexDirection: narrow ? 'column' : 'row',
            alignItems: narrow ? 'stretch' : 'center',
            gap: narrow ? 8 : 12,
            minHeight: narrow ? undefined : 44,
            padding: narrow ? '10px 16px' : '0 16px',
          }}
        >
          <Name>{t('settings.view.title')}</Name>
          <SegmentedControl
            size="compact"
            fullWidth={narrow}
            items={TRANSCRIPT_VIEWS.map((v) => ({ value: v, label: t(`session.view.${v}`) }))}
            value={s.transcriptView}
            onChange={actions.setTranscriptView}
            itemPadding={pad}
            itemHeight={itemHeight}
            itemMinWidth={narrow ? 44 : undefined}
          />
        </div>
        <Sep />
        <label style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '0 16px', cursor: 'pointer' }}>
          <span aria-hidden style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{t('settings.limitWarning.title')}</span>
          <Switch
            className={narrow ? 'hit-44' : undefined}
            on={s.limitWarning}
            label={t('settings.limitWarning.title')}
            onChange={() => actions.setLimitWarning(!s.limitWarning)}
          />
        </label>
      </Group>
      <GroupNote>{t('settings.view.note')}</GroupNote>
      <IdleSleepRow />
    </section>
  )
}

/** 자동 재개 설정. 불러오지 못하면(옛 서버: 404) 스위치를 끄고 안내만 보인다. */
export function AutoResumeSection({ hideTitle }: { hideTitle?: boolean }) {
  const t = useT()
  const narrow = useNarrow()
  const [cfg, setCfg] = useState<AutoResumeSettings | null | undefined>(undefined) // undefined=불러오는 중, null=지원 안 함
  const [text, setText] = useState('')
  useEffect(() => {
    let alive = true
    api.getAutoResumeSettings().then(
      (v) => {
        if (!alive) return
        setCfg(v)
        setText(v.text)
      },
      () => alive && setCfg(null),
    )
    return () => { alive = false }
  }, [])
  const save = (patch: { enabled?: boolean; text?: string }) =>
    api.putAutoResumeSettings(patch).then(
      (v) => {
        setCfg(v)
        setText(v.text)
      },
      (e) => actions.showError(errMsg(e)),
    )
  const usable = !!cfg
  return (
    <section>
      {!hideTitle && <GroupTitle>{t('settings.section.autoResume')}</GroupTitle>}
      <Group>
        <label style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '0 16px', cursor: usable ? 'pointer' : 'default' }}>
          <span aria-hidden style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{t('settings.autoResume.enable')}</span>
          <Switch
            className={narrow ? 'hit-44' : undefined}
            on={!!cfg?.enabled}
            disabled={!usable}
            label={t('settings.autoResume.enable')}
            onChange={() => cfg && void save({ enabled: !cfg.enabled })}
          />
        </label>
        <Sep />
        <label style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '0 16px' }}>
          <span style={{ flexShrink: 0, width: narrow ? 90 : 110, fontSize: 15, color: C.label }}>{t('settings.autoResume.text')}</span>
          <input
            type="text"
            maxLength={2000}
            disabled={!usable}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => cfg && text.trim() !== cfg.text && void save({ text: text.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
            style={{ flex: 1, minWidth: 0, height: 36, border: 'none', background: 'transparent', fontSize: 15, fontFamily: 'inherit', color: C.label, textAlign: 'right' }}
          />
        </label>
      </Group>
      <GroupNote>{cfg === null ? t('settings.autoResume.unavailable') : t('settings.autoResume.note')}</GroupNote>
    </section>
  )
}

// 권한 API가 없으면 막힌 것으로 보지 않는다. 접근 자체가 실패해도 설정 화면이 죽지 않게 한다.
function notificationsDenied(): boolean {
  if (typeof Notification === 'undefined') return false
  try {
    return Notification.permission === 'denied'
  } catch {
    // 권한 조회가 차단된 브라우저도 알림 기능 탐지를 계속한다.
    return false
  }
}

export function PushSection({ hideTitle }: { hideTitle?: boolean }) {
  const s = useStore()
  const t = useT()
  const narrow = useNarrow()
  const lock = useRef(false)
  const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window
  const denied = notificationsDenied()
  const available = supported && !!s.vapidPublic && !denied
  const on = s.pushEnabled
  const note = !supported
    ? t('settings.push.unsupported')
    : !s.vapidPublic
      ? t('settings.push.noVapid')
      : denied
        ? t('settings.push.denied')
        : t('settings.push.note')

  function toggle() {
    if (!available || lock.current) return
    lock.current = true
    const job = on ? actions.disablePush() : actions.enablePush()
    void Promise.resolve(job).finally(() => { lock.current = false })
  }

  return (
    <section>
      {!hideTitle && <GroupTitle>{t('settings.section.push')}</GroupTitle>}
      <Group>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            minHeight: rowMin(narrow),
            padding: '0 16px',
            cursor: available ? 'pointer' : 'default',
          }}
        >
          <span aria-hidden style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{t('settings.push.title')}</span>
          <Switch
            className={narrow ? 'hit-44' : undefined}
            on={available && on}
            disabled={!available}
            label={t('settings.push.title')}
            onChange={toggle}
          />
        </label>
      </Group>
      <GroupNote>{note}</GroupNote>
    </section>
  )
}

export function AccountSection() {
  const t = useT()
  const providers = useReloginProviders()
  if (providers.length === 0) return null
  return (
    <section>
      <GroupTitle>{t('settings.section.account')}</GroupTitle>
      <Group>
        {providers.map((p, i) => (
          <div key={p.id}>
            {i > 0 && <Sep />}
            <TextRow providerId={p.id} onClick={() => actions.openProviderAuth(p.id)}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.displayName}</span>
              <span style={{ flexShrink: 0, color: C.tint }}>{t('settings.reauth.action')} ›</span>
            </TextRow>
          </div>
        ))}
      </Group>
      <GroupNote>{t('settings.reauth.note')}</GroupNote>
    </section>
  )
}

export function TroubleSection({ hideTitle }: { hideTitle?: boolean }) {
  const t = useT()
  return (
    <section>
      {!hideTitle && <GroupTitle>{t('settings.section.trouble')}</GroupTitle>}
      <Group>
        <TextRow color={C.tint} onClick={hardRefresh}>{t('settings.refresh.title')}</TextRow>
        <Sep />
        <TextRow color={C.del} onClick={requestRestart}>{t('settings.restart.title')}</TextRow>
      </Group>
      <GroupNote>{t('settings.trouble.note')}</GroupNote>
    </section>
  )
}
