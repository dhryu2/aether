// 채팅영역 로드마스크 — 부팅(세션 로드) / 재연결(백엔드 재시작) 중 중간 렌더(NoActive 깜빡·세션 요동)을 프로스티드로 가림.
//   완료(booting 해제 + connected)되면 사라지고, 활성세션이 있으면 Stream이 자기 ChatSkeleton으로 자연스럽게 이어받는다.
//   참딩 마크는 700ms 지연 뒤에만 마운트한다. 그보다 빨리 끝나면 마크는 아예 안 뜬다.
//   한 번 드러난 뒤에는 덮개가 걷히는 동안에도 남긴다. 걷히기 시작한 뒤에야 700ms가 차는 경우는 끝내 안 띄운다.
import { useState } from 'react'
import { useT } from '../../lib/i18n'
import { useDelayedFlag } from '../../lib/hooks'
import { ChamdingMascot } from '../ChamdingMascot'
import { chamdingWidth } from '../chamdingWidth'
import { C, Z, alpha } from '../../design/tokens'

const CHAMDING_REVEAL_MS = 700
/** 참딩 상자 크기. 마크 타일(56px)보다 키운 이유 — 전신 그림이라 같은 크기면 얼굴이 절반으로 작아진다. */
const MASCOT_H = 88
const MASCOT_W = chamdingWidth(MASCOT_H)

export function LoadMask({ reconnecting, closing }: { reconnecting: boolean; closing?: boolean }) {
  const t = useT()
  const reveal = useDelayedFlag(!closing, CHAMDING_REVEAL_MS)
  const [kept, setKept] = useState(false)
  if (reveal && !kept) setKept(true)
  const showMark = kept && (reveal || !!closing)

  return (
    <div
      // 덮을 때도 걷힐 때도 투명도로 넘어간다. 흐림이 걸린 면이 한 프레임에 덮이면 화면이 번쩍인다 —
      //   재연결은 짧게 자주 일어나므로 특히 눈에 거슬렸다. 걷히는 동안은 클릭을 가로채지 않는다.
      className={`flex flex-col items-center justify-center ${closing ? 'mask-out' : 'mask-in'}`}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: Z.loadMask,
        gap: 14,
        background: alpha.bg2(0.72),
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        pointerEvents: closing ? 'none' : undefined,
      }}
      aria-busy="true"
      aria-label={reconnecting ? t('nav.app.loadMask.reconnectingLabel') : t('nav.app.loadMask.loadingLabel')}
    >
      {showMark ? (
        // 감싼 상자가 등장 동작을 맡는다 — 마스코트 자신은 기울임에 transform을 쓰므로 둘을 겹치면 서로 덮어쓴다.
        <div className="chamding-enter">
          <ChamdingMascot state="loading" size={MASCOT_H} priority={2} />
        </div>
      ) : (
        <div style={{ width: MASCOT_W, height: MASCOT_H }} aria-hidden />
      )}
      <div style={{ fontSize: 13.5, color: C.label2 }}>
        {reconnecting ? t('nav.app.loadMask.reconnectingText') : t('nav.app.loadMask.loadingText')}
      </div>
    </div>
  )
}
