// 앱 안 업데이트 진행 화면의 순수 판정. 폴링 결과를 받아 "지금 어떤 화면을 보일지"만 정한다.
import type { UpdateInstallFailure, UpdateStatusResponse } from '@shared/http'

/** 새로 고친 뒤 완료 토스트를 띄우기 위해 sessionStorage에 적어 두는 키(값=새 버전). */
export const UPDATE_DONE_KEY = 'aether.updateDone'
/** 설치 단계가 이만큼 길어지면 "오래 걸려요" 화면으로 바꾼다. */
export const UPDATE_SLOW_MS = 210_000 // 설치 프로그램의 대기 180초보다 길게

/** 1초마다 한 번 본 서버의 모습. health=상태 조회는 못 했지만 서버는 떠 있고 버전만 아는 경우. unauthorized=조회가 401이라 재로그인이 필요한 경우(이때만 health의 옛 버전을 믿는다). */
export type UpdateProbe =
  | { kind: 'status'; status: UpdateStatusResponse }
  | { kind: 'health'; version: string; unauthorized: boolean }
  | { kind: 'down' }

export type UpdateStep =
  | { step: 'reload'; version: string }
  | { step: 'checking' }
  | { step: 'downloading'; version: string; received: number; total: number }
  | { step: 'installing' }
  | { step: 'slow' }
  | { step: 'failed'; reason: UpdateInstallFailure }
  | { step: 'rolledBack'; kind: 'rolledBack' | 'unfinished' }

export interface UpdateFlowInput {
  probe: UpdateProbe
  /** 한 번이라도 연결이 끊긴 적이 있는가(설치 중 서버가 내려간 흔적). */
  wasDown: boolean
  /** 설치 단계가 시작된 뒤 지난 시간(ms). 아직이면 0. */
  elapsedMs: number
  /** 업데이트를 누를 때의 버전과 목표 버전. */
  fromVersion: string
  targetVersion?: string
}

export function decideUpdateStep(i: UpdateFlowInput): UpdateStep {
  const { probe, wasDown, elapsedMs, fromVersion, targetVersion } = i
  const waiting: UpdateStep = elapsedMs > UPDATE_SLOW_MS ? { step: 'slow' } : { step: 'installing' }
  const version = probe.kind === 'status' ? probe.status.current : probe.kind === 'health' ? probe.version : undefined
  // 목표 버전을 끝내 못 봤어도(checking에서 열린 화면) 끊겼다 돌아온 서버의 버전이 달라졌으면 완료로 본다.
  const goal = targetVersion ?? (wasDown ? version : undefined)
  if (version !== undefined && goal && version === goal && version !== fromVersion) return { step: 'reload', version }
  if (probe.kind === 'down') return waiting
  if (probe.kind === 'health') return probe.unauthorized && wasDown && version === fromVersion ? { step: 'rolledBack', kind: 'unfinished' } : waiting
  const { install, rolledBackVersion } = probe.status
  switch (install.phase) {
    case 'checking': return { step: 'checking' }
    case 'downloading': return { step: 'downloading', version: install.version, received: install.received, total: install.total }
    case 'installing': return waiting
    case 'failed': return { step: 'failed', reason: install.reason }
    case 'idle':
      if (targetVersion && rolledBackVersion === targetVersion) return { step: 'rolledBack', kind: 'rolledBack' }
      if (wasDown) return { step: 'rolledBack', kind: 'unfinished' }
      return { step: 'checking' } // 누른 직후 아직 시작 전
  }
}
