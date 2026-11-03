// 폴더 줄 모양. 최근 폴더 목록과 탐색 화면이 같은 높이, 여백, 간격을 쓴다.
import { C, R } from '../../design/tokens'
import { rowMin } from '../settings/settingsLayout'

export function folderRowStyle(narrow: boolean, disabled?: boolean) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    minHeight: rowMin(narrow),
    padding: '0 16px',
    border: 'none',
    background: 'transparent',
    cursor: disabled ? 'default' : 'pointer',
    textAlign: 'left' as const,
    font: 'inherit',
    color: C.label,
  }
}

/** 넓은 화면 사이드바 줄. 높이 32에 반경 R.chip, 좌우로 8씩 띄워 선택 면이 가장자리에 붙지 않게 한다. 폰은 일반 폴더 줄과 같다. */
export function sidebarRowStyle(narrow: boolean) {
  if (narrow) return folderRowStyle(true)
  return {
    ...folderRowStyle(false),
    width: 'calc(100% - 16px)',
    margin: '0 8px',
    minHeight: 32,
    padding: '0 8px',
    gap: 8,
    borderRadius: R.chip,
  }
}
