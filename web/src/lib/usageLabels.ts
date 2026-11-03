/**
 * 사용량 한도 창 이름 → 사람이 읽는 라벨 (Phase 8d-3 ④).
 *
 * 같은 어휘를 두 곳이 쓴다: 대화 중 뜨는 한도 배너(`streamSegments`)와 설정의 사용량 패널(`SessionStatus`).
 * 8d-3 전엔 이 표가 배너 쪽에만 있어서, 사용량 패널은 Claude 필드 이름별로 문구를 따로 박아 두고 있었다.
 *
 * 모르는 이름은 **그대로 보여준다**. provider가 새 창을 추가하거나 다른 provider가 자기 어휘를 쓸 때
 * 화면에서 사라지는 것보다 이름이라도 보이는 편이 낫고, 그래야 표에 없다는 이유로 정보가 유실되지 않는다.
 */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * 창 이름 대신 **길이**만 알려주는 서비스를 위한 라벨 (8h).
 *
 * Codex는 창에 `five_hour` 같은 이름을 주지 않고 길이(분)와 사용률만 준다(실측 2026-08-19).
 * 이름이 없다고 내부 키(`codex_primary`)를 화면에 띄우면 사용자에게 아무 뜻도 없으므로 길이로 부른다.
 * 분·시간·일 중 딱 떨어지는 단위를 고르고, 어느 것도 안 맞으면 시간으로 반올림한다.
 */
function durationLabel(minutes: number, t: Translate): string {
  if (minutes % 1440 === 0) return t('stream.rateLimit.lastDays', { n: minutes / 1440 })
  if (minutes % 60 === 0) return t('stream.rateLimit.lastHours', { n: minutes / 60 })
  if (minutes < 60) return t('stream.rateLimit.lastMinutes', { n: minutes })
  return t('stream.rateLimit.lastHours', { n: Math.round(minutes / 60) })
}

export function rateLimitLabel(limitType: string | undefined, t: Translate, windowMinutes?: number): string {
  switch (limitType) {
    case 'five_hour':
      return t('stream.rateLimit.fiveHour')
    case 'seven_day':
      return t('stream.rateLimit.sevenDay')
    case 'seven_day_opus':
      return t('stream.rateLimit.sevenDayOpus')
    case 'seven_day_sonnet':
      return t('stream.rateLimit.sevenDaySonnet')
    case 'seven_day_oauth_apps':
      return t('stream.rateLimit.sevenDayOauthApps')
    case 'extra_usage':
    case 'overage':
      return t('stream.rateLimit.overage')
    default:
      // 표에 없는 이름이면 길이로 부른다. 길이도 모르면 이름을 그대로 보여준다(정보를 없애지 않는다).
      if (typeof windowMinutes === 'number' && windowMinutes > 0) return durationLabel(windowMinutes, t)
      return limitType || t('stream.rateLimit.default')
  }
}

/** 가장 많이 찬 한도 창. 사용률을 아는 창이 없으면 null이다. */
export function fullestWindow<W extends { utilization: number | null }>(windows: readonly W[]): W | null {
  let top: W | null = null
  for (const w of windows) {
    if (w.utilization != null && (top?.utilization == null || w.utilization > top.utilization)) top = w
  }
  return top
}
