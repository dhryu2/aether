// 두 부분의 탭. 세그먼트가 아니다. 화살표는 초점만 옮기고, Enter·Space가 고른다.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { C, R } from '../../design/tokens'
import { useT } from '../../lib/i18n'
import type { BrainTab } from '../../lib/brain'
import { BRAIN_TABS } from './brainTabList'

export function BrainTabs({ orientation, value, onChange }: {
  orientation: 'vertical' | 'horizontal'
  value: BrainTab
  onChange: (next: BrainTab) => void
}) {
  const t = useT()
  const vertical = orientation === 'vertical'
  const [focusId, setFocusId] = useState<BrainTab>(value)
  const refs = useRef<Partial<Record<BrainTab, HTMLButtonElement | null>>>({})
  // 클릭이나 Enter로 선택이 바뀌면 그 탭이 다시 탭 순서의 자리가 된다.
  useEffect(() => { setFocusId(value) }, [value])

  function move(delta: number) {
    const i = BRAIN_TABS.findIndex((tb) => tb.id === focusId)
    const next = BRAIN_TABS[(Math.max(0, i) + delta + BRAIN_TABS.length) % BRAIN_TABS.length].id
    setFocusId(next)
    refs.current[next]?.focus()
  }

  function onKeyDown(e: KeyboardEvent) {
    const prev = vertical ? 'ArrowUp' : 'ArrowLeft'
    const next = vertical ? 'ArrowDown' : 'ArrowRight'
    if (e.key === prev || e.key === next) {
      e.preventDefault()
      move(e.key === next ? 1 : -1)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onChange(focusId)
    }
  }

  return (
    <div
      role="tablist"
      aria-orientation={vertical ? 'vertical' : undefined}
      onKeyDown={onKeyDown}
      style={vertical
        ? { display: 'flex', flexDirection: 'column', gap: 2, position: 'relative' }
        : { display: 'flex', flex: 1, minWidth: 0, height: '100%' }}
    >
      {/* 세로 탭의 선택 상자는 칸마다 칠하지 않고 하나가 세로로 미끄러진다(칸 높이 34 + 간격 2 = 36). */}
      {vertical && (
        <span
          aria-hidden
          className="tab-pill"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: 34,
            borderRadius: 10,
            background: C.fill,
            pointerEvents: 'none',
            transform: `translateY(${Math.max(0, BRAIN_TABS.findIndex((tb) => tb.id === value)) * 36}px)`,
          }}
        />
      )}
      {BRAIN_TABS.map((tb) => {
        const on = value === tb.id
        const label = t(tb.labelKey)
        return (
          <button
            key={tb.id}
            ref={(el) => { refs.current[tb.id] = el }}
            id={`brain-tab-${tb.id}`}
            type="button"
            role="tab"
            data-brain-tab={tb.id}
            aria-selected={on}
            aria-controls="brain-tabpanel"
            tabIndex={focusId === tb.id ? 0 : -1}
            className="press"
            onClick={() => { setFocusId(tb.id); onChange(tb.id) }}
            style={vertical ? verticalStyle(on) : horizontalStyle(on)}
          >
            {vertical ? (
              <>
                <tb.Icon size={18} style={{ flexShrink: 0, color: on ? C.tint : C.label2 }} />
                <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap' }}>{label}</span>
              </>
            ) : (
              <>
                <tb.Icon size={22} />
                <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}

function verticalStyle(on: boolean): CSSProperties {
  return {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    height: 34,
    padding: '0 10px',
    border: 'none',
    borderRadius: 10,
    background: 'transparent',
    color: C.label,
    fontSize: 14,
    fontWeight: on ? 600 : 500,
    cursor: 'pointer',
  }
}

function horizontalStyle(on: boolean): CSSProperties {
  return {
    position: 'relative',
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    border: 'none',
    borderRadius: R.full,
    background: 'transparent',
    color: on ? C.tint : C.label2,
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
  }
}
