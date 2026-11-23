// 작업 대기열 화면의 순수 계산. React도 저장소도 모른다.
import type { TaskQueueItem, TaskQueueResponse } from '@shared/http'
import type { SessionListItem } from './types'

/** 작업 줄에 글자로 보이는 상태. 서버가 준 state에 그 세션의 실시간 상태를 합쳐 정한다. */
export type QueueItemStatus = 'waiting' | 'running' | 'approval' | 'limit' | 'done' | 'failed' | 'cut'

/** attention·종류·자동 재개 예약 값만 본다. provider 이름은 보지 않는다. */
export function queueItemStatus(
  state: TaskQueueItem['state'],
  live?: Pick<SessionListItem, 'attention' | 'attentionKind' | 'autoResume'>,
): QueueItemStatus {
  if (state !== 'running') return state
  if (live?.attentionKind === 'rate_limit' || live?.autoResume?.at !== undefined) return 'limit'
  if (live?.attention === 'waiting') return 'approval'
  return 'running'
}

/** 기다리거나 도는 작업 수가 한도에 닿았는가. */
export function queueFull(q: Pick<TaskQueueResponse, 'items' | 'maxItems'>): boolean {
  return q.items.filter((x) => x.state === 'waiting' || x.state === 'running').length >= q.maxItems
}
