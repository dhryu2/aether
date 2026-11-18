#!/usr/bin/env node
// 커밋과 push에 비밀값, 개인정보가 섞였는지 검사한다. 걸린 값은 어디에도 출력하지 않는다(위치와 규칙 이름만).
// 사용: --staged | --message <파일> | --pre-push <remote> (표준 입력은 git pre-push 형식) | --range <git log 인자...>
// 개인 고유값(이메일, 이름, 망 주소)은 공개 저장소에 적을 수 없으므로 추적되지 않는 <git 공통 폴더>/secret-scan-literals.txt에 한 줄씩 둔다.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const git = (...a) => spawnSync("git", a, { encoding: "utf8", maxBuffer: 1 << 26 });
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const commonDir = path.resolve(git("rev-parse", "--git-common-dir").stdout.trim() || ".git");

const PLACEHOLDER = /process\.env|example|changeme|change-me|placeholder|dummy|fake|sample|redacted|your[-_]|xxx|\*\*\*|\$\{|<[a-z]|test|mock/i;
const RULES = [
  ["개인키", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS 키", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub 토큰", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["Anthropic 키", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI 키", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ["xAI 키", /\bxai-[A-Za-z0-9]{32,}/],
  ["Google 키", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack 토큰", /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/],
  ["npm 토큰", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["Tailscale 키", /\btskey-[A-Za-z0-9-]{10,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["주소 안의 비밀번호", /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s:/@'"`$<{]{3,}@(?!localhost\b|127\.0\.0\.1\b|\[::1\]|example\.)[a-z0-9]/i],
  ["비밀값 대입", /\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[\w-]*["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i, (m) => !PLACEHOLDER.test(m[0]) && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1])],
  ["주민등록번호", /\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-[1-4]\d{6}\b/],
  ["전화번호", /\b01[016789][- .]\d{3,4}[- .]\d{4}\b/],
  ["카드번호", /\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/],
  ["Tailscale 주소", /\btail[0-9a-f]{4,}\.ts\.net\b/i],
  ["Tailscale IP", /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  ["사설 IP", /\b(?:192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b|\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ["외장 디스크 경로", /(?<!\/System)\/Volumes\/[A-Za-z0-9_.-]+/, (m) => !/\/Volumes\/(?:Disk1|\.\.\.)/.test(m[0])],
  ["내 컴퓨터 경로", /(?<![\w:])\/Users\/([A-Za-z0-9_.-]+)/, (m) => !/^(?:me|meow|x|u|kim|user|you|name|foo|example|\.\.\.)$/.test(m[1])],
  ["Apple 팀 ID", /DEVELOPMENT_TEAM\s*=\s*[A-Z0-9]{10}\b/],
  ["이메일", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/, (m) => !/^(?:noreply|no-reply|git)@|@(?:[\w-]+\.)*(?:example(?:\.(?:com|org|net))?|test|invalid|local|localhost|anthropic\.com|users\.noreply\.github\.com)$|\.(?:png|jpe?g|gif|svg|webp|ico|pdf|ts|tsx|mts|js|jsx|mjs|cjs|json|md|css|html?|dart|py|sh|rs|ya?ml|toml|txt|lock|map)$/i.test(m[0])],
];
const BAD_FILE = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials\.json|auth\.json|[^/]+\.(?:pem|p12|pfx|key|keystore|jks|sqlite3?|sqlite-wal|sqlite-shm|db))$|^server\/data\//;
// 공개하지 않는 경로. 강제로 추가해도 막는다.
const PRIVATE_PATH = /^(?:\.private(?:\/|$)|docs\/|CLAUDE\.md$|AGENTS\.md$|HANDOFF\.md$|SPEC\.md$|PRODUCT\.md$|PHASE0_RESULTS\.md$|mobile\/|server\/spikes\/|\.claude\/(?:agents|skills)(?:\/|$)|\.grok(?:\/|$)|\.graphifyignore$|deploy\/dev-postgres\/|deploy\/notify\.sh$|graphify-out\/)/;
// 새 파일은 정한 자리에만 둔다. 문서와 루트 항목을 늘리려면 여기를 고쳐 이유를 남긴다.
// README.en.md: 저장소 첫 화면에서 바로 찾도록 영어 README를 맨 위에 둔다(2026-11-03 사용자 결정).
const ROOT_ENTRIES = new Set([".claude", ".githooks", ".gitignore", "BRAND.md", "LICENSE", "NOTICE", "README.md", "README.en.md", "deploy", "desktop", "e2e", "manager", "scripts", "server", "shared", "web"]);
const PUBLIC_MD = /(?:^|\/)README\.md$|^README\.en\.md$|^BRAND\.md$|^deploy\/site\/notes\/[^/]+\.md$|^server\/codex\/protocol\//;
const NOREPLY = /@users\.noreply\.github\.com$/i;

// .env의 비밀 항목 값과 개인 고유값은 그대로 찾는다. 짧은 값은 오탐이 많아 뺀다.
const literals = [["내 컴퓨터 경로", os.homedir()]].filter(([, v]) => v.split("/").length > 2);
const LITERALS_FILE = path.join(commonDir, "secret-scan-literals.txt");
if (!fs.existsSync(LITERALS_FILE)) {
  console.error(`개인 고유값 목록이 없어 검사를 할 수 없습니다: ${LITERALS_FILE}\n.private/secret-scan-literals.txt를 이 위치로 복사하세요.`);
  process.exit(1);
}
try {
  for (const l of fs.readFileSync(LITERALS_FILE, "utf8").split(/\r?\n/)) if (l.trim().length >= 4) literals.push(["개인 고유값", l.trim()]);
} catch {}
try {
  for (const l of fs.readFileSync(path.join(path.dirname(commonDir), "server/.env"), "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*["']?(.*?)["']?\s*$/.exec(l);
    if (m && /SECRET|PASSWORD|PRIVATE|HASH|TOKEN|API_?KEY/i.test(m[1]) && m[2].length >= 8) literals.push([`.env 값(${m[1]})`, m[2]]);
  }
} catch {}

// 오탐 허용 목록: "규칙 이름<TAB>경로 정규식" 한 줄씩.
const allow = [];
try {
  for (const l of fs.readFileSync(path.join(SCRIPT_DIR, "secret-scan-allow.txt"), "utf8").split(/\r?\n/)) {
    if (!l.trim() || l.startsWith("#")) continue;
    const [rule, re] = l.split("\t");
    allow.push([rule, new RegExp(re)]);
  }
} catch {}
const allowed = (rule, file) => allow.some(([r, re]) => r === rule && re.test(file));

const findings = new Map();
function hit(rule, where, file) {
  if (file && allowed(rule, file)) return;
  findings.set(`${rule}\t${where}`, { rule, where });
}
function scanLine(text, where, file) {
  for (const [rule, re, ok] of RULES) {
    const m = re.exec(text);
    if (m && (!ok || ok(m))) hit(rule, where, file);
  }
  for (const [rule, v] of literals) if (text.includes(v)) hit(rule, where, file);
}

function checkPath(file, where) {
  if (BAD_FILE.test(file)) hit("올리면 안 되는 파일", where, file);
  if (PRIVATE_PATH.test(file)) hit("공개하지 않는 경로", where, file);
}
// 비어 있는 파일은 diff에 내용 줄이 없으므로 이름 목록으로 따로 본다.
function checkStagedPaths() {
  const names = (filter) => git("-c", "core.quotepath=off", "diff", "--cached", "--no-renames", "--name-only", `--diff-filter=${filter}`, "-z").stdout.split("\0").filter(Boolean);
  for (const f of names("ACMT")) checkPath(f, f);
  for (const f of names("A")) {
    if (!ROOT_ENTRIES.has(f.split("/")[0])) hit("허용되지 않은 새 파일", f, f);
    else if (/\.md$/i.test(f) && !PUBLIC_MD.test(f)) hit("허용되지 않은 새 문서", f, f);
  }
}
function checkAuthor() {
  for (const v of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const email = /<([^>]*)>/.exec(git("var", v).stdout)?.[1] ?? "";
    if (!NOREPLY.test(email)) hit("작성자 메일", v === "GIT_AUTHOR_IDENT" ? "커밋 작성자" : "커밋한 사람");
  }
}

// 입력 줄은 \n으로만 나눈다. 맨 CR, U+2028, U+2029는 줄 끝이 아니라 내용이다(readline은 이 글자들에서도 줄을 나눈다).
async function* splitLines(stream) {
  stream.setEncoding("utf8");
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf) yield buf;
}

// git diff/log -p -U0 출력에서 추가된 줄만 본다. 지운 줄과 앞뒤 문맥은 올라가는 새 내용이 아니다.
// 내용 줄은 hunk 머리글이 알려 준 줄 수만큼 세어 읽는다. 내용이 `++ x`나 `diff --`처럼 생겨도 머리글로 읽지 않는다.
async function scanPatch(args) {
  const child = spawn("git", ["-c", "core.quotepath=off", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((r) => child.on("close", r));
  let commit = "", file = null, n = 0, inMsg = false, hunk = null, headers = 0, outside = 0;
  const at = () => (commit ? `${commit.slice(0, 8)} ` : "");
  for await (const line of splitLines(child.stdout)) {
    if (hunk && " +-\\".includes(line[0] ?? "\0")) {
      if (line[0] === "\\") continue; // "\ No newline at end of file"
      const mark = line.slice(0, hunk.old.length);
      const removed = mark.includes("-");
      if (!removed) { hunk.neu--; n++; }
      for (let k = 0; k < hunk.old.length; k++) if (removed ? mark[k] === "-" : mark[k] === " ") hunk.old[k]--;
      if (file && !removed && mark.includes("+")) scanLine(line.slice(hunk.old.length), `${at()}${file}:${n - 1}`, file);
      if (hunk.neu <= 0 && hunk.old.every((c) => c <= 0)) hunk = null;
      continue;
    }
    hunk = null; // 줄 수를 채우기 전에 다른 줄이 오면 머리글 판정으로 되돌린다
    if (line.startsWith("\0C")) {
      const [hash, author = ""] = line.slice(2).split(" ");
      commit = hash; inMsg = true; file = null;
      if (!NOREPLY.test(author)) hit("작성자 메일", `${commit.slice(0, 8)} 작성자`);
      continue;
    }
    if (line.startsWith("\0E")) { inMsg = false; continue; }
    if (inMsg) { scanLine(line, `${at()}커밋 메시지`); continue; }
    if (line.startsWith("diff --")) { headers++; file = null; continue; }
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.slice(6);
      if (file) checkPath(file, `${at()}${file}`);
      continue;
    }
    const h = /^@@+ ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      n = Number(h[2]);
      hunk = { old: h[1].trim().split(" ").map((o) => Number(o.split(",")[1] ?? 1)), neu: Number(h[3] ?? 1) };
      if (hunk.neu <= 0 && hunk.old.every((c) => c <= 0)) hunk = null;
      continue;
    }
    if (line.trim()) outside++;
  }
  if ((await exited) !== 0) throw new Error(`git 실행 실패: ${err.trim().slice(0, 300)}`);
  // 머리글을 하나도 못 읽었는데 읽을 수 없는 출력이 있으면 git 설정이 출력 모양을 바꾼 것이다. 조용히 통과시키지 않는다.
  if (!headers && outside) throw new Error("git 출력 형식을 읽지 못했습니다");
}

// 출력 모양을 사용자 설정(색, 접두어, 이름 변경 감지, 외부 비교기, 변환기)과 서명 표시에 맡기지 않는다.
// --text는 `-diff` 속성이나 NUL 한 글자로 이진 취급되어 내용이 빠지는 것을 막는다.
// shortcut: --text는 병합 커밋(-c)에 듣지 않는다. NUL이 든 병합은 내용을 못 읽는다. 병합에 키를 숨기는 경우가 실제로 보이면 병합도 -m으로 펼친다.
const FORMAT = ["--no-color", "--no-renames", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--text"];
const LOG = ["log", "-p", "-U0", "-c", "--no-show-signature", ...FORMAT, "--format=%x00C%H %ae%n%B%n%x00E"];
const [mode, ...rest] = process.argv.slice(2);
if (mode === "--staged") {
  checkStagedPaths();
  checkAuthor();
  await scanPatch(["diff", "--cached", "-U0", ...FORMAT]);
} else if (mode === "--message") {
  // 주석 줄은 git이 지우므로 커밋 메시지에 들어가지 않는다.
  for (const l of fs.readFileSync(rest[0], "utf8").split(/\r?\n/)) if (!l.startsWith("#")) scanLine(l, "커밋 메시지");
} else if (mode === "--range") {
  await scanPatch([...LOG, ...rest]);
} else if (mode === "--pre-push") {
  const ZERO = /^0+$/;
  for (const l of fs.readFileSync(0, "utf8").split("\n")) {
    const [, localSha, , remoteSha] = l.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // 브랜치 삭제
    const known = remoteSha && !ZERO.test(remoteSha) && git("cat-file", "-e", `${remoteSha}^{commit}`).status === 0;
    await scanPatch([...LOG, localSha, ...(known ? [`^${remoteSha}`] : ["--not", `--remotes=${rest[0] ?? "origin"}`])]);
  }
} else {
  console.error("사용법: secret-scan.mjs --staged | --message <파일> | --pre-push <remote> | --range <git log 인자...>");
  process.exit(2);
}

if (findings.size) {
  console.error(`\n비밀값 또는 개인정보가 ${findings.size}건 발견되어 막았습니다. 값은 표시하지 않습니다.`);
  const list = [...findings.values()];
  for (const f of list.slice(0, 40)) console.error(`  [${f.rule}] ${f.where}`);
  if (list.length > 40) console.error(`  그 밖에 ${list.length - 40}건`);
  console.error("공개할 이유가 없는 파일은 .private/로 옮기고, 그 자리에 있어야 하면 .gitignore에 넣으세요. 값은 지우거나 예시 값으로 바꾸세요.");
  console.error("작성자 메일은 git config user.email로 GitHub noreply 주소를 쓰세요.");
  console.error("이미 커밋된 경우 커밋을 고쳐야 합니다.");
  console.error("해당 내용을 지우거나 환경변수로 옮기세요. 이미 커밋된 경우 커밋을 고쳐야 합니다.");
  console.error("오탐이라고 판단되면 사용자에게 확인받은 뒤에만 scripts/secret-scan-allow.txt에 추가하세요. 진짜 값이었다면 그 값을 폐기하세요.\n");
  process.exit(1);
}
