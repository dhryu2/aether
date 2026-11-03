// 새 작업 창의 묶음. 설정 창과 같은 제목, 면, 구분선, 스위치 줄.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import type { ModelInfo, ProviderInfo } from '../../lib/types'
import { C } from '../../design/tokens'
import { useDismiss } from '../../lib/hooks'
import { PopoverSurface, Switch } from '../ui'
import { Group, Sep } from '../settings/parts'
import { rowMin, useNarrow } from '../settings/settingsLayout'

export function SwitchLine({
  title,
  on,
  disabled,
  onChange,
  onColor,
  sessionOpt,
}: {
  title: string
  on: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
  onColor?: string
  sessionOpt?: string
}) {
  const narrow = useNarrow()
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        minHeight: rowMin(narrow),
        padding: '0 16px',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <span aria-hidden style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.label }}>{title}</span>
      <Switch
        className={narrow ? 'hit-44' : undefined}
        on={on}
        disabled={disabled}
        label={title}
        onChange={onChange}
        onColor={onColor}
        data-session-opt={sessionOpt}
      />
    </label>
  )
}

export function ServiceBlock({
  label,
  providers,
  fanout,
  creating,
  isOn,
  onChoose,
  fanoutTitle,
  onFanout,
  unavailable,
}: {
  label: string
  providers: ProviderInfo[]
  fanout: boolean
  creating: boolean
  isOn: (id: string) => boolean
  onChoose: (id: string) => void
  fanoutTitle: string
  onFanout: (next: boolean) => void
  /** 지금 고를 수 없는 서비스면 그 이유 글. 그 줄은 흐리게 그리고 누를 수 없다. */
  unavailable: (id: string) => string | undefined
}) {
  const narrow = useNarrow()
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())

  // 한 개 고르기만 라디오 묶음이다. 고른 줄만 Tab에 두고, 방향키는 초점과 선택을 함께 옮긴다.
  function onRadioKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (fanout || creating || providers.length === 0) return
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight'
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft'
    if (forward || back) {
      e.preventDefault()
      // 고를 수 없는 줄은 건너뛴다. 한 바퀴 돌아도 없으면 그대로 둔다.
      let next = index
      for (let step = 0; step < providers.length; step++) {
        next = (next + (forward ? 1 : -1) + providers.length) % providers.length
        if (!unavailable(providers[next].id)) break
      }
      const id = providers[next]?.id
      if (!id || unavailable(id)) return
      onChoose(id)
      rowRefs.current.get(id)?.focus()
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      onChoose(providers[index].id)
    }
  }

  return (
    <Group>
      <div role={fanout ? 'group' : 'radiogroup'} aria-label={label}>
        {providers.map((p, i) => {
          const on = isOn(p.id)
          const reason = unavailable(p.id)
          return (
            <div key={p.id}>
              {i > 0 && <Sep />}
              <button
                type="button"
                role={fanout ? 'checkbox' : 'radio'}
                aria-checked={on}
                tabIndex={fanout ? undefined : (on ? 0 : -1)}
                disabled={creating || !!reason}
                data-provider-id={p.id}
                data-provider-unavailable={reason ? '1' : undefined}
                data-provider-selected={on ? '1' : undefined}
                ref={(el) => {
                  if (el) rowRefs.current.set(p.id, el)
                  else rowRefs.current.delete(p.id)
                }}
                onClick={() => onChoose(p.id)}
                onKeyDown={(e) => onRadioKey(e, i)}
                className="press"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  minHeight: rowMin(narrow),
                  padding: '0 16px',
                  border: 'none',
                  background: 'transparent',
                  cursor: creating || reason ? 'default' : 'pointer',
                  textAlign: 'left',
                  font: 'inherit',
                  fontSize: 15,
                  color: C.label,
                }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: reason ? C.label3 : undefined }}>{p.displayName}</span>
                {reason && <span style={{ flexShrink: 0, fontSize: 13, color: C.label3 }}>{reason}</span>}
                {on && (
                  <span aria-hidden style={{ color: C.tint, display: 'inline-flex', flexShrink: 0 }}>
                    <Check size={16} />
                  </span>
                )}
              </button>
            </div>
          )
        })}
      </div>
      <Sep />
      <SwitchLine
        title={fanoutTitle}
        on={fanout}
        disabled={creating}
        onChange={onFanout}
        sessionOpt="fanout-start"
      />
    </Group>
  )
}

// 고르면 값이 줄에 남는 팝업 단추. 목록은 세션 안 모델 칩과 같은 떠 있는 면에 그린다.
// 저장된 목록이 없어도 잠그지 않고, 열어서 기본 모델과 왜 목록이 없는지를 보여 준다.
export function ModelBlock({
  label,
  defaultLabel,
  emptyNote,
  rows,
  value,
  disabled,
  onChange,
}: {
  label: string
  defaultLabel: string
  emptyNote: string
  rows: ModelInfo[]
  /** 고른 모델. 빈 값은 기본 모델이다. */
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const narrow = useNarrow()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useDismiss(wrapRef, () => setOpen(false), open)
  const options = [{ value: '', displayName: defaultLabel }, ...rows]
  const picked = options.find((o) => o.value === value) ?? options[0]

  // 열면 고른 줄로 초점을 옮기고, 창 스크롤 안에 목록이 다 보이게 한다.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
    listRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open])

  function close() {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!open) return
    if (e.key === 'Escape') {
      // 뒤의 새 세션 창까지 닫히지 않게 여기서 멈춘다.
      e.stopPropagation()
      close()
      return
    }
    if (e.key === 'Tab') {
      setOpen(false)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }

  return (
    <div ref={wrapRef} onKeyDown={onKey} style={{ position: 'relative', background: C.cell, borderRadius: 12 }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        data-session-opt="new-session-model"
        onClick={() => setOpen((o) => !o)}
        className="press"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          minHeight: rowMin(narrow),
          padding: '0 16px',
          border: 'none',
          borderRadius: 12,
          background: 'transparent',
          cursor: disabled ? 'default' : 'pointer',
          textAlign: 'left',
          font: 'inherit',
          fontSize: 15,
          color: C.label,
        }}
      >
        <span style={{ flexShrink: 0 }}>{label}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right', color: C.label2 }}>{picked.displayName}</span>
        <ChevronsUpDown aria-hidden size={14} style={{ flexShrink: 0, color: C.label3 }} />
      </button>
      {open && (
        <PopoverSurface
          align="right"
          style={{ width: narrow ? '100%' : 300, maxWidth: '100%', maxHeight: 300, overflowY: 'auto', scrollMarginBlock: 88 }}
        >
          <div ref={listRef} role="listbox" aria-label={label}>
            {options.map((o) => {
              const on = o.value === picked.value
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={on}
                  data-model-value={o.value}
                  onClick={() => { onChange(o.value); close() }}
                  className="press"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    width: '100%',
                    minHeight: narrow ? rowMin(narrow) : 40,
                    padding: '0 16px',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    font: 'inherit',
                    fontSize: 15,
                    color: C.label,
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.displayName}</span>
                  {on && (
                    <span aria-hidden style={{ color: C.tint, display: 'inline-flex', flexShrink: 0 }}>
                      <Check size={16} />
                    </span>
                  )}
                </button>
              )
            })}
            {rows.length === 0 && (
              <p style={{ fontSize: 13, color: C.label2, lineHeight: 1.45, margin: 0, padding: '4px 16px 12px' }}>{emptyNote}</p>
            )}
          </div>
        </PopoverSurface>
      )}
    </div>
  )
}

export function SafetyBlock({
  copyTitle,
  copyOn,
  copyDisabled,
  onCopy,
  note,
  noteUnavailable,
}: {
  copyTitle: string
  copyOn: boolean
  copyDisabled: boolean
  onCopy: (next: boolean) => void
  note: string
  noteUnavailable: boolean
}) {
  return (
    <>
      <Group>
        <SwitchLine
          title={copyTitle}
          on={copyOn}
          disabled={copyDisabled}
          onChange={onCopy}
          sessionOpt="isolate-workspace"
        />
      </Group>
      <p
        data-session-opt={noteUnavailable ? 'isolate-unavailable' : undefined}
        style={{ fontSize: 13, color: C.label2, lineHeight: 1.45, margin: '8px 0 0', padding: '0 16px' }}
      >
        {note}
      </p>
    </>
  )
}
