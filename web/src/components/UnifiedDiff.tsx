// 권한 카드용 unified diff(한 컬럼 — 모바일 가독). mutation.hunks에서 렌더.
//   재설계 4단계: 카드 여백 안에 들어앉은 둥근 판(모서리 12, 화면 바탕색)이다. 카드 폭 끝까지 가로지르는 띠가 아니다.
import type { MutationPreview } from '../lib/types'
import { useT } from '../lib/i18n'
import { C } from '../design/tokens'

// 줄 종류별 색 — 배경/글자/줄번호(거터) 세 자리. 값은 전부 공통 토큰에서 가져온다.
//   bar = 줄 왼쪽 끝에 세우는 색 막대. 변경 없는 줄에는 세우지 않는다(없음 = 아무 일도 안 일어난 줄).
//   numberBg = 줄 번호 칸의 바탕. 변경된 줄에서는 비워 둔다 — 칠하면 그 줄을 가로지르는 색 띠가 왼쪽에서 끊긴다.
const ADD = { bg: C.okSoft, text: C.ok, gutter: C.okBorder, bar: C.ok, numberBg: undefined }
const DEL = { bg: C.delSoft, text: C.del, gutter: C.delBorder, bar: C.del, numberBg: undefined }
const CTX = { bg: undefined, text: C.label2, gutter: C.label3, bar: undefined, numberBg: undefined }

/** 둥근 판 — 안내 한 줄과 diff 본문이 같은 모양을 쓴다. */
const PANEL = { borderRadius: 12, overflow: 'hidden', background: C.bg } as const

function Label({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warn' }) {
  return (
    <div
      className="font-mono"
      style={{
        ...PANEL,
        fontSize: 12,
        color: tone === 'warn' ? C.attn : C.label3,
        background: tone === 'warn' ? C.attnSoft : C.bg,
        padding: '10px 14px',
      }}
    >
      {children}
    </div>
  )
}

export function UnifiedDiff({ m }: { m: MutationPreview }) {
  const t = useT()
  if (m.redacted) return <Label tone="warn">{t('stream.diff.secretHidden')}</Label>
  if (m.binary) return <Label>{t('stream.diff.binary')}</Label>
  if (m.truncated) return <Label tone="warn">{t('stream.diff.truncated')}</Label>
  if (!m.hunks || m.hunks.length === 0) return <Label>{t('stream.diff.noPreview')}</Label>

  const rows: { type: 'add' | 'del' | 'ctx'; n: number | null; text: string }[] = []
  for (const h of m.hunks) {
    let oldLine = h.oldStart
    let newLine = h.newStart
    for (const raw of h.lines) {
      const c = raw[0]
      const text = raw.slice(1)
      if (c === '+') {
        rows.push({ type: 'add', n: newLine++, text })
      } else if (c === '-') {
        rows.push({ type: 'del', n: oldLine++, text })
      } else {
        rows.push({ type: 'ctx', n: newLine, text })
        oldLine++
        newLine++
      }
    }
  }

  return (
    <div className="flex flex-col" style={{ gap: 8 }}>
      {m.inexact && <Label tone="warn">{t('stream.diff.inexact')}</Label>}
      {/* tabular-nums = 줄 번호의 숫자 폭을 같게. 9와 10에서 자릿수가 어긋나 보이지 않는다. */}
      <div className="font-mono tabular-nums overflow-x-auto" style={{ ...PANEL, overflow: 'auto', fontSize: 12.5, lineHeight: 1.7, padding: '8px 0' }}>
        {rows.map((r, i) => {
          const c = r.type === 'add' ? ADD : r.type === 'del' ? DEL : CTX
          return (
            <div key={i} className="diff-row flex" style={{ background: c.bg }}>
              {/* 줄 왼쪽 끝의 색 막대 — 배경색만으로 구분하던 것을 눈에 띄는 선으로 바꾼다.
                  변경 없는 줄에서는 색을 비워 자리만 차지한다(자리까지 없애면 줄들이 좌우로 어긋난다). */}
              <span
                aria-hidden
                className={`diff-bar ${r.type === 'add' ? 'diff-bar-add' : r.type === 'del' ? 'diff-bar-del' : ''}`}
                style={{ width: 2.5, flexShrink: 0, background: c.bar ?? 'transparent' }}
              />
              <span
                style={{
                  width: 38,
                  flexShrink: 0,
                  textAlign: 'right',
                  paddingRight: 8,
                  userSelect: 'none',
                  color: c.gutter,
                  background: c.numberBg,
                  borderRight: `1px solid ${C.sepSoft}`,
                }}
              >
                {r.n ?? ''}
              </span>
              {/* 구분선이 생겼으니 본문이 선에 붙지 않게 왼쪽 여백을 준다. */}
              <span style={{ flex: 1, color: c.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', paddingLeft: 8, paddingRight: 10 }}>
                <span style={{ userSelect: 'none', opacity: 0.7 }}>{r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '}</span>
                {r.text}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
