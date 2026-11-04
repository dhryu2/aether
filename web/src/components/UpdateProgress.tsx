// 앱 안 업데이트 진행 화면. 업데이트를 누른 순간부터 새로 고칠 때까지 앱 전체를 덮는다.
// 1초마다 서버 상태를 보고(끊기면 /api/health), 무엇을 보일지는 lib/updateFlow의 순수 함수가 정한다.
import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../lib/focusTrap'
import type { UpdateStatusResponse } from '@shared/http'
import { C, Z } from '../design/tokens'
import { api } from '../lib/api'
import { authHeaders } from '../lib/clientAuth'
import { errMsg } from '../lib/errors'
import { useT } from '../lib/i18n'
import { actions, useStore } from '../lib/store'
import { decideUpdateStep, UPDATE_DONE_KEY, type UpdateProbe, type UpdateStep } from '../lib/updateFlow'
import { safeHttpUrl } from '../lib/updateNotice'
import { ChamdingMascot } from './ChamdingMascot'
import { Button } from './ui'

/** 연결 끊김은 설치 중 정상이라 api.ts의 req(오류 기록·재시도)를 거치지 않고 직접 본다. */
async function readProbe(): Promise<UpdateProbe> {
  let unauthorized = false
  try {
    const res = await fetch('/api/system/update', { cache: 'no-store', credentials: 'same-origin', headers: authHeaders(), signal: AbortSignal.timeout(3000) })
    if (res.ok) return { kind: 'status', status: (await res.json()) as UpdateStatusResponse }
    unauthorized = res.status === 401
  } catch { /* 아래에서 health로 확인 */ }
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const v = ((await res.json()) as { version?: string }).version
      if (v) return { kind: 'health', version: v, unauthorized }
    }
  } catch { /* 서버가 내려가 있다 */ }
  return { kind: 'down' }
}

const mb = (n: number) => (n / 1048576).toFixed(1)

function Bar({ value }: { value?: number }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === undefined ? undefined : Math.round(value)}
      className={value === undefined ? 'update-bar-indet' : undefined}
      style={{ width: 'min(280px, 100%)', height: 6, borderRadius: 3, background: C.fill, overflow: 'hidden', color: C.onTint, marginTop: 8 }}
    >
      <div style={{ width: `${value ?? 100}%`, height: '100%', background: C.tintFill, transition: 'width 0.3s' }} />
    </div>
  )
}

export function UpdateProgress() {
  const p = useStore().updateProgress
  return p ? <Screen {...p} /> : null
}

function Screen({ fromVersion, targetVersion, pageUrl }: { fromVersion: string; targetVersion?: string; pageUrl?: string }) {
  const t = useT()
  const narrow = useStore().isNarrow
  const [step, setStep] = useState<UpdateStep>({ step: 'checking' })
  const [round, setRound] = useState(0) // 「다시 시도」를 누르면 올라가 판정을 처음부터 다시 한다
  const titleRef = useRef<HTMLHeadingElement>(null)
  const wasDown = useRef(false)
  const installSince = useRef<number | null>(null) // 설치 단계에 들어선 시각(지연 판정용)
  const target = useRef(targetVersion)
  const boxRef = useRef<HTMLDivElement>(null)
  const [err, setErr] = useState<string | null>(null) // 취소·다시 시도 실패를 화면 안에 알린다(오류 토스트는 이 화면 뒤에 가려진다)
  const link = safeHttpUrl(pageUrl)
  const btnH = narrow ? 50 : 44

  useEffect(() => {
    wasDown.current = false
    installSince.current = null
    setErr(null)
    setStep({ step: 'checking' })
    let stop = false
    const tick = async () => {
      const probe = await readProbe()
      if (stop) return
      if (probe.kind === 'down') wasDown.current = true
      if (probe.kind === 'status') {
        const ph = probe.status.install.phase
        // 내려받는 중에 잠깐 끊긴 것은 설치 중 끊김이 아니다. 다시 받는 단계가 보이면 끊김 기록과 설치 시계를 지운다.
        if (ph === 'checking' || ph === 'downloading') { wasDown.current = false; installSince.current = null }
        if ('version' in probe.status.install) target.current = probe.status.install.version
      }
      const input = { probe, wasDown: wasDown.current, fromVersion, targetVersion: target.current }
      const next = decideUpdateStep({ ...input, elapsedMs: installSince.current ? Date.now() - installSince.current : 0 })
      if ((next.step === 'installing' || next.step === 'slow') && installSince.current === null) installSince.current = Date.now()
      if (next.step === 'reload') {
        try { sessionStorage.setItem(UPDATE_DONE_KEY, next.version) } catch { /* 토스트만 건너뛴다 */ }
        window.location.reload()
        return
      }
      if (next.step === 'failed' || next.step === 'rolledBack') stop = true // 끝난 화면은 더 보지 않는다
      setStep(next)
    }
    const id = window.setInterval(() => void tick(), 1000)
    return () => {
      stop = true
      window.clearInterval(id)
    }
  }, [round, fromVersion])

  // 화면이 열리거나 제목이 바뀌면 초점을 제목으로 옮긴다.
  useEffect(() => { titleRef.current?.focus() }, [step.step])

  // 취소 응답의 설치 상태가 idle일 때만 닫는다. 이미 설치로 넘어갔으면 그 화면을 보이고, 요청이 실패하면 알리고 폴링을 계속한다.
  const cancel = async () => {
    setErr(null)
    try {
      const r = (await api.cancelUpdate()) as Partial<UpdateStatusResponse>
      if (r.install?.phase === 'idle') actions.closeUpdateProgress()
      else if (r.install?.phase === 'installing') setStep({ step: 'installing' })
    } catch (e) {
      setErr(errMsg(e))
    }
  }
  const retry = async () => {
    setErr(null)
    if (!target.current) return setErr(t('update.fail.handoff'))
    try {
      await api.installUpdate(target.current)
      setRound((n) => n + 1)
    } catch (e) {
      setErr(errMsg(e))
    }
  }
  const openLink = () => { if (link) window.open(link, '_blank', 'noopener,noreferrer') }
  const again = () => { installSince.current = Date.now(); setStep({ step: 'installing' }) }
  useFocusTrap(boxRef, () => titleRef.current)

  const bad = step.step === 'failed' || step.step === 'rolledBack' || step.step === 'slow'
  const version = step.step === 'downloading' ? step.version : target.current
  let title: string
  let body: string
  if (step.step === 'failed') { title = t('update.fail.title'); body = t(`update.fail.${step.reason === 'signature' ? 'verify' : step.reason}`) }
  else if (step.step === 'rolledBack') { title = t('update.fail.title'); body = t(step.kind === 'rolledBack' ? 'update.fail.rolledBack' : 'update.fail.unfinished') }
  else if (step.step === 'slow') { title = t('update.slow.title'); body = t('update.slow.body') }
  else {
    title = version ? t('update.progress.title', { version }) : t('update.progress.preparing')
    body = step.step === 'installing' ? t('update.progress.installing') : t('update.progress.downloading')
  }
  const btn = (label: string, onClick: () => void, tone: 'primary' | 'gray' = 'gray') => (
    <Button type="button" tone={tone} height={btnH} paddingX={22} fontSize={15} onClick={onClick}>{label}</Button>
  )

  return (
    <div ref={boxRef} role="dialog" aria-modal="true" aria-labelledby="update-progress-title" style={{ position: 'fixed', inset: 0, zIndex: Z.root.dialog, background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div role="status" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8 }}>
        <ChamdingMascot state={bad ? 'error' : 'loading'} size={88} />
        <h1 id="update-progress-title" ref={titleRef} tabIndex={-1} style={{ margin: '12px 0 0', fontSize: 22, fontWeight: 700, color: C.label }}>{title}</h1>
        <p style={{ margin: 0, maxWidth: '36ch', wordBreak: 'keep-all', fontSize: 15, lineHeight: 1.5, color: C.label2 }}>{body}</p>
        {(step.step === 'checking' || step.step === 'downloading') && (
          <>
            <Bar value={step.step === 'downloading' && step.total > 0 ? Math.min(100, (step.received / step.total) * 100) : 0} />
            {step.step === 'downloading' && step.total > 0 && (
              <p style={{ margin: 0, fontSize: 13, color: C.label3 }}>{t('update.progress.size', { received: mb(step.received), total: mb(step.total) })}</p>
            )}
          </>
        )}
        {step.step === 'installing' && <Bar />}
        {err && <p role="alert" style={{ margin: 0, fontSize: 14, color: C.del }}>{err}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 12 }}>
          {(step.step === 'checking' || step.step === 'downloading') && btn(t('update.progress.cancel'), () => void cancel())}
          {step.step === 'slow' && <>
            {btn(t('update.slow.check'), again)}
            {link && btn(t('update.manual'), openLink)}
            {btn(t('common.close'), actions.closeUpdateProgress)}
          </>}
          {(step.step === 'failed' || step.step === 'rolledBack') && <>
            {btn(t('update.fail.retry'), () => void retry(), 'primary')}
            {link && btn(t('update.fail.manual'), openLink)}
            {btn(t('common.close'), actions.closeUpdateProgress)}
          </>}
        </div>
      </div>
    </div>
  )
}
