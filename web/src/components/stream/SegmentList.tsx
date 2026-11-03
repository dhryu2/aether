// 보이는 구간의 세그먼트를 실제 컴포넌트로 바꾸는 곳 — 조각을 만드는 일은 `lib/streamSegments.ts`의
//   순수 함수가, 스크롤 위치 계산은 `useStreamScroll.ts`가 맡는다. 여기는 그리기만 한다.
//   모르는 종류는 조용히 무시한다(크래시 금지).
import { useState, type ReactNode } from 'react'
import { actions, activeProviderId, canReauthProvider, getState } from '../../lib/store'
import type { StreamSeg } from '../../lib/streamSegments'
import { C, FONT, R } from '../../design/tokens'
import { Markdown } from '../Markdown'
import { PermissionCard } from '../PermissionCard'
import { PlanCard } from '../PlanCard'
import { QuestionCard } from '../QuestionCard'
import { QuestionnaireCard, QuestionnairePendingCard } from '../QuestionnaireCard'
import { AuthExpiredBanner, CommandOperationBanner, NoticeBanner } from './Banners'
import { AssistantBubble, ChoiceBubble, UserBubble } from './Bubbles'
import { ResponseCopy } from './ResponseCopy'
import { ResponseHandoff } from './ResponseHandoff'
import { lastAnswerIndex } from '../../lib/handoff'
import { PlanNote } from './PlanNote'
import { ReasoningNote } from './ReasoningNote'
import { ResultFooter } from './ResultFooter'
import { WorkNote } from './WorkNote'
import { ToolRun } from './ToolRun'
import { TeamRun } from './TeamRun'

/** 슬래시 명령(/context·/usage 등)의 텍스트 출력 — 표 형식 보존 위해 고정폭 pre-wrap 블록으로. */
function CommandOutput({ text }: { text: string }) {
  return (
    <div
      className="self-stretch scroll-area"
      style={{
        background: C.bg2,
        borderRadius: R.field,
        padding: '10px 14px',
        fontFamily: FONT.mono,
        fontSize: 12.5,
        lineHeight: 1.5,
        color: C.label2,
        whiteSpace: 'pre-wrap',
        overflowX: 'auto',
      }}
    >
      {text}
    </div>
  )
}

/**
 * 세그먼트 서술 → 실제 컴포넌트. 텍스트·도구런은 아래 SegmentList가 직접 그리므로 여기 없다.
 * 빌더는 순수 함수라 콜백을 모른다 — 사용자가 누르는 버튼(재인증·학습 결과 보기)은 여기서 붙인다.
 */
function renderSeg(seg: StreamSeg, sessionId: string): ReactNode {
  switch (seg.kind) {
    case 'user':
      return <UserBubble sessionId={sessionId} seq={seg.seq} text={seg.text} images={seg.images} documents={seg.documents} autoSent={seg.autoSent} handoffFrom={seg.handoffFrom} />
    case 'banner':
      return <NoticeBanner variant={seg.variant} text={seg.text} />
    case 'reasoning':
      return <ReasoningNote text={seg.text} />
    case 'plan':
      return <PlanNote text={seg.text} />
    case 'planCard':
      return <PlanCard req={seg.req} resolved={seg.resolved} />
    case 'authExpired': {
      // 다시 로그인할 통로가 없는 서비스면 버튼을 안 그린다 — 눌러도 안 되는 버튼은 안내가 아니라 함정이다(8h).
      const st = getState()
      const provider = st.sessions.find((x) => x.id === sessionId)?.provider ?? activeProviderId(st)
      const reauth = provider && canReauthProvider(st, provider) ? () => actions.openProviderAuth(provider) : undefined
      return <AuthExpiredBanner text={seg.text} onReauth={reauth} />
    }
    case 'permission':
      return <PermissionCard req={seg.req} resolved={seg.resolved} />
    case 'question':
      return <QuestionCard req={seg.req} resolved={seg.resolved} skipped={seg.skipped} savedAnswers={seg.savedAnswers} />
    case 'questionnaire':
      return <QuestionnaireCard sessionId={sessionId} id={seg.id} questions={seg.questions} state={seg.state} />
    case 'questionnairePending':
      return <QuestionnairePendingCard />
    case 'choice':
      return <ChoiceBubble labels={seg.labels} />
    case 'result':
      return <ResultFooter turn={seg.turn} ts={seg.ts} />
    case 'commandOutput':
      return <CommandOutput text={seg.text} />
    case 'operation':
      return <CommandOperationBanner state={seg.state} text={seg.text} />
    case 'live':
      // 작업 중 알림은 자기 상태(방금까지 보이던 말)를 들고 교체 애니메이션을 돌린다 — 빌더는 지금 말만 준다.
      return <WorkNote text={seg.text} />
    default:
      return null
  }
}

/**
 * 창 안의 세그먼트를 순서대로 그린다.
 *   `data-seq`는 두 곳이 읽는 좌표다 — 이전 묶음을 붙인 뒤 위치를 되돌릴 때(scrollAnchor)와
 *   검색 결과로 이동할 때(useJumpToSeq). 지우지 마라.
 *   `data-seg`는 조각 종류를 화면에 남기는 표식이다 — 시각 확인 하네스(server/test/visual)가 이걸로
 *   "끝난 턴은 명령 요약 줄 → 최종 답변 순서인가" 같은 배치를 기계로 대조한다.
 *   텍스트 세그먼트 래퍼가 `display:contents`인 것도 의도다(버블이 부모 flex의 직접 자식으로 남아야 정렬이 맞다).
 *   떠오르는 등장(msg-in)은 이 목록이 뜬 뒤 끝에 새로 붙은 조각에만 건다. 세션을 열 때 이미 있던 지난 대화와
 *   위로 덧붙는 더 오래된 묶음까지 떠오르면, 화면 전체가 한꺼번에 움직여 "새로 온 말"이 무엇인지 안 보인다.
 */
export function SegmentList({
  sessionId,
  segs,
  flashSeq,
  running,
  waiting,
}: {
  sessionId: string
  segs: StreamSeg[]
  flashSeq: number | null
  running: boolean
  waiting?: boolean
}) {
  // 처음 그릴 때(세션이 바뀔 때 포함) 있던 조각의 이름과 가장 큰 seq. 이보다 뒤에 온 새 조각만 떠오른다.
  //   이름도 함께 보는 이유: 쓰는 중인 답은 이름이 그대로인 채 seq만 커진다. seq만 보면 처음부터 있던 그 조각에
  //   도중에 클래스가 붙어 애니메이션이 갑자기 돈다.
  //   effect가 아니라 렌더 중에 고친다 — 한 번 움직인 뒤에 막으면 이미 늦다.
  const [base, setBase] = useState(() => quietBase(sessionId, segs))
  if (base.sessionId !== sessionId) setBase(quietBase(sessionId, segs))
  const handoffAt = lastAnswerIndex(segs, !!running || !!waiting)
  return (
    <>
      {segs.map((seg, i) => {
        const sq = seg.seq
        const flash = flashSeq === sq ? ' seg-flash' : ''
        const enter = sq > base.seq && !base.keys.has(seg.key) ? 'msg-in ' : ''
        if (seg.kind === 'text')
          return (
            <div key={seg.key} data-seq={sq} data-seg="text" className={enter + 'self-start' + flash} style={{ display: 'contents' }}>
              <AssistantBubble>
                <Markdown size={15.5}>{seg.text}</Markdown>
                <ResponseCopy text={seg.text}>{i === handoffAt && <ResponseHandoff sessionId={sessionId} />}</ResponseCopy>
              </AssistantBubble>
            </div>
          )
        if (seg.kind === 'tools')
          return (
            <div key={seg.key} data-seq={sq} data-seg="tools" className={enter + 'flex flex-col self-stretch' + flash} style={{ gap: 14 }}>
              <ToolRun tools={seg.tools} live={running && i === segs.length - 1} />
            </div>
          )
        if (seg.kind === 'team')
          return (
            <div key={seg.key} data-seq={sq} data-seg="team" className={enter + 'flex flex-col self-stretch' + flash} style={{ gap: 14 }}>
              <TeamRun tasks={seg.tasks} waiting={!!waiting && i === segs.length - 1} />
            </div>
          )
        return (
          <div key={seg.key} data-seq={sq} data-seg={seg.kind} className={enter + 'flex flex-col' + flash} style={{ gap: 14 }}>
            {renderSeg(seg, sessionId)}
          </div>
        )
      })}
    </>
  )
}

function quietBase(sessionId: string, segs: StreamSeg[]) {
  return { sessionId, seq: segs.reduce((m, x) => Math.max(m, x.seq), -1), keys: new Set(segs.map((x) => x.key)) }
}
