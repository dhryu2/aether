// 어시스턴트 버블 본문 마크다운 — react-markdown + remark-gfm + syntax highlighting.
//   ⚠️ memo 필수: Prism 문법강조 토큰화가 무거워, 라이브 스트리밍/재렌더마다 바뀌지 않은 버블을 재계산하면 버벅인다.
//   children(문자열)이 값-동일이면 memo가 재렌더를 건너뛴다(변한 버블만 다시 강조).
import { Children, createContext, type ComponentProps, isValidElement, memo, use, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, Download, WrapText } from 'lucide-react'
import { codeFileName } from '../lib/codeFileName'
import { MenuItem } from './WorkMenu'
import { copyItem, menuOf, onContextMenuFor } from './contextMenuFor'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import batch from 'react-syntax-highlighter/dist/esm/languages/prism/batch'
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import dart from 'react-syntax-highlighter/dist/esm/languages/prism/dart'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php'
import powershell from 'react-syntax-highlighter/dist/esm/languages/prism/powershell'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift'
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useT } from '../lib/i18n'
import { useCopy, useMediaQuery } from '../lib/hooks'
import { C, FONT, R, alpha } from '../design/tokens'

// 코드 강조는 필요한 언어만 등록한다(전체 판은 297개 문법을 시작 때 전부 실행해 무겁다).
//   미등록 언어는 오류 없이 색 없는 코드로 나온다. 별칭(ts, js, py, sh, yml, html …)은 각 문법이 스스로 갖고 있다.
for (const lang of [bash, batch, c, cpp, csharp, css, dart, diff, docker, go, java, javascript, json, jsx, kotlin, markdown, markup, php, powershell, python, ruby, rust, scss, sql, swift, toml, tsx, typescript, yaml]) {
  SyntaxHighlighter.registerLanguage('', lang)
}
// 문법이 별칭을 갖지 않는 것만 더한다.
SyntaxHighlighter.alias({ rust: ['rs'], powershell: ['ps1'], batch: ['bat', 'cmd'], bash: ['zsh'] })

// 코드블록 + 우상단의 언어 표시와 복사 버튼(④).
//   보이고 숨는 규칙은 index.css의 .code-chrome이 갖는다 — 마우스가 있으면 블록에 올렸을 때 떠오르고,
//   터치 기기에서는 항상 옅게 보인다(손가락에는 hover가 없어서 숨기면 복사할 방법이 사라진다).
//   clipboard 미지원(비-보안 컨텍스트 등)이면 버튼 숨김. dark = 스킬 상세 등 늘 어두운 코드 테마.
//   기기가 어두운 모드면 dark가 없어도 어두운 테마를 쓴다 — 밝은 글자색 묶음은 어두운 바탕에서 안 읽힌다.
const COLLAPSE_AT = 18

function chromeButton(label: string, onClick: () => void, icon: ReactNode, copied = false) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: R.chip,
        background: alpha.cellHi(0.92),
        border: `1px solid ${C.sep}`,
        color: copied ? C.ok : C.label2,
        cursor: 'pointer',
      }}
    >
      {icon}
    </button>
  )
}

function downloadCode(name: string, code: string) {
  const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

export const CodeBlock = memo(function CodeBlock({ language, code, index, dark: forceDark }: { language: string; code: string; index: number; dark?: boolean }) {
  const t = useT()
  const dark = useMediaQuery('(prefers-color-scheme: dark)') || forceDark
  const { copied, copy } = useCopy()
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard
  const [wrap, setWrap] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  // 접고 펼 때 글은 바로 바뀌므로, 바뀌기 전 높이에서 새 높이로 상자만 이어 준다.
  // 높이는 그릴 때마다 효과 안에서 기록한다(줄바꿈 토글이나 스트리밍으로 높이가 바뀌어도 직전 값이 맞다).
  const box = useRef<HTMLDivElement>(null)
  const last = useRef<{ h: number; collapsed: boolean } | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const prev = last.current
    const h = el.offsetHeight
    last.current = { h, collapsed }
    if (!prev || prev.collapsed === collapsed || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.animate([{ height: `${prev.h}px`, overflow: 'hidden' }, { height: `${h}px`, overflow: 'hidden' }], { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }) // --dur-panel, --ease-enter
  })
  const lines = code.split('\n')
  const long = lines.length > COLLAPSE_AT
  const shown = collapsed ? lines.slice(0, 8).join('\n') : code
  const label = language || t('stream.code.plain')
  return (
    <div
      ref={box}
      className="code-block"
      style={{ position: 'relative', maxWidth: '100%' }}
      onContextMenu={onContextMenuFor(() => menuOf(
        copyItem(code, t('stream.copyCode')),
        <MenuItem onClick={() => downloadCode(codeFileName(language, index), code)}>{t('stream.code.download')}</MenuItem>,
        <MenuItem onClick={() => setWrap((value) => !value)}>{wrap ? t('stream.code.unwrap') : t('stream.code.wrap')}</MenuItem>,
        long && <MenuItem onClick={() => setCollapsed((value) => !value)}>{collapsed ? t('stream.code.expand') : t('stream.code.collapse')}</MenuItem>,
      ))}
    >
      <SyntaxHighlighter
        language={language || 'text'}
        wrapLongLines={wrap}
        // 줄바꿈이 꺼져 있으면 긴 줄은 블록 안에서 가로로 스크롤된다.
        className="scroll-area"
        style={dark ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          borderRadius: R.field,
          padding: '14px 16px',
          fontSize: 12,
          background: dark ? C.codeBg : C.bg2,
          border: `1px solid ${dark ? C.codeLine : C.sepSoft}`,
          maxWidth: '100%',
          overflowX: wrap ? 'hidden' : 'auto',
        }}
        codeTagProps={{ style: { fontFamily: FONT.mono, whiteSpace: wrap ? 'pre-wrap' : 'pre', wordBreak: wrap ? 'break-word' : 'normal' } }}
      >
        {shown}
      </SyntaxHighlighter>
      <div
        className="code-chrome inline-flex items-center"
        data-copied={copied ? 'true' : undefined}
        style={{ position: 'absolute', top: 8, right: 8, gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 'calc(100% - 16px)' }}
      >
        {/* 언어 이름은 사람이 쓴 말이 아니라 기계가 읽는 식별자라 고정폭으로 둔다(index.css의 글꼴 기준). */}
        <span
          className="font-mono"
          style={{
            fontSize: 9.5,
            fontWeight: 600,
            color: C.label3,
            background: alpha.cellHi(0.72),
            border: `1px solid ${C.sep}`,
            borderRadius: R.sm,
            padding: '2px 6px',
            lineHeight: 1.4,
            textTransform: 'uppercase',
          }}
        >
          {label}
        </span>
        <button
          type="button"
          onClick={() => setWrap((value) => !value)}
          aria-pressed={wrap}
          aria-label={wrap ? t('stream.code.unwrap') : t('stream.code.wrap')}
          title={wrap ? t('stream.code.unwrap') : t('stream.code.wrap')}
          style={{
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: R.chip,
            background: alpha.cellHi(0.92),
            border: `1px solid ${C.sep}`,
            color: wrap ? C.label : C.label2,
            cursor: 'pointer',
          }}
        >
          <WrapText size={13} />
        </button>
        {long &&
          chromeButton(collapsed ? t('stream.code.expand') : t('stream.code.collapse'), () => setCollapsed((value) => !value), (
            <span style={{ fontSize: 11, fontWeight: 700 }}>{collapsed ? '▸' : '▾'}</span>
          ))}
        {chromeButton(t('stream.code.download'), () => downloadCode(codeFileName(language, index), code), <Download size={13} />)}
        {canCopy && chromeButton(t('stream.copyCode'), () => copy(code), copied ? <Check size={13} /> : <Copy size={13} />, copied)}
      </div>
    </div>
  )
})

// size = 본문 글자 크기. 대화의 답과 작업 중 알림은 15.5(재설계 4단계, 시안 A), 나머지 자리(카드 안 미리보기·Brain)는 13.5.
function fenceText(node: ReactNode): string | null {
  const only = Children.toArray(node)
  const child = only.length === 1 ? only[0] : null
  if (!isValidElement(child) || child.type !== 'code') return null
  const props = child.props as { children?: ReactNode }
  return String(props.children ?? '').replace(/\n$/, '')
}

// 마크다운 렌더 사이에 바뀌는 값(어두운 테마 여부, 코드 블록 순번)은 context로 넘긴다.
//   components 객체를 렌더마다 새로 만들면 react-markdown이 코드 블록을 다른 컴포넌트로 보고 지웠다 다시 만든다.
//   그러면 스트리밍 중에 사용자가 켠 줄바꿈과 접기 상태가 초기화되므로 객체는 함수 밖에 하나만 둔다.
const MarkdownCtx = createContext<{ dark?: boolean; nextIndex: () => number }>({ nextIndex: () => 0 })

function MdPre({ children }: { children?: ReactNode }) {
  const { dark, nextIndex } = use(MarkdownCtx)
  const plain = fenceText(children)
  if (plain != null) return <CodeBlock language="" code={plain} index={nextIndex()} dark={dark} />
  return <>{children}</>
}

function MdCode({ className, children, ...props }: ComponentProps<'code'>) {
  const { dark, nextIndex } = use(MarkdownCtx)
  const matched = /language-(\w+)/.exec(className || '')
  if (matched) {
    return <CodeBlock language={matched[1]} code={String(children).replace(/\n$/, '')} index={nextIndex()} dark={dark} />
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  )
}

const markdownComponents: Components = {
  pre: MdPre,
  // 좁은 화면에서 표는 가로로 스크롤된다(index.css의 .md table) — 스크롤바 모양을 공통으로 맞춘다.
  table: ({ children }) => <table className="scroll-area">{children}</table>,
  code: MdCode,
}

export const Markdown = memo(function Markdown({ children, dark, size = 13.5 }: { children: string; dark?: boolean; size?: number }) {
  const indexRef = useRef(0)
  indexRef.current = 0
  // dark가 같으면 값이 그대로여야 context 소비자가 불필요하게 다시 그려지지 않는다. 순번은 ref로 읽는다.
  const ctx = useMemo(() => ({ dark, nextIndex: () => ++indexRef.current }), [dark])
  return (
    <div className="md" style={{ fontSize: size, color: C.label }}>
      <MarkdownCtx.Provider value={ctx}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {children}
        </ReactMarkdown>
      </MarkdownCtx.Provider>
    </div>
  )
})
