// 검토함의 바뀐 파일 한 줄. 누르면 그 자리에서 변경 내용(diff)을 펼친다.
//   처음 펼칠 때만 불러오고, 접었다 펴면 받아 둔 것을 쓴다. 부모가 key에 세션과 마지막 순번을 넣어 두므로
//   세션이 바뀌거나 기록이 늘면 이 컴포넌트가 새로 만들어지며 펼침과 응답이 같이 초기화된다.
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ReviewFileDiffResponse } from '@shared/brain'
import { C, FONT } from '../../design/tokens'
import { api } from '../../lib/api'
import { useT } from '../../lib/i18n'
import { Button, Collapse, Skeleton } from '../ui'
import { UnifiedDiff } from '../UnifiedDiff'
import { RowLine } from './Bits'

const note = { fontSize: 13, lineHeight: 1.45, color: C.label2 } as const

export function ReviewFile({ sessionId, index, shownPath, state, seq, path, narrow, onOpen }: {
  sessionId: string
  index: number
  shownPath: string
  /** 이미 번역된 파일 상태 문구. 모르면 비운다. */
  state?: string
  seq: number
  path: string
  narrow: boolean
  onOpen: (seq?: number) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [res, setRes] = useState<ReviewFileDiffResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [tries, setTries] = useState(0)
  const [slow, setSlow] = useState(false)
  const id = `review-file-${index}`

  useEffect(() => {
    if (!open || res || failed) return
    let alive = true
    setSlow(false)
    // 빠른 응답은 뼈대가 깜빡이지 않게 180ms 뒤에야 보인다.
    const timer = setTimeout(() => alive && setSlow(true), 180)
    api.reviewFileDiff(sessionId, path)
      .then((r) => alive && setRes(r))
      .catch(() => alive && setFailed(true))
    return () => { alive = false; clearTimeout(timer) }
  }, [open, res, failed, tries, sessionId, path])

  const edits = res?.edits ?? []
  const empty = !!res && res.source === 'none' && edits.length === 0
  return (
    <div>
      <RowLine index={index} />
      <button
        type="button"
        className="press"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%', minHeight: 44, padding: '10px 14px', border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', color: C.label }}
      >
        {open ? <ChevronDown size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: C.label3 }} /> : <ChevronRight size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: C.label3 }} />}
        <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', fontFamily: FONT.mono, fontVariantLigatures: 'none', fontSize: 13, lineHeight: 1.45 }}>{shownPath}</span>
          {state && <span style={{ fontSize: 12, color: C.label3 }}>{state}</span>}
        </span>
      </button>
      <Collapse open={open} id={id}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 14px 12px' }}>
          <button
            type="button"
            className="press"
            onClick={() => onOpen(seq)}
            style={{ alignSelf: 'flex-start', minHeight: narrow ? 44 : 36, padding: 0, border: 'none', background: 'transparent', color: C.tint, fontSize: 14, cursor: 'pointer' }}
          >
            {t('brain.review.viewInSession')}
          </button>
          {!res && !failed && slow && (
            <div role="status" aria-label={t('brain.loading')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Skeleton width="100%" height={18} radius={6} />
              <Skeleton width="80%" height={18} radius={6} />
            </div>
          )}
          {failed && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
              <div style={note}>{t('brain.review.diffFailed')}</div>
              <Button tone="gray" height={narrow ? 44 : 36} onClick={() => { setFailed(false); setTries((n) => n + 1) }}>{t('brain.review.retry')}</Button>
            </div>
          )}
          {res?.partial && <div style={note}>{t('brain.review.partial')}</div>}
          {res?.source === 'git' && <div style={note}>{t('brain.review.diffFromGit')}</div>}
          {empty && <div style={note}>{t('brain.review.diffNone')}</div>}
          {edits.map((m, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {edits.length > 1 && (
                <div className="tabular-nums" style={{ fontSize: 12.5, color: C.label3 }}>{t('brain.review.diffPart', { n: i + 1, total: edits.length })}</div>
              )}
              <UnifiedDiff m={m} />
            </div>
          ))}
        </div>
      </Collapse>
    </div>
  )
}
