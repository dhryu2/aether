/**
 * 브라우저가 연결을 거부하는 포트(Chromium 금지 목록 중 1024 이상). 이 포트로 저장하면 첫 설정 뒤 화면에 들어갈 수 없다.
 * 첫 설정 화면과 서버 저장 검사가 같은 목록을 쓴다.
 */
const BLOCKED = [1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080];

export function isBrowserBlockedPort(port: number): boolean {
  return BLOCKED.includes(port);
}
