// 새 작업 창의 묶음. 설정 창과 같은 제목, 면, 구분선, 스위치 줄.
import { useRef, type KeyboardEvent } from 'react'
import { Check } from 'lucide-react'
import type { ProviderInfo } from '../../lib/types'
import { C } from '../../design/tokens'
import { Switch } from '../ui'
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
