// 다음 작업으로 넘기기 창. 세 가지 모습이다.
//   form    목적·초점·진행 방식·받는 곳을 정하고 [넘기기]를 누른다.
//   waiting 이미 한도에 막혀 있어 풀릴 때까지 기다린다는 안내와 [확인]
//   result  복사만 고른 결과, 또는 새 세션을 만들지 못했을 때 남은 인계서 글(읽기 전용 + [복사])
// 서버가 인계서 쓰기부터 새 세션 만들기까지 끝까지 진행한다. 이 창은 시작을 알리고 결과를 보여 주기만 한다.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ChevronRight } from 'lucide-react'
import { actions, useStore } from '../lib/store'
import { roomIdForExecution } from '../lib/workspaceRooms'
import { api } from '../lib/api'
import { errMsg } from '../lib/errors'
import { useT } from '../lib/i18n'
import { canSubmitHandoff, HANDOFF_FOCUS_MAX, HANDOFF_PURPOSES, type HandoffPurpose } from '../lib/handoff'
import { recentFolders } from '../lib/sessionGroups'
import type { HandoffInfo } from '../lib/types'
import { C, FONT, Z } from '../design/tokens'
import { Button, ModalCard, ModalFooter, ModalHeader, ModalShell, SegmentedControl, Switch } from './ui'
import { GroupTitle } from './settings/parts'
import { FolderChoices } from './folderPicker/FolderChoices'
import { useFolderBrowser } from './folderPicker/useFolderBrowser'
import { fieldStyle } from './newSession/fieldStyle'

const RECENT_FOLDERS = 4

export function HandoffSheet() {
  const sheet = useStore().handoffSheet
  if (!sheet) return null
  if (sheet.mode === 'result') return <ResultWindow sessionId={sheet.sessionId} />
  if (sheet.mode === 'waiting') return <WaitingWindow sessionId={sheet.sessionId} />
  return <FormWindow sessionId={sheet.sessionId} />
}

type AnchorRect = { left: number; width: number }

/**
 * 컴퓨터에서는 넘기는 세션의 칸과 같은 가로 자리에 작은 창으로 띄운다. 칸을 못 찾거나 폰이면 null이라
 * 창 틀이 정한 자리(가운데 창 / 아래 시트)를 그대로 쓴다. 창 크기가 바뀌어도 칸을 따라가도록 그릴 때마다 잰다.
 */
function useAnchor(execId: string): AnchorRect | null {
  const st = useStore()
  if (st.isNarrow || typeof document === 'undefined') return null
  const el = document.querySelector(`[data-split-session="${roomIdForExecution(st.rooms, execId)}"]`)
  const r = el?.getBoundingClientRect()
  return r && r.width > 0 && r.height > 0 ? { left: r.left, width: r.width } : null
}

/**
 * 칸과 같은 폭, 화면 높이의 투명 틀 안에서 창을 가운데에 둔다. 틀은 눌림을 통과시켜 막 클릭(닫기)이 그대로 동작한다.
 * 세로를 칸에 맞추지 않는다. 4분할의 칸은 창보다 낮아서 화면 위아래로 넘쳐 잘린다.
 */
function Anchor({ rect, children }: { rect: AnchorRect | null; children: ReactNode }) {
  if (!rect) return <>{children}</>
  return (
    <div
      style={{ position: 'fixed', left: rect.left, top: 0, width: rect.width, height: '100%', boxSizing: 'border-box', padding: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}
    >
      {children}
    </div>
  )
}

const CARD_CLICKABLE = { pointerEvents: 'auto' } as const

function FormWindow({ sessionId }: { sessionId: string }) {
  const s = useStore()
  const rect = useAnchor(sessionId)
  // 목록은 실시간 갱신으로 바로 맞지 않는 칸(복사본 변경 여부 등)이 있다. 열 때 한 번 맞춘다.
  useEffect(() => {
    void actions.refreshSessions()
  }, [])
  const t = useT()
  const narrow = s.isNarrow
  const item = s.sessions.find((x) => x.id === sessionId)
  const reasonId = useId()
  const errorId = useId()
  const [purpose, setPurpose] = useState<HandoffPurpose>('continue')
  const [focus, setFocus] = useState('')
  const [includeMethod, setIncludeMethod] = useState(true)
  const [recipientOpen, setRecipientOpen] = useState(false)
  const [copyOnly, setCopyOnly] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 복사본에서 일하던 세션은 원 폴더에서 이어 간다(복사본은 이 세션과 함께 사라진다).
  const defaultFolder = item?.workspaceSource || item?.cwd || ''
  const can = canSubmitHandoff(purpose, focus)
  const otherProviders = (s.providers ?? []).filter((p) => p.id !== item?.provider)
  const sameLabel = t('handoff.to.same')
  const toSummary = copyOnly
    ? t('handoff.to.copyOnly')
    : providerId || (folder && folder !== defaultFolder)
      ? [providerId ? otherProviders.find((p) => p.id === providerId)?.displayName : t('handoff.to.sameAi'), folder && folder !== defaultFolder ? folder : t('handoff.to.originalFolder')]
          .filter(Boolean)
          .join(' · ')
      : sameLabel
  const dirty = !!item?.isolated && !!item.needsApply

  async function submit() {
    if (busy || !can) return
    setBusy(true)
    setError('')
    const r = await actions.startHandoff(sessionId, {
      purpose,
      ...(focus.trim() ? { focus: focus.trim() } : {}),
      includeMethod,
      ...(copyOnly ? { copyOnly: true } : {}),
      ...(!copyOnly && providerId ? { provider: providerId } : {}),
      ...(!copyOnly && folder && folder !== defaultFolder ? { cwd: folder } : {}),
    })
    setBusy(false)
    if (!r.ok) setError(r.error)
  }

  const submitBtn = (
    <Button
      key="submit"
      tone="primary"
      height={narrow ? 50 : 40}
      paddingX={18}
      fontSize={15}
      fullWidth={narrow}
      disabled={busy || !can}
      aria-describedby={!can ? reasonId : error ? errorId : undefined}
      data-session-opt="handoff-submit"
      onClick={() => void submit()}
    >
      {busy ? t('handoff.submitting') : t('handoff.submit')}
    </Button>
  )
  const cancelBtn = (
    <Button key="cancel" tone="gray" height={narrow ? 50 : 40} paddingX={18} fontSize={15} fullWidth={narrow} disabled={busy} onClick={actions.closeHandoff}>
      {t('handoff.cancel')}
    </Button>
  )

  return (
    <ModalShell onClose={actions.closeHandoff} zIndex={Z.root.handoff}>
      <Anchor rect={rect}>
      <ModalCard variant="sheet" maxWidth={480} style={CARD_CLICKABLE} data-window="handoff" data-modal="handoff">
        <ModalHeader title={t('handoff.title')} onClose={actions.closeHandoff} closeLabel={t('common.close')} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22, minWidth: 0 }}>
          <section>
            <GroupTitle>{t('handoff.purpose.label')}</GroupTitle>
            <SegmentedControl
              items={HANDOFF_PURPOSES.map((p) => ({ value: p, label: t(`handoff.purpose.${p}`) }))}
              value={purpose}
              onChange={setPurpose}
              fullWidth
              fontSize={13.5}
              itemHeight={narrow ? 44 : 32}
            />
          </section>

          <section>
            <GroupTitle>{t(`handoff.focus.label.${purpose}`)}</GroupTitle>
            <textarea
              className="sheet-field"
              aria-label={t(`handoff.focus.label.${purpose}`)}
              aria-required={purpose === 'next'}
              value={focus}
              maxLength={HANDOFF_FOCUS_MAX}
              rows={3}
              disabled={busy}
              placeholder={t(`handoff.focus.placeholder.${purpose}`)}
              onChange={(e) => setFocus(e.target.value)}
              style={{ ...fieldStyle(), minHeight: 88, padding: '12px 16px', resize: 'vertical', lineHeight: 1.45 }}
            />
          </section>

          <section>
            <div className="flex items-center" style={{ gap: 12, padding: '0 16px', minHeight: narrow ? 44 : 32 }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{t('handoff.method')}</span>
              <Switch on={includeMethod} onChange={setIncludeMethod} label={t('handoff.method')} disabled={busy} data-session-opt="handoff-method" />
            </div>
            <p style={{ fontSize: 13, color: C.label2, lineHeight: 1.45, margin: '4px 0 0', padding: '0 16px' }}>{t('handoff.method.note')}</p>
          </section>

          <section>
            <GroupTitle>{t('handoff.to.label')}</GroupTitle>
            <button
              type="button"
              className="press"
              aria-expanded={recipientOpen}
              data-session-opt="handoff-recipient"
              onClick={() => setRecipientOpen((v) => !v)}
              style={{ ...fieldStyle(), display: 'flex', alignItems: 'center', gap: 8, minHeight: narrow ? 50 : 44, padding: '0 16px', textAlign: 'left', cursor: 'pointer' }}
            >
              <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{toSummary}</span>
              <ChevronRight size={17} aria-hidden style={{ flexShrink: 0, color: C.label3, transform: recipientOpen ? 'rotate(90deg)' : undefined, transition: 'transform var(--dur-fast, 150ms)' }} />
            </button>
            {recipientOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12 }}>
                <div>
                  <div className="flex items-center" style={{ gap: 12, padding: '0 16px', minHeight: narrow ? 44 : 32 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{t('handoff.to.copyOnly')}</span>
                    <Switch on={copyOnly} onChange={setCopyOnly} label={t('handoff.to.copyOnly')} disabled={busy} data-session-opt="handoff-copy-only" />
                  </div>
                  <p style={{ fontSize: 13, color: C.label2, lineHeight: 1.45, margin: '4px 0 0', padding: '0 16px' }}>{t('handoff.to.copyOnlyNote')}</p>
                </div>
                {!copyOnly && otherProviders.length > 0 && (
                  <div>
                    <GroupTitle>{t('handoff.to.ai')}</GroupTitle>
                    <SegmentedControl
                      items={[{ value: '', label: t('handoff.to.sameAi') }, ...otherProviders.map((p) => ({ value: p.id, label: p.displayName }))]}
                      value={providerId}
                      onChange={setProviderId}
                      fullWidth
                      scrollable
                      fontSize={13.5}
                      itemHeight={narrow ? 44 : 32}
                    />
                  </div>
                )}
                {!copyOnly && <RecipientFolders defaultFolder={defaultFolder} picked={folder ?? defaultFolder} onPick={setFolder} disabled={busy} />}
              </div>
            )}
            {dirty && (
              <div role="note" className="flex items-start" style={{ gap: 6, marginTop: 10, padding: '0 16px', fontSize: 13, lineHeight: 1.45, color: C.attn }}>
                <AlertTriangle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
                <span>{t('handoff.copyDirty')}</span>
              </div>
            )}
          </section>
        </div>
        <ModalFooter>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', alignItems: 'stretch', padding: error || !can ? '8px 0' : undefined }}>
            {!can && (
              <p id={reasonId} style={{ margin: 0, padding: '0 4px', fontSize: 13, lineHeight: 1.45, color: C.label2, textAlign: narrow ? 'center' : 'right' }}>
                {t('handoff.needFocus')}
              </p>
            )}
            {error && (
              <p id={errorId} role="alert" style={{ margin: 0, padding: '0 4px', fontSize: 13, lineHeight: 1.45, color: C.del, textAlign: 'left' }}>
                {t('handoff.error', { error })}
              </p>
            )}
            <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', justifyContent: 'flex-end', gap: 8 }}>
              {narrow ? [submitBtn, cancelBtn] : [cancelBtn, submitBtn]}
            </div>
          </div>
        </ModalFooter>
      </ModalCard>
      </Anchor>
    </ModalShell>
  )
}

/** 받을 폴더 고르기 — 이 세션의 폴더와 최근 폴더. 열렸을 때만 서버 위치 정보를 받는다. */
function RecipientFolders({ defaultFolder, picked, onPick, disabled }: { defaultFolder: string; picked: string; onPick: (path: string) => void; disabled: boolean }) {
  const t = useT()
  const s = useStore()
  const browser = useFolderBrowser()
  const rows = [defaultFolder, ...recentFolders(s.sessions, RECENT_FOLDERS)].filter((p, i, a) => p && a.indexOf(p) === i).slice(0, RECENT_FOLDERS + 1)
  return (
    <div>
      <GroupTitle>{t('handoff.to.folder')}</GroupTitle>
      <FolderChoices
        home={browser.places?.home ?? ''}
        rows={rows}
        picked={picked}
        ready
        failed={false}
        disabled={disabled}
        onPick={onPick}
        onRetry={() => void browser.loadPlaces()}
      />
    </div>
  )
}

function WaitingWindow({ sessionId }: { sessionId: string }) {
  const rect = useAnchor(sessionId)
  const t = useT()
  const narrow = useStore().isNarrow
  const okRef = useRef<HTMLButtonElement>(null)
  return (
    <ModalShell onClose={actions.closeHandoff} zIndex={Z.root.handoff} initialFocusRef={okRef}>
      <Anchor rect={rect}>
      <ModalCard variant="sheet" maxWidth={420} style={CARD_CLICKABLE} data-window="handoff" data-modal="handoff-waiting">
        <ModalHeader title={t('handoff.waiting.title')} onClose={actions.closeHandoff} closeLabel={t('common.close')} />
        <p role="status" style={{ margin: 0, fontSize: 15, lineHeight: 1.5, color: C.label }}>{t('handoff.waiting.body')}</p>
        <ModalFooter>
          <Button ref={okRef} tone="primary" height={narrow ? 50 : 40} paddingX={18} fontSize={15} fullWidth={narrow} onClick={actions.closeHandoff}>
            {t('handoff.waiting.ok')}
          </Button>
        </ModalFooter>
      </ModalCard>
      </Anchor>
    </ModalShell>
  )
}

function ResultWindow({ sessionId }: { sessionId: string }) {
  const rect = useAnchor(sessionId)
  const t = useT()
  const narrow = useStore().isNarrow
  const [info, setInfo] = useState<HandoffInfo | null>(null)
  const [loadError, setLoadError] = useState('')
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle')
  const boxRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let alive = true
    api.getHandoff(sessionId)
      .then((r) => alive && setInfo(r))
      .catch((e: unknown) => alive && setLoadError(errMsg(e)))
    return () => {
      alive = false
    }
  }, [sessionId])
  useEffect(() => {
    if (copied === 'idle') return
    const id = window.setTimeout(() => setCopied('idle'), 2000)
    return () => window.clearTimeout(id)
  }, [copied])

  const result = info?.result
  async function copy() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.text)
      setCopied('ok')
    } catch {
      boxRef.current?.select() // 클립보드를 못 쓰면 글을 골라 두어 직접 복사하게 한다
      setCopied('failed')
    }
  }
  // 결과를 다 읽었다. 서버에 남은 글을 지우고 닫는다. 지우기에 실패해도 창은 닫는다(다음에 새로 넘기면 덮어쓴다).
  function finish() {
    void api.clearHandoff(sessionId).catch(() => undefined)
    actions.closeHandoff()
  }

  return (
    <ModalShell onClose={actions.closeHandoff} zIndex={Z.root.handoff}>
      <Anchor rect={rect}>
      <ModalCard variant="sheet" maxWidth={560} style={CARD_CLICKABLE} data-window="handoff" data-modal="handoff-result">
        <ModalHeader title={t('handoff.result.title')} onClose={actions.closeHandoff} closeLabel={t('common.close')} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          {loadError && <p role="alert" style={{ margin: 0, fontSize: 13, color: C.del }}>{t('handoff.result.failed', { error: loadError })}</p>}
          {!info && !loadError && <p role="status" style={{ margin: 0, fontSize: 13, color: C.label2 }}>{t('handoff.result.loading')}</p>}
          {result?.error && <p role="alert" style={{ margin: 0, fontSize: 13, lineHeight: 1.45, color: C.del }}>{result.error}</p>}
          {result?.source === 'skeleton' && <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45, color: C.label2 }}>{t('handoff.result.skeleton')}</p>}
          {result && (
            <textarea
              ref={boxRef}
              readOnly
              aria-label={t('handoff.result.label')}
              value={result.text}
              rows={12}
              style={{ ...fieldStyle(), padding: '12px 16px', resize: 'vertical', lineHeight: 1.45, fontFamily: FONT.mono, fontSize: 13 }}
            />
          )}
          <p role="status" aria-live="polite" style={{ margin: 0, minHeight: 18, fontSize: 13, color: copied === 'failed' ? C.del : C.label2 }}>
            {copied === 'ok' ? t('handoff.result.copied') : copied === 'failed' ? t('handoff.result.copyFailed') : ''}
          </p>
        </div>
        <ModalFooter>
          <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', justifyContent: 'flex-end', gap: 8, width: '100%' }}>
            {(() => {
              const copyBtn = (
                <Button key="copy" tone="primary" height={narrow ? 50 : 40} paddingX={18} fontSize={15} fullWidth={narrow} disabled={!result} onClick={() => void copy()}>
                  {t('handoff.result.copy')}
                </Button>
              )
              const closeBtn = (
                <Button key="close" tone="gray" height={narrow ? 50 : 40} paddingX={18} fontSize={15} fullWidth={narrow} onClick={finish}>
                  {t('handoff.result.close')}
                </Button>
              )
              return narrow ? [copyBtn, closeBtn] : [closeBtn, copyBtn]
            })()}
          </div>
        </ModalFooter>
      </ModalCard>
      </Anchor>
    </ModalShell>
  )
}
