import { ChamdingMascot } from '../ChamdingMascot'

/** 홈 히어로. 참딩이 창 바탕 위에 선다. 손을 따라 반응하는 참딩은 이 화면의 것 하나다. */
export function BrainApertureHero({ ariaLabel }: { ariaLabel: string }) {
  return <ChamdingMascot state="idle" size={148} interactive ariaLabel={ariaLabel} priority={2} />
}
