// 저장 뒤 기다리는 화면. 설정 서버가 끝나고 진짜 서버가 뜰 때까지 기다린다.
// 연결 실패는 서버가 바뀌는 중이라 정상이다. 같은 포트면 /api/health로 확인해 다시 불러오고,
// 다른 포트면 화면 보안 정책(CSP)이 다른 포트 조회를 막으므로 새 주소 링크만 보인다(서버가 늦으면 연결 오류 화면에 멈추므로 자동 이동은 하지 않는다).
import { useEffect, useRef, useState } from 'react'
import { C } from '../../design/tokens'
import { useT } from '../../lib/i18n'
import { classifyProbe, newAddress, waitDecision } from '../../lib/setupForm'
import { ChamdingMascot } from '../ChamdingMascot'
import { Button } from '../ui'

export async function probeHealth() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
    return classifyProbe(res.ok ? ((await res.json()) as { ok?: boolean; setup?: boolean }) : null)
  } catch {
    return 'down' as const
  }
}

export function SetupWait({ port, desktop }: { port: number; desktop: boolean }) {
  const t = useT()
  const samePort = String(port) === window.location.port
  const [slow, setSlow] = useState(false)
  const startedAt = useRef(Date.now())
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [round, setRound] = useState(0) // 「다시 확인」을 누르면 올라가 기다림을 처음부터 다시 센다
  const next = newAddress(window.location, port)

  useEffect(() => {
    startedAt.current = Date.now()
    setSlow(false)
    if (!samePort) return
    let stop = false
    const tick = async () => {
      const probe = await probeHealth()
      if (stop) return
      const d = waitDecision(probe, Date.now() - startedAt.current)
      if (d === 'reload') window.location.reload()
      else setSlow(d === 'slow')
    }
    const id = window.setInterval(() => void tick(), 1000)
    return () => {
      stop = true
      window.clearInterval(id)
    }
  }, [samePort, round])

  return (
    <div role="status" aria-live="polite" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8 }}>
      <ChamdingMascot state={slow ? 'error' : 'loading'} size={88} />
      <h1 ref={titleRef} tabIndex={-1} style={{ margin: '12px 0 0', fontSize: 22, fontWeight: 700, color: C.label }}>
        {slow ? t('setup.wait.slowTitle') : t('setup.wait.title')}
      </h1>
      <p style={{ margin: 0, maxWidth: '36ch', fontSize: 15, lineHeight: 1.5, color: C.label2 }}>
        {slow ? t('setup.wait.slowBody') : t(samePort ? 'setup.wait.body' : 'setup.wait.moved')}
      </p>
      {!samePort && (
        <a href={next} style={{ marginTop: 8, fontSize: 15, color: C.tint, minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
          {t('setup.wait.link')} ({next})
        </a>
      )}
      {samePort && slow && (
        <Button type="button" tone="gray" height={desktop ? 44 : 50} paddingX={22} fontSize={15} style={{ marginTop: 12 }} onClick={() => { setRound((n) => n + 1); titleRef.current?.focus() }}>
          {t('setup.wait.check')}
        </Button>
      )}
    </div>
  )
}
