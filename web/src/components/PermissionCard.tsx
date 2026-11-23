// W13. 권한 카드(PermissionCard) — 변이 승인의 주연. 허용/거부 전용(인자수정 폐쇄·H1).
//   바깥 면·머리·결과 줄은 질문·계획 카드와 같아서 `stream/ActionCard`가 함께 갖고 있다.
import { useRef } from 'react'
import { FilePen, FilePlus, FileCog, Terminal } from 'lucide-react'
import type { PermissionRequest } from '../lib/types'
import { actions, useStore } from '../lib/store'
import { permissionArgs } from '../lib/format'
import { t, useT } from '../lib/i18n'
import { C } from '../design/tokens'
import { Button } from './ui'
import { ActionCard, ActionCardActions, ActionCardFooter, ActionCardHeader, ActionCardTitle } from './stream/ActionCard'
import { UnifiedDiff } from './UnifiedDiff'
import { useReportPermButtons } from '../lib/permButtonsVisibility'

export function titleFor(req: PermissionRequest): { title: string; Icon: typeof FilePen } {
  const k = req.mutation?.kind
  if (k === 'write') return { title: req.mutation?.isCreate ? t('session.permission.createTitle') : t('session.permission.writeTitle'), Icon: FilePlus }
  if (k === 'edit' || k === 'multiedit') return { title: t('session.permission.editTitle'), Icon: FilePen }
  if (k === 'notebook') return { title: t('session.permission.notebookTitle'), Icon: FileCog }
  return { title: req.displayName || t('session.permission.runTitle', { tool: req.toolName }), Icon: Terminal }
}

/**
 * 도구 인자 전부 — 키는 라벨, 값은 본문. 값은 자르지 않고 줄바꿈한다(가로 스크롤·말줄임 없음).
 * 어느 provider의 인자든 키를 해석하지 않고 그대로 그린다.
 */
function PermissionArgs({ input }: { input: Record<string, unknown> | undefined }) {
  const args = permissionArgs(input)
  if (!args.length) return null
  return (
    <div className="flex flex-col" style={{ gap: 10, minWidth: 0 }}>
      {args.map((a) => (
        <div key={a.key} style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, color: C.label2, marginBottom: 4, overflowWrap: 'anywhere' }}>{a.key}</div>
          <div
            className="font-mono"
            style={{ fontSize: 12.5, color: C.label, background: C.bg, borderRadius: 12, padding: '10px 14px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6, minWidth: 0 }}
          >
            {a.value === '' ? '""' : a.value}
          </div>
        </div>
      ))}
    </div>
  )
}

export function PermissionCard({ req, resolved }: { req: PermissionRequest; resolved?: 'allow' | 'deny' }) {
  const t = useT()
  const narrow = useStore().isNarrow // 모바일: 버튼을 풀폭 2분할(거부 flex1 / 승인 flex1.4, h46)
  const { title, Icon } = titleFor(req)
  const m = req.mutation
  const add = m?.additions
  const del = m?.deletions
  const pending = !resolved
  // 비밀 경로는 어댑터 표시본에 내용이 남아 있어도 인자를 그리지 않는다.
  const showArgs = !m?.redacted
  // 버튼 줄이 화면에 보이면 입력창 위 승인 줄을 숨긴다 — 같은 버튼이 두 벌 보이지 않게.
  const buttonsRef = useRef<HTMLDivElement>(null)
  useReportPermButtons(req.id, buttonsRef, pending)

  return (
    <ActionCard pending={pending} result={resolved === 'deny' ? 'deny' : 'allow'}>
      <ActionCardHeader pending={pending} icon={<Icon size={16} />}>
        <ActionCardTitle title={title} sub={m?.path ?? req.toolName} subMono subTitle={m?.path} subWrap />
        {/* 늘어난·줄어든 줄 수 — 상자 없이 색 글자만(시안 A). */}
        {((add ?? 0) > 0 || (del ?? 0) > 0) && (
          <div className="flex items-center font-mono tabular-nums" style={{ gap: 6, fontSize: 12, flexShrink: 0, alignSelf: 'flex-start', marginTop: 3 }}>
            {add != null && add > 0 && <span style={{ color: C.ok }}>+{add}</span>}
            {del != null && del > 0 && <span style={{ color: C.del }}>-{del}</span>}
          </div>
        )}
      </ActionCardHeader>

      {/* 본문: 변경 미리보기가 있으면 diff와 접힌 전체 인자, 없으면 인자 전부를 펼쳐 둔다(승인 버튼에 닿으려면 내용을 지나간다). */}
      {m ? (
        <>
          <UnifiedDiff m={m} />
          {showArgs && Object.keys(req.input ?? {}).length > 0 && (
            <details style={{ fontSize: 13, color: C.label2, minWidth: 0 }}>
              <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer', color: C.tint }}>{t('session.permission.allArgs')}</summary>
              <PermissionArgs input={req.input} />
            </details>
          )}
        </>
      ) : (
        <PermissionArgs input={req.input} />
      )}
      {req.decisionReason && <div style={{ fontSize: 12.5, color: C.label2 }}>{req.decisionReason}</div>}

      {/* 버튼 줄 / 결과 줄 */}
      {pending ? (
        <ActionCardActions narrow={narrow} divRef={buttonsRef}>
          <Button
            tone="gray"
            onClick={() => actions.resolvePermission(req.id, 'deny')}
            height={narrow ? 46 : 44}
            paddingX={narrow ? 0 : 22}
            fontSize={15}
            style={narrow ? { flex: 1 } : undefined}
          >
            {t('session.permission.deny')}
          </Button>
          <Button
            tone="primary"
            onClick={() => actions.resolvePermission(req.id, 'allow')}
            height={narrow ? 46 : 44}
            paddingX={narrow ? 0 : 22}
            fontSize={15}
            style={narrow ? { flex: 1.4 } : undefined}
          >
            {t('session.permission.allow')}
          </Button>
        </ActionCardActions>
      ) : resolved === 'allow' ? (
        <ActionCardFooter color={C.ok}>{t('session.permission.allowedStatus')}</ActionCardFooter>
      ) : (
        <ActionCardFooter color={C.del}>{t('session.permission.deniedStatus')}</ActionCardFooter>
      )}
    </ActionCard>
  )
}
