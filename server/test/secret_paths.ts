/**
 * 비밀 경로 판정. 파일을 열지 않는다. 모델 호출 0.
 * 실행: node --env-file=.env --import tsx test/secret_paths.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandTokens, isSecretPath } from "../sessions/secretPaths";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "aether-secret-paths-"));
process.env.AETHER_DATA_DIR = data;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const secret = [
  ".env",
  ".ENV",
  "app/.env.local",
  "/tmp/project/.env",
  ".git/config",
  "repo/.ssh/id_ed25519",
  ".gnupg/pubring.kbx",
  ".aws/credentials",
  ".docker/config.json",
  ".npmrc",
  "home/.netrc",
  ".pgpass",
  ".htpasswd",
  ".dockercfg",
  "keys/id_rsa",
  "keys/id_ed25519.pub",
  "db/credentials.json",
  "MyCredentials",
  "tls/server.pem",
  "tls/server.KEY",
  "tls/client.p12",
  "tls/client.pfx",
  "tls/ca.crt",
  "android.keystore",
  "prod.tfvars",
];
for (const p of secret) check(isSecretPath(p) === true, `비밀로 본다 ${p}`);

const plain = [
  "src/index.ts",
  "notes/environment.md",
  "foo.env",
  "notgit/config",
  "readme.md",
  "",
];
for (const p of plain) check(isSecretPath(p) === false, `비밀이 아니다 ${p === "" ? "(빈 문자열)" : p}`);
check(isSecretPath(123 as unknown as string) === false, "문자열이 아니면 비밀이 아니다");

// 윈도우 경로
for (const p of ["C:\\p\\.env", "C:\\Users\\x\\.ssh\\id_rsa", "C:\\p\\.git\\config", "D:\\p\\.ssh\\known_hosts", "C:\\p\\server.key"]) check(isSecretPath(p), `윈도우 경로는 비밀이다 ${p}`);
for (const p of ["C:\\p\\src\\main.ts", "C:\\p\\env.txt"]) check(isSecretPath(p) === false, `윈도우 일반 경로는 비밀이 아니다 ${p}`);
// 명령 문자열 토큰: 드라이브 문자는 안 쪼개고, 그 밖의 콜론은 기존대로 자른다
check(JSON.stringify(commandTokens("cat C:\\p\\.env")) === JSON.stringify(["cat", "C:\\p\\.env"]), "드라이브 문자 경로가 한 토큰이다");
check(JSON.stringify(commandTokens("a=/x:/y/.env")) === JSON.stringify(["a", "/x", "/y/.env"]), "맥 PATH형 콜론은 기존대로 자른다");
check(commandTokens("cat C:\\p\\.env").some(isSecretPath), "명령 `cat C:\\p\\.env`는 비밀을 건드린다");
check(commandTokens("cat 'C:/p/.env'").some(isSecretPath), "슬래시 드라이브 경로도 비밀이다");
check(commandTokens("echo hi").some(isSecretPath) === false, "일반 명령은 비밀이 아니다");

console.log(`\n${fail === 0 ? "✅" : "❌"} secret_paths: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
