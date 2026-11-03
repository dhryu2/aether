// 공용(범용) 문자열 — 여러 컴포넌트가 공유하는 단어. 특정 화면 전용은 각 네임스페이스 파일로.
import type { Dict } from './types'

export const common: Dict = {
  'common.close': { ko: '닫기', en: 'Close' },
  'common.cancel': { ko: '취소', en: 'Cancel' },
  'common.confirm': { ko: '확인', en: 'OK' },
  'common.save': { ko: '저장', en: 'Save' },
  'common.start': { ko: '시작', en: 'Start' },
  'common.restart': { ko: '재시작', en: 'Restart' },
  'common.refresh': { ko: '새로고침', en: 'Refresh' },
  'common.loadFailed': { ko: '화면을 불러오지 못했습니다. 연결을 확인하고 다시 열어 주세요.', en: 'Could not load this screen. Check your connection and open it again.' },
  'common.delete': { ko: '삭제', en: 'Delete' },
}
