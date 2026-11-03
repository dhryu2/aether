// 새 작업 창. 이름, 폴더, 서비스, 모델, 안전을 묶음으로 고르고 발을 눌러 만든다.
// 모델 목록은 창을 열 때 저장본을 한 번 받는다. 서비스를 바꿔 눌러도 요청이나 프로그램 실행이 늘지 않는다.
// 폴더는 최근 폴더를 바로 고르고, 다른 폴더는 같은 창 안의 탐색 화면으로 넘어가 고른다.
import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { flushSync } from 'react-dom'
import { actions, defaultNewSessionProvider, getState, newSessionFolderCandidates, useStore } from '../lib/store'
import { recentFolders } from '../lib/sessionGroups'
import { useT } from '../lib/i18n'
import { api } from '../lib/api'
import type { ModelInfo } from '../lib/types'
import { reportClientError } from '../lib/errorReporting'
import { newSessionProviderView, type AvailabilityState, type ProviderListState } from '../lib/newSessionProviders'
import { C, Z } from '../design/tokens'
import { Button, ModalCard, ModalFooter, ModalHeader, ModalShell } from './ui'
import { GroupTitle } from './settings/parts'
import { FolderChoices } from './folderPicker/FolderChoices'
import { FolderExplorer } from './folderPicker/FolderExplorer'
import { isWideFolder, seedFolder } from './folderPicker/explorerModel'
import { useFolderBrowser } from './folderPicker/useFolderBrowser'
import { SafetyBlock, ServiceBlock } from './newSession/blocks'
import { fieldStyle } from './newSession/fieldStyle'

const RECENT_FOLDERS = 4

// 창을 열 때마다 안을 새로 띄운다. 그래서 선택값과 폴더 목록은 늘 기본값과 새 목록에서 시작한다.
export function NewSessionModal() {
  const open = useStore().modalOpen
  return open ? <NewSessionWindow /> : null
}

function NewSessionWindow() {
  const s = useStore()
  const t = useT()
  const narrow = s.isNarrow
  const nameRef = useRef<HTMLInputElement>(null)
  const pickedRowRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef(false)
  const browser = useFolderBrowser()
  const { load } = browser
  // 폴더 헤더에서 열면 그 폴더. 아니면 지금 보는 세션의 폴더, 그다음 최근 폴더. 후보가 없으면 홈이다.
  const [folderSeed] = useState(() => {
    const st = getState()
    return st.modalCwd ? [st.modalCwd] : newSessionFolderCandidates(st)
  })
  // 사람이 직접 고른 폴더(절대 경로). 아직 안 골랐으면 null이고, 홈 경로를 안 뒤에 위 후보에서 정한다.
  const [folderChoice, setFolderChoice] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  // 본문이 들어오는 방향. 폴더 찾기로 들어가면 오른쪽에서(r), 나오면 왼쪽에서(l). 처음 열 때는 없다.
  const [dir, setDir] = useState<'r' | 'l' | null>(null)
  // 탐색 화면이 알려 주는 "고를 폴더". 위치 화면처럼 고를 폴더가 없으면 null.
  const [browseTarget, setBrowseTarget] = useState<string | null>(null)
  // 탐색 화면이 열려 있는 동안 창 높이를 새 작업 화면 높이로 둔다. 목록이 짧다고 창이 갑자기 줄어들지 않게.
  const [browseMinH, setBrowseMinH] = useState<number | null>(null)
  const [name, setName] = useState('')
  // 복사본에서 작업은 끈 채로 시작한다(사용자 결정). 켜면 원 폴더와 떨어진 복사본에서 일한다.
  const [isolate, setIsolate] = useState(false)
  const [model, setModel] = useState('')
  const [rememberedModels, setRememberedModels] = useState<Record<string, ModelInfo[]>>({})
  const [provider, setProvider] = useState(() => defaultNewSessionProvider(getState()))
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [fanout, setFanout] = useState(false)
  const [pickedProviders, setPickedProviders] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  // 서비스마다 지금 고를 수 있는지. 받기 전(null)이나 받지 못했으면('failed') 막지 않는다. 서버가 만들 때 다시 확인한다.
  const [availability, setAvailability] = useState<AvailabilityState>(null)

  // 부팅 때 서비스 목록을 못 받았으면(비어 있으면) 창이 열릴 때 다시 받는다. 안 그러면 새로고침 전까지 세션을 못 만든다.
  const providerListEmpty = !s.providers?.length
  // 받는 중과 받기 실패를 나눠 보여준다. 목록이 이미 있으면 상태는 쓰이지 않는다.
  const [listState, setListState] = useState<ProviderListState>('loading')
  useEffect(() => {
    if (!providerListEmpty) return
    let alive = true
    setListState('loading')
    // 요청이 끝났는데도(실패했거나 성공했지만 목록이 비었음) 이 창이 열려 있으면 목록 안내(noList)를 보인다. 받아서 목록이 차면 이 상태는 안 쓰인다.
    void actions.loadProviders().then(() => {
      if (alive) setListState('failed')
    })
    return () => {
      alive = false
    }
  }, [providerListEmpty])

  useEffect(() => {
    let alive = true
    api.providerAvailability()
      .then((r) => {
        if (alive) setAvailability(r.availability)
      })
      .catch((error) => {
        reportClientError(error, { component: 'session', operation: 'web.new_session.availability', severity: 'warning' })
        if (alive) setAvailability('failed')
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    api.rememberedModels()
      .then((r) => {
        if (alive) setRememberedModels(r.models)
      })
      .catch((error) => {
        // 못 받아도 기본 모델로 시작할 수 있으므로 막지 않는다.
        reportClientError(error, { component: 'session', operation: 'web.new_session.models', severity: 'warning' })
      })
    return () => {
      alive = false
    }
  }, [])

  const places = browser.places
  const seeded = places !== undefined
  const picked = folderChoice ?? (places ? seedFolder(folderSeed, places.home) : '')
  // 고른 폴더가 복사본을 쓸 수 있는지 모르면 그 폴더를 한 번 물어본다. 못 쓰는 폴더면 복사본 스위치가 꺼지고 잠긴다.
  const pickedCanCopy = browser.canCopyOf(picked)
  const canCopy = pickedCanCopy !== false
  useEffect(() => {
    if (seeded && picked && pickedCanCopy === undefined) void load(picked)
  }, [seeded, picked, pickedCanCopy, load])

  // 탐색 화면에서 돌아오면 초점을 고른 폴더 줄로 돌려준다. 누른 버튼은 이미 사라졌다.
  useEffect(() => {
    if (browsing || !returnFocusRef.current) return
    returnFocusRef.current = false
    pickedRowRef.current?.focus()
  }, [browsing, picked])

  const providers = s.providers ?? []
  // 고른 서비스를 쓸 수 없으면 쓸 수 있는 첫 서비스로 시작한다. 하나도 없으면 고른 서비스가 없고 시작할 수 없다.
  const view = newSessionProviderView(s.providers, availability, provider, listState)
  const { usable, chosen } = view
  const unavailable = (id: string): string | undefined => {
    const a = view.unavailableOf(id)
    if (!a) return undefined
    return a.requires
      ? t('session.newSession.providerUnavailable.requires', { requires: a.requires })
      : t(`session.newSession.providerUnavailable.${a.reason}`)
  }
  const selectedIds = fanout
    ? usable.filter((p) => pickedProviders.includes(p.id)).map((p) => p.id)
    : (chosen ? [chosen.id] : [])

  const modelRows = (chosen && rememberedModels[chosen.id]) || []
  // 고른 서비스가 쓸 수 없게 바뀌어 다른 서비스로 넘어가면 그 목록에 없는 값은 기본 모델로 돌아간다.
  const pickedModel = modelRows.some((m) => m.value === model) ? model : ''

  const onProvider = (id: string) => (fanout ? pickedProviders.includes(id) : id === chosen?.id)
  const rootFailed = browser.placesFailed
  const folderReady = seeded || rootFailed
  const recents = recentFolders(s.sessions, RECENT_FOLDERS)
  const folderRows = !picked || recents.includes(picked) ? recents : [picked, ...recents].slice(0, RECENT_FOLDERS)
  const startLabel = creating
    ? t('session.newSession.creating')
    : fanout
      ? t('session.newSession.fanout.start', { count: selectedIds.length })
      : t('session.newSession.start')

  function openBrowser() {
    if (creating) return
    setBrowseMinH(nameRef.current?.closest<HTMLElement>('[data-window="new-session"]')?.offsetHeight ?? null)
    setBrowseTarget(null)
    swapBrowsing(true)
  }

  function closeBrowser(pick?: string) {
    if (pick !== undefined) setFolderChoice(pick)
    returnFocusRef.current = true
    swapBrowsing(false)
  }

  // 창 크기(520↔760)가 바뀌므로 브라우저 View Transitions로 이어 준다. 없거나 움직임 줄이기면 그냥 바꾼다.
  //   이름은 전환하는 동안만 붙인다 — 닫히는 잔상 복사본과 이름이 겹치지 않게.
  function swapBrowsing(next: boolean) {
    const apply = () => { setDir(next ? 'r' : 'l'); setBrowsing(next) }
    const card = document.querySelector<HTMLElement>('[data-window="new-session"]')
    if (!card || !document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      apply()
      return
    }
    card.style.viewTransitionName = 'new-session-window'
    document.startViewTransition(() => flushSync(apply)).finished.finally(() => { card.style.viewTransitionName = '' })
  }

  function chooseProvider(id: string) {
    if (creating || unavailable(id)) return
    if (!fanout) {
      setProvider(id)
      if (id !== chosen?.id) setModel('')
      return
    }
    setPickedProviders((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function setFanoutMode(next: boolean) {
    if (creating) return
    if (!next) {
      if (pickedProviders[0]) setProvider(pickedProviders[0])
      setModel('')
      setPrompt('')
      setFanout(false)
      return
    }
    const seed = chosen?.id
    setPickedProviders(seed ? [seed] : [])
    setFanout(true)
  }

  async function start() {
    if (creating) return
    const useCopy = isolate && canCopy
    if (fanout && selectedIds.length === 0) {
      setError(t('session.newSession.fanout.needProvider'))
      return
    }
    const soloId = chosen?.id
    if (!fanout && !soloId) return // 고를 서비스가 없으면 만드는 중 상태로 들어가지 않는다(이름 칸 Enter로도 들어올 수 있다)
    setCreating(true)
    setError('')
    const opts = { isolateWorkspace: useCopy, name: name.trim() || undefined }
    const r = fanout
      ? await actions.startSameWork(picked || undefined, { ...opts, providers: selectedIds, prompt })
      : await actions.createSession(picked || undefined, { ...opts, provider: soloId ?? '', model: pickedModel || undefined })
    setCreating(false)
    if (!r.ok) {
      setError(r.error)
      setModel('')
    }
  }

  return (
    <ModalShell
      onClose={browsing ? () => closeBrowser() : actions.closeModal}
      zIndex={Z.root.newSession}
      initialFocusRef={narrow ? undefined : nameRef}
    >
      <ModalCard
        variant="sheet"
        maxWidth={browsing && !narrow ? 760 : 520}
        data-window="new-session"
        data-modal="new-session"
        data-fanout={fanout ? '1' : undefined}
        data-folder-browsing={browsing ? '1' : undefined}
        style={browsing && browseMinH ? { minHeight: browseMinH } : undefined}
      >
        {browsing ? (
          <ModalHeader
            title={t('session.folderPicker.browseTitle')}
            onClose={actions.closeModal}
            closeLabel={t('common.close')}
            onBack={() => closeBrowser()}
            backLabel={t('session.folderPicker.back')}
          />
        ) : (
          <ModalHeader title={t('session.newSession.title')} onClose={actions.closeModal} closeLabel={t('common.close')} />
        )}
        {browsing ? (
          <div className={dir === 'r' ? 'tab-in-r' : undefined}>
            <FolderExplorer browser={browser} quick={recents} initialAt={picked} narrow={narrow} onTargetChange={setBrowseTarget} />
          </div>
        ) : (
          <div className={dir === 'l' ? 'tab-in-l' : undefined} style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
            <section>
              <GroupTitle>{t('session.newSession.nameLabel')}</GroupTitle>
              <input
                ref={nameRef}
                className="sheet-field"
                aria-label={t('session.newSession.nameLabel')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder={t('session.newSession.namePlaceholder')}
                disabled={creating}
                style={{ ...fieldStyle(), height: narrow ? 50 : 44, padding: '0 16px' }}
              />
            </section>

            <section>
              <GroupTitle>{t('session.newSession.folderLabel')}</GroupTitle>
              <FolderChoices
                home={places?.home ?? ''}
                rows={folderRows}
                picked={picked}
                ready={seeded}
                failed={rootFailed}
                disabled={creating}
                onPick={setFolderChoice}
                onBrowse={openBrowser}
                onRetry={() => void browser.loadPlaces()}
                pickedRef={pickedRowRef}
              />
              {places && picked !== '' && isWideFolder(picked, places) && (
                <p style={{ fontSize: 13, color: C.label2, lineHeight: 1.45, margin: '8px 0 0', padding: '0 16px' }}>
                  {t('session.folderPicker.wide')}
                </p>
              )}
            </section>

            {providers.length > 1 && (
              <section>
                <GroupTitle>{t('session.newSession.providerLabel')}</GroupTitle>
                <ServiceBlock
                  label={t('session.newSession.providerLabel')}
                  providers={providers}
                  fanout={fanout}
                  creating={creating}
                  isOn={onProvider}
                  onChoose={chooseProvider}
                  fanoutTitle={t('session.newSession.fanout.title')}
                  onFanout={setFanoutMode}
                  unavailable={unavailable}
                />
                <p style={{ fontSize: 13, color: C.label2, lineHeight: 1.45, margin: '8px 0 0', padding: '0 16px' }}>
                  {t('session.newSession.providerHint')}
                </p>
              </section>
            )}

            {view.notice === 'noProvider' && (
              <p role="status" data-session-opt="no-provider" style={{ fontSize: 13, color: C.del, lineHeight: 1.45, margin: 0, padding: '0 16px' }}>
                {t('session.newSession.noProvider')}
              </p>
            )}
            {view.notice === 'listLoading' && (
              <p role="status" data-session-opt="provider-list-loading" style={{ fontSize: 13, color: C.label2, lineHeight: 1.45, margin: 0, padding: '0 16px' }}>
                {t('session.newSession.providerListLoading')}
              </p>
            )}
            {view.notice === 'noList' && (
              <p role="status" data-session-opt="no-provider-list" style={{ fontSize: 13, color: C.del, lineHeight: 1.45, margin: 0, padding: '0 16px' }}>
                {t('session.newSession.noProviderList')}
              </p>
            )}
            {view.notice === 'checkFailed' && (
              <p role="status" data-session-opt="availability-failed" style={{ fontSize: 13, color: C.label2, lineHeight: 1.45, margin: 0, padding: '0 16px' }}>
                {t('session.newSession.availabilityFailed')}
              </p>
            )}

            {fanout && (
              <section>
                <GroupTitle>{t('session.newSession.fanout.promptLabel')}</GroupTitle>
                <textarea
                  className="sheet-field"
                  data-session-opt="fanout-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t('session.newSession.fanout.promptPlaceholder')}
                  disabled={creating}
                  rows={3}
                  style={{ ...fieldStyle(), minHeight: 88, padding: '12px 16px', resize: 'vertical', lineHeight: 1.45 }}
                />
              </section>
            )}

            {!fanout && chosen && (
              <section>
                <GroupTitle>{t('session.newSession.modelLabel')}</GroupTitle>
                <span style={{ position: 'relative', display: 'block' }}>
                  <select
                    className="sheet-field"
                    aria-label={t('session.newSession.modelLabel')}
                    data-session-opt="new-session-model"
                    value={pickedModel}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={creating || modelRows.length === 0}
                    style={{ ...fieldStyle(), height: narrow ? 50 : 44, padding: '0 40px 0 16px', appearance: 'none', cursor: modelRows.length ? 'pointer' : 'default' }}
                  >
                    <option value="">{t('session.newSession.modelDefault')}</option>
                    {modelRows.map((m) => <option key={m.value} value={m.value}>{m.displayName}</option>)}
                  </select>
                  {modelRows.length > 0 && <ChevronDown aria-hidden size={16} style={{ position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: C.label3 }} />}
                </span>
                <p style={{ fontSize: 13, color: C.label2, lineHeight: 1.45, margin: '8px 0 0', padding: '0 16px' }}>
                  {t(modelRows.length ? 'session.newSession.modelHint' : 'session.newSession.modelHintEmpty')}
                </p>
              </section>
            )}

            <section>
              <GroupTitle>{t('session.newSession.safety')}</GroupTitle>
              <SafetyBlock
                copyTitle={t('session.newSession.isolate.title')}
                copyOn={isolate && canCopy}
                copyDisabled={!canCopy}
                onCopy={(next) => { if (canCopy) setIsolate(next) }}
                note={canCopy ? t('session.newSession.isolate.desc') : t('session.newSession.isolate.unavailable')}
                noteUnavailable={!canCopy}
              />
            </section>
          </div>
        )}
        {browsing ? (
          <ModalFooter>
            <Button
              tone="primary"
              height={narrow ? 50 : 40}
              paddingX={18}
              fontSize={15}
              fullWidth={narrow}
              data-folder-choose=""
              disabled={browseTarget === null}
              onClick={() => browseTarget !== null && closeBrowser(browseTarget)}
              style={narrow ? undefined : { alignSelf: 'center' }}
            >
              {t('session.folderPicker.choose')}
            </Button>
          </ModalFooter>
        ) : (
          <ModalFooter>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', alignItems: 'stretch', padding: error ? '8px 0' : undefined }}>
              {error && (
                <p role="alert" style={{ margin: 0, width: '100%', padding: '0 16px', fontSize: 13, lineHeight: 1.45, color: C.del, textAlign: 'left' }}>
                  {error}
                </p>
              )}
              <Button
                tone="primary"
                height={narrow ? 50 : 40}
                paddingX={18}
                fontSize={15}
                fullWidth={narrow}
                disabled={creating || !folderReady || (fanout && selectedIds.length === 0) || (!fanout && !chosen)}
                data-session-opt="new-session-start"
                data-fanout-ids={fanout ? selectedIds.join(',') : undefined}
                onClick={() => void start()}
                style={narrow ? undefined : { alignSelf: 'flex-end' }}
              >
                {startLabel}
              </Button>
            </div>
          </ModalFooter>
        )}
      </ModalCard>
    </ModalShell>
  )
}
