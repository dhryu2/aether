// 작업 폴더 파일 열어 보기(읽기 전용). 두 화면이다.
//   찾기   검색칸과 파일 목록. 이름으로 거르고 하나를 고르면 본문으로 간다.
//   본문   파일 내용. 찾기에서 왔으면 뒤로 가기로 찾기에 돌아가고, 검토함에서 바로 열었으면 닫기만 있다.
//   기록   본문에서 "이 파일을 고친 세션"을 누르면 같은 창에서 바뀐다. 뒤로 가기는 본문으로 돌아간다.
// 목록과 본문은 서버(/api/files)가 작업 폴더 안의 파일만, 비밀 파일은 가려서 준다. 편집·폴더 트리는 없다.
import { useEffect, useRef, useState } from 'react'
import type { WorkspaceFileResponse } from '@shared/http'
import { actions, useStore } from '../lib/store'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import { rankFiles } from '../lib/fileMention'
import { relTime } from '../lib/format'
import type { FileTraceResponse } from '@shared/brain'
import { C, FONT, R, Z } from '../design/tokens'
import { Button, ModalCard, ModalHeader, ModalShell, Skeleton } from './ui'
import { CodeBlock } from './Markdown'
import { fieldStyle } from './newSession/fieldStyle'

const MAX_ROWS = 100
const HIGHLIGHT_MAX = 100_000 // 이보다 길면 색 입히기를 끈다(폰에서 느려진다)
const note = { fontSize: 13, lineHeight: 1.45, color: C.label2 } as const

export function FileViewer() {
  const v = useStore().fileViewer
  if (!v) return null
  return <Viewer key={`${v.sessionId}\n${v.path ?? ''}`} sessionId={v.sessionId} entryPath={v.path} />
}

function Viewer({ sessionId, entryPath }: { sessionId: string; entryPath?: string }) {
  const t = useT()
  const [path, setPath] = useState(entryPath)
  const [trace, setTrace] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const close = actions.closeFileViewer
  // 검토함에서 바로 연 본문은 돌아갈 찾기 화면이 없다.
  const onBack = trace ? () => setTrace(false) : path && !entryPath ? () => setPath(undefined) : undefined
  return (
    <ModalShell onClose={close} zIndex={Z.root.fileViewer} initialFocusRef={path ? undefined : searchRef}>
      <ModalCard variant="sheet" maxWidth={880} data-window="file-viewer">
        <ModalHeader
          title={trace ? t('fileViewer.trace') : path ? path.slice(path.lastIndexOf('/') + 1) : t('fileViewer.title')}
          onClose={close}
          closeLabel={t('common.close')}
          onBack={onBack}
          backLabel={t(trace ? 'fileViewer.backToFile' : 'fileViewer.back')}
        />
        {path && trace ? <FileTrace sessionId={sessionId} path={path} /> : path ? <FileBody sessionId={sessionId} path={path} onTrace={() => setTrace(true)} /> : <FileSearch sessionId={sessionId} inputRef={searchRef} onPick={setPath} />}
      </ModalCard>
    </ModalShell>
  )
}

function FileSearch({ sessionId, inputRef, onPick }: { sessionId: string; inputRef: React.RefObject<HTMLInputElement | null>; onPick: (p: string) => void }) {
  const t = useT()
  const narrow = useStore().isNarrow
  const [list, setList] = useState<{ files: string[]; truncated: boolean } | null>(null)
  const [failed, setFailed] = useState(false)
  const [tries, setTries] = useState(0)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)

  useEffect(() => {
    let alive = true
    api.workspaceFiles(sessionId)
      .then((r) => alive && setList(r))
      .catch(() => alive && setFailed(true))
    return () => { alive = false }
  }, [sessionId, tries])

  const rows = list ? rankFiles(list.files, query, MAX_ROWS) : []
  const at = Math.min(sel, Math.max(0, rows.length - 1))
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || rows.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((at + 1) % rows.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((at - 1 + rows.length) % rows.length) }
    else if (e.key === 'Enter') { e.preventDefault(); onPick(rows[at]) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setSel(0) }}
        onKeyDown={onKeyDown}
        placeholder={t('fileViewer.search')}
        aria-label={t('fileViewer.search')}
        style={{ ...fieldStyle(), height: narrow ? 44 : 38, padding: '0 12px', outline: 'none' }}
      />
      {failed && <FailNote text={t('fileViewer.failed')} onRetry={() => { setFailed(false); setTries((n) => n + 1) }} narrow={narrow} />}
      {!list && !failed && <Loading />}
      {list?.truncated && <div style={note}>{t('fileViewer.listTruncated')}</div>}
      {list && rows.length === 0 && <div style={{ ...note, color: C.label3 }}>{t('fileViewer.empty')}</div>}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((f, i) => {
          const cut = f.lastIndexOf('/')
          return (
            <button
              key={f}
              type="button"
              className="press"
              ref={i === at ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onClick={() => onPick(f)}
              onMouseEnter={() => setSel(i)}
              style={{ display: 'flex', alignItems: 'baseline', gap: 8, minHeight: narrow ? 44 : 34, padding: '6px 10px', border: 'none', borderRadius: R.sm, textAlign: 'left', cursor: 'pointer', color: C.label, background: i === at ? C.tintSoft : 'transparent' }}
            >
              <span style={{ fontFamily: FONT.mono, fontSize: 13, fontWeight: 600, flexShrink: 0 }}>{f.slice(cut + 1)}</span>
              {cut >= 0 && <span className="truncate" style={{ minWidth: 0, fontFamily: FONT.mono, fontSize: 11.5, color: C.label3 }}>{f.slice(0, cut)}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function FileBody({ sessionId, path, onTrace }: { sessionId: string; path: string; onTrace: () => void }) {
  const t = useT()
  const narrow = useStore().isNarrow
  const [res, setRes] = useState<WorkspaceFileResponse | null>(null)
  const [error, setError] = useState<number | 'other' | null>(null)
  const [tries, setTries] = useState(0)

  useEffect(() => {
    let alive = true
    api.workspaceFile(sessionId, path)
      .then((r) => alive && setRes(r))
      .catch((e: { status?: number }) => alive && setError(e?.status === 404 ? 404 : 'other'))
    return () => { alive = false }
  }, [sessionId, path, tries])

  if (error === 404) return <div style={note}>{t('fileViewer.notFound')}</div>
  if (error) return <FailNote text={t('fileViewer.failed')} onRetry={() => { setError(null); setTries((n) => n + 1) }} narrow={narrow} />
  if (!res) return <Loading />
  if (res.redacted) return <div style={note}>{t('fileViewer.redacted')}</div>
  if (res.binary) return <div style={note}>{t('fileViewer.binary')}</div>
  const text = res.text ?? ''
  const dot = path.lastIndexOf('.')
  const language = text.length > HIGHLIGHT_MAX || dot <= path.lastIndexOf('/') + 1 ? '' : path.slice(dot + 1).toLowerCase()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <button
        type="button"
        className="press"
        onClick={onTrace}
        style={{ alignSelf: 'flex-start', minHeight: narrow ? 44 : 36, padding: 0, border: 'none', background: 'transparent', color: C.tint, fontSize: 14, cursor: 'pointer' }}
      >
        {t('fileViewer.trace')}
      </button>
      {res.truncated && <div style={note}>{t('fileViewer.truncated')}</div>}
      <CodeBlock language={language} code={text} index={0} />
    </div>
  )
}

/** 이 파일을 고친 같은 프로젝트의 세션들(최신이 위). 첫 조회가 길 수 있어 곧바로 훑는 중이라고 알린다. */
function FileTrace({ sessionId, path }: { sessionId: string; path: string }) {
  const t = useT()
  const narrow = useStore().isNarrow
  const [res, setRes] = useState<FileTraceResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [tries, setTries] = useState(0)

  useEffect(() => {
    let alive = true
    api.reviewTrace(sessionId, path)
      .then((r) => alive && setRes(r))
      .catch(() => alive && setFailed(true))
    return () => { alive = false }
  }, [sessionId, path, tries])

  const open = (id: string, seq: number) => {
    actions.closeFileViewer()
    actions.closeBrain()
    actions.openSessionAt(id, seq)
  }
  if (failed) return <FailNote text={t('fileViewer.failed')} onRetry={() => { setFailed(false); setTries((n) => n + 1) }} narrow={narrow} />
  if (!res) {
    return (
      <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={note}>{t('fileViewer.traceScanning')}</div>
        <Loading />
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      {res.partial && <div style={note}>{t('fileViewer.tracePartial')}</div>}
      {res.entries.length === 0 && <div style={{ ...note, color: C.label3 }}>{t('fileViewer.traceEmpty')}</div>}
      {res.entries.map((e) => (
        <button
          key={`${e.sessionId}:${e.seq}`}
          type="button"
          className="press"
          onClick={() => open(e.sessionId, e.prompt?.seq ?? e.seq)}
          style={{ display: 'flex', flexDirection: 'column', gap: 3, minHeight: narrow ? 44 : 34, padding: '8px 10px', border: 'none', borderRadius: R.sm, textAlign: 'left', cursor: 'pointer', color: C.label, background: 'transparent' }}
        >
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span className="truncate" style={{ minWidth: 0, flex: 1, fontSize: 14, fontWeight: 600 }}>{e.title || t('brain.review.untitled')}</span>
            <span style={{ flexShrink: 0, fontSize: 12, color: C.label3 }}>{relTime(e.at)}</span>
          </span>
          {e.prompt && <span style={{ fontSize: 13, lineHeight: 1.4, color: C.label2, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{e.prompt.text}</span>}
          {e.commands.slice(0, 3).map((c) => (
            <span key={c.seq} className="truncate" style={{ fontFamily: FONT.mono, fontVariantLigatures: 'none', fontSize: 12, color: C.label3 }}>{c.text}</span>
          ))}
        </button>
      ))}
    </div>
  )
}

function Loading() {
  return (
    <div role="status" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Skeleton width="100%" height={18} radius={6} />
      <Skeleton width="80%" height={18} radius={6} />
    </div>
  )
}

function FailNote({ text, onRetry, narrow }: { text: string; onRetry: () => void; narrow: boolean }) {
  const t = useT()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
      <div style={note}>{text}</div>
      <Button tone="gray" height={narrow ? 44 : 36} onClick={onRetry}>{t('fileViewer.retry')}</Button>
    </div>
  )
}
