// 다시 로그인 창의 단계별 내용. 파랑 버튼은 창 발에만 둔다.
import type { ReactNode } from 'react'
import { AlertTriangle, Check, Copy, ExternalLink } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { C, FONT, R } from '../../design/tokens'
import { IconButton } from '../ui'
import { ChamdingMascot } from '../ChamdingMascot'

export function Steps({ items }: { items: string[] }) {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((text, i) => (
        <li key={text} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span style={{ width: 16, flexShrink: 0, fontSize: 13, fontWeight: 600, color: C.label3 }}>{i + 1}</span>
          <span style={{ fontSize: 15, color: C.label, lineHeight: 1.4 }}>{text}</span>
        </li>
      ))}
    </ol>
  )
}

export function DeviceCode({ code, copied, narrow, onCopy }: {
  code: string
  copied: boolean
  narrow: boolean
  onCopy: () => void
}) {
  const t = useT()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, padding: '16px', borderRadius: 12, background: C.cell }}>
      <div style={{ flex: 1, minWidth: 0, textAlign: 'center', fontFamily: FONT.mono, fontSize: 28, fontWeight: 600, color: C.label, letterSpacing: '0.04em' }}>
        {code}
      </div>
      <button
        type="button"
        className="press"
        onClick={onCopy}
        style={{
          flexShrink: 0,
          height: narrow ? 44 : 32,
          padding: '0 14px',
          border: 'none',
          borderRadius: R.full,
          background: C.fill,
          color: C.label,
          font: 'inherit',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {copied ? t('session.auth.copied') : t('session.auth.device.copy')}
      </button>
    </div>
  )
}

export function GrayLink({ href, height, children }: { href: string; height: number; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="press"
      style={{
        height,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '0 14px',
        borderRadius: R.full,
        background: C.fill,
        color: C.label,
        fontSize: 13,
        fontWeight: 600,
        fontFamily: 'inherit',
        textDecoration: 'none',
        boxSizing: 'border-box',
      }}
    >
      {children}
      <ExternalLink size={14} />
    </a>
  )
}

export function CodeLinks({ url, narrow, copied, onCopy }: {
  url: string
  narrow: boolean
  copied: boolean
  onCopy: () => void
}) {
  const t = useT()
  const hit = narrow ? 44 : 32
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
      <GrayLink href={url} height={hit}>{t('session.auth.openLogin')}</GrayLink>
      <IconButton
        label={copied ? t('session.auth.copied') : t('session.auth.copyUrl')}
        size={hit}
        className={narrow ? 'hit-44' : undefined}
        onClick={onCopy}
        style={{ background: C.fill, color: copied ? C.ok : C.label }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </IconButton>
    </div>
  )
}

// 거절 문장. 창의 기존 낭독 영역 안에 그리고, 코드 칸이 이 id를 가리킨다.
export function ServerNote({ id, message }: { id: string; message: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', paddingTop: 14 }}>
      <span aria-hidden style={{ color: C.attn, flexShrink: 0, marginTop: 1 }}><AlertTriangle size={16} /></span>
      <span id={id} style={{ fontSize: 15, color: C.label, lineHeight: 1.4 }}>{message}</span>
    </div>
  )
}

export function CodeEntry({ code, narrow, describedBy, onChange, onSubmit }: {
  code: string
  narrow: boolean
  describedBy?: string
  onChange: (next: string) => void
  onSubmit: () => void
}) {
  const t = useT()
  return (
    <label style={{ display: 'block', marginTop: 14 }}>
      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: C.label2, marginBottom: 6 }}>{t('session.auth.codeLabel')}</span>
      <input
        value={code}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (code.trim()) onSubmit()
          }
        }}
        aria-describedby={describedBy}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        style={{
          width: '100%',
          height: narrow ? 50 : 44,
          boxSizing: 'border-box',
          border: 'none',
          borderRadius: 12,
          background: C.cell,
          color: C.label,
          padding: '0 12px',
          fontSize: 15,
          fontFamily: FONT.mono,
        }}
      />
    </label>
  )
}

export function SuccessPane() {
  const t = useT()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 8, padding: '8px 0' }}>
      <ChamdingMascot state="success" size={64} playOnMount priority={3} />
      <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', color: C.label }}>{t('session.auth.successTitle')}</div>
      <div style={{ fontSize: 15, color: C.label2, lineHeight: 1.45 }}>{t('session.auth.successDesc')}</div>
    </div>
  )
}

export function ErrorPane({ message }: { message: string }) {
  return (
    <div role="alert" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span style={{ color: C.del, flexShrink: 0, marginTop: 1 }}><AlertTriangle size={22} /></span>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.45, color: C.del }}>{message}</p>
    </div>
  )
}

export function PrimaryLink({ href, height, children }: { href: string; height: number; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="lift"
      style={{
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '0 18px',
        borderRadius: R.full,
        background: C.tintFill,
        color: C.onTint,
        fontSize: 15,
        fontWeight: 600,
        fontFamily: 'inherit',
        textDecoration: 'none',
        boxSizing: 'border-box',
      }}
    >
      {children}
      <ExternalLink size={15} />
    </a>
  )
}
