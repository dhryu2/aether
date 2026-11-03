/**
 * 과거 검색 도구가 돌려준 결과 줄을 알아보는 정규식.
 * 검색 결과를 그릴 때(agentTool.ts)와 검색용 표를 정제할 때(refineLetter.ts) 같은 규칙을 쓴다.
 */
export const PAST_SEARCH_RESULT = /^▸ (".*" ((과거 )?검색|과거 검색 요약|검색 결과 없음)|[0-9]+ result\(s\) for|Past-search summary for|No results for|session=\S+ (맥락|context|원문)|session=\S+에서 더 볼|Raw session=|No more raw messages)/;
