// 작업 폴더 파일 열어 보기(읽기 전용). 두 화면이다.
//   찾기   검색칸과 파일 목록. 이름으로 거르고 하나를 고르면 본문으로 간다.
//   본문   파일 내용. 찾기에서 왔으면 뒤로 가기로 찾기에 돌아가고, 검토함에서 바로 열었으면 닫기만 있다.
// 목록과 본문은 서버(/api/files)가 작업 폴더 안의 파일만, 비밀 파일은 가려서 준다. 편집·폴더 트리는 없다.
import { useEffect, useRef, useState } from 'react'
import type { WorkspaceFileResponse } from '@shared/http'
import { actions, useStore } from '../lib/store'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import { rankFiles } from '../lib/fileMention'
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
  const searchRef = useRef<HTMLInputElement>(null)
  const close = actions.closeFileViewer
  // 검토함에서 바로 연 본문은 돌아갈 찾기 화면이 없다.
  const onBack = path && !entryPath ? () => setPath(undefined) : undefined
  return (
    <ModalShell onClose={close} zIndex={Z.root.fileViewer} initialFocusRef={path ? undefined : searchRef}>
      <ModalCard variant="sheet" maxWidth={880} data-window="file-viewer">
        <ModalHeader
          title={path ? path.slice(path.lastIndexOf('/') + 1) : t('fileViewer.title')}
          onClose={close}
          closeLabel={t('common.close')}
          onBack={onBack}
          backLabel={t('fileViewer.back')}
        />
        {path ? <FileBody sessionId={sessionId} path={path} /> : <FileSearch sessionId={sessionId} inputRef={searchRef} onPick={setPath} />}
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

function FileBody({ sessionId, path }: { sessionId: string; path: string }) {
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
      {res.truncated && <div style={note}>{t('fileViewer.truncated')}</div>}
      <CodeBlock language={language} code={text} index={0} />
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
