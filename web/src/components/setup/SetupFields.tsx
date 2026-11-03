// 첫 설정 화면의 작은 부품: 글자 입력칸, AI 준비 상태, 동의 전 핵심 안내.
import { useId, type ReactNode, type Ref } from 'react'
import { Check, CircleAlert } from 'lucide-react'
import { C, R } from '../../design/tokens'
import { useT } from '../../lib/i18n'
import type { AvailabilityState } from '../../lib/newSessionProviders'
import { aiStatusOf } from '../../lib/setupForm'
import type { ProviderInfo } from '../../lib/types'
import { Spinner } from '../ui'

export const FIELD_H = { desktop: 44, mobile: 50 }

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      {title && <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: C.label }}>{title}</h2>}
      {children}
    </section>
  )
}

/** 라벨, 안내, 오류가 aria-describedby로 입력칸에 이어진 한 칸. right는 칸 오른쪽 버튼 자리(칸 안쪽 여백은 호출부가 정한다). */
export function TextField(p: {
  id: string
  label: string
  hint?: string
  error?: string
  value: string
  onChange: (v: string) => void
  onBlur?: () => void
  type?: string
  autoComplete?: string
  inputMode?: 'numeric' | 'text'
  mono?: boolean
  height: number
  inputRef?: Ref<HTMLInputElement>
  /** 칸 옆(오른쪽 바깥)에 둘 버튼. */
  after?: ReactNode
  /** 칸 안 오른쪽에 겹칠 버튼. */
  inside?: ReactNode
}) {
  const hintId = useId()
  const errId = useId()
  const describedBy = [p.hint && hintId, p.error && errId].filter(Boolean).join(' ') || undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <label htmlFor={p.id} style={{ fontSize: 13, fontWeight: 600, color: C.label }}>{p.label}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', minWidth: 0 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <input
            ref={p.inputRef}
            id={p.id}
            className="setup-field"
            type={p.type ?? 'text'}
            value={p.value}
            inputMode={p.inputMode}
            autoComplete={p.autoComplete ?? 'off'}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={p.error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(e) => p.onChange(e.target.value)}
            onBlur={p.onBlur}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              height: p.height,
              borderRadius: R.field,
              background: C.cell,
              border: `1px solid ${p.error ? C.del : 'transparent'}`,
              padding: p.inside ? '0 48px 0 14px' : '0 14px',
              fontSize: 15,
              fontFamily: p.mono ? 'var(--font-mono)' : 'inherit',
              color: C.label,
            }}
          />
          {p.inside}
        </div>
        {p.after}
      </div>
      {p.hint && <p id={hintId} style={{ margin: 0, fontSize: 13, lineHeight: 1.4, color: C.label2 }}>{p.hint}</p>}
      {p.error && (
        <p id={errId} className="setup-reveal" style={{ margin: 0, fontSize: 13, lineHeight: 1.4, color: C.del, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <CircleAlert size={15} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{p.error}</span>
        </p>
      )}
    </div>
  )
}

/** AI 준비 상태. 이름은 서버가 준 displayName, 이유는 availability의 reason만 본다. 글자와 아이콘으로 보이고 색만 쓰지 않는다. */
export function AiStatus({ providers, availability, checking }: { providers: ProviderInfo[] | null | 'failed'; availability: AvailabilityState; checking: boolean }) {
  const t = useT()
  // 조회 중에도 자리를 잡아 화면이 밀리지 않게 한다.
  const note = (text: string) => <p style={{ margin: 0, padding: '14px 0', fontSize: 14, color: C.label2 }}>{text}</p>
  return (
    <div aria-live="polite" aria-busy={checking} style={{ minHeight: 56, background: C.cell, borderRadius: R.field, padding: '4px 14px' }}>
      {providers === null ? (
        <div role="status" style={{ padding: '10px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span className="sr-only">{t('setup.ai.checking')}</span>
          {[0, 1, 2, 3].map((n) => <div key={n} className="skeleton" style={{ height: 22 }} />)}
        </div>
      ) : providers === 'failed' || availability === 'failed' ? note(t('setup.ai.failed')) : providers.length === 0 ? note(t('setup.ai.none')) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {providers.map((p, i) => {
            const pending = availability === null
            const st = aiStatusOf(pending ? undefined : availability[p.id])
            const bad = !st.ready
            const reason = st.ready
              ? t('setup.ai.ready')
              : st.requires
                ? t('session.newSession.providerUnavailable.requires', { requires: st.requires })
                : t(`session.newSession.providerUnavailable.${st.reason}`)
            return (
              <li
                key={p.id}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 44,
                  borderTop: i === 0 ? 'none' : `1px solid ${C.sepSoft}`,
                }}
              >
                <span style={{ fontSize: 15, color: C.label, minWidth: 0, overflowWrap: 'anywhere' }}>{p.displayName}</span>
                <span key={pending ? '' : reason} className="setup-fade" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: pending || bad ? C.label2 : C.ok, flexShrink: 0 }}>
                  {pending ? <Spinner size={14} thickness={2} /> : bad ? <CircleAlert size={15} aria-hidden /> : <Check size={15} aria-hidden />}
                  {pending ? t('setup.ai.checking') : reason}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** 동의 전에 꼭 알려야 할 다섯 가지. 약관규제법 제3조에 따라 가장 큰 위험(첫 줄)과 면책(마지막 줄)은 굵게 둔다. */
const CONSENT_COUNT = 5
export function ConsentList() {
  const t = useT()
  return (
    <ul style={{ listStyle: 'disc', margin: 0, padding: '12px 14px 12px 30px', background: C.cell, borderRadius: R.field, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, lineHeight: 1.45, color: C.label2 }}>
      {Array.from({ length: CONSENT_COUNT }, (_, i) => (
        <li key={i} style={i === 0 || i === CONSENT_COUNT - 1 ? { fontWeight: 600, color: C.label } : undefined}>{t(`setup.consent.${i + 1}`)}</li>
      ))}
    </ul>
  )
}
