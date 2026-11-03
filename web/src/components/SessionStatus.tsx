// 설정 안의 사용량. 지금 작업의 한도 막대, 그리고 비용과 저장소를 한 줄로 보여 준다.
import { useEffect, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { chromeSessionId, useStore } from '../lib/store'
import { bytes, ctxPctFromTokens, fmtShortDateTime } from '../lib/format'
import { formatCostUsd } from '../lib/formatCost'
import { httpStatus } from '../lib/errors'
import { useT } from '../lib/i18n'
import { rateLimitLabel } from '../lib/usageLabels'
import type { UsageResponse } from '../lib/types'
import { C, R } from '../design/tokens'
import { IconButton, Skeleton } from './ui'
import { Group, GroupNote, Sep } from './settings/parts'
import { useNarrow } from './settings/settingsLayout'

// 첫 응답 전 자리 잡기. 흔한 경우(문맥 창 + 한도 둘)에 맞춰 세 줄을 그린다.
const SKELETON_ROWS = 3

/** UsageBlock과 같은 높이로 그려 응답이 와도 화면이 밀리지 않게 한다. */
function UsageBlockSkeleton() {
  return (
    <div style={{ padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, height: 20 }}>
        <Skeleton width={96} height={14} />
        <Skeleton width={32} height={14} />
      </div>
      <Skeleton width="100%" height={4} radius={R.full} style={{ marginTop: 8 }} />
      <Skeleton width={140} height={11} style={{ marginTop: 9 }} />
    </div>
  )
}

function UsageBlock({ label, pct, detail }: { label: string; pct: number | null; detail?: string | null }) {
  const shown = pct == null ? null : Math.max(0, Math.min(100, pct))
  const high = (shown ?? 0) >= 85
  return (
    <div style={{ padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 15, color: C.label }}>{label}</span>
        {shown != null && (
          <span className="tabular-nums" style={{ fontSize: 15, fontWeight: 600, color: high ? C.attn : C.label }}>
            {Math.round(shown)}%
          </span>
        )}
      </div>
      {shown != null && (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(shown)}
          style={{ height: 4, borderRadius: R.full, background: C.fill, overflow: 'hidden', marginTop: 8 }}
        >
          <div className="bar-fill" style={{ width: '100%', height: '100%', transform: `scaleX(${shown / 100})`, background: high ? C.attn : C.tint }} />
        </div>
      )}
      {detail && <div style={{ fontSize: 12.5, color: C.label3, marginTop: 6 }}>{detail}</div>}
    </div>
  )
}

export function SessionStatus() {
  const s = useStore()
  const t = useT()
  const narrow = useNarrow()
  const id = chromeSessionId(s)
  const [usage, setUsage] = useState<UsageResponse | null>(null)
  const [stats, setStats] = useState<{ dataBytes: number; sessions: number } | null>(null)
  const [err, setErr] = useState('')

  const load = async () => {
    setErr('')
    if (!id) {
      setUsage(null)
      setStats(null)
      return
    }
    void api.getStats().then(setStats).catch(() => { /* 공통 API가 원인을 처리했으며 통계 없이 사용량 표시를 계속한다. */ })
    try {
      setUsage(await api.getUsage(id))
    } catch (e) {
      setErr(httpStatus(e) === 501 ? t('session.status.notSupported') : t('session.status.liveOnly'))
    }
  }

  useEffect(() => { void load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 새로고침 때는 이미 그린 값을 둔 채 바꿔 끼우므로, 아직 받은 값이 없을 때만 스켈레톤이다.
  const loading = !!id && !usage && !err

  const blocks: ReactNode[] = []
  if (usage?.context && usage.context.size > 0) {
    blocks.push(
      <UsageBlock
        key="context"
        label={t('session.status.context')}
        pct={ctxPctFromTokens(usage.context.used, usage.context.size)}
        detail={t('session.status.contextTokens', {
          used: usage.context.used.toLocaleString(),
          size: usage.context.size.toLocaleString(),
        })}
      />,
    )
  }
  if (usage?.windowsAvailable) {
    for (const w of usage.windows) {
      const reset = w.resetsAt ? new Date(w.resetsAt) : null
      const detail = reset && !Number.isNaN(reset.getTime())
        ? t('session.status.resetAt', { date: fmtShortDateTime(reset.getTime()) })
        : null
      blocks.push(
        <UsageBlock key={w.key} label={rateLimitLabel(w.key, t, w.windowMinutes)} pct={w.utilization} detail={detail} />,
      )
    }
  }

  const notes: string[] = []
  if (!id) notes.push(t('session.status.noActive'))
  else if (err) notes.push(err)
  else if (usage && !usage.windowsAvailable) notes.push(t('session.status.noRateLimit'))
  if (id && usage) {
    const amount = formatCostUsd(usage.costUsd)
    if (amount) notes.push(t('session.status.sessionCost', { amount }))
  }
  if (id && stats) notes.push(t('session.status.storageStats', { bytes: bytes(stats.dataBytes), count: stats.sessions }))

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingLeft: 16, marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.label2 }}>{t('session.status.title')}</div>
        <IconButton
          label={t('common.refresh')}
          size={narrow ? 44 : 28}
          className={narrow ? 'hit-44' : undefined}
          onClick={() => void load()}
          style={{ background: C.fill, color: C.label2 }}
        >
          <RefreshCw size={narrow ? 16 : 14} />
        </IconButton>
      </div>
      {loading && (
        <div role="status" aria-busy="true" aria-label={t('session.status.loading')}>
          <Group>
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <div key={i}>
                {i > 0 && <Sep />}
                <UsageBlockSkeleton />
              </div>
            ))}
          </Group>
          <Skeleton width={180} height={12} style={{ margin: '12px 16px 0' }} />
        </div>
      )}
      {!loading && blocks.length > 0 && (
        <Group>
          {blocks.map((block, i) => (
            <div key={i}>
              {i > 0 && <Sep />}
              {block}
            </div>
          ))}
        </Group>
      )}
      {!loading && notes.length > 0 && <GroupNote>{notes.join(' ')}</GroupNote>}
    </section>
  )
}
