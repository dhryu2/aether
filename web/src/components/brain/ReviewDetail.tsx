// 검토함 오른쪽 상세. 기록에서 모은 실패한 명령, 남은 할 일, 바뀐 파일을 보인다.
//   기록은 먼저 그리고, git 상태는 따로 와서 채운다.
//   실패한 명령과 할 일을 누르면 세션의 그 지점으로 가고, 바뀐 파일을 누르면 그 자리에서 변경 내용을 펼친다.
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Circle, CircleAlert } from 'lucide-react'
import type { ReviewDetailResponse, ReviewRow } from '@shared/brain'
import { C, FONT } from '../../design/tokens'
import { api } from '../../lib/api'
import { relTime } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { displayPath } from '../../lib/review'
import { actions } from '../../lib/store'
import { Button, Collapse, Skeleton } from '../ui'
import { Group, RowLine } from './Bits'
import { ReviewFile } from './ReviewFile'

const itemStyle = {
  display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', minHeight: 44, padding: '10px 14px',
  border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', color: C.label,
} as const
const wrapText = { minWidth: 0, flex: 1, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } as const

function Section({ title, count, hint, children }: { title: string; count?: number; hint?: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 20 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: C.label3 }}>
        {title} {count !== undefined && <span className="tabular-nums">{count}</span>}
      </h3>
      {hint && <div style={{ fontSize: 13, color: C.label3, margin: '0 0 8px' }}>{hint}</div>}
      <Group>{children}</Group>
    </section>
  )
}

export function ReviewDetail({ row, narrow, busy, onOpen, onDone }: {
  row: ReviewRow
  narrow: boolean
  busy: boolean
  onOpen: (seq?: number) => void
  onDone: () => void
}) {
  const t = useT()
  const [detail, setDetail] = useState<ReviewDetailResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [gitLoading, setGitLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [unrecordedOpen, setUnrecordedOpen] = useState(false)
  const [otherOpen, setOtherOpen] = useState(false)
  const [leftoversOpen, setLeftoversOpen] = useState(false)

  // 같은 세션의 새로고침은 화면을 비우지 않는다(스크롤과 펼침을 지킨다). 다른 세션으로 바뀔 때만 비운다.
  useEffect(() => {
    let alive = true
    setDetail((prev) => (prev && prev.id === row.id ? prev : null))
    setFailed(false)
    setGitLoading(true)
    // 기록만 먼저(빠름), git 포함본이 뒤따라 와서 상태를 채운다. 늦게 온 기록본이 git 포함본을 덮지 않는다.
    api.reviewDetail(row.id, false)
      .then((d) => alive && setDetail((prev) => (prev && prev.id === d.id && prev.git !== 'skipped' ? prev : d)))
      .catch(() => alive && setFailed(true))
    api.reviewDetail(row.id, true)
      .then((d) => alive && setDetail(d))
      .catch(() => { /* git 포함본이 실패해도 기록본이 있으면 그대로 둔다. 기록본도 실패하면 위에서 오류를 보인다. */ })
      .finally(() => alive && setGitLoading(false))
    return () => { alive = false }
  }, [row.id, row.lastSeq, retry])
  useEffect(() => { setUnrecordedOpen(false); setOtherOpen(false); setLeftoversOpen(false) }, [row.id])

  const d = detail && detail.id === row.id ? detail : null
  const gitOk = d?.git === 'ok'
  const showGitFail = !!d && d.git === 'unavailable' && !gitLoading
  const title = row.title || t('brain.review.untitled')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: C.label, overflowWrap: 'anywhere' }}>{title}</h2>
        <div title={row.projectPath} className="truncate" style={{ marginTop: 4, fontSize: 13, color: C.label3 }}>
          {row.projectName} · {relTime(row.lastActivityAt)}
        </div>
        {(row.partial || d?.partial) && <div style={{ marginTop: 10, fontSize: 13, color: C.label2 }}>{t('brain.review.partial')}</div>}
        {showGitFail && <div style={{ marginTop: 10, fontSize: 13, color: C.label2 }}>{t('brain.review.gitUnavailable')}</div>}

        {d?.turnFailed && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: C.label }}>
            <CircleAlert size={14} aria-hidden style={{ flexShrink: 0, color: C.del }} />
            {t(d.turnFailed === 'failed' ? 'brain.review.turnFailed' : 'brain.review.turnInterrupted')}
          </div>
        )}

        {!d && failed && (
          <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ fontSize: 14, color: C.label2 }}>{t('brain.review.detailFailed')}</div>
            <Button tone="gray" height={36} onClick={() => setRetry((n) => n + 1)}>{t('brain.review.retry')}</Button>
          </div>
        )}
        {!d && !failed && (
          <div aria-label={t('brain.loading')} role="status" style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Skeleton width="60%" height={14} />
            <Skeleton width="90%" height={44} radius={12} />
            <Skeleton width="90%" height={44} radius={12} />
          </div>
        )}

        {d && d.failedCommands.length > 0 && (
          <Section title={t('brain.review.sectionFailed')} count={d.failedCommands.length}>
            {d.failedCommands.map((c, i) => (
              <div key={`${c.seq}:${c.text}`}>
                <RowLine index={i} />
                <button type="button" className="press" onClick={() => onOpen(c.seq)} style={itemStyle}>
                  <CircleAlert size={15} aria-hidden style={{ flexShrink: 0, marginTop: 3, color: C.del }} />
                  <span style={{ ...wrapText, fontFamily: FONT.mono, fontVariantLigatures: 'none', fontSize: 13, lineHeight: 1.45 }}>{c.text}</span>
                </button>
              </div>
            ))}
          </Section>
        )}

        {d && d.openTodos.length > 0 && (
          <Section title={t('brain.review.sectionTodos')} count={d.openTodos.length}>
            {d.openTodos.map((todo, i) => (
              <div key={`${i}:${todo.text}`}>
                <RowLine index={i} />
                <button type="button" className="press" onClick={() => onOpen(todo.seq)} style={itemStyle}>
                  <Circle size={15} aria-hidden style={{ flexShrink: 0, marginTop: 3, color: C.label3 }} />
                  <span style={{ ...wrapText, fontSize: 15, lineHeight: 1.45 }}>{todo.text}</span>
                </button>
              </div>
            ))}
          </Section>
        )}

        {d && d.outsideFiles.length > 0 && (
          <Section title={t('brain.review.sectionOutside')} hint={t('brain.review.outsideHint')}>
            {d.outsideFiles.map((p, i) => (
              <div key={p}>
                <RowLine index={i} />
                <button type="button" className="press" onClick={() => onOpen(d.changedFiles.find((f) => f.path === p)?.seq)} style={itemStyle}>
                  <span style={{ ...wrapText, fontFamily: FONT.mono, fontVariantLigatures: 'none', fontSize: 13, lineHeight: 1.45 }}>{p}</span>
                </button>
              </div>
            ))}
          </Section>
        )}

        {d && gitOk && d.leftovers.length > 0 && (
          <section style={{ marginTop: 20 }}>
            <button
              type="button"
              className="press"
              aria-expanded={leftoversOpen}
              aria-controls="review-leftovers"
              onClick={() => setLeftoversOpen((v) => !v)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 44, padding: 0, border: 'none', background: 'transparent', color: C.label2, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
            >
              {leftoversOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
              {t('brain.review.leftovers', { n: d.leftovers.length })}
            </button>
            <Collapse open={leftoversOpen} id="review-leftovers">
              <div style={{ fontSize: 13, color: C.label3, margin: '0 0 8px' }}>{t('brain.review.leftoversHint')}</div>
              {d.leftoversIncomplete && <div style={{ fontSize: 13, color: C.label2, margin: '0 0 8px' }}>{t('brain.review.leftoversIncomplete')}</div>}
              {d.leftovers.map((l) => (
                <div key={`${l.from}:${l.name}`} style={{ marginBottom: 10 }}>
                  <div style={{ margin: '0 0 6px', fontFamily: FONT.mono, fontVariantLigatures: 'none', fontSize: 13, fontWeight: 600, color: C.label, overflowWrap: 'anywhere' }}>{l.name}</div>
                  <Group>
                    {l.hits.map((h, i) => (
                      <div key={`${h.path}:${h.line}`}>
                        <RowLine index={i} />
                        <button type="button" className="press" onClick={() => actions.openFileViewer(row.id, h.path)} style={itemStyle}>
                          <span style={{ ...wrapText, display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ fontFamily: FONT.mono, fontVariantLigatures: 'none', fontSize: 12.5, color: C.label3 }}>{h.path}:{h.line}</span>
                            <span style={{ fontFamily: FONT.mono, fontVariantLigatures: 'none', fontSize: 13, lineHeight: 1.45 }}>{h.text}</span>
                          </span>
                        </button>
                      </div>
                    ))}
                  </Group>
                </div>
              ))}
            </Collapse>
          </section>
        )}

        {d && d.changedFiles.length > 0 && (
          <Section title={t('brain.review.sectionFiles')} count={d.changedFiles.length}>
            {d.changedFiles.map((f, i) => (
              <ReviewFile
                key={`${row.id}:${row.lastSeq}:${f.path}`}
                sessionId={row.id}
                index={i}
                shownPath={displayPath(f.path, row.cwd)}
                state={gitOk && d.fileStates[i] !== 'unknown' ? t(d.fileStates[i] === 'uncommitted' ? 'brain.review.fileUncommitted' : 'brain.review.fileClean') : undefined}
                seq={f.seq}
                path={f.path}
                narrow={narrow}
                onOpen={onOpen}
              />
            ))}
          </Section>
        )}

        {d && gitOk && d.unrecorded.length > 0 && (
          <section style={{ marginTop: 20 }}>
            <button
              type="button"
              className="press"
              aria-expanded={unrecordedOpen}
              aria-controls="review-unrecorded"
              onClick={() => setUnrecordedOpen((v) => !v)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 44, padding: 0, border: 'none', background: 'transparent', color: C.label2, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
            >
              {unrecordedOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
              {t('brain.review.unrecorded', { n: d.unrecorded.length })}
            </button>
            <Collapse open={unrecordedOpen} id="review-unrecorded">
              <div style={{ fontSize: 13, color: C.label3, margin: '0 0 8px' }}>{t('brain.review.unrecordedHint')}</div>
              <Group>
                {d.unrecorded.map((p, i) => (
                  <div key={p}>
                    <RowLine index={i} />
                    <div style={{ padding: '10px 14px', fontFamily: FONT.mono, fontVariantLigatures: 'none', fontSize: 13, lineHeight: 1.45, overflowWrap: 'anywhere', color: C.label }}>{p}</div>
                  </div>
                ))}
              </Group>
            </Collapse>
          </section>
        )}

        {d && d.otherFailures.length > 0 && (
          <section style={{ marginTop: 20 }}>
            <button
              type="button"
              className="press"
              aria-expanded={otherOpen}
              aria-controls="review-other"
              onClick={() => setOtherOpen((v) => !v)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 44, padding: 0, border: 'none', background: 'transparent', color: C.label2, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
            >
              {otherOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
              {t('brain.review.otherFailures', { n: d.otherFailures.length })}
            </button>
            <Collapse open={otherOpen} id="review-other">
              <div style={{ fontSize: 13, color: C.label3, margin: '0 0 8px' }}>{t('brain.review.otherFailuresHint')}</div>
              <Group>
                {d.otherFailures.map((c, i) => (
                  <div key={`${c.seq}:${c.text}`}>
                    <RowLine index={i} />
                    <button type="button" className="press" onClick={() => onOpen(c.seq)} style={itemStyle}>
                      <span style={{ ...wrapText, fontFamily: FONT.mono, fontVariantLigatures: 'none', fontSize: 13, lineHeight: 1.45 }}>{c.text}</span>
                    </button>
                  </div>
                ))}
              </Group>
            </Collapse>
          </section>
        )}

        <p style={{ margin: '24px 0 0', fontSize: 12.5, lineHeight: 1.5, color: C.label3 }}>{t('brain.review.footnote')}</p>
      </div>

      <div style={{ flexShrink: 0, display: 'flex', gap: 8, justifyContent: narrow ? undefined : 'flex-end', padding: '10px 0 0', borderTop: `0.5px solid ${C.sepSoft}`, background: C.bg }}>
        <Button tone="gray" height={narrow ? 44 : 36} grow={narrow} onClick={() => onOpen()} disabled={busy}>{t('brain.review.openSession')}</Button>
        <Button
          tone="gray"
          height={narrow ? 44 : 36}
          grow={narrow}
          disabled={busy}
          onClick={() => {
            // 검토함 창(z 70)이 넘기기 창(z 52)보다 위라서 먼저 닫는다.
            actions.closeBrain()
            actions.selectSession(row.id)
            actions.openReview(row.id)
          }}
        >
          {t('handoff.review.button')}
        </Button>
        <Button tone="primary" height={narrow ? 44 : 36} grow={narrow} onClick={onDone} disabled={busy} aria-busy={busy}>
          {busy ? t('brain.review.working') : t('brain.review.markDone')}
        </Button>
      </div>
    </div>
  )
}
