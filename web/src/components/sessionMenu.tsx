// 세션 하나에 거는 메뉴의 공통 부품 — 사이드바 카드, 접힌 사이드바 칩, 상단바 대기 목록 행이 함께 쓴다.
//   점 메뉴(WorkMenu)와 우클릭 메뉴가 같은 항목(WorkMenuItems)을 쓴다. 줄 id는 방 id, 이름 바꾸기·삭제는 실행 id(sourceSessionId)로 한다.
import { actions, getState } from '../lib/store'
import type { SessionListItem, WorkspaceRoom } from '../lib/types'
import { WorkMenuItems } from './WorkMenu'
import { onContextMenuFor } from './contextMenuFor'

export function roomAsListItem(room: WorkspaceRoom): SessionListItem {
  return {
    id: room.id,
    cwd: room.cwd ?? '',
    displayName: room.title,
    provider: room.provider ?? '',
    model: '',
    permissionMode: 'manual',
    status: room.status,
    createdAt: 0,
    lastActivityAt: room.lastActivityAt,
    preview: room.preview,
    attention: room.attention,
    attentionKind: room.attentionKind,
    attentionPreview: room.attentionPreview,
    attentionSince: room.attentionSince,
    backgroundTasks: room.backgroundTasks,
    backgroundCanStop: room.backgroundCanStop,
    lastViewedAt: room.lastViewedAt,
    archivedAt: room.archivedAt,
  }
}

/** WorkMenu·WorkMenuItems에 넘길 항목 동작. archiveBlocked = 일하는 중·대기·뒤 작업 중이라 보관할 수 없다. */
export function sessionMenuProps(room: WorkspaceRoom, archiveBlocked: boolean) {
  const exec = room.sourceSessionId
  const withSession = (fn: (s: SessionListItem) => void) => () => {
    const sess = exec ? getState().sessions.find((x) => x.id === exec) : undefined
    if (sess) fn(sess)
  }
  return {
    session: roomAsListItem(room),
    onExport: exec ? () => void actions.exportTranscript(exec) : undefined,
    onArchive: exec && room.status !== 'corrupted' ? () => void (room.archivedAt ? actions.unarchiveSession(exec) : actions.archiveSession(exec)) : undefined,
    archiveBlocked,
    // 실행 id가 없는 방은 이름을 바꿀 곳이 없어 항목을 숨긴다.
    onRename: exec ? () => actions.openRename(exec, room.title ?? '') : undefined,
    onReset: withSession(actions.requestReset),
    onDelete: withSession(actions.requestDelete),
  }
}

/** 세션을 가리키는 위젯의 onContextMenu. */
export function sessionContextMenu(room: WorkspaceRoom, archiveBlocked: boolean) {
  return onContextMenuFor(() => <WorkMenuItems {...sessionMenuProps(room, archiveBlocked)} close={actions.closeContextMenu} />)
}
