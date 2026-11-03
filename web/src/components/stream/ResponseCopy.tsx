// 끝난 답변 아래의 전체 복사. 코드 블록 오른쪽 위의 복사는 그 칸만 옮긴다.
//   이 버튼은 답에 적힌 글을 통째로 옮긴다. 화면에 그려진 결과가 아니라 원문을 넣는다.
//   그래서 코드 울타리와 표식이 빠지지 않고, 다른 곳에 붙여도 같은 글로 남는다.
//   길게 누르거나 우클릭하면 표식을 걷어 낸 보통 글로 옮긴다. 한때 이것이 따로 된 T 아이콘이었는데,
//   아이콘만으로는 뜻이 안 읽혀서 버튼 하나로 합쳤다(2026-10-06 사용자 판단). 길게 누르기는 보내기 버튼과 같은 방식이다.
//   클립보드를 못 쓰는 환경(보안이 아닌 주소)에서는 버튼을 그리지 않는다. 눌러도 안 되는 버튼은 함정이다.
import { useEffect, useRef, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { useCopy } from '../../lib/hooks'
import { markdownToPlain } from '../../lib/plainText'
import { useT } from '../../lib/i18n'

/** 보내기 버튼(SendButton)의 길게 누르기와 같은 시간. */
const LONG_PRESS_MS = 450

export function ResponseCopy({ text, children }: { text: string; children?: ReactNode }) {
  const t = useT()
  const raw = useCopy()
  const plain = useCopy()
  const timer = useRef<number | null>(null)
  const longFired = useRef(false)
  const clearTimer = () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }
  useEffect(() => clearTimer, [])
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard && text.trim() !== ''
  if (!canCopy && !children) return null
  const copyPlain = () => plain.copy(markdownToPlain(text))
  const copied = raw.copied || plain.copied
  const tip = plain.copied ? t('stream.copiedPlain') : raw.copied ? t('stream.copied') : t('stream.copyHint')
  return (
    <div className="response-copy">
      {canCopy && <button
        type="button"
        className="response-copy-btn hit-44"
        data-copied={copied ? 'true' : undefined}
        aria-label={copied ? tip : t('stream.copyResponse')}
        onClick={() => {
          if (longFired.current) {
            longFired.current = false
            return
          }
          raw.copy(text)
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          clearTimer()
          timer.current = window.setTimeout(() => {
            timer.current = null
            longFired.current = true
            copyPlain()
          }, LONG_PRESS_MS)
        }}
        onPointerUp={clearTimer}
        onPointerCancel={clearTimer}
        onPointerLeave={clearTimer}
        onContextMenu={(e) => {
          e.preventDefault()
          // 안드로이드는 길게 누르면 이 이벤트도 온다. 타이머가 이미 보통 글을 옮겼으면 두 번 옮기지 않는다.
          if (longFired.current) return
          if (timer.current != null) longFired.current = true
          clearTimer()
          copyPlain()
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
        <span className="response-copy-tip" aria-hidden="true">
          {tip}
        </span>
      </button>}
      {children}
    </div>
  )
}
