/**
 * 첫 설정 화면. health.setup이 true일 때만 AuthGate가 그린다(이때 보호 REST와 store 초기화는 부르지 않는다).
 * 세 단계: 1 비밀번호 → 2 작업 환경(작업 폴더, AI 준비 상태, 고급 설정) → 3 확인과 동의(사용 조건) → 시작하기.
 * 단계는 이 컴포넌트의 상태이고 입력값은 단계를 오가도 남는다. 저장은 마지막에 한 번만 한다.
 * 저장하면 설정 서버가 끝나고 진짜 서버로 바뀐다. 그 기다림은 SetupWait가 맡는다.
 */
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { ChevronRight, ExternalLink, Eye, EyeOff, Folder } from 'lucide-react'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { useMediaQuery } from '../../lib/hooks'
import { actions, getState } from '../../lib/store'
import type { AvailabilityState } from '../../lib/newSessionProviders'
import type { ProviderInfo } from '../../lib/types'
import {
  issueFromServerCode, needsAdvancedOpen, saveFailureNext, SETUP_STEP_COUNT, stepForIssues, stepOfField, toSetupBody,
  validateSetupForm, validateSetupStep,
  type SetupField, type SetupFormValues, type SetupIssue, type SetupStep,
} from '../../lib/setupForm'
import { C, R } from '../../design/tokens'
import { ChamdingMascot } from '../ChamdingMascot'
import { Toasts } from '../shell/Toasts'
import { Button, IconButton, Spinner } from '../ui'
import { AiStatus, ConsentList, FIELD_H, Section, TextField } from './SetupFields'
import { probeHealth, SetupWait } from './SetupWait'

type Defaults = { port: number; dataDir: string; projectRoot: string; termsUrl: string }
// 버튼을 비워 두고 크기·색만 정한다. CSS all 초기화는 초점 표시까지 지우므로 쓰지 않는다.
const plainButton = { background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'pointer' } as const

export function SetupScreen() {
  const t = useT()
  const locale = getState().locale
  const desktop = useMediaQuery('(min-width: 760px)')
  const h = desktop ? FIELD_H.desktop : FIELD_H.mobile
  const ids = {
    password: useId(), confirm: useId(), projectRoot: useId(), dataDir: useId(), port: useId(), terms: useId(),
  } satisfies Record<SetupField, string>
  const advId = useId()
  const browseBtnId = useId()

  const [defaults, setDefaults] = useState<Defaults | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [v, setV] = useState<SetupFormValues>({ password: '', confirm: '', port: '', dataDir: '', projectRoot: '', terms: false })
  const [shown, setShown] = useState(false)
  const [advOpen, setAdvOpen] = useState(false)
  const [step, setStep] = useState<SetupStep>(1)
  const [focusReq, setFocusReq] = useState<{ field: SetupField | null } | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [issues, setIssues] = useState<SetupIssue[]>([])
  const [summaryOn, setSummaryOn] = useState(false)
  const [focusTick, setFocusTick] = useState(0)
  const summaryRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [savedPort, setSavedPort] = useState<number | null>(null)
  const [picking, setPicking] = useState(false)
  const [checking, setChecking] = useState(true)
  const [providers, setProviders] = useState<ProviderInfo[] | null | 'failed'>(null)
  const [availability, setAvailability] = useState<AvailabilityState>(null)

  // 화면 낭독기와 브라우저가 쓰는 문서 언어. store.init은 부르지 않으므로 여기서 맞춘다.
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const loadDefaults = useCallback(() => {
    setLoadFailed(false)
    api.setupDefaults().then((d) => {
      setDefaults(d)
      setV((cur) => ({ ...cur, port: String(d.port), dataDir: d.dataDir, projectRoot: d.projectRoot }))
    }).catch(() => setLoadFailed(true))
  }, [])
  useEffect(loadDefaults, [loadDefaults])

  const checkAi = useCallback(() => {
    // 다시 확인하는 동안 이전 목록을 남겨 화면이 깜빡이지 않게 한다. 응답이 빨라도 진행 표시가 번쩍이지 않도록 잠깐은 둔다.
    setChecking(true)
    void Promise.all([
      api.listProviders().then((r) => setProviders(r.providers)).catch(() => setProviders('failed')),
      api.providerAvailability().then((r) => setAvailability(r.availability)).catch(() => setAvailability('failed')),
      new Promise((done) => setTimeout(done, 400)),
    ]).finally(() => setChecking(false))
  }, [])
  useEffect(checkAi, [checkAi])

  // 요약으로 초점을 옮긴다. 상태가 반영된 뒤에 실행되도록 effect로 한다.
  useEffect(() => {
    if (focusTick > 0) summaryRef.current?.focus()
  }, [focusTick])

  // 단계가 바뀐 뒤(새 화면이 그려진 뒤) 칸이나 단계 제목으로 초점을 옮긴다. 제목에 주면 화면 낭독기가 새 단계를 읽는다.
  useEffect(() => {
    if (!focusReq) return
    const id = requestAnimationFrame(() => (focusReq.field ? document.getElementById(ids[focusReq.field])?.focus() : headingRef.current?.focus()))
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq])

  const set = <K extends keyof SetupFormValues>(k: K, val: SetupFormValues[K]) => {
    setV((cur) => ({ ...cur, [k]: val }))
    // 고치는 중인 칸의 오류는 거둔다. 다시 맞는지는 칸을 벗어날 때와 제출 때 본다.
    setIssues((cur) => cur.filter((i) => i.field !== k && !(k === 'password' && i.field === 'confirm')))
  }
  const errOf = (f: SetupField) => {
    const i = issues.find((x) => x.field === f)
    return i ? t(`setup.error.${i.key}`) : undefined
  }
  const blurCheck = (f: SetupField) => () => {
    const found = validateSetupForm(v).filter((i) => i.field === f)
    setIssues((cur) => [...cur.filter((i) => i.field !== f), ...found])
  }
  const focusField = (f: SetupField | null) => {
    if (!f) return
    if (f === 'port' || f === 'dataDir') setAdvOpen(true)
    const target = stepOfField(f)
    if (target) setStep(target)
    setFocusReq({ field: f })
  }
  const moveStep = (to: SetupStep) => {
    const apply = () => {
      setIssues([])
      setSummaryOn(false)
      setStep(to)
      setFocusReq({ field: null })
    }
    if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return apply()
    const root = document.documentElement
    root.dataset.setupDir = to > step ? 'next' : 'back'
    document.startViewTransition(() => flushSync(apply)).finished.finally(() => { delete root.dataset.setupDir })
  }
  async function browseFolder() {
    setPicking(true)
    try {
      const { path } = await api.setupPickFolder()
      // 버튼이 다시 켜진 뒤에야 초점을 받을 수 있다.
      if (path === null) return void requestAnimationFrame(() => document.getElementById(browseBtnId)?.focus())
      set('projectRoot', path)
      focusField('projectRoot')
    } catch {
      setIssues((cur) => [...cur.filter((i) => i.field !== 'projectRoot'), { field: 'projectRoot', key: 'picker_failed' }])
      focusField('projectRoot')
    } finally {
      setPicking(false)
    }
  }
  function onNext() {
    const found = validateSetupStep(v, step)
    if (found.length > 0) return showIssues(found)
    moveStep((step + 1) as SetupStep)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (step < SETUP_STEP_COUNT) return onNext()
    const found = validateSetupForm(v)
    if (found.length > 0) return showIssues(found)
    setBusy(true)
    try {
      const r = await api.setupComplete(toSetupBody(v))
      // 비밀번호는 더 이상 화면에 남기지 않는다.
      setV((cur) => ({ ...cur, password: '', confirm: '' }))
      setSavedPort(r.port)
    } catch (err) {
      // 응답만 잃었거나 409면 저장은 됐을 수 있다. 설정 서버가 이미 끝났다면 오류 대신 기다림으로 넘어간다.
      const status = (err as { status?: number } | null)?.status
      const probe = status === undefined || status === 409 ? await probeHealth() : 'down'
      if (saveFailureNext(status, probe) === 'wait') {
        setV((cur) => ({ ...cur, password: '', confirm: '' }))
        setSavedPort(Number(v.port))
      } else showIssues([issueFromServerCode(err instanceof Error ? err.message : '')])
    } finally {
      setBusy(false)
    }
  }
  function showIssues(found: SetupIssue[]) {
    // 동의만 빠졌으면 알림을 띄우고 체크박스로 초점을 옮긴다.
    if (found.length === 1 && found[0].field === 'terms') {
      setIssues([])
      setSummaryOn(false)
      actions.showNotice({ title: t('setup.terms.needCheck') })
      focusField('terms')
      return
    }
    setIssues(found)
    setSummaryOn(true)
    setStep(stepForIssues(found, step))
    if (needsAdvancedOpen(found)) setAdvOpen(true)
    setFocusTick((n) => n + 1)
  }

  // topAligned: 단계를 옮겨도 진행 막대가 같은 자리에 있도록 위에 붙인다.
  const screen = savedPort !== null ? 'wait' : defaults ? 'form' : 'load' // 화면이 바뀔 때만 부드럽게 나타나게 한다
  const shell = (children: React.ReactNode, topAligned = false) => (
    <main
      data-auth-phase="setup"
      style={{ height: '100%', overflowY: 'auto', background: C.bg, display: 'flex', padding: '24px 20px', wordBreak: 'keep-all', overflowWrap: 'anywhere' }}
    >
      <div key={screen} className="setup-enter" style={{ width: '100%', maxWidth: 520, margin: topAligned ? 'clamp(0px, 4vh, 40px) auto auto' : 'auto', minWidth: 0 }}>{children}</div>
    </main>
  )

  if (savedPort !== null) return shell(<SetupWait port={savedPort} desktop={desktop} />)

  if (!defaults) {
    return shell(
      <div role="status" style={{ textAlign: 'center', color: C.label2, fontSize: 15 }}>
        <p style={{ margin: 0 }}>{loadFailed ? t('setup.loadFailed') : t('setup.loading')}</p>
        {loadFailed && (
          <Button type="button" tone="gray" height={h} paddingX={22} fontSize={15} style={{ marginTop: 12 }} onClick={loadDefaults}>
            {t('setup.retry')}
          </Button>
        )}
      </div>,
    )
  }

  const browseBtn = (
    <Button
      id={browseBtnId} type="button" tone="gray" height={h} paddingX={14} fontSize={14} disabled={picking} aria-busy={picking} onClick={() => void browseFolder()}
      style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      {picking ? <Spinner size={16} thickness={2} /> : <Folder size={16} aria-hidden />}{t('setup.browse')}
    </Button>
  )

  const isLast = step === SETUP_STEP_COUNT
  // 누르는 순간 칸의 초점이 빠져 오류 줄이 사라지면 버튼이 밀려 클릭이 빗나간다. 칸 검사는 버튼 동작에서 어차피 다시 한다.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()
  const small = { ...plainButton, minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 4px', fontSize: 14, color: C.tint } as const

  return shell(
    <form onSubmit={onSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Toasts />
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <span aria-hidden className="tabular-nums" style={{ fontSize: 13, fontWeight: 600, color: C.label2 }}>
            {t('setup.step', { n: step, total: SETUP_STEP_COUNT })}
          </span>
          <div
            role="progressbar" aria-label={t('setup.step.label')} aria-valuemin={1} aria-valuemax={SETUP_STEP_COUNT} aria-valuenow={step}
            aria-valuetext={t('setup.step', { n: step, total: SETUP_STEP_COUNT })}
            style={{ width: '100%', display: 'flex', gap: 6 }}
          >
            {Array.from({ length: SETUP_STEP_COUNT }, (_, n) => (
              <span key={n} style={{ flex: 1, height: 4, borderRadius: R.full, background: C.fill, overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', background: C.tintFill, transformOrigin: 'left', transform: n < step ? 'none' : 'scaleX(0)', transition: 'transform var(--dur-panel) var(--ease-enter)' }} />
              </span>
            ))}
          </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, viewTransitionName: 'setup-step' }}>
      <header style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8 }}>
        {step === 1 && <ChamdingMascot state={summaryOn && issues.length > 0 ? 'error' : 'idle'} size={88} />}
        <h1 ref={headingRef} tabIndex={-1} style={{ margin: '8px 0 0', fontSize: 28, fontWeight: 700, color: C.label, outline: 'none' }}>{t(`setup.step.${step}.title`)}</h1>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.45, color: C.label2 }}>{t(`setup.step.${step}.desc`)}</p>
      </header>

      {summaryOn && issues.length > 0 && (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          data-setup-summary
          className="setup-reveal"
          style={{ background: C.delSoft, border: `1px solid ${C.delBorder}`, borderRadius: R.field, padding: '12px 14px', color: C.del }}
        >
          <p style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{t(issues.length === 1 ? 'setup.errorSummaryOne' : 'setup.errorSummary')}</p>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 14, lineHeight: 1.5 }}>
            {issues.map((i, n) => (
              <li key={n}>
                {i.field ? (
                  <button
                    type="button" onClick={() => focusField(i.field)}
                    style={{ ...plainButton, color: 'inherit', textDecoration: 'underline', minHeight: 24, display: 'inline-block', textAlign: 'left' }}
                  >
                    {t(`setup.error.${i.key}`)}
                  </button>
                ) : t(`setup.error.${i.key}`)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {step === 1 && (
        <Section>
          <TextField
            id={ids.password} label={t('setup.password.label')} hint={t('setup.password.hint')} error={errOf('password')}
            type={shown ? 'text' : 'password'} autoComplete="new-password" height={h} value={v.password}
            onChange={(x) => set('password', x)} onBlur={blurCheck('password')}
            inside={
              <IconButton
                type="button" label={shown ? t('setup.password.hide') : t('setup.password.show')} aria-pressed={shown}
                size={44} color={C.label2} lift={false} onClick={() => setShown((s) => !s)}
                style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)' }}
              >
                {shown ? <EyeOff size={18} /> : <Eye size={18} />}
              </IconButton>
            }
          />
          <TextField
            id={ids.confirm} label={t('setup.password.confirm')} error={errOf('confirm')}
            type={shown ? 'text' : 'password'} autoComplete="new-password" height={h} value={v.confirm}
            onChange={(x) => set('confirm', x)} onBlur={blurCheck('confirm')}
          />
        </Section>
      )}

      {step === 2 && (
        <>
          <Section>
            <TextField
              id={ids.projectRoot} label={t('setup.projectRoot.label')} hint={t('setup.projectRoot.hint')} error={errOf('projectRoot')}
              height={h} mono value={v.projectRoot} onChange={(x) => set('projectRoot', x)} onBlur={blurCheck('projectRoot')}
              after={browseBtn}
            />
          </Section>

          <Section title={t('setup.ai.title')}>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: C.label2 }}>{t('setup.ai.help')}</p>
            <AiStatus providers={providers} availability={availability} checking={checking} />
            <div>
              <button type="button" onClick={checkAi} disabled={checking} className="setup-link" style={{ ...small, cursor: checking ? 'default' : 'pointer', color: checking ? C.label2 : C.tint }}>
                {checking && <Spinner size={14} thickness={2} />}
                {checking ? t('setup.ai.checking') : t('setup.ai.recheck')}
              </button>
            </div>
          </Section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            <button
              type="button" aria-expanded={advOpen} aria-controls={advId} onClick={() => setAdvOpen((o) => !o)}
              className="setup-link" style={{ ...plainButton, minHeight: 44, display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, fontWeight: 700, color: C.label }}
            >
              <ChevronRight size={18} aria-hidden style={{ transform: advOpen ? 'rotate(90deg)' : 'none', transition: 'transform var(--dur-panel) var(--ease-enter)' }} />
              {t('setup.advanced')}
            </button>
            {/* 접힌 칸은 inert라 초점과 화면 낭독기가 들어가지 않는다. 높이는 0fr↔1fr로 늘고 준다. */}
            <div id={advId} inert={!advOpen} className="setup-fold" data-open={advOpen || undefined}>
              <div style={{ minHeight: 0, overflow: 'clip', overflowClipMargin: 4, display: 'flex', flexDirection: 'column', gap: 18 }}>
              <TextField
                id={ids.port} label={t('setup.port.label')} hint={t('setup.port.hint')} error={errOf('port')}
                inputMode="numeric" height={h} value={v.port} onChange={(x) => set('port', x)} onBlur={blurCheck('port')}
              />
              <TextField
                id={ids.dataDir} label={t('setup.dataDir.label')} hint={t('setup.dataDir.hint')} error={errOf('dataDir')}
                height={h} mono value={v.dataDir} onChange={(x) => set('dataDir', x)} onBlur={blurCheck('dataDir')}
              />
              </div>
            </div>
          </section>
        </>
      )}

      {step === 3 && (
        <Section>
          <ConsentList />
          <div>
            {defaults.termsUrl ? (
              <a href={defaults.termsUrl} target="_blank" rel="noopener noreferrer" className="setup-link" style={{ ...small, textDecoration: 'none' }}>
                {t('setup.terms.open')}<ExternalLink size={14} aria-hidden />
              </a>
            ) : <span style={{ fontSize: 13, color: C.label2 }}>{t('setup.terms.noLink')}</span>}
          </div>
          <label htmlFor={ids.terms} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, fontSize: 15, color: C.label, cursor: 'pointer' }}>
            <input
              id={ids.terms} type="checkbox" checked={v.terms} className="setup-check"
              aria-invalid={errOf('terms') ? true : undefined} aria-describedby={errOf('terms') ? `${ids.terms}-err` : undefined}
              onChange={(e) => set('terms', e.target.checked)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }} // 체크박스의 Enter로 저장되지 않게 한다
              style={{ width: 22, height: 22, margin: 0, flexShrink: 0, accentColor: 'var(--c-tint-fill)' }}
            />
            {t('setup.terms.agree')}
          </label>
          {errOf('terms') && <p id={`${ids.terms}-err`} role="alert" className="setup-reveal" style={{ margin: 0, fontSize: 13, color: C.del }}>{errOf('terms')}</p>}
        </Section>
      )}
      </div>

      <div style={{ display: 'flex', gap: 10, viewTransitionName: 'setup-actions' }}>
        {step > 1 && (
          <Button type="button" tone="gray" height={h} paddingX={22} fontSize={15} onMouseDown={keepFocus} onClick={() => moveStep((step - 1) as SetupStep)}>{t('setup.back')}</Button>
        )}
        <Button type="submit" tone="primary" grow height={h} fontSize={15} disabled={busy} looksDisabled={isLast && !v.terms} className="setup-submit" onMouseDown={keepFocus} data-setup-submit={isLast ? '' : undefined} data-setup-next={isLast ? undefined : ''}
          onClick={(e) => { if (e.detail > 1) e.preventDefault() }} // 더블클릭의 두 번째 클릭으로 다음 단계까지 넘어가거나 저장되지 않게 한다
        >
          {isLast ? (busy ? t('setup.submitBusy') : t('setup.submit')) : t('setup.next')}
        </Button>
      </div>
    </form>,
    true,
  )
}
