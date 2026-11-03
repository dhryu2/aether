// 자동 재개 예약의 시각 표시와 입력 변환. React도 저장소도 모른다.

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** 시각만 보여 준다("3:00"). 오늘이 아니면 날짜를 앞에 붙인다("11/3 3:00"). 분은 항상 두 자리다. */
export function autoResumeTimeText(at: number, now = Date.now()): string {
  const d = new Date(at)
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay(d, new Date(now)) ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

/** `<input type="time">` 값("HH:MM")에 해당하는 다음 시각(ms). 이미 지났거나 같으면 다음 날이다. 모양이 틀리면 null. */
export function nextOccurrence(hhmm: string, now = Date.now()): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  const d = new Date(now)
  d.setHours(h, min, 0, 0)
  if (d.getTime() <= now) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** 시각 입력 칸의 초기값("HH:MM", 두 자리). */
export function timeInputValue(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
