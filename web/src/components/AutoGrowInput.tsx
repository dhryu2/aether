// 글자가 칸 너비를 넘으면 줄바꿈하고 높이가 따라 늘어나는 한 줄 입력 칸.
//   <input>은 줄바꿈이 안 돼서 길게 쓰면 앞 글자가 왼쪽으로 밀려 안 보인다. 그래서 textarea를 쓰되,
//   Enter는 줄을 나누지 않으므로(각 호출처가 onKeyDown으로 처리) 겉모습만 여러 줄이고 값은 한 줄 그대로다.
import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react'

export function AutoGrowInput(props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows'>) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // 값이 바뀔 때마다 높이를 내용에 맞춘다. 먼저 auto로 풀어야 글을 지울 때 줄어든다.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [props.value])
  return (
    <textarea
      {...props}
      ref={ref}
      rows={1}
      style={{ resize: 'none', overflow: 'hidden', fontFamily: 'inherit', lineHeight: 1.4, overflowWrap: 'anywhere', ...props.style }}
    />
  )
}
