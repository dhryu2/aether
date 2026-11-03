/**
 * 상단바가 대화 위를 덮는 높이. 대화 칸은 이만큼 위를 비워 첫 글이 섬 밑에 숨지 않게 한다.
 * 컴퓨터: 위 여백 10 + 섬 52. 폰: 상태 표시줄 + 위 여백 8 + 섬 48.
 * App(main의 --bar-h)과 FindBar(찾기 막대 위치)가 같이 쓴다 — 섬 크기를 바꾸면 여기도 바꾼다.
 */
export function topBarInset(narrow: boolean): string {
  if (narrow) return 'calc(env(safe-area-inset-top) + 56px)'
  return '62px'
}
