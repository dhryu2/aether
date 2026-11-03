/**
 * 인증 게이트. ready 뒤에만 자식을 그리고 actions.init()을 한 번 부른다.
 * 비번 칸은 health.auth==="password" 이고 보호 REST가 401일 때만.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowBigUp, Eye, EyeOff, Lock, Network } from 'lucide-react'
import { api, classifyTransportError, reportApiResponseError } from '../../lib/api'
import { reportClientError } from '../../lib/errorReporting'
import { nextAuthPhase, type AuthPhase } from '../../lib/authGate'
import { authHeaders, setClientToken } from '../../lib/clientAuth'
import { t } from '../../lib/i18n'
import { useDelayedFlag, useMediaQuery } from '../../lib/hooks'
import { actions } from '../../lib/store'
import { C, R } from '../../design/tokens'
import { ChamdingMascot } from '../ChamdingMascot'
import { chamdingWidth } from '../chamdingWidth'
import { Button, IconButton } from '../ui'
import { SetupScreen } from '../setup/SetupScreen'

type Props = { children: ReactNode }

function originHost(): string {
  try {
    return window.location.hostname || '127.0.0.1'
  } catch {
    // 화면 밖 렌더링에서는 브라우저 출처가 없으므로 기본 호스트를 쓴다.
    return '127.0.0.1'
  }
}

function GateScreen({ phase, children }: { phase: string; children: ReactNode }) {
  return (
    <main
      data-auth-phase={phase}
      style={{
        height: '100%',
        background: C.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 20px',
      }}
    >
      <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {children}
      </div>
    </main>
  )
}

export function AuthGate({ children }: Props) {
  const [phase, setPhase] = useState<AuthPhase | 'booting'>('booting')
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
  const [loginError, setLoginError] = useState('')
  // Caps Lock 안내는 브라우저 대신 앱이 칸 아래에 직접 띄운다(index.css .auth-password 주석).
  const [capsOn, setCapsOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const initOnce = useRef(false)
  const passwordId = useId()
  const errorId = useId()
  const capsId = useId()
  const desktop = useMediaQuery('(min-width: 760px)')
  // 부팅이 0.7초 안에 끝나면 참딩은 안 띄운다. 자리는 미리 비워 둔다.
  const bootReady = useDelayedFlag(phase === 'booting', 700)
  const bootH = 88

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let healthAuth: 'off' | 'tailscale' | 'password' | undefined
      let healthSetup = false
      try {
        const h = await api.health()
        healthAuth = h.auth
        healthSetup = h.setup === true
      } catch (error) {
        // API 실패는 공통 호출기가 이미 판정했다. 응답 처리 결함만 warning으로 남기고 인증 방식 탐지는 계속한다.
        reportClientError(error, { component: 'auth', operation: 'web.auth.health', severity: 'warning' })
        healthAuth = undefined
      }
      if (cancelled) return

      const host = originHost()
      // 첫 설정 서버면 보호 REST를 부르지 않는다(그 서버에는 없다).
      if (nextAuthPhase({ sessionsStatus: null, healthAuth, healthSetup, originHost: host }) === 'setup') {
        setPhase('setup')
        return
      }
      // need-tailnet이면 보호 REST를 치지 않는다
      const early = nextAuthPhase({ sessionsStatus: null, healthAuth, originHost: host })
      if (healthAuth === 'tailscale' && early === 'need-tailnet') {
        setPhase('need-tailnet')
        return
      }

      let sessionsStatus: number | null
      try {
        const res = await fetch('/api/sessions', {
          credentials: 'same-origin',
          headers: { ...authHeaders() },
        })
        sessionsStatus = res.status
        if (res.status >= 500) reportApiResponseError(new Error(`${res.status} ${res.statusText}`), res)
      } catch (error) {
        reportClientError(classifyTransportError(error), { component: 'auth', operation: 'web.auth.probe' })
        sessionsStatus = null
      }
      if (cancelled) return
      setPhase(nextAuthPhase({ sessionsStatus, healthAuth, originHost: host }))
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (phase !== 'ready') return
    if (initOnce.current) return
    initOnce.current = true
    void actions.init()
  }, [phase])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy || !password) return
    setBusy(true)
    setLoginError('')
    try {
      const body = await api.login(password)
      if (body.token) setClientToken(body.token)
      const res = await fetch('/api/sessions', {
        credentials: 'same-origin',
        headers: { ...authHeaders() },
      })
      if (res.status >= 200 && res.status < 300) {
        setPhase('ready')
      } else {
        reportApiResponseError(new Error(`${res.status} ${res.statusText}`), res)
        setLoginError(t('nav.auth.loginFailed'))
      }
    } catch (err) {
      reportClientError(classifyTransportError(err), { component: 'auth', operation: 'web.auth.login' })
      const locked = (err as { status?: number } | null)?.status === 429
      setLoginError(t(locked ? 'nav.auth.tooManyAttempts' : 'nav.auth.loginFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (phase === 'booting') {
    return (
      <GateScreen phase="booting">
        {/* LoadMask는 700ms 뒤에 뜨는 덮개라 이 화면에서 그대로 쓰면 안 된다. 참딩과 문구 모양만 같다.
            0.7초 전에는 같은 크기 빈 상자만 둔다. 글이 위로 튀지 않게. */}
        {bootReady ? (
          <div className="chamding-enter">
            <ChamdingMascot state="loading" size={bootH} />
          </div>
        ) : (
          <div style={{ width: chamdingWidth(bootH), height: bootH }} aria-hidden />
        )}
        <h1 style={{ margin: '14px 0 0', fontSize: 13.5, fontWeight: 400, color: C.label2, textAlign: 'center' }}>
          {t('nav.app.loadMask.loadingText')}
        </h1>
      </GateScreen>
    )
  }

  if (phase === 'setup') return <SetupScreen />

  if (phase === 'need-tailnet' || phase === 'blocked') {
    const blocked = phase === 'blocked'
    return (
      <GateScreen phase={phase}>
        {blocked ? (
          <Lock size={48} aria-hidden style={{ color: C.label3 }} />
        ) : (
          <Network size={48} aria-hidden style={{ color: C.label3 }} />
        )}
        <h1 style={{ margin: '16px 0 0', fontSize: 22, fontWeight: 700, color: C.label, textAlign: 'center' }}>
          {t(blocked ? 'nav.auth.blockedTitle' : 'nav.auth.needTailnetTitle')}
        </h1>
        <p
          style={{
            margin: '8px 0 0',
            maxWidth: 'min(34ch, 100%)',
            fontSize: 15,
            lineHeight: 1.45,
            color: C.label2,
            textAlign: 'center',
          }}
        >
          {t(blocked ? 'nav.auth.blockedBody' : 'nav.auth.needTailnetBody')}
        </p>
        <Button
          type="button"
          tone="gray"
          height={desktop ? 44 : 50}
          paddingX={22}
          fontSize={15}
          style={{ marginTop: 20 }}
          onClick={() => window.location.reload()}
        >
          {t('nav.auth.retry')}
        </Button>
      </GateScreen>
    )
  }

  if (phase === 'login') {
    const fieldH = desktop ? 44 : 50
    return (
      <GateScreen phase="login">
        <ChamdingMascot state={loginError ? 'error' : 'idle'} size={88} />
        <h1 style={{ margin: '16px 0 0', fontSize: 28, fontWeight: 700, color: C.label, textAlign: 'center' }}>Aether</h1>
        <p style={{ margin: '8px 0 0', width: '100%', fontSize: 15, lineHeight: 1.45, color: C.label2, textAlign: 'center' }}>
          {t('nav.auth.loginBody')}
        </p>
        <form
          onSubmit={onSubmit}
          style={{ width: '100%', marginTop: 22, display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <label htmlFor={passwordId} style={{ fontSize: 13, fontWeight: 600, color: C.label }}>
            {t('nav.auth.passwordLabel')}
          </label>
          <div className="auth-password" style={{ position: 'relative', width: '100%', borderRadius: R.field }}>
            <input
              id={passwordId}
              type={shown ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              data-auth-password
              value={password}
              // 폰에서는 화면이 뜨자마자 키보드가 올라오지 않게, 컴퓨터에서만 초점을 준다.
              autoFocus={desktop}
              aria-describedby={[capsOn && capsId, loginError && errorId].filter(Boolean).join(' ') || undefined}
              onChange={(ev) => setPassword(ev.target.value)}
              // 키를 누르고 뗄 때마다 Caps Lock 상태를 다시 읽는다. 칸을 떠나면 안내를 거둔다.
              onKeyDown={(ev) => setCapsOn(ev.getModifierState('CapsLock'))}
              onKeyUp={(ev) => setCapsOn(ev.getModifierState('CapsLock'))}
              onBlur={() => setCapsOn(false)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                height: fieldH,
                border: 'none',
                borderRadius: R.field,
                background: C.cell,
                padding: '0 48px 0 14px',
                fontSize: 15,
                fontFamily: 'inherit',
                color: C.label,
              }}
            />
            <IconButton
              type="button"
              label={shown ? t('nav.auth.hidePassword') : t('nav.auth.showPassword')}
              aria-pressed={shown}
              size={44}
              color={C.label2}
              lift={false}
              onClick={() => setShown((v) => !v)}
              style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)' }}
            >
              {shown ? <EyeOff size={18} /> : <Eye size={18} />}
            </IconButton>
          </div>
          {capsOn && (
            <p id={capsId} role="status" className="flex items-center" style={{ margin: 0, gap: 4, fontSize: 13, color: C.attn }}>
              <ArrowBigUp size={15} aria-hidden />
              {t('nav.auth.capsLock')}
            </p>
          )}
          {loginError && (
            <p id={errorId} role="alert" data-auth-error style={{ margin: 0, fontSize: 13, color: C.del }}>
              {loginError}
            </p>
          )}
          <Button
            type="submit"
            tone="primary"
            fullWidth
            height={fieldH}
            fontSize={15}
            data-auth-submit
            disabled={!password || busy}
          >
            {busy ? t('nav.auth.loginBusy') : t('nav.auth.loginSubmit')}
          </Button>
        </form>
      </GateScreen>
    )
  }

  return <>{children}</>
}
