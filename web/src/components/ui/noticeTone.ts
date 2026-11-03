import { C, alpha } from '../../design/tokens'

/** 알림 띠의 표준 색 조합 — 원래 스트림 화면 안에만 있어서 바깥 3곳이 색 값을 복사해 갔다. */
export const NOTICE_TONE = {
  info: { background: C.tintSoft, border: C.tintBorder, color: C.tint },
  /** 진짜 경고 — 테두리와 글자가 진하다. 사용자가 지나치면 안 되는 알림. */
  warn: { background: C.attnSoft, border: C.attnBorder, color: C.attn },
  /** 차분한 안내 — 같은 노랑 계열이지만 "이어서 진행 중" 같은 무해한 소식용. */
  note: { background: C.attnSoft, border: C.attnBorder, color: C.attn },
  danger: { background: C.delSoft, border: C.delBorder, color: C.del },
  neutral: { background: C.bg2, border: C.sepSoft, color: C.label2 },
  violet: { background: C.tintSoft, border: C.sep, color: C.tint },
} as const

/** 그림자용 반투명 먹 — 여기 두면 호출부가 rgba를 직접 적을 일이 없다. */
export const scrim = alpha.ink
