// 알림 목록의 승인 요청 줄들 — 한 세션 분량. 바로 승인할 수 있는 요청은 인자 전문과 단추를,
//   그렇지 않은 요청(파일 변경 등)은 제목·경로·줄 수와 "세션에서 보기"만 그린다.
import type { PermissionRequest } from '../lib/types'
import { inboxPermissionText, inlinePermissionOk } from '../lib/activityInbox'
import { useT } from '../lib/i18n'
import { C } from '../design/tokens'
import { Button } from './ui'
import { titleFor } from './PermissionCard'

export function InboxPermissions({
  requests,
  selected,
  onToggle,
  showCheck,
  onResolve,
  onOpen,
  narrow,
}: {
  requests: PermissionRequest[]
  selected: ReadonlySet<string>
  onToggle: (id: string) => void
  showCheck: boolean
  onResolve: (id: string, decision: 'allow' | 'deny') => void
  onOpen: () => void
  narrow: boolean
}) {
  const t = useT()
  const h = narrow ? 44 : 32
  return (
    <div className="flex flex-col" data-inbox-permissions style={{ gap: 12, marginTop: 8, minWidth: 0 }}>
      {requests.map((req) => {
        const { title } = titleFor(req)
        if (!inlinePermissionOk(req)) {
          const m = req.mutation
          return (
            <div key={req.id} data-inbox-permission={req.id} className="flex flex-col" style={{ gap: 4, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: C.label }}>{title}</div>
              {m?.path && <div className="truncate font-mono" style={{ fontSize: 12, color: C.label2 }} title={m.path}>{m.path}</div>}
              {((m?.additions ?? 0) > 0 || (m?.deletions ?? 0) > 0) && (
                <div className="flex font-mono tabular-nums" style={{ gap: 6, fontSize: 12 }}>
                  {(m?.additions ?? 0) > 0 && <span style={{ color: C.ok }}>+{m?.additions}</span>}
                  {(m?.deletions ?? 0) > 0 && <span style={{ color: C.del }}>-{m?.deletions}</span>}
                </div>
              )}
              <div style={{ fontSize: 12.5, color: C.label2 }}>{t('nav.inbox.needsSession')}</div>
              <div className="flex">
                <Button tone="gray" height={h} paddingX={narrow ? 14 : 16} fontSize={13} onClick={onOpen}>
                  {t('nav.inbox.openSession')}
                </Button>
              </div>
            </div>
          )
        }
        return (
          <div key={req.id} data-inbox-permission={req.id} className="flex items-start" style={{ gap: 8, minWidth: 0 }}>
            {showCheck && (
              <label className="inline-flex items-center justify-center" style={{ width: narrow ? 44 : 28, height: narrow ? 44 : 28, flexShrink: 0, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={selected.has(req.id)}
                  onChange={() => onToggle(req.id)}
                  aria-label={t('nav.inbox.select')}
                  style={{ width: 18, height: 18, cursor: 'pointer' }}
                />
              </label>
            )}
            <div className="flex flex-col" style={{ gap: 6, flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: C.label }}>{title}</div>
              {req.decisionReason && <div style={{ fontSize: 12.5, color: C.label2 }}>{req.decisionReason}</div>}
              <div
                className="font-mono"
                style={{ fontSize: 12.5, color: C.label, background: C.bg, borderRadius: 8, padding: '6px 10px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5, minWidth: 0 }}
              >
                {inboxPermissionText(req)}
              </div>
              <div className="flex" style={{ gap: 8 }}>
                <Button tone="gray" height={h} paddingX={narrow ? 0 : 16} fontSize={13} style={narrow ? { flex: 1 } : undefined} onClick={() => onResolve(req.id, 'deny')}>
                  {t('session.permission.deny')}
                </Button>
                <Button tone="primary" height={h} paddingX={narrow ? 0 : 16} fontSize={13} style={narrow ? { flex: 1 } : undefined} onClick={() => onResolve(req.id, 'allow')}>
                  {t('session.permission.allow')}
                </Button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
