import { useEffect, useState } from 'react'
import { api } from '../../lib/api'

/** 최근 24시간 오류 건수. 설정 목록의 「오류 기록」 줄에 붙인다. 불러오지 못하면 0으로 둔다. */
export function useErrorTodayCount(): number {
  const [total, setTotal] = useState(0)
  useEffect(() => {
    let alive = true
    api.errorGroups({ since: '24h', source: 'all' }).then((r) => alive && setTotal(r.total)).catch(() => undefined)
    return () => { alive = false }
  }, [])
  return total
}
