import { ShieldAlert } from 'lucide-react'
import { C, R } from '../../design/tokens'
import { actions } from '../../lib/store'
import { useT } from '../../lib/i18n'
import { Button } from '../ui'
import type { PermissionRequest } from '../../lib/types'
import { usePermButtonsVisible } from '../../lib/permButtonsVisibility'

// 승인 Y/N 퀵바 — 미해결 권한요청이 있으면 카드까지 스크롤하지 않고 여기서 원탭 승인/거부.
//   카드의 버튼이 이미 화면에 보이면 뜨지 않는다. 같은 거부·승인이 한 화면에 두 벌 있으면 어느 쪽을 누를지 헷갈린다.
export function PermissionQuickBar({ perm, isNarrow }: { perm: PermissionRequest; isNarrow: boolean }) {
  const t = useT()
  const cardVisible = usePermButtonsVisible(perm.id)
  if (cardVisible) return null
  const label = perm.mutation?.path || perm.displayName || perm.toolName
  const h = isNarrow ? 40 : 34 // 터치는 크게, 마우스는 작게
  return (
    // 입력창 위에 뜬 유리 알약(재설계 4단계). 기다림은 주황 방패 아이콘이 알린다 — 테두리는 칠하지 않는다.
    <div
      className="glass flex items-center card-in"
      style={{ gap: 9, padding: '6px 6px 6px 14px', borderRadius: R.full }}
    >
      <ShieldAlert size={16} style={{ color: C.attn, flexShrink: 0 }} />
      <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.label2 }} title={label}>
        <span style={{ fontWeight: 600, color: C.label }}>{t('composer.permission.waiting')}</span>
        {' · '}
        <span className="font-mono" style={{ fontSize: 12 }}>{label}</span>
      </span>
      <Button
        tone="gray"
        onClick={() => actions.resolvePermission(perm.id, 'deny')}
        height={h}
        paddingX={14}
        fontSize={13}
        style={{ flexShrink: 0 }}
      >
        {t('composer.permission.deny')}
      </Button>
      <Button
        tone="primary"
        onClick={() => actions.resolvePermission(perm.id, 'allow')}
        height={h}
        paddingX={16}
        fontSize={13}
        style={{ flexShrink: 0 }}
      >
        {t('composer.permission.allow')}
      </Button>
    </div>
  )
}
