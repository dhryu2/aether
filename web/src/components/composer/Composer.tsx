// W16. Composer — 자동확장 멀티라인 입력 + 전송↑ + Stop. running/requires 시 Stop 노출, idle+텍스트일 때만 전송 활성.
//  · 모바일: textarea(1→N줄 자동확장, 상한 후 내부 스크롤), 안전영역 하단 패딩, 터치 타깃 확대.
//  · Enter=전송 / Shift+Enter=줄바꿈. IME(한글) 조합 중 Enter는 전송 안 함(조합 확정용).
//  · ``` 또는 ~~~ 만 있는 줄에서 Shift+Enter 는 코드 상자를 연다. 상자 안에서는 Enter 도 줄바꿈이다.
//  · 세션별 드래프트(⑤): 입력을 활성세션 키로 sessionStorage 보관 → 전환 시 분리·새로고침 생존.
//  · 슬래시 메뉴(⑥): "/" 입력 시 명령 목록(필터·↑↓·Enter/Tab 채우기·Esc 닫기)으로 발견성 제공.
//  화면 조각은 composer/ 아래로, 순수 로직은 lib/attachments.ts·lib/slashCommands.ts·lib/composerBlocks.ts로 분리했다.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { actions, composerTurn, modelList, pendingPermission, queuedFor, slashCommandsFor, slashRichFor, supportedEfforts, useStore, isSplit } from '../../lib/store'
import { drafts } from '../../lib/drafts'
import { useDismiss, useSignal } from '../../lib/hooks'
import {
  blocksFromMessage,
  closeCodeAt,
  decodeDraft,
  encodeDraft,
  neighborBlock,
  openCodeAt,
  removeEmptyCode,
  serializeBlocks,
  setBlockValue,
  soleText,
  textBlock,
  toggleCodeCollapsed,
  type ComposerBlock,
} from '../../lib/composerBlocks'
import { useT } from '../../lib/i18n'
import { reloadGuard } from '../../lib/contractReload'
import { MAX_ATTACH, parseFiles, type Attachment } from '../../lib/attachments'
import { buildSlashCmds, parseSlashCommand, withBriefAlias, type SlashCmd } from '../../lib/slashCommands'
import { ctxOf } from '../ctxOf'
import { UsageChip } from '../UsageChip'
import { LimitChip } from './LimitChip'
import { ModelPicker } from '../ModelPicker'
import { EffortPicker } from '../EffortPicker'
import { PermissionPicker } from '../PermissionPicker'
import { ComposerCodeBox } from './ComposerCodeBox'
import { ComposerTextarea, MAX_TA_HEIGHT } from './ComposerTextarea'
import { PermissionQuickBar } from './PermissionQuickBar'
import { SlashMenu } from './SlashMenu'
import { AttachmentPreview } from './AttachmentPreview'
import { browseDown, browseUp, promptsFor, rememberPrompt, type HistoryBrowse } from '../../lib/promptHistory'
import { ComposerPlusMenu } from './ComposerPlusMenu'
import { MicButton } from './MicButton'
import { InterruptButton } from './InterruptButton'
import { SendButton } from './SendButton'
import { api } from '../../lib/api'
import { BackgroundAnnouncer, BackgroundTasksStrip } from './BackgroundTasksStrip'
import { AutoResumeBar } from './AutoResumeBar'
import { HandoffNote } from './HandoffNote'
import type { BackgroundTask, HandoffSource, ImageAttachment, DocAttachment } from '../../lib/types'
import { findRoom, executionId as roomExecutionId } from '../../lib/workspaceRooms'

const NO_TASKS: BackgroundTask[] = [] // 빈 목록을 렌더마다 새로 만들지 않는다(효과 의존성 안정)

/** 칸 폭이 이보다 좁으면 칩 글자를 줄인다. 칸 최소 폭 420에서도 전송 버튼을 밀지 않게 하는 값이다. */
const CHIPS_TIGHT_W = 500
/** 칸 폭이 이보다 좁으면 평소 사용량을 뺀다. 주황으로 바뀌는 경계(CTX_WARN_PCT)부터는 남긴다. */
const USAGE_MIN_W = 600
const CTX_WARN_PCT = 70
/** 칸 높이가 이보다 낮으면 글 칸을 일찍 스크롤시킨다. 긴 글을 쓰는 동안에도 대화가 몇 줄은 보이게 하는 값이다. */
const SHORT_PANE_H = 420
const SHORT_PANE_TA = 88

export function Composer({ sessionId }: { sessionId: string }) {
  const s = useStore()
  const t = useT()
  const room = findRoom(s.rooms, sessionId)
  const execId = roomExecutionId(room) ?? sessionId
  // provider interface가 돌려준 실제 지원 명령. /model·/effort의 인자 힌트는 이 세션이 알려준 실제 값으로 채운다
  //   — 둘은 Aether 공통 명령이라 화면이 현재 카탈로그 값을 보강해도 provider 결합이 생기지 않는다.
  // 별칭은 서버 목록 뒤에 붙인다. 앞쪽 순서를 바꾸면 화살표로 고르는 명령이 달라진다.
  const SLASH_CMDS = withBriefAlias(
    buildSlashCmds(slashCommandsFor(s, execId), slashRichFor(s, execId), s.locale, {
      model: modelList(s).map((m) => m.value).join(' · '),
      effort: supportedEfforts(s).join(' · '),
    }),
    t('composer.slash.brief'),
  )
  const active = execId ? s.sessions.find((x) => x.id === execId) : undefined
  const split = isSplit(s)
  const turn = composerTurn(s, execId)
  const bgTasks = active?.backgroundTasks ?? NO_TASKS
  // 중지를 보낸 뒤 목록이 바뀔 때까지 그 작업의 중지 버튼은 비활성이다. 실패하면(오류 안내는 공통 API가 낸다) 다시 누를 수 있게 푼다.
  const [bgStopping, setBgStopping] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    setBgStopping((cur) => {
      const live = new Set(bgTasks.map((x) => x.id))
      const next = new Set([...cur].filter((id) => live.has(id)))
      return next.size === cur.size ? cur : next
    })
  }, [bgTasks])
  const stopBgTask = (taskId: string) => {
    if (!execId) return
    setBgStopping((cur) => new Set(cur).add(taskId))
    void api.stopBackgroundTask(execId, taskId).catch(() => {
      setBgStopping((cur) => {
        const next = new Set(cur)
        next.delete(taskId)
        return next
      })
    })
  }
  const [blocks, setBlocks] = useState<ComposerBlock[]>(() => decodeDraft(drafts.get(sessionId))) // 드래프트 키=방 id
  const [attach, setAttach] = useState<Attachment[]>([]) // 첨부 파일(전송 전 대기, 드래프트엔 미포함=휘발)
  const hasAttach = attach.length > 0
  useEffect(() => {
    if (!hasAttach) return
    reloadGuard.attachments++ // 첨부가 남은 칸이 있으면 자동 새로고침을 미룬다(칸이 여럿이라 개수로 센다)
    return () => { reloadGuard.attachments-- }
  }, [hasAttach])
  const [attachNote, setAttachNote] = useState('') // 형식·크기·개수 초과 안내(잠깐 표시)
  const [slashSel, setSlashSel] = useState(0)
  const [sent, setSent] = useState(0) // 보낸 횟수 — 바뀔 때마다 전송 버튼이 한 번 눌린다(SendButton)
  const [slashClosed, setSlashClosed] = useState(false) // Esc로 닫음(다음 입력 시 재오픈)
  const [browse, setBrowse] = useState<HistoryBrowse>({ cursor: null, draft: '' })
  const idRef = useRef(sessionId)
  // 넘겨받은 인계서가 아직 보내지지 않았다. 입력창이 비어 있으면(다른 기기에서 열었을 때 등) 서버에서 받아 채운다.
  const handoffFrom = room?.handoffDraftPending ? room.handoffFrom : undefined
  const [handoffInfo, setHandoffInfo] = useState<{ execId: string; source: HandoffSource } | null>(null)
  const handoffSource = handoffInfo?.execId === execId ? handoffInfo.source : null
  useEffect(() => {
    if (!handoffFrom || !execId) return
    let alive = true
    api
      .getHandoff(execId)
      .then((info) => {
        if (!alive || !info.incoming) return
        setHandoffInfo({ execId, source: info.incoming.source })
        // 입력 변경은 늘 드래프트에도 저장된다. 드래프트가 비어 있으면 입력창도 비어 있다.
        if (!drafts.get(sessionId).trim()) actions.editMessage(info.incoming.text, sessionId)
      })
      .catch(() => { /* 옛 서버이거나 일시 오류 — 안내 줄은 기본 문구로 둔다 */ })
    return () => {
      alive = false
    }
  }, [handoffFrom, execId, sessionId])
  const pendingPerm = pendingPermission(s.convos[execId]) // 미해결 권한요청 → 컴포저 상단 Y/N 퀵바
  const busy = turn === 'running' || turn === 'requires_action'
  const limitProvider = s.sessions.find((x) => x.id === execId)?.provider
  const loading = !!s.loadingConvo[execId] // 초기 대화 로딩 중 — 입력/전송 차단(init 중 컨트롤 방지)
  // 글 칸 하나만 있으면 그 글 그대로(슬래시 판정). 코드 상자가 있으면 보낼 글자로 붙인 뒤 판정한다.
  const plain = soleText(blocks)
  const messageText = plain ?? serializeBlocks(blocks)
  // busy 중에도 전송 허용 — idle이면 즉시 전송, busy면 큐에 추가(다음 턴 자동 발사). 단 로딩 중엔 비활성. 첨부만도 전송 가능.
  const canSend = (messageText.trim().length > 0 || attach.length > 0) && !loading

  // 칸이 바뀐 뒤에 커서를 옮긴다. 상자가 방금 붙었을 때는 그 칸이 그려진 다음에 포커스한다.
  const fieldRefs = useRef(new Map<string, HTMLTextAreaElement>())
  const registerField = useCallback((id: string, el: HTMLTextAreaElement | null) => {
    if (el) fieldRefs.current.set(id, el)
    else fieldRefs.current.delete(id)
  }, [])
  const pendingFocus = useRef<{ id: string; at: number } | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const armFocus = (id: string, at: number) => {
    pendingFocus.current = { id, at }
    setFocusTick((n) => n + 1)
  }
  useLayoutEffect(() => {
    const req = pendingFocus.current
    if (!req) return
    const el = fieldRefs.current.get(req.id)
    if (!el) return
    pendingFocus.current = null
    el.focus()
    const at = Math.max(0, Math.min(req.at, el.value.length))
    el.setSelectionRange(at, at)
  }, [focusTick, blocks])

  // 파일 목록 → 첨부 추가(종류 분류·크기 필터는 lib, 개수 상한은 여기서). 붙여넣기·드롭·파일선택 공용.
  const addFiles = async (files: File[]) => {
    const { parsed, rejected } = await parseFiles(files)
    let overflow = false
    setAttach((prev) => {
      const next = [...prev, ...parsed]
      if (next.length > MAX_ATTACH) overflow = true
      return next.slice(0, MAX_ATTACH)
    })
    setAttachNote(rejected ? t('composer.attachNote.rejected') : overflow ? t('composer.attachNote.overflow', { max: MAX_ATTACH }) : '')
  }
  const removeAttach = (i: number) => setAttach((prev) => prev.filter((_, j) => j !== i))
  const btn = s.coarsePointer ? 44 : 36 // 터치 타깃 ≥44(폰·아이패드), 마우스는 36 — 넓이가 아닌 입력수단으로 판정

  // 슬래시 메뉴 표시 판정 — 글 칸 하나의 내용이 "/명령어"(공백 전)일 때만. 이름 문법은 provider가 소유하므로 여기서 제한하지 않는다.
  const slashMatch = plain !== null ? /^\/([^/\s]*)$/.exec(plain) : null
  const slashQuery = slashMatch?.[1].toLowerCase() ?? ''
  const slashCmds = slashMatch
    ? SLASH_CMDS.filter((c) => c.name.toLowerCase().startsWith(slashQuery) || c.aliases.some((alias) => alias.toLowerCase().startsWith(slashQuery)))
    : []
  const showSlash = slashCmds.length > 0 && !slashClosed && !loading
  const sel = Math.min(slashSel, Math.max(0, slashCmds.length - 1))

  // 입력 영역 바깥(대화 화면·상단바 등)을 누르면 슬래시 메뉴를 닫는다. 입력칸 자체를 누른 것은 계속 쓰는 중이므로 놔둔다.
  //   Esc로 닫을 때와 같은 상태를 쓰므로, 다시 타이핑하면 메뉴가 도로 열린다.
  const slashBoxRef = useRef<HTMLDivElement>(null)
  useDismiss(slashBoxRef, () => setSlashClosed(true), showSlash)

  // 세션 전환 시 그 세션의 드래프트를 로드(이전 세션 입력은 onChange로 이미 저장됨).
  useEffect(() => {
    if (idRef.current === sessionId) return
    idRef.current = sessionId
    pendingFocus.current = null
    setBlocks(decodeDraft(drafts.get(sessionId)))
    setAttach([]) // 첨부는 세션 전환 시 비움(휘발)
    setAttachNote('')
    setSlashClosed(false)
    setSlashSel(0)
    setBrowse({ cursor: null, draft: '' })
  }, [sessionId])

  // 메시지 재전송·편집 — store.composerFill이 갱신되면 그 텍스트를 입력에 로드+포커스(커서 끝).
  //   대상 세션이 아니면 신호(nonce)를 넘기지 않아 아무 일도 일어나지 않는다(오염 방지).
  const fill = s.composerFill
  useSignal(fill && fill.id === sessionId ? fill.nonce : undefined, () => {
    if (!fill) return
    const next = blocksFromMessage(fill.text)
    setBlocks(next)
    drafts.set(sessionId, encodeDraft(next))
    const last = [...next].reverse().find((block) => block.kind === 'text')
    if (last) armFocus(last.id, last.value.length)
    const restored: Attachment[] = [
      ...(fill.images ?? []).map((img) => ({
        kind: 'image' as const,
        name: 'image',
        media_type: img.media_type,
        data: img.data,
        url: `data:${img.media_type};base64,${img.data}`,
      })),
      ...(fill.documents ?? []).map((doc) => ({
        kind: 'pdf' as const,
        name: doc.name,
        media_type: doc.media_type,
        data: doc.data,
      })),
    ]
    setAttach(restored)
  })

  // 떠 있는 입력창의 높이를 대화 칸(부모 .session-pane)에 --composer-h로 알린다. 여러 줄·첨부·승인 줄·칩으로
  //   높이가 바뀔 때마다 다시 잰다. 대화 칸의 아래 여백과 '맨 아래로' 버튼 위치가 이 값을 따른다(index.css).
  const outerRef = useRef<HTMLDivElement>(null)
  const [paneW, setPaneW] = useState(Infinity)
  const [paneH, setPaneH] = useState(Infinity)
  const chipsTight = paneW < CHIPS_TIGHT_W
  useLayoutEffect(() => {
    const el = outerRef.current
    const pane = el?.parentElement
    if (!el || !pane) return
    const apply = () => {
      const box = el.getBoundingClientRect()
      pane.style.setProperty('--composer-h', `${Math.ceil(box.height)}px`)
      setPaneW(box.width)
      setPaneH(pane.getBoundingClientRect().height)
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    ro.observe(pane)
    return () => {
      ro.disconnect()
      pane.style.removeProperty('--composer-h')
    }
  }, [])

  // 입력 변경 — 로컬 state + 세션 드래프트 동시 갱신(키스트로크당 store set 안 함 → Stream 재렌더 회피).
  const commit = (next: ComposerBlock[]) => {
    setBlocks(next)
    drafts.set(sessionId, encodeDraft(next))
  }
  // 전송/명령 처리 후 입력·드래프트·첨부 클리어.
  const reset = () => {
    commit([textBlock('')])
    setAttach([])
    setAttachNote('')
  }
  // 슬래시 메뉴에서 명령 선택 → "/model " 채우고 포커스(인자 입력 대기). 메뉴는 공백 때문에 자동 닫힘.
  const acceptSlash = (c: SlashCmd) => {
    const v = c.cmd + ' '
    const current = blocks[0]
    if (current?.kind === 'text' && blocks.length === 1) {
      commit(setBlockValue(blocks, current.id, v))
      armFocus(current.id, v.length)
    } else {
      const block = textBlock(v)
      commit([block])
      armFocus(block.id, v.length)
    }
    setSlashClosed(false)
    setSlashSel(0)
  }

  const pack = () => {
    const trimmed = messageText.trim()
    // 첨부를 종류별로 분리: 이미지→image 블록, PDF→document 블록, 텍스트/코드→메시지에 코드펜스로 인라인 주입(확실히 동작).
    const imgs = attach.filter((a) => a.kind === 'image')
    const pdfs = attach.filter((a) => a.kind === 'pdf')
    const texts = attach.filter((a) => a.kind === 'text')
    const images: ImageAttachment[] | undefined = imgs.length ? imgs.map(({ media_type, data }) => ({ media_type, data })) : undefined
    const documents: DocAttachment[] | undefined = pdfs.length ? pdfs.map(({ name, media_type, data }) => ({ name, media_type, data })) : undefined
    let finalText = trimmed
    for (const tf of texts) finalText += `${finalText ? '\n\n' : ''}${t('composer.attach.inlinePrefix', { name: tf.name })}\n\`\`\`\n${tf.data}\n\`\`\``
    return { finalText, images, documents }
  }
  const deliver = (finalText: string, images?: ImageAttachment[], documents?: DocAttachment[], asBrief = false) => {
    // idle이면 즉시 전송, 진행 중(running·카드 대기·압축 같은 명령 작업)이면 큐에 쌓아 다음 턴에 순차 자동 전송.
    if (finalText.trim()) rememberPrompt(sessionId, finalText)
    if (turn === 'idle') void actions.send(finalText, images, documents, sessionId, asBrief)
    else actions.enqueue(finalText, images, documents, sessionId, asBrief)
    setBrowse({ cursor: null, draft: '' })
    reset()
  }
  const submit = () => {
    const trimmed = messageText.trim()
    if ((!trimmed && attach.length === 0) || loading) return // 텍스트·이미지 둘 다 없거나 로딩 중이면 차단
    setSent((n) => n + 1)
    // 코드 상자가 섞여 있으면 슬래시 명령으로 보지 않는다. 글 전체가 명령일 때만 실행한다.
    const slash = plain !== null && trimmed ? parseSlashCommand(trimmed, SLASH_CMDS) : null
    // 별칭은 첨부 여부와 상관없이 이번 글만 브리프다. 보낸 뒤에는 갈래가 남지 않는다.
    if (slash?.brief) {
      const packed = pack()
      deliver(packed.finalText, packed.images, packed.documents, true)
      return
    }
    // 슬래시 명령은 첨부 없을 때만. 이름의 의미는 화면이 해석하지 않고 공통 실행 API로 넘긴다.
    if (attach.length === 0 && slash) {
      if (slash.uiAction) {
        actions.runSlashUiAction(slash.uiAction, slash.arguments, sessionId)
        reset()
        return
      }
      void actions.executeCommand(slash.name, slash.arguments, slash.startsTurn, sessionId)
      reset()
      return
    }
    const packed = pack()
    deliver(packed.finalText, packed.images, packed.documents, false)
  }
  // 갈래는 입력 전체를 요구로 보낸다. 슬래시 명령으로 실행하지 않고, 다음 글에 남지 않는다.
  const submitBrief = () => {
    const trimmed = messageText.trim()
    if ((!trimmed && attach.length === 0) || loading) return
    setSent((n) => n + 1)
    const packed = pack()
    deliver(packed.finalText, packed.images, packed.documents, true)
  }

  // 접힌 코드 상자로 커서를 옮기면 먼저 펼친다. 칸이 그려진 뒤에 포커스한다.
  const moveTo = (id: string, at: number) => {
    const target = blocks.find((block) => block.id === id)
    if (target?.kind === 'code' && target.collapsed) commit(toggleCodeCollapsed(blocks, id))
    armFocus(id, at)
  }
  const moveEdge = (id: string, key: string, el: HTMLTextAreaElement) => {
    if (el.selectionStart !== el.selectionEnd) return false
    if (key === 'ArrowUp' && el.selectionStart === 0) {
      const prev = neighborBlock(blocks, id, -1)
      if (!prev) return false
      moveTo(prev.id, prev.value.length)
      return true
    }
    if (key === 'ArrowDown' && el.selectionStart === el.value.length) {
      const next = neighborBlock(blocks, id, 1)
      if (!next) return false
      moveTo(next.id, 0)
      return true
    }
    return false
  }

  // ── textarea 이벤트 핸들러 ──
  // 클로저는 매 렌더 최신 state를 담지만, ref로 안정 식별자를 memo 자식에 넘긴다 → 스트리밍 리렌더로 textarea가 재조정되지 않음.
  const onTextChange = (id: string, value: string) => {
    commit(setBlockValue(blocks, id, value))
    setBrowse({ cursor: null, draft: '' })
    setSlashClosed(false) // 다시 타이핑하면 메뉴 재오픈
    setSlashSel(0)
  }
  const recall = (text: string, next: HistoryBrowse, at: number) => {
    const only = textBlock(text)
    commit([only])
    setBrowse(next)
    armFocus(only.id, at)
  }
  const appendSpoken = (spoken: string) => {
    const chunk = spoken.trim()
    if (!chunk) return
    const focused = blocks.find((block) => block.kind === 'text' && fieldRefs.current.get(block.id) === document.activeElement)
    const target = focused ?? [...blocks].reverse().find((block) => block.kind === 'text')
    if (!target || target.kind !== 'text') return
    const value = target.value.trim() ? `${target.value.replace(/\s+$/, '')} ${chunk}` : chunk
    commit(setBlockValue(blocks, target.id, value))
    armFocus(target.id, value.length)
  }
  const onCodeChange = (id: string, value: string) => commit(setBlockValue(blocks, id, value))
  const onToggleCode = (id: string) => commit(toggleCodeCollapsed(blocks, id))
  const onPasteTA = (_id: string, e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length) { e.preventDefault(); void addFiles(files) }
  }
  // 글 칸과 코드 상자가 같은 단축키를 쓴다. 진행 중이면 대기열에 넣은 뒤 그 턴을 멈추고 바로 보낸다.
  const onCtrlEnter = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.nativeEvent.isComposing) return false
    e.preventDefault()
    if (loading) return true
    if (turn === 'running') {
      if (!canSend && queuedFor(s, execId).length === 0) return true
      if (canSend) {
        const packed = pack()
        if (packed.finalText.trim()) rememberPrompt(sessionId, packed.finalText)
        actions.enqueue(packed.finalText, packed.images, packed.documents, sessionId)
        reset()
      }
      actions.sendQueuedNow(execId)
      return true
    }
    submit()
    return true
  }
  const onTextKeyDown = (id: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 슬래시 메뉴 열림 중 키 처리(IME 조합 중 제외) — ↑↓ 이동, Enter/Tab 채우기, Esc 닫기.
    if (showSlash && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSel((sel + 1) % slashCmds.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSel((sel - 1 + slashCmds.length) % slashCmds.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashClosed(true)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        acceptSlash(slashCmds[sel])
        return
      }
    }
    const el = e.currentTarget
    // ``` 또는 ~~~ 만 있는 줄에서 Shift+Enter 는 줄바꿈 대신 코드 상자를 연다.
    if (e.key === 'Enter' && e.shiftKey && !e.nativeEvent.isComposing && el.selectionStart === el.selectionEnd) {
      const opened = openCodeAt(blocks, id, el.selectionStart)
      if (opened) {
        e.preventDefault()
        commit(opened.blocks)
        armFocus(opened.focusId, opened.focusAt)
        return
      }
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      if (moveEdge(id, e.key, el)) {
        e.preventDefault()
        return
      }
      const index = blocks.findIndex((block) => block.id === id)
      const block = blocks[index]
      if (block?.kind === 'text' && index === 0 && !showSlash) {
        if (e.key === 'ArrowUp' && el.selectionStart === 0 && (messageText.trim() === '' || browse.cursor != null)) {
          const next = browseUp(promptsFor(sessionId), browse, el.value)
          if (next) {
            e.preventDefault()
            recall(next.text, next.state, 0)
            return
          }
        }
        if (e.key === 'ArrowDown' && browse.cursor != null && el.selectionStart === el.value.length) {
          const next = browseDown(promptsFor(sessionId), browse)
          if (next) {
            e.preventDefault()
            recall(next.text, next.state, next.text.length)
            return
          }
        }
      }
    }
    if (onCtrlEnter(e)) return
    // IME(한글 등) 조합 중 Enter는 글자 확정용 → 전송 금지. Shift+Enter는 줄바꿈.
    // 모바일 디자인(좁은 화면)에서는 Enter도 줄바꿈이다. 보내기는 단추로 한다. 데스크탑 디자인이면 입력수단과 무관하게 Enter가 전송이다.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !s.isNarrow) {
      e.preventDefault()
      submit()
    }
  }
  const onCodeKeyDown = (id: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (onCtrlEnter(e)) return
    if (e.nativeEvent.isComposing) return
    const el = e.currentTarget
    const caret = el.selectionStart === el.selectionEnd
    // 상자 안에서는 Enter 도 줄바꿈이다. 닫는 표시 줄의 Shift+Enter 만 상자를 끝낸다.
    if (e.key === 'Enter' && e.shiftKey && caret) {
      const closed = closeCodeAt(blocks, id, el.selectionStart)
      if (closed) {
        e.preventDefault()
        commit(closed.blocks)
        armFocus(closed.focusId, closed.focusAt)
      }
      return
    }
    if (e.key === 'Backspace' && caret && el.value === '' && el.selectionStart === 0) {
      const removed = removeEmptyCode(blocks, id)
      if (removed) {
        e.preventDefault()
        commit(removed.blocks)
        armFocus(removed.focusId, removed.focusAt)
      }
      return
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && moveEdge(id, e.key, el)) {
      e.preventDefault()
    }
  }
  // ref로 최신 핸들러 보관 → 아래 stable 래퍼는 식별자가 영구 고정(memo 자식이 콜백 identity로 리렌더되지 않음).
  //   그리기 중에 ref를 바꾸면 린트가 막으므로, 그린 뒤에 최신 핸들러로 갈아끼운다. 키 입력은 그 이후다.
  const handlersRef = useRef({ onTextChange, onCodeChange, onTextKeyDown, onCodeKeyDown, onPasteTA, onToggleCode })
  useEffect(() => {
    handlersRef.current = { onTextChange, onCodeChange, onTextKeyDown, onCodeKeyDown, onPasteTA, onToggleCode }
  })
  const stableTextChange = useCallback((id: string, value: string) => handlersRef.current.onTextChange(id, value), [])
  const stableCodeChange = useCallback((id: string, value: string) => handlersRef.current.onCodeChange(id, value), [])
  const stableTextKey = useCallback((id: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => handlersRef.current.onTextKeyDown(id, e), [])
  const stableCodeKey = useCallback((id: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => handlersRef.current.onCodeKeyDown(id, e), [])
  const stablePaste = useCallback((id: string, e: React.ClipboardEvent<HTMLTextAreaElement>) => handlersRef.current.onPasteTA(id, e), [])
  const stableToggle = useCallback((id: string) => handlersRef.current.onToggleCode(id), [])

  // 알약의 빈 곳을 누르면 마지막 글 칸에 커서를 둔다(끝으로).
  const focusLastText = () => {
    const last = [...blocks].reverse().find((block) => block.kind === 'text')
    if (last) armFocus(last.id, last.value.length)
  }

  // placeholder — 문자열이라 memo 얕은비교로 값이 실제 바뀔 때(로딩·턴 전환)만 textarea 갱신.
  const placeholder = loading
    ? t('composer.placeholder.loading')
    : // 모바일은 입력칸이 좁아(특히 busy 시 Stop 버튼과 공유) 긴 안내가 2줄로 감김 → 짧은 1줄 문구로.
      s.isNarrow
      ? turn === 'requires_action' || turn === 'running' || turn === 'operation'
        ? t('composer.placeholder.queueShort')
        : t('composer.placeholder.messageShort')
      : turn === 'operation'
        ? t('composer.placeholder.operation')
        : turn === 'requires_action'
        ? t('composer.placeholder.requiresAction')
        : turn === 'running'
          ? t('composer.placeholder.running')
          : t('composer.placeholder.idle')

  return (
    // 재설계 4단계: 붙박이 띠 대신 대화 칸 바닥에 뜬 유리 알약이다. 바깥 틀은 투명하고 누름을 통과시킨다(index.css .aether-composer).
    //   높이를 재서 --composer-h로 대화 칸에 알린다 — 마지막 글과 '맨 아래로' 버튼이 이 알약 밑에 숨지 않게 한다.
    <div ref={outerRef} className="aether-composer">
      <div
        className="mx-auto flex flex-col"
        style={{
          maxWidth: 760,
          width: '100%',
          minWidth: 0, // 자식 행이 뷰포트를 넘겨 우측(전송버튼)이 잘리지 않게 shrink 허용
          gap: 8,
          paddingLeft: `max(${s.isNarrow ? 10 : 16}px, env(safe-area-inset-left))`,
          paddingRight: `max(${s.isNarrow ? 10 : 16}px, env(safe-area-inset-right))`,
          paddingBottom: `max(${s.isNarrow ? 10 : 14}px, env(safe-area-inset-bottom))`,
        }}
      >
        {pendingPerm && !loading && <PermissionQuickBar perm={pendingPerm} isNarrow={s.isNarrow} />}
        {handoffFrom && !loading && <HandoffNote fromId={handoffFrom} source={handoffSource} />}
        {room?.autoResume && <AutoResumeBar plan={room.autoResume} sessionId={sessionId} execId={execId} />}
        <BackgroundAnnouncer count={bgTasks.length} />
        <BackgroundTasksStrip
          tasks={bgTasks}
          canStop={active?.backgroundCanStop === true}
          stopping={bgStopping}
          onStop={stopBgTask}
          onStopAll={() => bgTasks.forEach((x) => !bgStopping.has(x.id) && stopBgTask(x.id))}
          isNarrow={s.isNarrow}
        />
        {/* 컨트롤 행 — 모델·생각(effort)·권한을 입력창 위에 둔다. 폰은 엄지 영역이라서, 1100 미만 컴퓨터 폭은
            상단 도구 섬이 대화 칸 폭 안에 다 안 들어가서다(재설계 3단계, 800px 실측). 1100 이상은 상단 도구 섬에 있다.
            칩마다 작은 유리 알약이다(ChipPicker compact). */}
        {!s.isWide && active && (
          // --hit-dy: 칩의 넓힌 누름 범위(index.css .hit-44)를 3px 올린다 — 아래 입력창과 8px뿐이라 가운데 기준이면 겹친다.
          <div className="flex items-center" style={{ gap: 6, '--hit-dy': '-3px' } as CSSProperties}>
            <ModelPicker compact direction="up" />
            <EffortPicker compact direction="up" />
            <PermissionPicker compact direction="up" />
          </div>
        )}
        <div ref={slashBoxRef} style={{ position: 'relative' }}>
          {showSlash && <SlashMenu cmds={slashCmds} sel={sel} onHover={setSlashSel} onPick={acceptSlash} />}
          {/* 알약 하나가 두 줄이다. 윗줄은 글 칸이 폭을 다 쓰고, 아랫줄 왼쪽에 ＋, 오른쪽에 마이크·중단·전송이 있다.
              한때 이 버튼들이 글 칸과 한 줄에 있어서 폰에서는 글 칸이 손가락 두 개 폭으로 줄었다(2026-10-06 사용자 판단).
              첨부 미리보기는 알약 안 맨 위에 붙는다. 알약 어디에 파일을 끌어 놓아도 첨부된다. */}
          <div
            className="glass composer-box flex flex-col"
            style={{ padding: 6, minWidth: 0 }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const files = Array.from(e.dataTransfer.files)
              if (files.length) void addFiles(files)
            }}
          >
            {(attach.length > 0 || attachNote) && <AttachmentPreview items={attach} note={attachNote} onRemove={removeAttach} />}
            {/* 여백을 눌러도 마지막 글 칸이 켜진다. hit-44-under = 넓힌 누름 범위를 글 칸 밑에 깐다(index.css). */}
            <div
              className="hit-44 hit-44-under flex flex-col justify-center"
              style={{ minHeight: 36, padding: '4px 8px 2px', minWidth: 0, cursor: 'text', gap: 2 }}
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) focusLastText()
              }}
            >
              {blocks.map((block) =>
                block.kind === 'code' ? (
                  <ComposerCodeBox
                    key={block.id}
                    block={block}
                    disabled={loading}
                    register={registerField}
                    collapseLabel={t('composer.code.collapse')}
                    expandLabel={t('composer.code.expand')}
                    copyLabel={t('composer.code.copy')}
                    copiedLabel={t('composer.code.copied')}
                    onChange={stableCodeChange}
                    onKeyDown={stableCodeKey}
                    onPaste={stablePaste}
                    onToggle={stableToggle}
                  />
                ) : (
                  <ComposerTextarea
                    key={block.id}
                    blockId={block.id}
                    register={registerField}
                    value={block.value}
                    disabled={loading}
                    placeholder={blocks.length === 1 ? placeholder : ''}
                    maxHeight={paneH < SHORT_PANE_H ? SHORT_PANE_TA : MAX_TA_HEIGHT}
                    minHeight={blocks.some((item) => item.kind === 'code') && block.value === '' ? 22 : 0}
                    onChange={stableTextChange}
                    onKeyDown={stableTextKey}
                    onPaste={stablePaste}
                    sendOnEnter={!s.isNarrow}
                  />
                ),
              )}
            </div>
            {/* 아랫줄. 좁은 화면은 버튼 사이를 8 띄운다 — 마우스 기기의 좁은 창은 버튼이 36이라, 누름 범위를 44까지 넓힌 것(hit-44)이
                옆 버튼과 겹치지 않는 최소 간격이 8이다. 터치 기기는 버튼 자체가 44다. 가운데 빈 곳을 눌러도 글 칸이 켜진다. */}
            <div className="flex items-center" style={{ gap: s.isNarrow ? 8 : 2, minWidth: 0 }}>
              <ComposerPlusMenu
                attachDisabled={loading || attach.length >= MAX_ATTACH}
                size={btn}
                onFiles={(files) => void addFiles(files)}
              />
              {/* 칸이 나뉘면 칩을 이 줄의 빈 곳에 둔다. 칩 줄을 따로 만들면 칸마다 대화가 두 줄 가까이 줄어든다. */}
              {split && active && (
                <>
                  <ModelPicker roomId={sessionId} direction="up" tight={chipsTight} />
                  <EffortPicker roomId={sessionId} direction="up" />
                  <PermissionPicker roomId={sessionId} direction="up" tight={chipsTight} />
                  {(paneW >= USAGE_MIN_W || (ctxOf(s.convos[execId]) ?? 0) >= CTX_WARN_PCT) && (
                    <span style={{ display: 'inline-flex', flexShrink: 0, padding: '0 6px' }}>
                      <UsageChip items={s.convos[execId]} loading={!!s.loadingConvo[execId]} compact />
                    </span>
                  )}
                </>
              )}
              {active && s.limitWarning && limitProvider && <LimitChip sessionId={execId} provider={limitProvider} busy={busy} />}
              <div
                className="flex-1 self-stretch"
                style={{ cursor: 'text' }}
                onMouseDown={(e) => {
                  e.preventDefault()
                  focusLastText()
                }}
              />
              <MicButton disabled={loading} size={btn} onText={appendSpoken} />
              {busy && !loading && <InterruptButton sessionId={sessionId} size={btn} />}
              <SendButton enabled={canSend} size={btn} sent={sent} onClick={submit} onSendBrief={submitBrief} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
