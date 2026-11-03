// W6. 대화 스트림 — convo 이벤트를 종류별로 렌더. 모르는 종류는 조용히 무시(크래시 금지).
//   스무스 전략(버벅임 제거):
//   1) 윈도잉+무한스크롤 — 최근 몇 개 세그먼트만 렌더, 위로 스크롤하면 묶음 추가(스크롤 위치 앵커링).
//      로컬 데이터 소진 시 서버에서 이전 페이지 로드(store.loadOlder — 초기 replay는 꼬리 300개만 온다).
//   2) 전환 스켈레톤 — 큰 세션 진입/전환은 렌더 시점에 즉시 스켈레톤으로 전환(무거운 Markdown/Prism 렌더가 클릭을 막지 않음).
//   3) 메모이제이션(Markdown 등) — 라이브 스트리밍 중 바뀐 버블만 재계산.
//
//   위 1·2의 위치 계산은 전부 `stream/useStreamScroll.ts`에 있고(누가 언제 scrollTop을 쓰는가는 그 파일 상단 주석),
//   조각 만들기는 `lib/streamSegments.ts`의 순수 함수가 한다. 이 파일은 훅을 부르고 그리기만 한다.
import { useRef } from 'react'
import { actions, oldestPendingCardSeq, providerName, queuedFor, sessionTurn, useStore } from '../../lib/store'
import { sessionWorkTitle } from '../../lib/workTitle'
import { useT } from '../../lib/i18n'
import { buildStreamSegments, type StreamSeg } from '../../lib/streamSegments'
import {
  ChatLoadingMask,
  NoticeBanner,
  OlderLoading,
  QueuedBubble,
  RunningOrb,
  ScrollToBottomButton,
  SegmentList,
  useInfiniteOlder,
  useJumpToSeq,
  useSegmentWindow,
  useSessionSwitchSkeleton,
  useStickyBottom,
} from './index'
import { EmptyHero } from '../EmptyHero'
import { TodoLeftover } from './TodoLeftover'
import { useChamdingPresence } from './useChamdingPresence'

export function Stream({ sessionId, cardsOnly = false }: { sessionId: string; cardsOnly?: boolean }) {
  const s = useStore()
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)

  const id = sessionId
  const rawItems = s.convos[id] ?? []
  const pendingSeq = oldestPendingCardSeq(rawItems)
  const items = cardsOnly
    ? rawItems.filter(
        (e) =>
          e.kind === 'permission_request' ||
          e.kind === 'permission_resolved' ||
          e.kind === 'question_request' ||
          e.kind === 'question_resolved' ||
          e.kind === 'plan_request' ||
          e.kind === 'plan_resolved',
      )
    : rawItems
  const queued = cardsOnly ? [] : queuedFor(s, id)
  const turn = sessionTurn(s, id)
  const loading = !!(id && s.loadingConvo[id]) // 초기 백로그 replay 중(caught_up 게이트)
  const older = id ? s.older[id] : undefined // 무한스크롤 페이징 상태(초기 replay 꼬리 절단 시 세팅)

  // ★ 훅 호출 순서 = effect 실행 순서다. 검색 결과 점프(useJumpToSeq)는 진입 하단점프(useStickyBottom)
  //   *뒤에* 와야 같은 커밋에서 바닥으로 간 다음 대상 위치로 다시 이동한다. 순서를 바꾸지 마라.
  const win = useSegmentWindow()
  const { renderId, showSkeleton } = useSessionSwitchSkeleton(id, loading, items.length, win.reset)
  // 훅이 돌려준 것은 바로 풀어서 받는다 — 객체째 들고 있다가 렌더 중에 점으로 꺼내 쓰면
  //   react-hooks/refs 검사가 '렌더 중 ref 접근'으로 잡는다(훅 안에 ref가 들어 있어서).
  const { atBottom, contentRef, scrollToBottom, trackScroll, leaveBottom } = useStickyBottom({
    ref,
    renderId,
    showSkeleton,
    scrollBottomNonce: s.scrollBottom?.id === id ? s.scrollBottom.nonce : 0,
    setFrozenKey: win.setFrozenKey,
  })

  // 세그먼트 빌드 — 스켈레톤(초기 백로그 replay·전환 defer) 중엔 전부 건너뛴다. 대량 메시지를 매 프레임 전체 마크다운/
  // 문법강조/diff로 재계산하면 O(n²)로 메인스레드가 멈춘다. 빌드는 가볍지만(객체 push) 렌더 비용(Prism)이 무거우므로,
  // 스켈레톤 중엔 빌드를 통째로 스킵하고, 콘텐츠 표시 시에도 윈도(visibleSegs)만 렌더한다.
  const built = showSkeleton
    ? null
    : buildStreamSegments({ items, turn, providerName: providerName(s, s.sessions.find((x) => x.id === id)?.provider), answers: s.answers, view: s.transcriptView, t })
  const segs: StreamSeg[] = built?.segs ?? []
  const hasConvo = built?.hasConvo ?? false
  const retry = built?.retry ?? null
  const chamdingPhase = built?.chamdingPhase ?? 'idle'
  const turnKey = built?.turnKey ?? null
  // 참딩을 붙잡을지는 "턴이 살아 있고, 뼈대 화면이 아니고, 대화가 있다"뿐이다.
  //   끝났는데 성공으로 남은 목록은 새로고침으로 다시 열어도 참딩을 띄우지 않는다.
  const chamdingActive = (turn === 'running' || turn === 'requires_action') && !showSkeleton && hasConvo
  const presence = useChamdingPresence(id, chamdingActive, chamdingPhase, turnKey)

  const paging = useInfiniteOlder({
    ref,
    renderId,
    showSkeleton,
    itemCount: items.length,
    frozenKey: win.frozenKey,
    hasConvo,
    hasOlder: older?.hasOlder,
    olderLoading: older?.loading,
  })
  const jump = useJumpToSeq({
    ref,
    jumpToSeq: s.jumpToSeq,
    id,
    renderId,
    showSkeleton,
    itemCount: items.length,
    frozenKey: win.frozenKey,
    leaveBottom,
    setFrozenKey: win.setFrozenKey,
  })

  const { start, visibleSegs } = win.slice(segs)
  const hasOlder = !showSkeleton && (start > 0 || !!older?.hasOlder) // 로컬 윈도 여분 또는 서버 미로드 과거 구간
  const searchingOlderConversation = !showSkeleton && !hasConvo && !!older?.hasOlder

  // 렌더마다 최신 세그먼트·페이징 상태를 훅에 넘긴다(effect·콜백의 stale 클로저 방지).
  paging.bind({ id, segs, start, older, setFrozenKey: win.setFrozenKey, spinnerShown: hasConvo && hasOlder })
  jump.bind({ segs, start, older })

  // 바닥 추적 판정이 먼저, 이전 묶음 로드가 나중 — 로드 판정은 이번 렌더의 frozenKey를 보므로 순서를 바꾸면
  //   같은 이벤트 안에서 방금 바뀐 값을 읽게 된다.
  const onScroll = () => {
    const el = ref.current
    if (!el) return
    trackScroll(el, segs[start]?.key ?? null) // 이탈 시 고정할 세그먼트 = 현재 창의 첫 세그먼트
    paging.handleScroll(el)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={ref} onScroll={onScroll} className="scroll-area stream-scroll flex-1 overflow-y-auto">
        {!showSkeleton && s.contractMismatch && (
          <div className="mx-auto flex flex-col" style={{ maxWidth: s.isNarrow ? 'none' : 760, width: '100%', minWidth: 0, padding: s.isNarrow ? '0 18px 14px' : '0 16px 14px' }}>
            <NoticeBanner variant="warn" text={t('stream.contractRefresh.required')} />
          </div>
        )}
        {showSkeleton ? (
          // 받는 중에는 클릭 직후부터 마스크 문구를 보인다. 메시지형 뼈대는 메시지가 있는 세션만 — 빈 새 세션·로드 극초기(items 0)는
          //   문구만(가짜 버블 깜빡임 방지). 문구는 CSS가 0.2초 늦춰 띄운다.
          <ChatLoadingMask narrow={s.isNarrow} withRows={items.length > 0} />
        ) : hasConvo ? (
          <div
            ref={contentRef}
            className="mx-auto flex flex-col"
            style={{ maxWidth: s.isNarrow ? 'none' : 760, width: '100%', minWidth: 0, gap: 14, padding: s.isNarrow ? '0 18px' : '0 16px' }}
          >
            {hasOlder && <OlderLoading anchorRef={paging.olderSentinelRef} />}
            <SegmentList sessionId={id} segs={visibleSegs} flashSeq={jump.flashSeq} running={turn === 'running'} waiting={turn === 'requires_action'} />
            {!cardsOnly && <TodoLeftover sessionId={id} />}
            {retry && (
              <div className="msg-in flex flex-col">
                <NoticeBanner
                  variant="warn"
                  text={t('stream.retry.progress', {
                    text: retry.error === 'overloaded' ? t('stream.retry.overloaded') : t('stream.retry.error', { error: retry.error ?? '' }),
                    attempt: retry.attempt ?? 0,
                    max: retry.max ?? 0,
                  })}
                />
              </div>
            )}
            {/* 마운트는 보이기 관리자만 정한다. 도구가 돌 때마다 감췄다 그리면 0.7초와 등장 동작이 되풀이된다.
                턴이 끝나면 성공·실패·당황만 1.8초 보여 주고 치운다. 마지막 240ms는 투명도로 내려간다. */}
            {presence.mounted && (
              <div className={`msg-in flex flex-col${presence.leaving ? ' chamding-leave' : ''}`}>
                <RunningOrb onGoAnswer={pendingSeq != null ? () => actions.jumpInSession(pendingSeq, id) : undefined} phase={presence.shown} revealed={presence.revealed} ending={presence.endAt != null} taskKey={presence.epoch} />
              </div>
            )}
            {queued.map((q) => (
              <QueuedBubble
                key={q.qid}
                text={q.text}
                imageCount={q.images?.length ?? 0}
                canSendNow={turn === 'running'}
                onCancel={() => id && actions.dequeue(id, q.qid)}
                onEdit={() => id && actions.editQueued(id, q.qid)}
                onSendNow={() => id && actions.sendQueuedNow(id)}
              />
            ))}
          </div>
        ) : searchingOlderConversation ? (
          <div className="mx-auto flex w-full flex-col" style={{ maxWidth: s.isNarrow ? 'none' : 760, padding: s.isNarrow ? '0 18px' : '0 16px' }}>
            <OlderLoading anchorRef={paging.olderSentinelRef} />
          </div>
        ) : (
          <EmptyHero name={sessionWorkTitle(s.sessions.find((x) => x.id === id) ?? { displayName: '' }, t('stream.emptyHero.newName'))} />
        )}
      </div>
      {!showSkeleton && hasConvo && !atBottom && <ScrollToBottomButton narrow={s.isNarrow} onClick={scrollToBottom} />}
    </div>
  )
}
