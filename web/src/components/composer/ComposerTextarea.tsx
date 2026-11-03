import { memo, useCallback, useLayoutEffect, useRef } from 'react'
import { C, FONT } from '../../design/tokens'

export const MAX_TA_HEIGHT = 132 // 약 5~6줄 후 내부 스크롤
export const MAX_CODE_HEIGHT = 220 // 코드 상자는 글 칸보다 조금 더 보여주고, 그다음은 안에서 스크롤

// IME 격리 textarea — memo로 감싸 스트리밍 리렌더(useStore 초당 ~60회)로부터 분리한다.
//   핸들러는 부모에서 ref로 안정 식별자를 유지해 넘기므로, 스트리밍 중엔 value/placeholder/disabled가 그대로면 리렌더 안 됨
//   → 응답 생성 중 한글 입력 시 조합이 깨지지 않는다. props는 얕은 비교로 값이 실제 바뀔 때(키 입력·턴 전환)만 갱신.
type TAProps = {
  blockId: string
  register: (id: string, el: HTMLTextAreaElement | null) => void
  value: string
  disabled: boolean
  placeholder: string
  maxHeight: number
  minHeight?: number
  /** 코드 상자 안. 고정폭이고 Enter는 줄바꿈이다. */
  code?: boolean
  /** 글 칸에서 Enter가 보내기인지. 아니면 키보드 Enter 키에 줄바꿈 모양을 보인다. */
  sendOnEnter?: boolean
  onChange: (id: string, value: string) => void
  onKeyDown: (id: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (id: string, e: React.ClipboardEvent<HTMLTextAreaElement>) => void
}

export const ComposerTextarea = memo(function ComposerTextarea({
  blockId,
  register,
  value,
  disabled,
  placeholder,
  maxHeight,
  minHeight = 0,
  code = false,
  sendOnEnter = true,
  onChange,
  onKeyDown,
  onPaste,
}: TAProps) {
  const localRef = useRef<HTMLTextAreaElement | null>(null)
  const setRef = useCallback((el: HTMLTextAreaElement | null) => {
    localRef.current = el
    register(blockId, el)
  }, [blockId, register])

  // 글 길이에 맞춰 높이를 늘린다. 상한 이후에는 칸 안에서 스크롤된다.
  useLayoutEffect(() => {
    const ta = localRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const grown = Math.min(ta.scrollHeight, maxHeight)
    ta.style.height = Math.max(grown, minHeight) + 'px'
  }, [value, maxHeight, minHeight])

  return (
    <textarea
      ref={setRef}
      rows={1}
      onPaste={(e) => onPaste(blockId, e)}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(blockId, e.target.value)}
      onKeyDown={(e) => onKeyDown(blockId, e)}
      placeholder={placeholder}
      enterKeyHint={code || !sendOnEnter ? 'enter' : 'send'}
      autoCapitalize={code ? 'off' : 'sentences'}
      autoCorrect={code ? 'off' : 'on'}
      autoComplete="off"
      spellCheck={!code}
      wrap={code ? 'off' : undefined}
      aria-multiline="true"
      // 여러 줄을 넘겨 쓰면 입력칸 안에서 스크롤된다 — 스크롤바 모양은 공통(index.css).
      className="scroll-area"
      style={{
        width: '100%',
        border: 'none',
        outline: 'none',
        background: 'transparent',
        resize: 'none',
        fontSize: code ? 13.5 : 15.5,
        lineHeight: 1.45,
        fontFamily: code ? FONT.mono : undefined,
        maxHeight,
        overflowX: code ? 'auto' : 'hidden',
        overflowY: 'auto',
        color: C.label,
        padding: code ? '2px 6px 0' : 0,
        margin: 0,
        display: 'block',
        minWidth: 0,
        whiteSpace: code ? 'pre' : undefined,
      }}
    />
  )
})
