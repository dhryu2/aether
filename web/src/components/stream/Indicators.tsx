// 진행 상태를 알리는 표시들 — 응답 중 구슬·세션 전환 자리표시자·이전 대화 로딩 센티널.
import { useState, type Ref } from 'react'
import { useT } from '../../lib/i18n'
import { ChamdingMascot, type ChamdingState } from '../ChamdingMascot'
import { useChamdingSlot } from '../chamdingSlot'
import type { ChamdingPhase } from '../../lib/types'
import { C, R } from '../../design/tokens'
import { Skeleton, Spinner } from '../ui'

/** 참딩 국면(사건이 매긴 값) → 마스코트 자세. `waiting`은 렌즈를 올린 채 더 느리게 자세를 고친다. */
const MASCOT_STATE: Record<ChamdingPhase, ChamdingState> = {
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  success: 'success',
  error: 'error',
  confused: 'confused',
  surprise: 'surprise',
  waiting: 'waiting',
}

/** 참딩 상자 높이. 28px 이하에선 전신 그림이 뭉개진다. 36·44·52 시안 중 사용자가 고른 값(디자인 감사 3-3). */
const CHAMDING_H = 44

// W15 "생각하는 중" 줄 — 턴이 0.7초 넘게 돌면 앞자리를 참딩이 넘겨받는다.
//   그 전에는 멈춰 있는 파랑 점 하나다. 0.7초는 보이기 관리자가 재서 `revealed`로 알려 준다.
//   끝없이 도는 움직임은 참딩만 쓴다. 점은 "지금 도는 중"이라는 실제 상태다.
//   마무리가 시작될 때 슬롯이 없던 칸은 그 동안 점에도 문구에도 자리를 내주지 않는다.
//   다른 칸이 끝나 슬롯이 넘어와도 성공 참딩이 잠깐 튀어나오지 않게 하려는 것이다.
export function RunningOrb({ phase, revealed, ending, taskKey, onGoAnswer }: { phase: ChamdingPhase; revealed: boolean; ending: boolean; taskKey: number; onGoAnswer?: () => void }) {
  const t = useT()
  // 등장 동작은 처음 한 번만. 도구가 도는 동안 감췄다 다시 보일 때 되풀이되지 않게 끝나면 클래스를 뗀다.
  const [entering, setEntering] = useState(true)
  // 마무리가 시작되는 순간 슬롯을 갖고 있었는지만 기억한다. 그 뒤에 새로 요청하지 않는다.
  const [liveSlot, setLiveSlot] = useState(false)
  const want = ending ? liveSlot : revealed
  // 우선순위 1 — 화면을 나눠 한 칸은 빈 세션 인사, 한 칸은 작업 중일 때 먼저 뜬 인사가 자리를 쥐고 있으면
  //   정작 일하는 칸이 턴 내내 파란 점으로 남는다(격리 서버 분할 화면 실측). 일하는 쪽이 이긴다.
  const hasSlot = useChamdingSlot(want, 1)
  if (!ending && liveSlot !== hasSlot) setLiveSlot(hasSlot)
  if (ending && !liveSlot) return null
  const text = ending
    ? null
    : phase === 'waiting'
      ? t('stream.runningOrb.waitingText')
      : phase === 'working' || phase === 'error'
        ? t('stream.runningOrb.workingText')
        : t('stream.runningOrb.text')
  return (
    <div className="self-start flex items-center" style={{ gap: hasSlot ? 8 : 10 }}>
      {hasSlot ? (
        // 감싼 상자가 등장 동작을 맡는다 — 마스코트 자신은 기울임에 transform을 쓰므로 둘을 겹치면 서로 덮어쓴다.
        //   슬롯은 이 줄이 이미 다퉜다. 마스코트가 한 번 더 다투면 자기 자신과 겨루게 된다.
        <span className={entering ? 'chamding-enter' : undefined} onAnimationEnd={(e) => e.target === e.currentTarget && setEntering(false)} style={{ display: 'inline-block' }}>
          <ChamdingMascot state={MASCOT_STATE[phase]} size={CHAMDING_H} playOnMount taskKey={taskKey} slot />
        </span>
      ) : (
        <span aria-hidden style={{ width: 8, height: 8, margin: '0 4px', borderRadius: '50%', background: C.tintFill, flexShrink: 0 }} />
      )}
      {/* label2 — '지금 돌고 있다'는 유일한 글자 신호라 흐린 회색으로 두지 않는다(디자인 감사 2026-09-25 F6).
          마무리 중에는 결과 글이 이미 있으므로 문구를 비운다. */}
      {text != null && <span style={{ fontSize: 14, color: C.label2 }}>{text}</span>}
      {/* 대기 중이고 답할 카드가 있으면 그 카드로 보낸다. 터치 영역 44px는 패딩으로 채운다. */}
      {!ending && phase === 'waiting' && onGoAnswer && (
        <button type="button" onClick={onGoAnswer} style={{ minHeight: 44, minWidth: 44, padding: '0 10px', fontSize: 14, color: C.tint, background: 'none', border: 'none', cursor: 'pointer' }}>
          {t('stream.runningOrb.goAnswer')}
        </button>
      )}
    </div>
  )
}

// 세션 진입/전환 스켈레톤 — 메시지 모양 플레이스홀더로 채팅 영역을 채워, 클릭 즉시 응답(무거운 렌더가 클릭을 막지 않게).
//   대화 로드(백로그 replay)·전환 defer 동안 표시되며 콘텐츠 준비 시 교체된다.
const SKELETON_ROWS: { side: 'l' | 'r'; w: string; lines: number }[] = [
  { side: 'l', w: '74%', lines: 3 },
  { side: 'r', w: '44%', lines: 1 },
  { side: 'l', w: '86%', lines: 4 },
  { side: 'r', w: '36%', lines: 1 },
  { side: 'l', w: '62%', lines: 2 },
]
export function ChatSkeleton({ narrow }: { narrow: boolean }) {
  const t = useT()
  return (
    <div className="mx-auto flex flex-col" style={{ maxWidth: narrow ? 'none' : 760, gap: 14, padding: narrow ? '0 18px' : '0 16px' }} aria-busy="true" aria-label={t('stream.skeleton.loading')}>
      {SKELETON_ROWS.map((r, i) => (
        <div key={i} className={r.side === 'r' ? 'self-end' : 'self-start'} style={{ width: r.w, maxWidth: r.side === 'r' ? '82%' : '88%' }}>
          <div
            className="flex flex-col"
            style={{
              gap: 8,
              // 내 말은 회색 풍선, 모델의 답은 상자 없는 글이라 자리표시자도 같은 모양이다(재설계 4단계).
              padding: r.side === 'r' ? '12px 16px' : '4px 0',
              borderRadius: R.cardLg,
              background: r.side === 'r' ? C.fill : 'transparent',
            }}
          >
            {Array.from({ length: r.lines }).map((_, j) => (
              // 모서리 8은 .skeleton 클래스가 갖고 있던 값 — 공통 Skeleton의 기본값(4)과 달라 명시한다.
              <Skeleton key={j} height={10} width={j === r.lines - 1 ? '55%' : '100%'} radius={R.btn} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * 세션을 처음 열어 과거 기록을 받는 동안 대화 영역을 가리는 마스크.
 * 받는 중에는 대화를 그리지 않으므로(Stream이 세그먼트 빌드를 건너뛴다) 복원 과정이 화면에 보이지 않는다.
 * 문구는 0.2초 뒤에 떠오른다 — 새 빈 세션이나 아주 빠른 로딩에서 깜빡이지 않게. 움직임 줄이기 설정에서는 애니메이션 없이 바로 보인다.
 */
export function ChatLoadingMask({ narrow, withRows }: { narrow: boolean; withRows: boolean }) {
  const t = useT()
  return (
    <div className="relative" style={{ minHeight: '100%' }} aria-busy="true">
      {withRows && <ChatSkeleton narrow={narrow} />}
      <div className="chat-loading-label" role="status">
        <Spinner size={13} thickness={2} color={C.label2} track={C.sep} />
        {t('stream.loadingMask')}
      </div>
    </div>
  )
}

// 윈도잉: 이전 묶음을 불러오는 동안 상단에 보이는 인디케이터 겸 센티널 — Stream이 anchorRef로 위치를 관측해
//   화면(+선로드 여유) 안에 들어오면 자동 로드를 발동한다(스크롤 이벤트에만 의존하지 않음).
export function OlderLoading({ anchorRef }: { anchorRef?: Ref<HTMLDivElement> }) {
  const t = useT()
  return (
    <div ref={anchorRef} className="self-stretch flex items-center justify-center" style={{ fontSize: 12, color: C.label3, gap: 7, padding: '2px 0 6px' }}>
      <Spinner size={12} thickness={2} color={C.label3} track={C.sep} />
      {t('stream.olderLoading')}
    </div>
  )
}
