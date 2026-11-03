#!/usr/bin/env node
// 커밋과 push에 비밀값, 개인정보가 섞였는지 검사한다. 걸린 값은 어디에도 출력하지 않는다(위치와 규칙 이름만).
// 사용: --staged | --message <파일> | --pre-push <remote> (표준 입력은 git pre-push 형식) | --range <git log 인자...>
// 개인 고유값(이메일, 이름, 망 주소)은 공개 저장소에 적을 수 없으므로 추적되지 않는 <git 공통 폴더>/secret-scan-literals.txt에 한 줄씩 둔다.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
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
  ["주소 안의 비밀번호", /[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s:/@'"`$<{]{3,}@(?!localhost\b|127\.0\.0\.1\b|\[::1\]|example\.)[a-z0-9]/i],
  ["비밀값 대입", /\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[\w-]*["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i, (m) => !PLACEHOLDER.test(m[0]) && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1])],
  ["주민등록번호", /\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])-[1-4]\d{6}\b/],
  ["전화번호", /\b01[016789][- .]\d{3,4}[- .]\d{4}\b/],
  ["카드번호", /\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/],
  ["이메일", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/, (m) => !/^(?:noreply|no-reply|git)@|@(?:[\w-]+\.)*(?:example(?:\.(?:com|org|net))?|test|invalid|local|localhost|anthropic\.com|users\.noreply\.github\.com)$|\.(?:png|jpe?g|gif|svg|webp|ico|pdf|ts|tsx|mts|js|jsx|mjs|cjs|json|md|css|html?|dart|py|sh|rs|ya?ml|toml|txt|lock|map)$/i.test(m[0])],
];
const BAD_FILE = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials\.json|auth\.json|[^/]+\.(?:pem|p12|pfx|key|keystore|jks|sqlite3?|sqlite-wal|sqlite-shm|db))$|^server\/data\//;

// .env의 비밀 항목 값과 개인 고유값은 그대로 찾는다. 짧은 값은 오탐이 많아 뺀다.
const literals = [["내 컴퓨터 경로", os.homedir()]].filter(([, v]) => v.split("/").length > 2);
try {
  for (const l of fs.readFileSync(path.join(commonDir, "secret-scan-literals.txt"), "utf8").split(/\r?\n/)) if (l.trim().length >= 4) literals.push(["개인 고유값", l.trim()]);
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

// git diff/log -p -U0 출력에서 추가된 줄만 본다. 지운 줄과 앞뒤 문맥은 올라가는 새 내용이 아니다.
async function scanPatch(args) {
  const child = spawn("git", ["-c", "core.quotepath=off", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((r) => child.on("close", r));
  let commit = "", file = null, n = 0, combined = false, inMsg = false;
  const at = () => (commit ? `${commit.slice(0, 8)} ` : "");
  for await (const line of readline.createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (line.startsWith("\0C")) { commit = line.slice(2); inMsg = true; file = null; continue; }
    if (line.startsWith("\0E")) { inMsg = false; continue; }
    if (inMsg) { scanLine(line, `${at()}커밋 메시지`); continue; }
    if (line.startsWith("diff --")) { combined = !line.startsWith("diff --git"); file = null; continue; }
    const bin = /^Binary files .* and b\/(.*) differ$/.exec(line);
    if (bin && BAD_FILE.test(bin[1])) hit("올리면 안 되는 파일", `${at()}${bin[1]}`, bin[1]);
    if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? null : line.slice(6);
      if (file && BAD_FILE.test(file)) hit("올리면 안 되는 파일", `${at()}${file}`, file);
      continue;
    }
    const hunk = /^@@+ .*\+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { n = Number(hunk[1]); continue; }
    if (!file) continue;
    const added = combined ? /^[ +]{2}/.test(line) && line.slice(0, 2).includes("+") : line.startsWith("+");
    if (added) { scanLine(line.slice(combined ? 2 : 1), `${at()}${file}:${n}`, file); n++; }
  }
  if ((await exited) !== 0) throw new Error(`git 실행 실패: ${err.trim().slice(0, 300)}`);
}

const LOG = ["log", "-p", "-U0", "-c", "--format=%x00C%H%n%B%n%x00E"];
const [mode, ...rest] = process.argv.slice(2);
if (mode === "--staged") {
  await scanPatch(["diff", "--cached", "-U0", "--no-color"]);
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
  console.error("해당 내용을 지우거나 환경변수로 옮기세요. 이미 커밋된 경우 커밋을 고쳐야 합니다.");
  console.error("오탐이라고 판단되면 사용자에게 확인받은 뒤에만 scripts/secret-scan-allow.txt에 추가하세요. 진짜 값이었다면 그 값을 폐기하세요.\n");
  process.exit(1);
}
