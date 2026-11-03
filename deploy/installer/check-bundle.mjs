// 설치 묶음에 비밀·운영 데이터가 섞였는지 검사한다. 사용: node check-bundle.mjs <묶음 폴더> [--env <.env 경로>] [--no-secret-compare]
// 발견하면 경로와 사유만 찍고 코드 1로 끝난다. 비밀 값 자체는 어디에도 찍지 않는다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = process.argv[2];
if (!root || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error("사용: check-bundle.mjs <묶음 폴더> [--env <.env 경로>] [--no-secret-compare]");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const flagValue = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
// 대조할 .env: --env, 없으면 AETHER_BUILD_ENV, 없으면 저장소 server/.env.
const envFile = flagValue("--env") ?? process.env.AETHER_BUILD_ENV ?? path.join(here, "..", "..", "server", ".env");
const noCompare = process.argv.includes("--no-secret-compare");

// 비밀이 아닌 것이 확실한 키만 대조에서 뺀다(공개 키, 포트·경로·모드 같은 설정). 나머지는 모든 값을 대조한다.
// 8자 미만과 흔한 값(true/false/숫자)은 코드와 겹쳐 오탐이 나므로 뺀다.
const NON_SECRET_KEY = /(_PUBLIC|_PORT|_HOST|_MODE|_DIR|_ROOT|_PATH|_BIN|_ENABLED?|_ENABLE_\w+|_MS|_SEC)$|^(NODE_ENV|PORT|HOME|PATH|USER|LANG|TZ)$/i;
const COMMON_VALUE = /^(true|false|yes|no|on|off|null|none|production|development|localhost|\d+)$/i;
const secrets = []; // { key, buf }
if (noCompare) {
  console.warn("경고: --no-secret-compare — 저장소 .env 값과의 대조를 건너뜁니다. 비밀이 묶음에 섞였는지 확인되지 않았습니다.");
} else if (!fs.existsSync(envFile)) {
  console.error(`비밀 값을 대조할 .env를 찾지 못했습니다(${envFile}). AETHER_BUILD_ENV로 경로를 지정하거나, 대조를 생략하려면 --no-secret-compare를 명시하세요.`);
  process.exit(1);
} else {
  const parsed = parseEnv(fs.readFileSync(envFile, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (!NON_SECRET_KEY.test(key) && value.length >= 8 && !COMMON_VALUE.test(value)) secrets.push({ key, buf: Buffer.from(value) });
  }
}

const problems = [];
const bad = (rel, why) => problems.push(`${rel}: ${why}`);
const realRoot = fs.realpathSync(root);

// node_modules 안에는 test·data·logs 폴더와 인증서 파일이 정상으로 있으므로 그 이름들은 밖에서만 본다.
// 비밀 파일 이름(.env, auth-password.json, sqlite)은 어디서든 금지다.
function walk(dir, rel, inModules) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    const n = ent.name.toLowerCase();
    if (n === ".env" || n.startsWith(".env.") || n.endsWith(".env")) bad(r, "환경 파일");
    if (n === "auth-password.json") bad(r, "저장된 비밀번호 파일");
    if (/\.(sqlite|sqlite3|db)(-[a-z0-9]+)?$/.test(n)) bad(r, "데이터베이스 파일");
    if (!inModules && (n === ".npmrc" || n.endsWith(".pem") || n.endsWith(".key"))) bad(r, "인증 정보 파일");
    if (ent.isSymbolicLink()) {
      // 묶음 밖을 가리키는 링크는 설치본에 개인 파일을 끌어들일 수 있다.
      let target;
      try { target = fs.realpathSync(full); } catch { target = null; }
      if (target === null || !(target === realRoot || target.startsWith(realRoot + path.sep))) bad(r, "묶음 밖을 가리키는 링크");
    } else if (ent.isDirectory()) {
      if (!inModules && ["data", "test", "spikes", "logs"].includes(n)) bad(r, "운영 데이터·시험·로그 폴더");
      walk(full, r, inModules || n === "node_modules");
    } else if (ent.isFile() && secrets.length) {
      const buf = fs.readFileSync(full);
      for (const s of secrets) if (buf.includes(s.buf)) bad(r, `${s.key} 값과 같은 문자열`);
    }
  }
}
walk(root, "", false);

if (problems.length) {
  console.error(`묶음 검사 실패(${problems.length}건):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`묶음 검사 통과(${noCompare ? "비밀 값 대조 생략" : `비밀 값 ${secrets.length}개 대조`})`);
