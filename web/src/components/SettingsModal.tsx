// 설정 창. 칸(pane) 열 개를 앱·서버 두 묶음으로 나눈다.
// 컴퓨터는 왼쪽 목록 + 오른쪽 본문(창 크기 고정). 폰은 묶음 목록에서 칸으로 들어가는 iOS 설정 앱 방식이다.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { actions, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { C, R, Z } from '../design/tokens'
import { ModalCard, ModalHeader, ModalShell } from './ui'
import { SessionStatus } from './SessionStatus'
import { BackupView } from './settings/BackupView'
import { ErrorLogView } from './settings/ErrorLogView'
import { useErrorTodayCount } from './settings/useErrorTodayCount'
import { Group, GroupTitle, Sep, TextRow } from './settings/parts'
import { PasswordSection } from './settings/PasswordSection'
import { LlmSection, ServerInfoSection } from './settings/ServerInfoSection'
import { RemoteAccessSection } from './settings/RemoteAccessSection'
import { ServerLogView } from './settings/ServerLogView'
import { rowMin } from './settings/settingsLayout'
import { AccountSection, AutoResumeSection, GeneralSection, PushSection, TroubleSection } from './settings/sections'

type Pane = 'general' | 'push' | 'autoResume' | 'account' | 'usage' | 'info' | 'llm' | 'errors' | 'logs' | 'backup' | 'trouble'
const GROUPS: readonly { title: string; panes: readonly Pane[] }[] = [
  { title: 'settings.group.app', panes: ['general', 'push', 'autoResume', 'account', 'usage'] },
  { title: 'settings.group.server', panes: ['info', 'llm', 'errors', 'logs', 'backup', 'trouble'] },
]
const PANES: readonly Pane[] = GROUPS.flatMap((g) => g.panes)
const PANE_TITLE: Record<Pane, string> = {
  general: 'settings.section.general',
  push: 'settings.section.push',
  autoResume: 'settings.section.autoResume',
  account: 'settings.pane.account',
  usage: 'settings.pane.usage',
  info: 'settings.info.title',
  llm: 'settings.llm.title',
  errors: 'settings.errorLog.title',
  logs: 'settings.logs.title',
  backup: 'settings.backup.title',
  trouble: 'settings.section.trouble',
}
const TAB_ID = 'settings'

// 마지막에 본 칸. 창을 닫았다 열어도 기억한다(새로고침하면 처음으로 돌아간다).
const memory: { pane: Pane } = { pane: 'general' }
const remember = (p: Pane) => { memory.pane = p }

function PaneBody({ pane }: { pane: Pane }) {
  switch (pane) {
    case 'general': return <GeneralSection hideTitle />
    case 'push': return <PushSection hideTitle />
    case 'autoResume': return <AutoResumeSection hideTitle />
    case 'account': return <><AccountSection /><PasswordSection /></>
    case 'usage': return <SessionStatus />
    case 'info': return <><ServerInfoSection hideTitle /><RemoteAccessSection /></>
    case 'llm': return <LlmSection hideTitle />
    case 'errors': return <ErrorLogView />
    case 'logs': return <ServerLogView />
    case 'backup': return <BackupView />
    case 'trouble': return <TroubleSection hideTitle />
  }
}

export function SettingsModal() {
  const open = useStore().settingsOpen
  // 창이 닫히면 칸 상태를 버린다. 컴퓨터는 마지막에 본 칸, 폰은 목록에서 다시 시작한다.
  return open ? <SettingsWindow /> : null
}

function SettingsWindow() {
  const s = useStore()
  const t = useT()
  const narrow = s.isNarrow
  const errorToday = useErrorTodayCount()
  // 폰의 null은 묶음 목록 화면. 컴퓨터는 늘 어느 한 칸이 열려 있다.
  const [phonePane, setPhonePane] = useState<Pane | null>(null)
  const [deskPane, setDeskPane] = useState<Pane>(memory.pane)
  const [enter, setEnter] = useState<'tab-in-r' | 'tab-in-l' | undefined>(undefined)
  const root = useRef<HTMLDivElement>(null)
  // 목록으로 돌아올 때 초점을 줄 줄. Safari는 눌린 단추에 초점을 주지 않아 activeElement를 믿을 수 없으므로 직접 기억한다.
  const returning = useRef<Pane | null>(null)

  const pane = narrow ? phonePane : deskPane
  const back = () => {
    returning.current = phonePane
    setEnter('tab-in-l')
    setPhonePane(null)
  }
  const openPhone = (p: Pane) => {
    returning.current = p
    remember(p)
    setDeskPane(p)
    setEnter('tab-in-r')
    setPhonePane(p)
  }
  const pickDesk = (p: Pane) => {
    remember(p)
    setDeskPane(p)
  }

  // 폰: 칸을 바꾸면 창 본문(스크롤 칸)이 이전 위치에 남지 않고 맨 위부터 보인다.
  useEffect(() => {
    root.current?.closest('.scroll-area')?.scrollTo({ top: 0 })
  }, [phonePane])

  // 폰: 칸에 들어가면 뒤로 단추로, 목록으로 돌아오면 방금 열었던 줄로 초점을 옮긴다.
  useEffect(() => {
    if (!narrow) return
    if (phonePane) {
      root.current?.closest('[data-window]')?.querySelector<HTMLElement>('[data-modal-back]')?.focus()
    } else if (returning.current) {
      root.current?.querySelector<HTMLElement>(`[data-pane-row="${returning.current}"] button`)?.focus()
      returning.current = null
    }
  }, [narrow, phonePane])

  const todayText = errorToday > 0 ? t('settings.errorLog.today', { n: errorToday.toLocaleString() }) : null
  const onPhoneBack = narrow && phonePane

  return (
    <ModalShell onClose={onPhoneBack ? back : actions.closeSettings} zIndex={Z.root.settings}>
      <ModalCard variant="sheet" maxWidth={780} split data-window="settings">
        <ModalHeader
          title={pane ? t(PANE_TITLE[pane]) : t('settings.title')}
          onClose={actions.closeSettings}
          closeLabel={t('common.close')}
          onBack={onPhoneBack ? back : undefined}
          backLabel={onPhoneBack ? t('settings.back') : undefined}
        />
        {narrow ? (
          <div ref={root} className={enter} style={{ minWidth: 0, minHeight: 420 }}>
            {phonePane ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
                <PaneBody pane={phonePane} />
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                {GROUPS.map((g) => (
                  <section key={g.title}>
                    <GroupTitle>{t(g.title)}</GroupTitle>
                    <Group>
                      {g.panes.map((p, i) => (
                        <div key={p} data-pane-row={p}>
                          {i > 0 && <Sep />}
                          <TextRow onClick={() => openPhone(p)}>
                            <span style={{ flex: 1, minWidth: 0 }}>{t(PANE_TITLE[p])}</span>
                            {p === 'errors' && todayText && (
                              <span className="tabular-nums" style={{ fontSize: 15, color: C.label2 }}>{todayText}</span>
                            )}
                            <ChevronRight size={16} aria-hidden style={{ flexShrink: 0, color: C.label2 }} />
                          </TextRow>
                        </div>
                      ))}
                    </Group>
                  </section>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div ref={root} style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0 }}>
            <PaneList pane={deskPane} onPick={pickDesk} todayText={todayText} />
            <div
              key={deskPane}
              role="tabpanel"
              id={`${TAB_ID}-panel-${deskPane}`}
              aria-labelledby={`${TAB_ID}-tab-${deskPane}`}
              className="pane-fade scroll-area"
              style={{ flex: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', boxSizing: 'border-box', padding: '16px 20px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}
            >
              <PaneBody pane={deskPane} />
            </div>
          </div>
        )}
      </ModalCard>
    </ModalShell>
  )
}

/** 컴퓨터의 왼쪽 목록. 선택 표시는 칸마다 칠하지 않고 하나의 상자가 세로로 미끄러진다. */
function PaneList({ pane, onPick, todayText }: { pane: Pane; onPick: (p: Pane) => void; todayText: string | null }) {
  const t = useT()
  const list = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ top: number; height: number } | null>(null)
  // 선택된 줄의 자리를 재서 상자를 옮긴다. 묶음 제목 때문에 줄 높이만으로는 계산할 수 없다.
  useLayoutEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!el) return
    const next = { top: el.offsetTop, height: el.offsetHeight }
    // 같은 자리면 상태를 그대로 둔다. useT는 그릴 때마다 새 함수라, 새 객체를 넣으면 다시 그리기가 끝없이 돈다(React #185).
    setPill((p) => (p && p.top === next.top && p.height === next.height ? p : next))
  }, [pane, t])

  // 위/아래 화살표는 양 끝에서 돌아 이어지고, 옮기면 곧바로 그 칸이 선택된다(자동 활성).
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = PANES.length - 1
    const to = e.key === 'ArrowDown' ? (i === last ? 0 : i + 1)
      : e.key === 'ArrowUp' ? (i === 0 ? last : i - 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1
    if (to < 0) return
    e.preventDefault()
    onPick(PANES[to])
    document.getElementById(`${TAB_ID}-tab-${PANES[to]}`)?.focus()
  }

  let idx = -1
  const row = (p: Pane): ReactNode => {
    const i = ++idx
    const on = p === pane
    return (
      <button
        key={p}
        id={`${TAB_ID}-tab-${p}`}
        role="tab"
        type="button"
        aria-selected={on}
        aria-controls={`${TAB_ID}-panel-${p}`}
        tabIndex={on ? 0 : -1}
        onKeyDown={(e) => onKey(e, i)}
        onClick={() => onPick(p)}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          minHeight: rowMin(false) - 8,
          padding: '0 10px',
          border: 'none',
          borderRadius: R.sm,
          background: 'transparent',
          font: 'inherit',
          fontSize: 14,
          fontWeight: on ? 600 : 400,
          color: C.label,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t(PANE_TITLE[p])}</span>
        {p === 'errors' && todayText && (
          <span className="tabular-nums" style={{ flexShrink: 0, fontSize: 12, color: C.label2 }}>{todayText}</span>
        )}
      </button>
    )
  }

  return (
    <div
      ref={list}
      role="tablist"
      aria-orientation="vertical"
      aria-label={t('settings.pane.label')}
      className="scroll-area"
      style={{ position: 'relative', flexShrink: 0, width: 200, overflowY: 'auto', overflowX: 'hidden', boxSizing: 'border-box', padding: '8px 8px 16px', background: C.bg2, borderRight: `1px solid ${C.sepSoft}` }}
    >
      {pill && (
        <div
          aria-hidden
          className="pane-pill"
          style={{ position: 'absolute', left: 8, right: 8, top: 0, height: pill.height, transform: `translateY(${pill.top}px)`, borderRadius: R.sm, background: C.segOn }}
        />
      )}
      {GROUPS.map((g, gi) => (
        <div key={g.title} role="presentation" style={{ marginTop: gi > 0 ? 12 : 0, paddingTop: gi > 0 ? 8 : 0, borderTop: gi > 0 ? `1px solid ${C.sepSoft}` : undefined }}>
          <div style={{ padding: '4px 10px 4px', fontSize: 12, fontWeight: 600, color: C.label2 }}>{t(g.title)}</div>
          {g.panes.map(row)}
        </div>
      ))}
    </div>
  )
}
