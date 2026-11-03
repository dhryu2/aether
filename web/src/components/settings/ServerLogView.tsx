// 설정 > 서버의 「서버 로그」 칸.
// 오류 기록과 달리 서버가 남긴 전체 출력을 시간순으로 보여 준다. 수준은 색이 아니라 글자로 표시한다.
import { useEffect, useRef, useState } from 'react'
import type { ServerLogEntry as LogLine, ServerLogLevel } from '@shared/http'
import { api } from '../../lib/api'
import { fmtShortDateTime } from '../../lib/format'
import { useT } from '../../lib/i18n'
import { C, FONT } from '../../design/tokens'
import { Button, EmptyState, Notice, NOTICE_TONE, SegmentedControl, Skeleton } from '../ui'
import { Group, GroupNote, Sep } from './parts'
import { rowMin, useNarrow } from './settingsLayout'

const LEVELS: readonly ServerLogLevel[] = ['log', 'warn', 'error']
type State = { phase: 'loading' | 'failed' | 'ready'; entries: LogLine[] }

export function ServerLogView() {
  const t = useT()
  const narrow = useNarrow()
  const [level, setLevel] = useState<ServerLogLevel>('log')
  const [state, setState] = useState<State>({ phase: 'loading', entries: [] })
  const [attempt, setAttempt] = useState(0)
  // 늦게 도착한 응답을 버리기 위한 번호(req()는 취소 신호를 받지 않는다).
  const seq = useRef(0)

  useEffect(() => {
    const mine = ++seq.current
    setState({ phase: 'loading', entries: [] })
    api.serverLogs({ lines: 200, level }).then(
      (r) => { if (mine === seq.current) setState({ phase: 'ready', entries: r.entries }) },
      () => { if (mine === seq.current) setState({ phase: 'failed', entries: [] }) },
    )
  }, [level, attempt])

  const empty = state.phase === 'ready' && state.entries.length === 0
  const announce = state.phase === 'failed' ? t('settings.logs.failed') : empty ? t('settings.logs.empty') : ''
  const itemHeight = narrow ? 44 : 28

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div>
        <Group>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: rowMin(narrow), padding: '0 16px' }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{t('settings.logs.level.label')}</span>
            <SegmentedControl
              size="compact"
              items={LEVELS.map((v) => ({ value: v, label: t(`settings.logs.level.${v}`) }))}
              value={level}
              onChange={setLevel}
              itemPadding={narrow ? '0 12px' : '0 10px'}
              itemHeight={itemHeight}
              itemMinWidth={narrow ? 44 : undefined}
              style={{ flexShrink: 0 }}
            />
          </div>
        </Group>
        <GroupNote>{t('settings.logs.note')}</GroupNote>
      </div>
      <div role="status" className="sr-only">{announce}</div>

      {state.phase === 'loading' && (
        <div aria-busy="true">
          <Group>
            {[0, 1, 2].map((i) => (
              <div key={i}>
                {i > 0 && <Sep />}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 16px' }}>
                  <Skeleton width="80%" height={14} />
                  <Skeleton width="40%" height={12} />
                </div>
              </div>
            ))}
          </Group>
        </div>
      )}

      {state.phase === 'failed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
          <Notice {...NOTICE_TONE.warn} fontSize={13} style={{ alignSelf: 'stretch' }}>{t('settings.logs.failed')}</Notice>
          <Button onClick={() => setAttempt((n) => n + 1)}>{t('settings.logs.retry')}</Button>
        </div>
      )}

      {empty && <EmptyState title={t('settings.logs.empty')} color={C.label2} />}

      {state.phase === 'ready' && state.entries.length > 0 && (
        <Group>
          {state.entries.map((line, i) => (
            <div key={i}>
              {i > 0 && <Sep />}
              <LogRow line={line} />
            </div>
          ))}
        </Group>
      )}
    </div>
  )
}

function LogRow({ line: { t: at, level, msg } }: { line: LogLine }) {
  const t = useT()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 16px' }}>
      <span className="tabular-nums" style={{ display: 'flex', gap: 8, fontSize: 11, color: C.label3 }}>
        <span>{fmtShortDateTime(Date.parse(at))}</span>
        <span style={{ fontWeight: 600 }}>{t(`settings.logs.tag.${level}`)}</span>
      </span>
      <span style={{ fontFamily: FONT.mono, fontSize: 12, color: C.label, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text' }}>{msg}</span>
    </div>
  )
}
