/**
 * 디자인 토큰 — 화면 코드(.tsx)가 쓰는 시각 값의 유일한 출처.
 *
 * 재설계 A "떠 있는 유리판"(2026-09-27)부터 색은 CSS 변수를 가리킨다.
 *   값 자체는 index.css의 `--c-*`에 밝은 화면·어두운 화면 두 벌로 있고, 기기 설정(prefers-color-scheme)을
 *   따라 브라우저가 바꿔 끼운다. 여기 문자열은 'var(--c-label)' 같은 참조일 뿐이다.
 *   그래서 화면 코드는 예전처럼 `color: C.label`로 쓰면 되고, 밝기 모드를 몰라도 된다.
 *
 * 인라인 `style={{}}` 관용구는 그대로다. 달라진 것은 두 가지다.
 *   ① 색 문자열 뒤에 글자를 이어 붙여 투명도를 만들면 안 된다(`${C.tint}33` 금지 — var()에는 안 먹는다).
 *      투명도는 아래 `alpha`를 쓴다(color-mix로 만든다).
 *   ② 새 색을 만들 때는 index.css 두 벌(밝게·어둡게)에 모두 적는다. tokens.test.ts가 짝을 검사한다.
 */

/**
 * 역할 색. 이름은 Apple HIG의 역할 이름을 따랐다(label·fill·tint·separator).
 * 값은 index.css `:root`(밝게)와 `@media (prefers-color-scheme: dark)`(어둡게)에 있다.
 */
const P = {
  // ── 면 ──
  /** 화면 바탕 */
  bg: 'var(--c-bg)',
  /** 묶음 바탕·코드 줄 바탕·회색 면 */
  bg2: 'var(--c-bg2)',
  /** 카드 면 */
  cell: 'var(--c-cell)',
  /** 카드 안의 한 단계 옅은 면(옛 surface1). 어두운 화면에서 바탕(검정)을 쓰면 창 안에 검은 구멍이 생긴다 */
  cell2: 'var(--c-cell2)',
  /** 떠오른 면(팝오버·창). 어두운 화면에서 카드보다 한 단계 밝다 */
  cellHi: 'var(--c-cell-hi)',
  // ── 글자 ──
  /** 본문 */
  label: 'var(--c-label)',
  /** 보조 설명 */
  label2: 'var(--c-label2)',
  /** 메타(시간·경로) */
  label3: 'var(--c-label3)',
  /** 입력 안내·꺼진 것. 읽어야 하는 글에 쓰지 않는다(명암 기준 미달) */
  label4: 'var(--c-label4)',
  // ── 선·채움 ──
  /** 구분선·테두리 */
  sep: 'var(--c-sep)',
  /** 카드 안쪽 옅은 구분선 */
  sepSoft: 'var(--c-sep-soft)',
  /** 회색 버튼·칩 바탕 */
  fill: 'var(--c-fill)',
  /** 세그먼트에서 선택된 칸. 밝게 흰색, 어둡게 회색 — 어두운 화면에서 카드 면을 쓰면 바탕과 같아져 선택이 안 보인다 */
  segOn: 'var(--c-seg-on)',
  // ── 강조: 파랑 하나 — 누를 수 있는 것에만 ──
  /** 파랑 글자·아이콘 */
  tint: 'var(--c-tint)',
  /** 파랑으로 채운 버튼 */
  tintFill: 'var(--c-tint-fill)',
  /** 채운 색 위의 글자(파랑·빨강·주황 채움 공통) */
  onTint: 'var(--c-on-tint)',
  tintSoft: 'var(--c-tint-soft)',
  tintBorder: 'var(--c-tint-border)',
  // ── 상태: 기다림(주황) · 완료(초록) · 위험(빨강) ──
  attn: 'var(--c-attn)',
  /** 주황으로 채운 버튼(흰 글자가 읽히는 진한 주황) */
  attnFill: 'var(--c-attn-fill)',
  attnSoft: 'var(--c-attn-soft)',
  attnBorder: 'var(--c-attn-border)',
  ok: 'var(--c-ok)',
  okSoft: 'var(--c-ok-soft)',
  okBorder: 'var(--c-ok-border)',
  del: 'var(--c-del)',
  /** 빨강으로 채운 버튼(흰 글자가 읽히는 진한 빨강) */
  delFill: 'var(--c-del-fill)',
  delSoft: 'var(--c-del-soft)',
  delBorder: 'var(--c-del-border)',
  // ── 코드 ──
  /** 어두운 코드블록 바탕(두 모드 모두 어둡다) */
  codeBg: 'var(--c-code-bg)',
  codeLine: 'var(--c-code-line)',
} as const

/**
 * 화면이 쓰는 색. 옛 이름은 이렇게 합쳤다.
 * 시안(실행)·바이올렛(질문)·청록(계획)은 파랑, 노랑(경고)은 주황, 초록은 완료, 빨강은 위험.
 */
export const C = P

/**
 * 반투명 색 — CSS 변수 색에 투명도를 준다. color-mix라 밝기 모드가 바뀌어도 따라간다.
 */
const mix = (v: string, a: number) => `color-mix(in srgb, var(${v}) ${Math.round(a * 1000) / 10}%, transparent)`
export const alpha = {
  /** 막·그림자의 바탕. 밝게 먹색, 어둡게 검정 */
  ink: (a: number) => mix('--c-shadow', a),
  shadow: (a: number) => mix('--c-shadow', a),
  tint: (a: number) => mix('--c-tint-fill', a),
  tintInk: (a: number) => mix('--c-tint', a),
  ok: (a: number) => mix('--c-ok', a),
  del: (a: number) => mix('--c-del', a),
  attn: (a: number) => mix('--c-attn', a),
  /** 반투명한 면. 밝게 흰 면, 어둡게 어두운 면이 비친다 */
  cellHi: (a: number) => mix('--c-cell-hi', a),
  label2: (a: number) => mix('--c-label2', a),
  bg2: (a: number) => mix('--c-bg2', a),
} as const

/**
 * 모서리 — 재설계 A. 이름은 그대로 두고 값만 바꿨다.
 * 줄·입력칸·작은 상자는 10~12, 카드 18~20, 떠 있는 기둥·창 22. 캡슐(알약)은 full(999)이다.
 *
 * ⚠️ chip·btn·pill에 999를 주면 안 된다. 이름과 달리 여러 줄 상자·글 입력칸·사진 미리보기·폴더 트리 줄에도
 *   쓰여서, 999가 되면 그 상자들이 양끝이 반원인 알약이나 원으로 잘린다(2026-09-27 blind 검토에서 발견).
 *   캡슐은 확실히 버튼인 곳에만 준다 — Button·IconButton의 기본값이 full이고, 나머지는 3~6단계에서
 *   화면을 다시 짜며 자리마다 full을 직접 넣는다.
 * 2026-07-29에 "너무 둥글다"는 판단으로 전부 8로 낮췄던 것을 방향 A 선택(2026-09-27)으로 다시 올렸다.
 */
export const R = {
  /** 미세 표시(진행바 fill, 작은 태그) */
  xs: 4,
  /** 아주 작은 배지 */
  sm: 6,
  /** 작은 칩·작은 상자 */
  chip: 10,
  /** 일반 버튼·타일(이름과 달리 상자에도 쓰인다 — 위 경고) */
  btn: 12,
  /** 알약형 액션·중간 타일(이름과 달리 사진 미리보기에도 쓰인다) */
  pill: 12,
  /** 배너·입력칸·목록 줄 */
  field: 12,
  /** 세그먼트 트랙 */
  track: 9,
  /** 카드·팝오버 */
  card: 18,
  /** 강조 카드 */
  cardLg: 20,
  /** 확인 대화상자 */
  dialog: 20,
  /** 모달·시트·떠 있는 기둥 */
  modal: 22,
  /** 완전한 원/캡슐 */
  full: 999,
} as const

/**
 * 겹침 순서 — 원래 23곳에 16가지 숫자가 흩어져 있었고 중앙 기준이 없었다.
 *
 * 함정(실측): App.tsx의 본문 래퍼가 `relative z-10`이라 그 안의 값(topBar·popover·composer)은
 * 바깥 형제(drawer·모달)와 애초에 경쟁하지 않는다. 숫자만 보면 같아 보여도 무대가 다르다.
 * 그래서 아래를 `inApp`(본문 안)과 `root`(문서 최상위) 두 무리로 갈라 적는다.
 * 값은 기존과 동일하게 유지했다 — 지금 겹침 모양을 바꾸지 않기 위해서다.
 */
export const Z = {
  /** 본문 래퍼 안에서만 유효한 순서 */
  inApp: {
    /** 스트림의 맨아래로 가기 버튼 */
    scrollFab: 5,
    /** 상단바 */
    topBar: 20,
    /** 컴포저의 슬래시 명령 목록 */
    slashMenu: 20,
    /** 모델·effort 선택 팝오버 */
    picker: 40,
  },
  /** 문서 최상위에서의 순서 — 위로 갈수록 앞에 온다 */
  root: {
    /** 모바일 서랍 뒤 어둡게 깔리는 막 */
    drawerScrim: 40,
    /** 모바일 서랍 본체 */
    drawer: 41,
    /** 찾기 막대 */
    findBar: 45,
    /** 새 세션 만들기 */
    newSession: 50,
    /** 다음 작업으로 넘기기 */
    handoff: 52,
    /** 삭제 확인 */
    deleteConfirm: 55,
    /** 설정 */
    settings: 56,
    /** 로그인·단축키 도움말 */
    providerAuth: 58,
    shortcuts: 59,
    /** Agent Brain 전체 화면 */
    brain: 70,
    /** 떠 있는 알림(오류·일반) — Brain 안에서 난 오류도 보여야 하므로 그 위, 확인 대화상자보다는 아래 */
    toast: 75,
    /** 최종 확인 대화상자 — 무엇 위에도 떠야 한다 */
    dialog: 80,
  },
  /** 세션 전환 중 화면을 덮는 막(본문 안, 위치가 absolute라 별도) */
  loadMask: 15,
} as const

/**
 * 그림자 — 방향 A: 떠 있는 것에만, 낮고 옅게. 색은 alpha가 만들므로 어두운 화면에서 검정으로 바뀐다.
 * 이름은 그대로 두고 값만 바꿨다.
 */
export const SH = {
  /** 모달·확인창 */
  modal: [`0 1px 2px ${alpha.ink(0.06)}`, `0 24px 60px -20px ${alpha.ink(0.35)}`].join(', '),
  /** 떠 있는 면의 가장자리 — 위쪽 빛 선과 아주 옅은 테두리(index.css --c-edge-*) */
  edge: 'inset 0 1px 0 var(--c-edge-hi), inset 0 0 0 0.5px var(--c-edge-lo)',
  /** Agent Brain 시트 */
  sheet: `0 30px 70px -34px ${alpha.ink(0.4)}`,
  /** 팝오버·떠 있는 막대. index.css의 `.popover-surface`가 같은 값을 쓴다 — 한쪽만 고치지 마라. */
  popover: [`0 1px 2px ${alpha.ink(0.06)}`, `0 12px 32px -12px ${alpha.ink(0.28)}`].join(', '),
  /** 토글 손잡이 */
  knob: `0 3px 8px ${alpha.ink(0.15)}, 0 1px 1px ${alpha.ink(0.16)}`,
  /** 세그먼트에서 선택된 칸 */
  segActive: `0 1px 3px ${alpha.ink(0.12)}`,
} as const

/** 움직임 시간(ms) — JS가 애니메이션이 끝나기를 기다려야 할 때만 쓴다. 값은 index.css의 --dur-*와 같아야 한다. */
export const MS = {
  /** 닫힘·사라짐(--dur-out) */
  out: 150,
} as const

/** 글꼴 — 하드코딩된 "'Geist Mono', monospace" 8곳을 대신한다. */
export const FONT = {
  mono: 'var(--font-mono)',
} as const
