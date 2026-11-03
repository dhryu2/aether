/**
 * 모델 프로세스에 넘길 환경변수 (Phase 8f · 위험 R21).
 *
 * ## 무엇이 문제였나
 *
 * 서버는 `.env`를 읽고 뜬다. 그래서 프로세스 환경에 이 허브의 **로그인 서명키**·비밀번호 해시·푸시
 * 개인키가 들어 있다. 그런데 모델을 돌리는 자식 프로세스는 그 환경을 통째로 물려받는다. 모델은 승인
 * 없이 되는 읽기 명령 하나(`env`·`printenv`)로 그걸 볼 수 있고, 그 출력은 **경로 기반 가리기에도 안
 * 걸린다** — 우리 마스킹은 "비밀이 든 파일을 읽었을 때"를 보지, 환경변수가 그대로 찍힌 글자를 보지 않는다.
 * 로그인 서명키가 새면 그것만으로 허브 인증 전체가 우회된다.
 *
 * ## 어떻게 막나
 *
 * 모델에게 넘길 환경에서 **Aether 자신의 비밀 변수만** 걷어낸다(유저 결정 2026-08-18). 사용자의 도구가
 * 쓰던 다른 환경변수는 그대로 물려준다 — 그것까지 지우면 모델이 쓰던 명령이 갑자기 안 되는데, 그건
 * 이 문제와 상관없는 손해다.
 *
 * 걷어낼 이름은 **정규식으로 판정한다**. 목록을 손으로 적어 두면 나중에 비밀 변수를 하나 더 만들 때
 * 아무도 이 파일을 안 고치고, 그 하나가 조용히 새어 나간다.
 *
 * ## 일부러 넘겨야 하는 값이 있을 때
 *
 * `extra`로 넘긴 것은 걸러낸 **뒤에** 얹힌다. 8g의 지식 도구 브릿지가 세션별 토큰을 자식 환경으로 주는데
 * (`AETHER_MCP_TOKEN`), 그 이름은 이 정규식에 걸린다. 그때는 `modelEnv({ AETHER_MCP_TOKEN: token })`처럼
 * 명시해야 한다 — 실수로 새는 것과 일부러 주는 것을 코드에서 구분하기 위해서다.
 */

/**
 * 이 이름이 Aether 자신의 비밀인가.
 *
 * `AETHER_` 이름 공간 안에서 자격증명처럼 보이는 낱말이 들어간 것만 고른다.
 * 실제로 걸리는 것: `AETHER_JWT_SECRET`(로그인 서명키) · `AETHER_PASSWORD_HASH`(비밀번호 해시) ·
 * `AETHER_VAPID_PRIVATE`(푸시 개인키) · `AETHER_DATABASE_URL`(DB 접속 주소, 관리 계정 비밀번호가 들어 있다).
 * 설정값(`AETHER_MODEL`·`AETHER_OLLAMA_URL` 등)은 안 걸린다.
 * DB 주소는 서버 코드만 쓴다. 모델은 지식 도구를 HTTP로 부르므로 필요 없다(M4 실기에서 모델 환경에 넘어가는 것을 확인했다).
 */
export function isAetherSecretName(name: string): boolean {
  return /^AETHER_/.test(name) && /(SECRET|TOKEN|PASSWORD|PASSWD|HASH|PRIVATE|CREDENTIAL|DATABASE_URL)/.test(name);
}

/**
 * 모델 프로세스에 넘길 환경. `extra`는 걸러낸 뒤에 얹는다(일부러 주는 값).
 *
 * 값이 `undefined`인 항목은 빼고 넘긴다 — 자식에게 빈 문자열로 전달되는 것을 막기 위해서다.
 */
export function modelEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (isAetherSecretName(name)) continue;
    out[name] = value;
  }
  return extra ? { ...out, ...extra } : out;
}
