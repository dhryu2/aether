// 대화 칸 참딩을 얼마나 붙잡아 둘지 — 순수 함수. 시각은 호출자가 넘긴다(렌더 중에 시계를 읽지 않게).
//
// 도구가 잠깐 끼어들 때마다 렌즈를 올렸다 내리면 화면이 깜빡인다. 그래서 국면은 바로 바꾸지 않고
// 최소 유지 시간을 둔다. 반대로 턴이 끝나면 그 몸짓은 1.8초만 보여주고 치운다.
// 새로고침으로 이미 끝난 턴을 열었을 때는 마운트조차 하지 않는다.
import type { ChamdingPhase } from './types'

/** 처음 드러나기까지. 이보다 빨리 끝나면 참딩은 아예 안 나온다. */
export const REVEAL_MS = 700
/** 한 국면을 적어도 이만큼은 유지한다. 그보다 빠른 교체는 마지막 것만 남긴다. */
export const MIN_DWELL_MS = 500
/** 일하는 자세에서 생각으로 돌아올 때 렌즈를 너무 빨리 올리지 않는 시간. */
export const LENS_UP_HOLD_MS = 1200
/** 턴이 끝난 뒤 성공·실패·당황 몸짓을 보여주는 시간. 보이기 시작한 순간부터 잰다. */
export const FINALE_MS = 1800
/** 마무리의 마지막 구간. 이 동안 투명도를 내린다. */
export const FADE_MS = 240

export type PresenceInput = { active: boolean; phase: ChamdingPhase; turnKey: string | null }

export type Presence = {
  /** 진행 줄을 트리에 둘지. */
  mounted: boolean
  /** 이번 마운트가 시작된 시각. */
  since: number
  /** 마운트 후 REVEAL_MS가 지나 보여도 되는 상태. */
  revealed: boolean
  /** 마지막으로 받은 입력. */
  input: PresenceInput
  /** input.phase가 지금 값이 된 시각. */
  wantAt: number
  /** 화면에 실제로 보이는 국면. */
  shown: ChamdingPhase
  /** shown이 지금 값이 된 시각. */
  shownAt: number
  /** 마무리 종료 시각. 마무리가 아니면 null. */
  endAt: number | null
  /** 마무리의 마지막 FADE_MS. 감싼 상자가 투명도를 내린다. */
  leaving: boolean
  /** 턴 번호. 일 시작 몸짓을 턴마다 한 번만 거는 데 쓴다. */
  epoch: number
  /** 이 턴을 연 시점의 turnKey. */
  epochKey: string | null
}

const IDLE_INPUT: PresenceInput = { active: false, phase: 'idle', turnKey: null }

export const INITIAL_PRESENCE: Presence = {
  mounted: false,
  since: 0,
  revealed: false,
  input: IDLE_INPUT,
  wantAt: 0,
  shown: 'idle',
  shownAt: 0,
  endAt: null,
  leaving: false,
  epoch: 0,
  epochKey: null,
}

const FINALE_PHASE: ReadonlySet<ChamdingPhase> = new Set(['success', 'error', 'confused'])

function sameInput(a: PresenceInput, b: PresenceInput): boolean {
  return a.active === b.active && a.phase === b.phase && a.turnKey === b.turnKey
}

function samePresence(a: Presence, b: Presence): boolean {
  return a.mounted === b.mounted
    && a.since === b.since
    && a.revealed === b.revealed
    && a.wantAt === b.wantAt
    && a.shown === b.shown
    && a.shownAt === b.shownAt
    && a.endAt === b.endAt
    && a.leaving === b.leaving
    && a.epoch === b.epoch
    && a.epochKey === b.epochKey
    && sameInput(a.input, b.input)
}

function keep(prev: Presence, next: Presence): Presence {
  return samePresence(prev, next) ? prev : next
}

function unmounted(prev: Presence, input: PresenceInput, now: number): Presence {
  return {
    mounted: false,
    since: 0,
    revealed: false,
    input,
    wantAt: now,
    shown: 'idle',
    shownAt: now,
    endAt: null,
    leaving: false,
    epoch: prev.epoch,
    epochKey: prev.epochKey,
  }
}

/** 새 입력. 입력이 같으면 시각이 달라도 같은 객체를 돌려준다(시간은 tickPresence가 본다). */
export function stepPresence(p: Presence, input: PresenceInput, now: number): Presence {
  if (sameInput(p.input, input)) return p
  return keep(p, apply(p, input, now, true))
}

/** 시간만 지난다. 기한을 넘겼으면 국면·드러남·마무리를 반영한다. */
export function tickPresence(p: Presence, now: number): Presence {
  return keep(p, apply(p, p.input, now, false))
}

/**
 * now보다 뒤에 있는 기한 중 가장 이른 것.
 * 중간 기한(최소 유지)에서 화면이 안 바뀌어도 다음 기한(렌즈 유지)을 다시 알 수 있게 한다.
 */
export function nextWake(p: Presence, now: number): number | null {
  if (!p.mounted) return null
  const times: number[] = []
  if (!p.revealed) times.push(p.since + REVEAL_MS)
  if (p.endAt != null) {
    if (!p.leaving) times.push(p.endAt - FADE_MS)
    times.push(p.endAt)
  } else if (p.input.active && p.input.phase !== p.shown) {
    const hold = p.shown === 'working' && p.input.phase === 'thinking' ? LENS_UP_HOLD_MS : 0
    times.push(Math.max(p.shownAt + MIN_DWELL_MS, p.wantAt + hold))
  }
  let best: number | null = null
  for (const t of times) {
    if (t > now && (best == null || t < best)) best = t
  }
  return best
}

function apply(p: Presence, input: PresenceInput, now: number, inputChanged: boolean): Presence {
  // 1. 끝난 턴의 사건만으로는 새로 마운트하지 않는다(새로고침).
  if (!p.mounted && !input.active) return p

  // 2. 일이 시작되면 그때의 국면으로 마운트한다.
  if (!p.mounted && input.active) {
    return {
      mounted: true,
      since: now,
      revealed: false,
      input,
      wantAt: now,
      shown: input.phase,
      shownAt: now,
      endAt: null,
      leaving: false,
      epoch: p.epoch + 1,
      epochKey: input.turnKey,
    }
  }

  const revealed = now >= p.since + REVEAL_MS

  // 4. 마운트된 채로 결과 키가 바뀌면 새 턴이다. 이전 마무리는 생략한다.
  if (input.active && input.turnKey !== p.epochKey) {
    return {
      mounted: true,
      since: p.since,
      revealed,
      input,
      wantAt: now,
      shown: input.phase,
      shownAt: now,
      endAt: null,
      leaving: false,
      epoch: p.epoch + 1,
      epochKey: input.turnKey,
    }
  }

  // 5. 마무리 중에 다시 일이 시작되면 마무리를 취소하고 그 국면으로 바로 간다.
  if (input.active && p.endAt != null) {
    return {
      mounted: true,
      since: p.since,
      revealed,
      input,
      wantAt: now,
      shown: input.phase,
      shownAt: now,
      endAt: null,
      leaving: false,
      epoch: p.epoch + 1,
      epochKey: input.turnKey,
    }
  }

  // 6. 살아있는 동안의 국면 교체. 아직 시각이 안 됐으면 마지막 요청만 기억한다.
  if (input.active && input.phase !== p.shown) {
    const hold = p.shown === 'working' && input.phase === 'thinking' ? LENS_UP_HOLD_MS : 0
    const wantAt = input.phase !== p.input.phase ? now : p.wantAt
    const switchAt = Math.max(p.shownAt + MIN_DWELL_MS, wantAt + hold)
    if (now >= switchAt) {
      return {
        ...p,
        revealed,
        input,
        wantAt,
        shown: input.phase,
        shownAt: now,
        endAt: null,
        leaving: false,
      }
    }
    return { ...p, revealed, input, wantAt, endAt: null, leaving: false }
  }

  if (input.active) {
    const wantAt = input.phase !== p.input.phase ? now : p.wantAt
    return { ...p, revealed, input, wantAt, endAt: null, leaving: false }
  }

  // 이미 마무리 중이고 입력은 그대로 — 흐려짐과 언마운트만 본다.
  if (p.endAt != null && !inputChanged) {
    if (now >= p.endAt) return unmounted(p, input, now)
    return { ...p, revealed: true, input, leaving: now >= p.endAt - FADE_MS }
  }

  // 7. 아직 드러나기 전에 끝났거나, 성공·실패·당황이 아니면 바로 치운다(사용자 멈춤 포함).
  if (!revealed || !FINALE_PHASE.has(input.phase)) return unmounted(p, input, now)

  // 마무리가 이미 돌아가고 있으면 시계를 되돌리지 않는다.
  if (p.endAt != null) {
    if (now >= p.endAt) return unmounted(p, input, now)
    return {
      ...p,
      revealed: true,
      input,
      shown: input.phase,
      leaving: now >= p.endAt - FADE_MS,
    }
  }

  // 8. 마무리. 최소 유지를 기다리지 않고 바로 그 국면을 보여 준 뒤 FINALE_MS 뒤에 치운다.
  return {
    mounted: true,
    since: p.since,
    revealed: true,
    input,
    wantAt: now,
    shown: input.phase,
    shownAt: now,
    endAt: now + FINALE_MS,
    leaving: false,
    epoch: p.epoch,
    epochKey: p.epochKey,
  }
}
