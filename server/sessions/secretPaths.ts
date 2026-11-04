/**
 * "이 경로에 든 파일은 비밀을 담고 있다"는 판정 — provider와 무관한 순수 규칙.
 *
 * 8e 분리 이유: 이 목록은 원래 `sessions/mutationPreview.ts`(권한 카드의 변경 미리보기)에 있었는데,
 * 이제 세 곳이 같은 판정을 쓴다 — 권한 카드, Claude 이벤트 영속 축소, Codex 이벤트 영속 축소.
 * 목록이 두 벌로 갈라지면 한쪽만 고치는 순간 다른 쪽이 비밀을 평문으로 남긴다. 그래서 한 곳에 모은다.
 * 파일을 읽지도, 설정을 보지도 않는 순수 규칙이라 어디서든 가볍게 가져다 쓸 수 있다.
 */

/** 작업 폴더 안이어도 내용을 보여주지 않는 경로(전부 대소문자 무시 — macOS의 대소문자 비구분 우회 차단). */
const SECRET_DENY = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.git\//i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.gnupg\//i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.docker\//i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pgpass$/i,
  /(^|\/)\.htpasswd$/i,
  /(^|\/)\.dockercfg$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /credentials/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.crt$/i,
  /\.keystore$/i,
  /\.tfvars$/i,
  /(^|\/)auth(-password)?\.json$/i,
];

/** 경로(상대·절대 어느 쪽이든)가 비밀 보유 파일이면 true → 내용을 가린다. */
// 윈도우 `\`를 `/`로 맞춰 같은 규칙을 적용한다. 맥·리눅스 파일 이름에 `\`가 든 경우는 드물어 오탐은 무시한다.
export const isSecretPath = (p: string) => typeof p === "string" && SECRET_DENY.some((re) => re.test(p.replace(/\\/g, "/")));

/**
 * 명령 문자열을 비밀 판정용 토큰으로 쪼갠다. 공백·따옴표·`=`·`,`·괄호와 `:`, 셸 제어 기호(`;` `|` `&` `<` `>` 백틱)에서 자르되,
 * 윈도우 드라이브 문자(한 글자 + `:` + `\` 또는 `/`)의 콜론은 자르지 않는다.
 * 저장 마스킹용 최선 노력 판정이라 `cat .e*`, `printenv`처럼 낱말에 경로가 드러나지 않는 명령은 잡지 못한다.
 */
export const commandTokens = (command: string): string[] =>
  command.split(/[\s'"=,();|&<>`]+/).flatMap((t) => t.split(/:(?![\\/])|(?<!(?:^|:)[A-Za-z]):/)).filter(Boolean);
