// 구독 다시 로그인. 맥의 로그인 절차를 폰으로 중계한다.
// 여는 순간 초점은 닫기. 단계가 바뀌어도 초점을 옮기지 않는다.
import { useId, useState } from 'react'
import { actions, providerName, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { useCopy, useDelayedFlag } from '../lib/hooks'
import { C, Z } from '../design/tokens'
import { Button, ModalCard, ModalFooter, ModalHeader, ModalShell } from './ui'
import { ChamdingMascot } from './ChamdingMascot'
import { chamdingWidth } from './chamdingWidth'
import { CodeEntry, CodeLinks, DeviceCode, ErrorPane, PrimaryLink, ServerNote, Steps, SuccessPane } from './providerAuth/pieces'

export function ProviderAuthModal() {
  const s = useStore()
  const t = useT()
  const ca = s.providerAuth
  const name = providerName(s, ca.provider)
  const narrow = s.isNarrow
  const [code, setCode] = useState('')
  const { copied, copy } = useCopy()
  const [lastUrl, setLastUrl] = useState<string | null>(ca.url)
  const codeNoteId = useId()
  // 준비·처리 중은 0.7초 뒤에 로딩 자세. 기기 로그인 대기는 사용자 몫이라 바로 대기 자세.
  //   훅은 창이 닫혀 있어도 여기서 부른다. 아래의 이른 return보다 앞이어야 한다.
  const preparing = ca.open && (ca.phase === 'starting' || ca.phase === 'submitting')
  const deviceWait = ca.open && ca.phase === 'awaiting_device'
  const authLate = useDelayedFlag(preparing, 700)
  const authMascot = 44

  if (ca.url !== lastUrl) {
    setLastUrl(ca.url)
    setCode('')
  }

  if (!ca.open) return null

  const phase = ca.phase
  const footerH = narrow ? 50 : 40
  const waiting = phase === 'starting'
    ? t('session.auth.preparing')
    : phase === 'submitting'
      ? t('session.auth.processing')
      : phase === 'awaiting_device'
        ? t('session.auth.device.waiting')
        : ''
  const deviceSteps = [t('session.auth.device.step1'), t('session.auth.device.step2'), t('session.auth.device.step3')]
  const pasteSteps = [t('session.auth.step1'), t('session.auth.step2'), t('session.auth.step3')]

  function submit() {
    if (code.trim()) void actions.submitProviderAuthCode(code)
  }

  // 기다리는 말, 완료, 코드 거절은 이 자식 하나만 바뀐다. 거절 글을 밖에 다시 그리지 않는다.
  const codeNote = phase === 'awaiting_code' && ca.message ? ca.message : ''
  const live = waiting ? (
    <div className="flex items-center" style={{ gap: 10, marginTop: phase === 'awaiting_device' ? 16 : 0 }}>
      {/* 같은 요소를 유지해야 로딩에서 대기로 넘어갈 때 자세만 바뀐다. 0.7초 전에는 빈 상자. */}
      {deviceWait || authLate ? (
        <ChamdingMascot state={deviceWait ? 'waiting' : 'loading'} size={authMascot} priority={3} />
      ) : (
        <div style={{ width: chamdingWidth(authMascot), height: authMascot }} aria-hidden />
      )}
      <span style={{ fontSize: 15, color: C.label2 }}>{waiting}</span>
    </div>
  ) : phase === 'success' ? (
    <SuccessPane />
  ) : codeNote ? (
    <ServerNote id={codeNoteId} message={codeNote} />
  ) : null

  return (
    <ModalShell onClose={actions.closeProviderAuth} zIndex={Z.root.providerAuth}>
      <ModalCard variant="sheet" maxWidth={440} data-window="provider-auth">
        <ModalHeader
          title={t('settings.reauth.title', { provider: name })}
          onClose={actions.closeProviderAuth}
          closeLabel={t('common.close')}
        />

        {phase === 'idle' && (
          <p style={{ margin: 0, fontSize: 15, color: C.label2, lineHeight: 1.5 }}>{t('session.auth.idleDesc', { provider: name })}</p>
        )}
        {phase === 'awaiting_device' && ca.url && (
          <>
            <Steps items={deviceSteps} />
            <DeviceCode code={ca.userCode ?? ''} copied={copied} narrow={narrow} onCopy={() => { if (ca.userCode) copy(ca.userCode) }} />
          </>
        )}
        {phase === 'awaiting_code' && ca.url && (
          <>
            <Steps items={pasteSteps} />
            <CodeLinks url={ca.url} narrow={narrow} copied={copied} onCopy={() => copy(ca.url!)} />
          </>
        )}
        {phase === 'error' && <ErrorPane message={ca.message || t('session.auth.errorFallback')} />}

        <div aria-live="polite">{live}</div>

        {phase === 'awaiting_code' && ca.url && (
          <CodeEntry
            code={code}
            narrow={narrow}
            describedBy={codeNote ? codeNoteId : undefined}
            onChange={setCode}
            onSubmit={submit}
          />
        )}

        {phase === 'idle' && (
          <ModalFooter>
            <Button tone="primary" height={footerH} paddingX={18} fontSize={15} onClick={() => void actions.startProviderAuth()}>
              {t('session.auth.start')}
            </Button>
          </ModalFooter>
        )}
        {phase === 'awaiting_device' && ca.url && (
          <ModalFooter>
            <PrimaryLink href={ca.url} height={footerH}>
              {t('session.auth.openLogin')}
            </PrimaryLink>
          </ModalFooter>
        )}
        {phase === 'awaiting_code' && (
          <ModalFooter>
            <Button tone="primary" height={footerH} paddingX={18} fontSize={15} disabled={!code.trim()} onClick={submit}>
              {t('session.auth.submitCode')}
            </Button>
          </ModalFooter>
        )}
        {phase === 'success' && (
          <ModalFooter>
            <Button tone="primary" height={footerH} paddingX={18} fontSize={15} onClick={actions.closeProviderAuth}>
              {t('session.auth.done')}
            </Button>
          </ModalFooter>
        )}
        {phase === 'error' && (
          <ModalFooter>
            <Button tone="primary" height={footerH} paddingX={18} fontSize={15} onClick={() => void actions.startProviderAuth()}>
              {t('session.auth.retry')}
            </Button>
          </ModalFooter>
        )}
      </ModalCard>
    </ModalShell>
  )
}
