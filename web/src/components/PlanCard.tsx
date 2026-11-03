// 계획 검토 카드 — 승인 / 수정 요청 / 취소 세 갈래. 권한 카드·질문 카드에 넣지 않는다.
import { useState } from 'react'
import { ListTodo } from 'lucide-react'
import type { PlanRequest } from '../lib/types'
import { actions, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { C, R } from '../design/tokens'
import { Button } from './ui'
import { ActionCard, ActionCardActions, ActionCardFooter, ActionCardHeader, ActionCardTitle } from './stream/ActionCard'
import { Markdown } from './Markdown'
import { onCopyMenu } from './contextMenuFor'

export function PlanCard({ req, resolved }: { req: PlanRequest; resolved?: 'approve' | 'revise' | 'cancel' }) {
  const t = useT()
  const narrow = useStore().isNarrow
  const pending = !resolved
  const [reviseOpen, setReviseOpen] = useState(false)
  const [note, setNote] = useState('')

  const result = resolved === 'cancel' ? 'deny' : resolved === 'revise' ? 'revise' : 'allow'

  return (
    <ActionCard pending={pending} result={result}>
      <ActionCardHeader pending={pending} icon={<ListTodo size={16} />}>
        <ActionCardTitle title={t('session.plan.title')} sub={t('session.plan.hint')} />
      </ActionCardHeader>

      <div
        className="scroll-area"
        onContextMenu={onCopyMenu(req.text.trim() ? req.text : null, t('menu.copyPlan'))}
        style={{
          fontSize: 14,
          color: C.label,
          background: C.bg,
          borderRadius: 12,
          padding: '12px 14px',
          maxHeight: 280,
          overflow: 'auto',
          lineHeight: 1.6,
        }}
      >
        {req.text.trim() ? <Markdown>{req.text}</Markdown> : t('session.plan.empty')}
      </div>

      {pending && !reviseOpen && (
        // 채운 버튼은 승인 하나뿐이다. 취소·수정 요청은 회색.
        <ActionCardActions narrow={narrow}>
          <Button tone="gray" height={narrow ? 46 : 44} paddingX={narrow ? 0 : 18} fontSize={14} style={narrow ? { flex: 1 } : undefined} onClick={() => actions.resolvePlan(req.id, 'cancel')}>
            {t('session.plan.cancel')}
          </Button>
          <Button tone="gray" height={narrow ? 46 : 44} paddingX={narrow ? 0 : 18} fontSize={14} style={narrow ? { flex: 1 } : undefined} onClick={() => setReviseOpen(true)}>
            {t('session.plan.revise')}
          </Button>
          <Button tone="primary" height={narrow ? 46 : 44} paddingX={narrow ? 0 : 22} fontSize={14} style={narrow ? { flex: 1.4 } : undefined} onClick={() => actions.resolvePlan(req.id, 'approve')}>
            {t('session.plan.approve')}
          </Button>
        </ActionCardActions>
      )}

      {pending && reviseOpen && (
        <div style={{ display: 'grid', gap: 10 }}>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('session.plan.revisePlaceholder')}
            rows={3}
            className="choice-other"
            style={{
              width: '100%',
              border: 'none',
              background: C.bg,
              color: C.label,
              borderRadius: R.field,
              padding: '10px 12px',
              fontSize: 15,
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          <ActionCardActions narrow={narrow}>
            <Button tone="gray" height={44} paddingX={narrow ? 0 : 18} fontSize={14} style={narrow ? { flex: 1 } : undefined} onClick={() => setReviseOpen(false)}>
              {t('common.close')}
            </Button>
            <Button
              tone="primary"
              height={44}
              paddingX={narrow ? 0 : 22}
              fontSize={14}
              style={narrow ? { flex: 1.4 } : undefined}
              disabled={!note.trim()}
              onClick={() => actions.resolvePlan(req.id, 'revise', note.trim())}
            >
              {t('session.plan.reviseSend')}
            </Button>
          </ActionCardActions>
        </div>
      )}

      {resolved === 'approve' && <ActionCardFooter color={C.ok}>{t('session.plan.approvedStatus')}</ActionCardFooter>}
      {resolved === 'revise' && <ActionCardFooter color={C.tint}>{t('session.plan.revisedStatus')}</ActionCardFooter>}
      {resolved === 'cancel' && <ActionCardFooter color={C.del}>{t('session.plan.cancelledStatus')}</ActionCardFooter>}
    </ActionCard>
  )
}
