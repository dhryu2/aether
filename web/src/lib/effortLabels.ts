/**
 * 추론 강도 설명 고르기 (Phase 8i).
 *
 * 8i 전엔 `EffortPicker`가 low·medium·high·xhigh·max라는 표를 직접 들고 있었다. 그건 Claude 어휘라서
 * 다른 서비스(Codex는 minimal 같은 자기 이름을 쓰고 강도마다 설명도 직접 준다)에서는 맞지 않았다.
 * 이제 설명의 출처는 모델 목록에 실려 오는 표 하나뿐이고, 화면은 강도 이름을 하나도 모른다.
 *
 * 서버가 언어를 고르지 않는 이유는 서버 로케일이 프로세스 전역 하나뿐이기 때문이다 — 폰과 노트북이
 * 다른 언어를 쓰면 어긋난다. 그래서 표 전체를 받아 여기서 고른다(언어를 바꿔도 다시 받을 필요 없음).
 */
import type { LocalizedText } from './types'
import { resolveLocalizedText } from './localizedText'

/**
 * 폴백 순서: 내 언어 → 언어 대분류(ko-KR → ko) → provider 원문 → 빈 문자열.
 *
 * 영어를 중간 폴백으로 넣지 않는다. `byLocale`은 aether가 가진 번역이라 한국어가 없으면 그 강도의
 * 번역을 안 만든 것이고, 그때 영어를 들이미느니 설명을 비우는 편이 낫다. 반면 `text`는 provider가 준
 * 원문이라 언어가 달라도 그 서비스의 권위 있는 설명이므로 보여준다(출처가 다르니 취급도 다르다).
 */
export function effortDescription(desc: LocalizedText | undefined, locale: string): string {
  return resolveLocalizedText(desc, locale)
}
