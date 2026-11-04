// 세션 내 찾기 바(Cmd/Ctrl+F) — 활성 세션 대화(채팅)에서 텍스트 검색 → 매칭 메시지로 점프+플래시.
//   검색 팝업(Cmd/Ctrl+K, 전 세션 대상)과 별개로, "지금 이 세션" 안에서 빠르게 찾을 때 쓴다. 도구호출/결과는 제외(채팅만).
//
//   ★ 검색 대상은 원본 이벤트가 아니라 **화면을 만드는 함수가 돌려준 목록**(buildStreamSegments의 searchable)이다.
//     화면에 안 그려지는 말이 검색에 걸리면, 결과를 눌렀을 때 갈 곳이 없어 아무 일도 안 일어나거나 엉뚱한 곳으로
//     튄다. 같은 출처를 쓰면 앞으로 렌더 규칙이 바뀌어도 둘이 어긋나지 않는다.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, X, TextSearch } from 'lucide-react'
import { actions, chromeSessionId, focusedTurn, isSplit, useStore, type ConvoItem } from '../lib/store'
import { useAutoFocus, useDismiss } from '../lib/hooks'
import { useT } from '../lib/i18n'
import { buildStreamSegments } from '../lib/streamSegments'
import { C, R, Z } from '../design/tokens'
import { IconButton } from './ui'
import { topBarInset } from './topBarInset'

/**
 * 조각을 만들 때 넘기는 번역 스텁. 찾기 대상은 사람과 모델이 실제로 한 말뿐이라 번역 문구가 하나도 안 들어간다
 * (배너·안내처럼 번역이 들어가는 조각은 애초에 찾기 대상이 아니다).
 * 진짜 번역 함수(`useT()`)는 렌더마다 새로 만들어지므로 의존성에 넣으면 아래 useMemo가 매 렌더 다시 돈다.
 */
const NO_T = () => ''
/** 참조가 매번 바뀌지 않게 고정한 빈 목록 — 대화가 아직 없을 때 쓴다. */
const NO_ITEMS: ConvoItem[] = []

/** pane: 칸이 나뉘었을 때 포커스 칸 안에 그리는 쪽. 어느 칸을 찾는지 자리로 보여 준다. */
export function FindBar({ pane }: { pane?: boolean }) {
  const s = useStore()
  const t = useT()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  // 열릴 때 입력 포커스(공용 훅이 rAF 한 프레임을 기다렸다 focus한다).
  const inputRef = useAutoFocus<HTMLInputElement>(s.findOpen)
  // 바 바깥을 누르면 닫는다. 상단바의 돋보기 버튼(data-find-toggle)은 예외 — 그 버튼은 스스로 여닫으므로,
  // 여기서 먼저 닫으면 이어지는 클릭이 도로 열어 버튼이 안 먹는 것처럼 보인다.
  const barRef = useRef<HTMLDivElement>(null)
  useDismiss(barRef, actions.closeFind, s.findOpen, '[data-find-toggle]')

  const chromeId = chromeSessionId(s)
  const items = (chromeId && s.convos[chromeId]) || NO_ITEMS
  const turn = focusedTurn(s)
  const answers = s.answers
  // 바가 닫혀 있거나 검색어가 없으면 조각을 아예 만들지 않는다. 이 컴포넌트는 늘 붙어 있고 검색어는 닫을 때
  //   안 지워지므로, 이 관문이 없으면 응답이 흘러드는 동안 매 프레임 대화 전체를 다시 조각내게 된다.
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!s.findOpen || !needle) return [] as { seq: number; text: string }[]
    const built = buildStreamSegments({ items, turn, providerName: '', answers, t: NO_T })
    return built.searchable.filter((x) => x.text.toLowerCase().includes(needle))
  }, [s.findOpen, q, items, turn, answers])

  // 열릴 때 검색어·인덱스 리셋.
  useEffect(() => {
    if (s.findOpen) {
      setQ('')
      setIdx(0)
    }
  }, [s.findOpen])

  // 점프 대상 seq(원시값) — matches 배열 참조가 아닌 "실제 대상 seq"에만 의존해 점프한다.
  //   ★ 스트리밍 중 flushIngest가 convos를 새 배열로 교체해도, 대상 메시지가 그대로면 target 숫자가 불변 →
  //     useEffect 미발화 → 화면이 매 프레임 끌려가며 하단추적이 깨지는 버그 방지.
  const target = matches.length ? matches[Math.min(idx, matches.length - 1)].seq : -1
  useEffect(() => {
    if (s.findOpen && target >= 0) actions.jumpInSession(target)
  }, [target, s.findOpen])

  if (!s.findOpen || !chromeId || isSplit(s) !== !!pane) return null

  const total = matches.length
  const go = (dir: 1 | -1) => {
    if (total === 0) return
    setIdx((i) => (i + dir + total) % total)
  }

  const count = q.trim() ? (total ? `${Math.min(idx, total - 1) + 1}/${total}` : t('composer.findBar.noResults')) : ''

  return (
    <div
      ref={barRef}
      role="search"
      // card-in은 transform으로 떠오른다. 위치를 transform으로 잡으면 그 값이 덮여 막대가 밀리므로,
      // 컴퓨터는 오른쪽 도구 섬 아래에 붙이고 폰은 좌우 여백으로만 잡는다.
      className="glass card-in find-bar"
      style={{
        // 상단 섬(과 작업 탭 줄) 바로 아래. 높이는 TopBar의 topBarInset 한 곳에서 정한다. 칸 안에서는 칸 머리(36) 아래.
        position: pane ? 'absolute' : 'fixed',
        top: pane ? 44 : `calc(${topBarInset(s.isNarrow)} + 8px)`,
        height: s.isNarrow ? 44 : 40,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 4px 0 14px',
        borderRadius: R.full,
        zIndex: Z.root.findBar,
        boxSizing: 'border-box',
        ...(pane
          ? { right: 12, width: 'min(420px, calc(100% - 24px))' }
          : s.isNarrow
          ? { left: 'max(12px, env(safe-area-inset-left))', right: 'max(12px, env(safe-area-inset-right))' }
          : { right: 'max(16px, env(safe-area-inset-right))', width: 'min(420px, calc(100vw - 340px))' }),
      }}
    >
      <TextSearch size={16} aria-hidden style={{ color: C.label3, flexShrink: 0 }} />
      <input
        ref={inputRef}
        value={q}
        aria-label={t('composer.findBar.placeholder')}
        onChange={(e) => { setQ(e.target.value); setIdx(0) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1) }
          else if (e.key === 'Escape') { e.preventDefault(); actions.closeFind() }
        }}
        placeholder={t('composer.findBar.placeholder')}
        style={{
          flex: 1,
          minWidth: 0,
          // 폰은 입력칸이 막대 높이(44)를 다 받는다. 칸 위아래를 눌러도 초점이 간다. 컴퓨터(40)는 그대로다.
          height: s.isNarrow ? 44 : undefined,
          border: 'none',
          background: 'transparent',
          fontSize: 15,
          color: C.label,
        }}
      />
      <span
        aria-live="polite"
        aria-atomic="true"
        style={{ fontSize: 13, color: C.label3, flexShrink: 0, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
      >
        {count}
      </span>
      {/* 폰: 기본 간격 6에 왼쪽 여백 6을 더한다. 32 원끼리 44 누름 범위가 겹치지 않는다. */}
      <IconButton
        type="button"
        size={32}
        className={s.isNarrow ? 'hit-44' : undefined}
        style={s.isNarrow ? { marginLeft: 6 } : undefined}
        label={t('composer.findBar.prev')}
        color={total ? C.label2 : C.label3}
        disabled={total === 0}
        lift={false}
        onClick={() => go(-1)}
      >
        <ChevronUp size={16} />
      </IconButton>
      <IconButton
        type="button"
        size={32}
        className={s.isNarrow ? 'hit-44' : undefined}
        style={s.isNarrow ? { marginLeft: 6 } : undefined}
        label={t('composer.findBar.next')}
        color={total ? C.label2 : C.label3}
        disabled={total === 0}
        lift={false}
        onClick={() => go(1)}
      >
        <ChevronDown size={16} />
      </IconButton>
      <IconButton
        type="button"
        size={32}
        className={s.isNarrow ? 'hit-44' : undefined}
        style={s.isNarrow ? { marginLeft: 6 } : undefined}
        label={t('composer.findBar.close')}
        color={C.label2}
        lift={false}
        onClick={() => actions.closeFind()}
      >
        <X size={16} />
      </IconButton>
    </div>
  )
}
