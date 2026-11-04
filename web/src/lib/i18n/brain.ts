// 워크스페이스(코드 이름 brain) 화면 문자열. 화면에 보이는 문장은 여기만 고친다.
import type { Dict } from './types'

export const brain: Dict = {
  'brain.loading': { ko: '불러오는 중', en: 'Loading' },

  'brain.date.today': { ko: '오늘 {hm}', en: 'Today {hm}' },
  'brain.date.yesterday': { ko: '어제 {hm}', en: 'Yesterday {hm}' },

  'brain.role.user': { ko: '나', en: 'Me' },
  'brain.role.assistant': { ko: 'AI', en: 'AI' },
  'brain.role.tool': { ko: '도구', en: 'Tool' },

  'brain.search.placeholder': { ko: '지난 대화 찾기', en: 'Search past conversations' },
  'brain.search.filter': { ko: '필터', en: 'Filters' },
  'brain.search.recent': { ko: '최근 세션', en: 'Recent sessions' },
  'brain.search.recentEmpty': { ko: '아직 세션이 없어요', en: 'No sessions yet' },
  'brain.search.clear': { ko: '지우기', en: 'Clear' },
  'brain.search.sort.relevance': { ko: '관련도순', en: 'Relevance' },
  'brain.search.sort.recent': { ko: '최신순', en: 'Newest' },
  'brain.search.sort.oldest': { ko: '오래된순', en: 'Oldest' },
  'brain.search.periodLabel': { ko: '기간', en: 'Period' },
  'brain.search.period.all': { ko: '전체', en: 'All' },
  'brain.search.period.today': { ko: '오늘', en: 'Today' },
  'brain.search.period.d7': { ko: '최근 7일', en: 'Last 7 days' },
  'brain.search.period.d30': { ko: '최근 30일', en: 'Last 30 days' },
  'brain.search.resultsSummary': { ko: '{count}건, 세션 {sessions}개', en: '{count} results, {sessions} sessions' },
  'brain.search.hitCount': { ko: '{n}건', en: '{n}' },
  'brain.search.loading': { ko: '검색 중', en: 'Searching' },
  'brain.search.emptyTitle': { ko: "'{query}' 검색 결과가 없어요", en: "No results for '{query}'" },
  'brain.search.emptyDesc': { ko: '다른 단어로 바꾸거나, 명령이나 결과의 일부만 넣어 보세요', en: 'Try another word, or a piece of a command or result' },
  'brain.search.deletedBadge': { ko: '삭제된 세션', en: 'Deleted session' },
  'brain.search.deletedNotice': { ko: '삭제된 세션이라 남아 있는 대화 내용만 읽을 수 있어요', en: 'This session was deleted. Only its remaining conversation text can be read.' },
  'brain.search.deletedBack': { ko: '검색 결과로', en: 'Back to results' },
  'brain.search.deletedMore': { ko: '더 보기', en: 'Load more' },
  'brain.search.deletedFailed': { ko: '대화 내용을 불러오지 못했어요', en: "Couldn't load the conversation" },
  'brain.search.idleTitle': { ko: '지난 대화 찾기', en: 'Find past conversations' },

  'brain.env.label': { ko: '현재 프로젝트', en: 'Current environment' },
  'brain.hub.defaultEnvLabel': { ko: '프로젝트 없음', en: 'No project' },

  'brain.tabs.hub': { ko: '홈', en: 'Home' },

  'brain.header.title': { ko: '워크스페이스', en: 'Workspace' },
  'brain.aperture.ariaLabel': { ko: 'Aether 로고', en: 'Aether Aperture mark' },
}
