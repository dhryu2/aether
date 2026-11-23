// 새 세션 빈 화면 아래의 "이 폴더에서 최근에 한 일". 같은 폴더의 이전 세션이 있을 때만 그린다.
//   없거나 읽기에 실패하거나 서버가 옛 버전이라 404를 주면 아무것도 그리지 않아, 화면은 지금 그대로다.
//   줄을 누르면 그 세션의 그 지점(지시·오류·파일·할 일이 나온 곳)으로 간다.
import { useEffect, useState } from 'react'
import type { ProjectRecapSession } from '@shared/brain'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import { actions, useStore } from '../lib/store'
import { C, FONT } from '../design/tokens'
import { Group, RowLine } from './brain/Bits'

const STATE_COLOR: Record<ProjectRecapSession['state'], string> = {
  running: C.tint, waiting: C.label2, failed: C.del, interrupted: C.label2, done: C.label3,
}
const lineOf = (min: number) => ({ display: 'block', width: '100%', minHeight: min, padding: '6px 14px', border: 'none', background: 'transparent', textAlign: 'left', cursor: 'pointer', color: C.label }) as const
const clamp = (n: number) => ({ display: '-webkit-box', WebkitLineClamp: n, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }) as const
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p

function Tag({ children }: { children: string }) {
  return <span style={{ display: 'block', fontSize: 11.5, fontWeight: 600, color: C.label3, marginBottom: 2 }}>{children}</span>
}

function RecapCard({ s }: { s: ProjectRecapSession }) {
  const t = useT()
  const narrow = useStore().isNarrow // 좁은 화면은 누르는 영역을 44로
  const line = lineOf(narrow ? 44 : 36)
  const go = (seq: number) => actions.openSessionAt(s.id, seq)
  return (
    <div style={{ paddingBottom: 6 }}>
      <button type="button" className="press" onClick={() => go(s.lastPrompt?.seq ?? s.lastSeq)} style={{ ...line, paddingTop: 10 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="truncate" style={{ minWidth: 0, flex: 1, fontSize: 14, fontWeight: 600 }}>{s.title || t('brain.review.untitled')}</span>
          <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, color: STATE_COLOR[s.state] }}>{t(`brain.recap.${s.state}`)}</span>
        </span>
        {s.lastPrompt && <span style={{ ...clamp(2), marginTop: 2, fontSize: 13, lineHeight: 1.4, color: C.label2 }}>{s.lastPrompt.text}</span>}
      </button>
      {s.lastError && (
        <button type="button" className="press" onClick={() => go(s.lastError!.seq)} style={line}>
          <Tag>{t('brain.recap.lastError')}</Tag>
          <span style={{ ...clamp(2), fontFamily: FONT.mono, fontVariantLigatures: 'none', fontSize: 12.5, lineHeight: 1.4 }}>{s.lastError.text}</span>
        </button>
      )}
      {s.recentFiles.length > 0 && (
        <div style={{ padding: '4px 14px' }}>
          <Tag>{t('brain.recap.recentFiles')}</Tag>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 12px' }}>
            {s.recentFiles.map((f) => (
              <button key={f.path} type="button" className="press" title={f.path} onClick={() => go(f.seq)} style={{ minHeight: narrow ? 44 : 32, maxWidth: '100%', padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', color: C.tint, fontFamily: FONT.mono, fontSize: 12.5 }}>
                <span className="truncate" style={{ display: 'block' }}>{base(f.path)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {s.openTodos.length > 0 && (
        <div>
          <div style={{ padding: '4px 14px 0' }}><Tag>{t('brain.recap.openTodos')}</Tag></div>
          {s.openTodos.map((todo, i) => (
            <button key={`${i}:${todo.text}`} type="button" className="press" onClick={() => go(todo.seq)} style={{ ...line, minHeight: narrow ? 44 : 32, paddingTop: 4, paddingBottom: 4 }}>
              <span style={{ ...clamp(1), fontSize: 13 }}>{todo.text}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ProjectRecap({ sessionId, project }: { sessionId: string; project: string }) {
  const t = useT()
  const [got, setGot] = useState<{ project: string; sessions: ProjectRecapSession[] } | null>(null)
  useEffect(() => {
    let alive = true
    if (project) api.reviewRecap(project).then((r) => alive && setGot({ project, sessions: r.sessions })).catch(() => { /* 없으면 지금 화면 그대로 */ })
    return () => { alive = false }
  }, [project])
  // 다른 폴더의 응답이 남아 있으면 쓰지 않는다.
  const shown = (got?.project === project ? got.sessions : []).filter((s) => s.id !== sessionId)
  if (!shown.length) return null
  return (
    <section aria-label={t('brain.recap.title')} style={{ width: '100%', maxWidth: 520, minWidth: 0 }}>
      <h3 style={{ margin: '0 0 8px 4px', fontSize: 13, fontWeight: 600, color: C.label3 }}>{t('brain.recap.title')}</h3>
      <Group>
        {shown.map((s, i) => (
          <div key={s.id}>
            <RowLine index={i} />
            <RecapCard s={s} />
          </div>
        ))}
      </Group>
    </section>
  )
}
