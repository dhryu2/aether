// 권한 칩 — 이 세션이 지금 어떤 권한 모드인지 보여 주고, 그 세션의 provider가 알려 준 모드 중에서 고르게 한다.
//   고르면 서버가 그 세션의 provider 어댑터에 넘긴다. 진행 중인 응답에 닿지 않는 변경은 서버가 지연으로 알리고 대화에 안내가 남는다. 화면은 provider를 모르고 받은 목록만 본다.
//   칩 글자는 현재 모드 이름이다. 수동일 때는 작업 폴더 설정의 자동승인 규칙도 여기 드러난다(8d-3 ⑥ⓕ).
import { Shield } from 'lucide-react'
import { actions, chromeSessionId, convoLoading, paneView, permissionBadgeKind, useStore, type State } from '../lib/store'
import { useT } from '../lib/i18n'
import { ChipPicker, type ChipOption } from './ui'
import { C } from '../design/tokens'
import type { PermissionMode, PermissionPolicyScope } from '../lib/types'

/** 목록에 보이는 순서. 받은 목록의 순서와 무관하게 화면 표시 순서만 고정한다. */
const DISPLAY_ORDER: readonly PermissionMode[] = ['auto', 'manual', 'edits', 'full']

/**
 * 이 세션의 권한 상태를 칩 글자로 요약한다. kind='all'(전면 우회)이면 주황으로 칠한다.
 *
 * 권한 카드를 건너뛰는 길이 둘이다. 권한 무시 모드(full)와 **작업 폴더의 설정에 등록된 자동승인 목록**이다.
 * 어느 폴더를 열지는 화면에서 고르므로, 폰에서는 뒤쪽을 알 방법이 아예 없었다. 그래서 칩에서 둘 다 드러낸다.
 * 자동승인 규칙은 수동 모드의 칩 글자로 보이고, 다른 모드에서는 마우스를 올렸을 때 설명에만 붙는다.
 */
function permissionSummary(s: State, mode: PermissionMode, t: ReturnType<typeof useT>): { kind: 'all' | 'partial' | null; label: string; title: string } {
  const p = s.permissionPolicy
  const kind = permissionBadgeKind(mode, p)
  const modeLabel = t(`session.permission.mode.${mode}`)
  if (kind === 'all') {
    // full이 아닌데 실효 정책이 전면 우회라면(작업 폴더 설정이 그렇다) 모드 이름 대신 그 사실을 보인다.
    return { kind, label: mode === 'full' ? modeLabel : t('session.permission.mode.full'), title: t('nav.topbar.permissionsTitle') }
  }
  const baseTitle = t('session.permission.title', { level: modeLabel })
  // 규칙이 하나도 없어도 **기본 동작 자체**가 승인을 건너뛰게 설정돼 있으면 카드는 안 뜬다 — 그때도 알려야 한다.
  if (kind === 'partial' && p) {
    const scopes = p.sources.map((sc: PermissionPolicyScope) => t(`nav.topbar.policyScope.${sc}`)).join(', ')
    const policyLabel = p.autoApproveMode
      ? t('nav.topbar.autoApproveModeLabel', { mode: p.autoApproveMode })
      : t('nav.topbar.autoApproveLabel', { count: p.autoApproveRules })
    const policyTitle = p.autoApproveMode
      ? t('nav.topbar.autoApproveModeTitle', { mode: p.autoApproveMode, count: p.autoApproveRules, scopes })
      : t('nav.topbar.autoApproveTitle', { count: p.autoApproveRules, scopes })
    if (mode === 'manual') return { kind, label: policyLabel, title: policyTitle }
    return { kind, label: modeLabel, title: `${baseTitle} · ${policyTitle}` }
  }
  return { kind, label: modeLabel, title: baseTitle }
}

export function PermissionPicker({ compact, direction = 'down', roomId, tight }: { compact?: boolean; direction?: 'up' | 'down'; roomId?: string; tight?: boolean }) {
  const store = useStore()
  // 칸 안의 칩은 자기 세션 값을 본다(상단 도구 섬의 칩은 포커스 칸).
  const s = roomId ? paneView(store, roomId) : store
  const t = useT()
  const sess = s.sessions.find((x) => x.id === chromeSessionId(s))
  if (!sess) return null
  const cur = sess.permissionMode
  const sum = permissionSummary(s, cur, t)
  // 목록을 아직 못 받았으면 현재 모드만 보인다. 받은 목록에 현재 모드가 없어도 지금 상태를 숨기지 않는다.
  const offered = new Set<PermissionMode>(s.permissionModes ?? [])
  offered.add(cur)
  const options: ChipOption<PermissionMode>[] = DISPLAY_ORDER.filter((m) => offered.has(m)).map((m) => ({
    value: m,
    // 위험한 쪽은 주황 글자로 구분하고, 부제에 위험을 글로 적는다(색은 상태 신호에만 — 감사 F5).
    title: m === 'full' ? <span style={{ color: C.attn }}>{t(`session.permission.mode.${m}`)}</span> : t(`session.permission.mode.${m}`),
    subtitle: t(`session.permission.mode.${m}Hint`),
  }))
  return (
    <ChipPicker
      options={options}
      value={cur}
      onPick={(next) => {
        if (next !== cur) void actions.setPermissionMode(next, chromeSessionId(s))
      }}
      label={
        <span className="inline-flex items-center" style={{ gap: 5, color: sum.kind === 'all' ? C.attn : undefined }}>
          <Shield size={13} aria-hidden />
          {/* 좁은 칸은 방패만 남긴다. 모드 이름은 접근성 이름과 마우스를 올렸을 때 설명에 남고, 전면 허용은 주황으로 남는다. */}
          {tight ? <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>{sum.label}</span> : sum.label}
        </span>
      }
      title={sum.title}
      loading={convoLoading(s)}
      loadingLabel={t('session.permission.checking')}
      skeletonWidth={compact ? 64 : 56}
      compact={compact}
      direction={direction}
      align={roomId ? 'left' : undefined}
      minWidth={280}
    />
  )
}
