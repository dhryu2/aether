// 단축키 도움말. '?'로 연다. Esc·막 클릭 = 닫기. 여는 순간 초점 = 닫기.
import { actions, useStore } from '../lib/store'
import { MOD } from '../lib/format'
import { useT } from '../lib/i18n'
import { C, R, Z } from '../design/tokens'
import { ModalCard, ModalHeader, ModalShell } from './ui'

const ROWS: [string, string][] = [
  [`${MOD}+K`, 'session.shortcuts.search'],
  [`${MOD}+F`, 'session.shortcuts.find'],
  [`${MOD}+/`, 'session.shortcuts.brain'],
  [`${MOD}+,`, 'session.shortcuts.settings'],
  ['Ctrl+O', 'session.shortcuts.view'],
  [`${MOD}+1`, 'session.shortcuts.panes'],
  [`${MOD}+Shift+Enter`, 'session.shortcuts.zoom'],
  ['Alt+Shift+←/→', 'session.shortcuts.movePane'],
  [`${MOD}+Enter`, 'session.shortcuts.openBeside'],
  [`${MOD}+\\`, 'session.shortcuts.sidebar'],
  ['Enter', 'session.shortcuts.send'],
  ['↑', 'session.shortcuts.history'],
  ['Ctrl+Enter', 'session.shortcuts.sendNow'],
  ['Alt+↑', 'session.shortcuts.jumpUser'],
  ['```', 'session.shortcuts.codeBox'],
  ['↑/↓', 'session.shortcuts.reviewMove'],
  ['Enter', 'session.shortcuts.reviewOpen'],
  ['E', 'session.shortcuts.reviewDone'],
  ['Z', 'session.shortcuts.reviewUndo'],
  ['Esc', 'session.shortcuts.escape'],
  ['?', 'session.shortcuts.help'],
]

function Kbd({ label }: { label: string }) {
  return (
    <span className="flex" style={{ gap: 4, flexShrink: 0 }}>
      {label.split('+').map((k, i) => (
        <kbd
          key={i}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 24,
            height: 24,
            padding: '0 6px',
            fontSize: 12.5,
            fontWeight: 600,
            fontFamily: 'inherit',
            color: C.label,
            background: C.fill,
            borderRadius: 6,
            border: 'none',
          }}
        >
          {k}
        </kbd>
      ))}
    </span>
  )
}

export function ShortcutsHelp() {
  const s = useStore()
  const t = useT()
  if (!s.shortcutsOpen) return null

  return (
    <ModalShell onClose={actions.closeShortcuts} zIndex={Z.root.shortcuts}>
      <ModalCard variant="sheet" maxWidth={420} data-window="shortcuts">
        <ModalHeader title={t('session.shortcuts.title')} onClose={actions.closeShortcuts} closeLabel={t('common.close')} />
        <div style={{ background: C.cell, borderRadius: R.field, overflow: 'hidden' }}>
          {ROWS.map(([keys, descKey], i) => (
            <div
              key={descKey}
              className="flex items-center"
              style={{
                minHeight: 44,
                gap: 12,
                padding: '0 14px',
                borderTop: i === 0 ? undefined : `0.5px solid ${C.sepSoft}`,
              }}
            >
              <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{t(descKey)}</span>
              <Kbd label={keys} />
            </div>
          ))}
        </div>
      </ModalCard>
    </ModalShell>
  )
}
