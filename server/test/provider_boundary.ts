/**
 * provider 경계 게이트 (Phase 8d/8d-1 · D3/D6/D2.6/D8.1/D12). 정적 검사 — 서버를 띄우지 않는다.
 *
 * 네 가지를 지킨다:
 *   ① Claude SDK(`@anthropic-ai/claude-agent-sdk`)의 *런타임* import는 허용 목록 안에서만.
 *      타입 전용 import(`import type …`)는 어디서나 허용 — 값이 딸려오지 않아 실행 결합이 아니다.
 *      지식툴 정의(D8.1)는 이 목록 밖이어야 한다 — 안 그러면 스키마·권한 규칙이 두 벌로 갈라진다.
 *   ② provider 원본 이벤트 모양(`kind === "sdk"`·`msg.type`) 검사는 codec·normalize·provider 구현 안에서만(D2.6).
 *      import는 안 해도 값·모양으로 Claude를 전제하면 같은 결합이다 — 8d-1이 남긴 잔여는 명시 목록으로 고정.
 *   ③ 이어가기 식별자의 옛 이름(`sdkSessionId`)은 승격 지점에만(D12). 코어 로직은 새 이름만 안다.
 *   ④ Claude 보조 모델 구현(`providers/claude/distill`)은 Claude provider 폴더 밖에서 import 금지.
 *      한 곳이라도 직접 가져다 쓰면 다른 provider 세션이 조용히 Claude 모델로 새는 통로가 된다(§0.1-4).
 *
 * 검사 제외: 벤더링된 codex 프로토콜 타입, 실험용 spikes(프로덕션 경로 아님), 세션 데이터.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK = "@anthropic-ai/claude-agent-sdk";
const DISTILL_IMPL = "providers/claude/distill";

/** 검사 대상에서 빼는 디렉터리(서버 루트 기준 상대경로 접두). */
const SKIP_DIRS = ["node_modules", "codex/protocol", "spikes", "data"];

/** SDK 런타임 import가 허용되는 파일(서버 루트 기준 상대경로). */
const SDK_ALLOWED = new Set([
  // SDK 값은 부팅 때 싣지 않는다. 동적 import는 이 통로 한 곳에만 있고, 나머지 Claude 어댑터는
  //   `loadClaudeSdk()`로 받아 쓴다.
  "providers/claude/sdk.ts",
]);
const NODE_PTY = "node-pty";

/** 지식툴 정의·공통 소비처는 provider adapter가 아니다 — SDK가 새어들면 스키마가 두 벌로 갈라진다(D8.1). */
const KNOWLEDGE_NEUTRAL = ["knowledge/types.ts", "knowledge/tools.ts", "knowledge/todoTool.ts", "search/agentTool.ts"];

/**
 * provider 원본 이벤트 모양(`kind === "sdk"`·`msg.type`)을 검사해도 되는 곳.
 * provider 구현 자리 + 테스트(원본 fixture를 손으로 짜는 게 일이라 이 검사의 대상이 아니다).
 */
const RAW_SHAPE_IMPL_DIRS = ["sessions/codec", "sessions/normalize", "providers/claude", "providers/grok", "test"];
/** 유니온 태그 정의 자체(`RawProviderEventBody`)라 원본 모양이 나올 수밖에 없다. */
const RAW_SHAPE_IMPL_FILES = ["types.ts"];
/**
 * 원본 모양을 아직 읽어도 되는 공통 계층 잔여. 9b가 `routes/stream.ts` sliceTail을 정규화 사건으로
 * 바꿨으므로 지금은 비어 있다. 항목이 다시 생기면 실패해야 하므로 집합 자체는 남긴다.
 */
const RAW_SHAPE_RESIDUE = new Set<string>([]);

/**
 * Claude 프로토콜 용어가 코어 로직에 이름으로 남아 있지 않은지(8d-1 ⑤ · D12).
 * `sdkSessionId`는 읽기 호환 필드로만 살아 있어야 하고, 승격은 `persistence.loadMeta` 한 곳에서만 한다.
 */
const LEGACY_RESUME_FIELD = "sdkSessionId";
const LEGACY_RESUME_ALLOWED = new Set(["types.ts", "sessions/persistence.ts"]);

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  cond ? pass++ : fail++;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(SERVER_DIR, abs);
    if (SKIP_DIRS.some((s) => rel === s || rel.startsWith(s + path.sep))) continue;
    if (e.isDirectory()) walk(abs, out);
    else if (e.isFile() && abs.endsWith(".ts")) out.push(rel);
  }
  return out;
}

/** 소스의 정적·동적 import/export-from 구문 목록 → {specifier, typeOnly}. 여러 줄에 걸친 구문도 잡는다. */
function importsFromSource(src: string): { spec: string; typeOnly: boolean; dynamic: boolean }[] {
  const re = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
  const out: { spec: string; typeOnly: boolean; dynamic: boolean }[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ spec: m[3], typeOnly: !!m[1], dynamic: false });
  // 부수효과 import(`import "x"`)도 런타임 결합이다.
  const bare = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  for (let m = bare.exec(src); m; m = bare.exec(src)) out.push({ spec: m[1], typeOnly: false, dynamic: false });
  // `await import("x")`와 CommonJS require는 기존 정적 import 정규식으로는 보이지 않는다.
  // 둘 다 런타임 결합이므로 경계 검사 대상에 포함한다. (현재 서버에는 SDK의 type-query import가 없다.)
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = dynamic.exec(src); m; m = dynamic.exec(src)) out.push({ spec: m[1], typeOnly: false, dynamic: true });
  const requireCall = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = requireCall.exec(src); m; m = requireCall.exec(src)) out.push({ spec: m[1], typeOnly: false, dynamic: false });
  return out;
}

function importsOf(rel: string): { spec: string; typeOnly: boolean; dynamic: boolean }[] {
  return importsFromSource(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"));
}

const files = walk(SERVER_DIR);
check(files.length > 50, `스캔 대상 파일 ${files.length}개(서버 전체)`);

// 검사기가 정적 import만 보는 장식물이 되지 않도록 동적 import/require 우회를 직접 반증한다.
// 이 파일 자신이 SDK 문자열을 동적 import로 오인하지 않도록 문자열은 런타임에 조립한다.
const dynamicSdk = ["@anthropic-ai", "claude-agent-sdk"].join("/");
const dynamicDistill = ["providers", "claude", "distill"].join("/");
const dynamicImports = importsFromSource(`const a = await import("${dynamicSdk}"); const b = require("${dynamicDistill}");`);
check(
  dynamicImports.some((im) => im.spec === dynamicSdk && !im.typeOnly) && dynamicImports.some((im) => im.spec === dynamicDistill && !im.typeOnly),
  "동적 import/require 우회도 런타임 import로 감지",
);

// ── 1. SDK 런타임 import 경계 ──
const sdkOffenders: string[] = [];
const sdkRuntimeUsers: string[] = [];
for (const rel of files) {
  for (const im of importsOf(rel)) {
    if (im.spec !== SDK) continue;
    if (im.typeOnly) continue;
    sdkRuntimeUsers.push(rel);
    if (!SDK_ALLOWED.has(rel)) sdkOffenders.push(rel);
  }
}
check(sdkOffenders.length === 0, `SDK 런타임 import는 허용 목록 안에서만 (위반: ${sdkOffenders.join(", ") || "없음"})`);
check(sdkRuntimeUsers.includes("providers/claude/sdk.ts"), "sdk.ts가 실제로 SDK를 불러온다(검사기가 헛돌지 않음)");
// 나머지 Claude 어댑터는 SDK 값을 직접 가져오지 않고 sdk.ts의 `loadClaudeSdk`로 받는다.
for (const rel of ["sessions/runtimes/claude.ts", "providers/claude/distill.ts"]) {
  const src = stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"));
  check(/\bloadClaudeSdk\b/.test(src) && /import\s*\{[^}]*\bloadClaudeSdk\b[^}]*\}\s*from/.test(src), `${rel}는 loadClaudeSdk로 SDK를 받는다`);
}
check(!sdkRuntimeUsers.includes("sessions/LiveSession.ts"), "LiveSession은 SDK를 런타임 import하지 않는다");
check(!sdkRuntimeUsers.includes("sessions/SessionManager.ts"), "SessionManager는 SDK를 런타임 import하지 않는다");
// 8d-1 ③(D8.1): 지식툴 정의가 SDK에서 떨어졌는지 — adapter만 SDK를 알아야 스키마·권한 규칙이 한 벌로 유지된다.
const knowledgeOffenders = KNOWLEDGE_NEUTRAL.filter((rel) => sdkRuntimeUsers.includes(rel));
check(knowledgeOffenders.length === 0, `지식툴 정의·공통 소비처는 SDK 무의존 (위반: ${knowledgeOffenders.join(", ") || "없음"})`);
check(
  KNOWLEDGE_NEUTRAL.every((rel) => fs.existsSync(path.join(SERVER_DIR, rel))),
  "지식툴 중립 검사 대상이 전부 실재(경로 오타로 게이트 무력화 방지)",
);

// ── 1b. 부팅 경로는 SDK·node-pty를 정적으로 가져오지 않는다 ──
// SDK나 node-pty 모듈이 없는 PC에서도 서버가 떠야 하므로(어떤 LLM 구독이 없어도 부팅), 부팅 진입점에서
//   정적·비타입 import를 따라가 닿는 모든 파일에 두 모듈의 정적 값 import가 없어야 한다.
//   동적 import(`import(...)`)는 쓰는 순간에만 로드되므로 따라가지 않는다.
/** 상대 경로 specifier를 서버 루트 기준 파일로 푼다. 확장자가 없으면 `x.ts`, `x/index.ts` 순으로 찾는다. */
function resolveRelative(fromRel: string, spec: string): string | null {
  const base = path.normalize(path.join(path.dirname(fromRel), spec));
  for (const c of [base, base + ".ts", path.join(base, "index.ts")]) {
    if (c.endsWith(".ts") && files.includes(c)) return c;
  }
  return null;
}
/** 시작 파일들에서 정적(타입 전용·동적이 아닌) 상대 import를 따라가 닿는 파일 집합. */
function staticClosure(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const im of importsOf(rel)) {
      if (im.typeOnly || im.dynamic || !im.spec.startsWith(".")) continue;
      const next = resolveRelative(rel, im.spec);
      if (next) queue.push(next);
    }
  }
  return seen;
}
const bootClosure = staticClosure(["index.ts", "providers/registry.ts"]);
const eagerHeavy = [...bootClosure].filter((rel) => importsOf(rel).some((im) => !im.typeOnly && !im.dynamic && (im.spec === SDK || im.spec === NODE_PTY)));
check(eagerHeavy.length === 0, `부팅 경로는 SDK·node-pty를 정적으로 가져오지 않는다 (위반: ${eagerHeavy.join(", ") || "없음"})`);
// 따라가기가 헛돌지 않았는지 — 실제로 Claude 런타임과 로그인까지 닿아야 위 검사가 의미 있다.
check(
  bootClosure.has("sessions/runtimes/claude.ts") && bootClosure.has("auth/claudeLogin.ts") && bootClosure.has("providers/claude/sdk.ts"),
  "부팅 경로 추적이 Claude 런타임·로그인·sdk.ts까지 닿는다(검사기가 헛돌지 않음)",
);
// 검사기 자체 반증: 정적 import와 동적 import를 구분하고, 타입 전용은 걸러낸다.
const kinds = importsFromSource(`import pty from "${NODE_PTY}";\nconst m = await import("${NODE_PTY}");\nimport type { X } from "${NODE_PTY}";`);
check(
  kinds.length === 3 && kinds[0].dynamic === false && !kinds[0].typeOnly && kinds.some((k) => k.dynamic) && kinds.some((k) => k.typeOnly),
  "importsFromSource가 정적·동적·타입 전용 import를 구분",
);
// node-pty의 실행용 import는 auth/claudeLogin.ts의 동적 import 한 곳뿐이어야 한다.
const ptyUsers = files.filter((rel) => importsOf(rel).some((im) => im.spec === NODE_PTY && !im.typeOnly));
const ptyStatic = ptyUsers.filter((rel) => importsOf(rel).some((im) => im.spec === NODE_PTY && !im.typeOnly && !im.dynamic));
check(
  ptyUsers.length === 1 && ptyUsers[0] === "auth/claudeLogin.ts" && ptyStatic.length === 0,
  `node-pty 실행용 import는 auth/claudeLogin.ts의 동적 import뿐 (실행용: ${ptyUsers.join(", ") || "없음"}, 정적: ${ptyStatic.join(", ") || "없음"})`,
);

// ── 2. provider 원본 이벤트 모양 직접 검사 금지(D2.6 — 판정은 codec 안에서만) ──
/** 주석 속 문구가 위반으로 잡히지 않게 라인·블록 주석을 지운 뒤 검사한다. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const RAW_SHAPE_RE = /kind\s*[=!]==?\s*["']sdk["']|\bmsg\s*\??\s*\.\s*type\b/;
const rawShapeOffenders: string[] = [];
for (const rel of files) {
  if (RAW_SHAPE_IMPL_DIRS.some((d) => rel.startsWith(d + path.sep)) || RAW_SHAPE_IMPL_FILES.includes(rel)) continue;
  if (!RAW_SHAPE_RE.test(stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8")))) continue;
  if (!RAW_SHAPE_RESIDUE.has(rel)) rawShapeOffenders.push(rel);
}
check(rawShapeOffenders.length === 0, `provider 원본 모양 검사는 codec 안에서만 (새 위반: ${rawShapeOffenders.join(", ") || "없음"})`);
// 잔여 목록이 실제로 아직 위반 중인지 — 이미 해소된 항목이 목록에 남아 게이트가 헐거워지는 것 방지.
const staleResidue = [...RAW_SHAPE_RESIDUE].filter(
  (rel) => !fs.existsSync(path.join(SERVER_DIR, rel)) || !RAW_SHAPE_RE.test(stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"))),
);
check(staleResidue.length === 0, `잔여 목록에 이미 해소된 항목 없음 (지울 것: ${staleResidue.join(", ") || "없음"})`);

// ── 2b. Claude 도구 어휘(도구 이름·입력 인자 스키마)가 provider 밖으로 새지 않는가 ──
// 8d-2 신설. 여기가 앞의 raw-모양 검사와 다른 점: 타입도 import도 중립인데 **값**이 Claude를 전제하는 경우다.
// 예를 들어 `toolName === "Write"`로 분기하거나 `input.old_string`을 읽는 코드는, 다른 provider 세션에서
// 조용히 아무것도 안 하고 지나간다(에러도 테스트 실패도 없이 카드가 비거나 마스킹이 안 걸린다).
const CLAUDE_TOOL_VOCAB = /"(?:Bash|Write|Edit|MultiEdit|NotebookEdit|AskUserQuestion|TodoWrite)"|"(?:old_string|new_string|new_source|file_path|notebook_path)"/;
/**
 * 아직 Claude 어휘에 매여 있는 곳 — **전부 8e가 Codex 도구 스키마를 알게 될 때 계약으로 바꾼다.**
 * 지금 옮기면 상대편 스키마를 모른 채 추상화하게 되므로(YAGNI) 목록으로 고정만 해둔다.
 * 목록이 늘지 않는 것이 이 검사의 역할이다.
 */
const TOOL_VOCAB_RESIDUE = new Set([
  // 8e에서 둘이 빠졌다: 변경 미리보기 조립은 `providers/claude/mutationPreview.ts`로, 영속 전 인자 마스킹은
  //   각 provider의 영속 축소기로 옮겼다. 턴 종료·한도 알림은 AgentEvent로 옮겼고, 남은 것은 권한 알림의
  //   대상 추출뿐이다. 이 값은 provider별 승인 스키마를 알아야 하므로 후속 도구 계약 작업까지 여기 남는다.
  "notify/worthNotifying.ts", // 권한 알림 본문 대상 추출(command·file_path…) — 본체에서 옮김, 도구 계약 전까지 여기
]);
/**
 * 도구 어휘를 알아도 되는 곳 = provider adapter가 사는 디렉터리 + 테스트 fixture.
 * `sessions/runtimes`가 여기 있는 이유: 그 폴더가 곧 provider별 실행부다(Claude는 AskUserQuestion 우회를
 * 하느라 도구 이름을 안다). 8e의 `runtimes/codex.ts`도 같은 자격이다.
 * raw-모양 검사의 목록과 일부러 따로 둔다 — 그쪽을 넓히면 무관한 검사까지 헐거워진다.
 */
const TOOL_VOCAB_IMPL_DIRS = [...RAW_SHAPE_IMPL_DIRS, "sessions/runtimes"];
const toolVocabOffenders: string[] = [];
for (const rel of files) {
  if (TOOL_VOCAB_IMPL_DIRS.some((d) => rel.startsWith(d + path.sep))) continue; // provider 구현·테스트 fixture는 대상 아님
  if (!CLAUDE_TOOL_VOCAB.test(stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8")))) continue;
  if (!TOOL_VOCAB_RESIDUE.has(rel)) toolVocabOffenders.push(rel);
}
check(toolVocabOffenders.length === 0, `Claude 도구 어휘는 provider 안에서만 (새 위반: ${toolVocabOffenders.join(", ") || "없음"})`);
const staleToolVocab = [...TOOL_VOCAB_RESIDUE].filter(
  (rel) => !fs.existsSync(path.join(SERVER_DIR, rel)) || !CLAUDE_TOOL_VOCAB.test(stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"))),
);
check(staleToolVocab.length === 0, `도구 어휘 잔여 목록에 이미 해소된 항목 없음 (지울 것: ${staleToolVocab.join(", ") || "없음"})`);

// ── 2c. 테스트용 provider 등록 통로가 프로덕션에서 안 불리는가(8d-2 게이트 ③의 수단) ──
const TEST_REGISTER = "__registerProviderForTest";
const testRegisterCallers = files.filter(
  (rel) =>
    rel !== "providers/registry.ts" && // 정의 자리
    !rel.startsWith("test" + path.sep) &&
    stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8")).includes(TEST_REGISTER),
);
check(testRegisterCallers.length === 0, `테스트용 provider 등록은 test/ 안에서만 (위반: ${testRegisterCallers.join(", ") || "없음"})`);

// ── 3. 이어가기 식별자의 옛 이름이 코어에 남아 있지 않은가(D12) ──
const legacyResumeOffenders = files.filter(
  (rel) =>
    !rel.startsWith("test" + path.sep) && // 테스트는 구 meta fixture를 일부러 만든다
    !LEGACY_RESUME_ALLOWED.has(rel) &&
    stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8")).includes(LEGACY_RESUME_FIELD),
);
check(
  legacyResumeOffenders.length === 0,
  `이어가기 식별자 옛 이름은 승격 지점에만 (위반: ${legacyResumeOffenders.join(", ") || "없음"})`,
);
check(
  stripComments(fs.readFileSync(path.join(SERVER_DIR, "sessions/persistence.ts"), "utf8")).includes(LEGACY_RESUME_FIELD),
  "승격 지점(loadMeta)은 실제로 옛 이름을 읽는다(검사기가 헛돌지 않음)",
);

// ── 4. Claude distill 구현 직접 import 금지(D6) ──
const distillOffenders: string[] = [];
for (const rel of files) {
  if (rel.startsWith("providers/claude" + path.sep)) continue; // 구현 폴더 안은 당연히 허용
  if (rel === path.join("test", "claude_distill.ts")) continue; // 어댑터 자신의 시험(모델 호출 0) — 호출측이 아니다
  if (rel === path.join("test", "error_collection_adapters.ts")) continue; // 구조화 원인의 어댑터 시험(모델 호출 0)
  if (rel === path.join("test", "background_adapters.ts")) continue; // 네 어댑터의 옵션·목록 시험(모델 호출 0) — 호출측이 아니다
  for (const im of importsOf(rel)) {
    if (im.spec.includes(DISTILL_IMPL)) distillOffenders.push(`${rel} → ${im.spec}`);
  }
}
check(distillOffenders.length === 0, `Claude distill 구현 직접 import 0건 (위반: ${distillOffenders.join(", ") || "없음"})`);

// 보조 모델은 canUseTool 콜백 하나에 의존하면 안 된다. SDK는 settingSources가 생략되면 호스트 설정을
// 읽고, tools가 생략되면 안전 도구를 자체 승인할 수 있다.
const distillSource = stripComments(fs.readFileSync(path.join(SERVER_DIR, "providers/claude/distill.ts"), "utf8"));
check(/settingSources\s*:\s*\[\s*\]/.test(distillSource), "Claude distill은 설정 소스를 빈 목록으로 고정");
check(/tools\s*:\s*\[\s*\]/.test(distillSource), "Claude distill은 노출 도구를 빈 목록으로 고정");
check(/persistSession\s*:\s*false/.test(distillSource), "Claude distill은 보조 세션을 영속하지 않음");
// 위 셋만 검사하면 정작 도구 승인 콜백이 사라지거나 allow로 바뀌어도 초록불이 뜬다. 그 순간부터 보조 모델은
//   사용자 작업 폴더에서 승인 없이 파일을 읽고 쓰고 명령을 실행할 수 있다 — 게다가 이 모델의 입력은
//   사용자 대화 내용이라, 대화에 섞인 지시문이 그대로 실행되는 통로가 된다. 그래서 셋을 함께 검사한다.
check(/canUseTool\s*:/.test(distillSource), "Claude distill은 도구 승인 콜백을 반드시 둔다");
check(/behavior\s*:\s*"deny"/.test(distillSource), "Claude distill의 도구 승인 콜백은 항상 거부");
check(!/permissionMode\s*:\s*"bypassPermissions"/.test(distillSource), "Claude distill은 승인 우회 모드를 쓰지 않음");

// ── 4a. Claude SDK의 query 호출은 모두 설치본 CLI를 띄운다 ──
// SDK에 딸린 CLI는 낡아서 별칭이 옛 모델로 풀린다(haiku→Haiku 4.5). 2026-10-15까지 배경 작업이 실제로
//   그렇게 돌았다. 한 파일만 검사하면 새 호출 자리가 생길 때 다시 빠진다. 그래서 서버 코드 전체에서
//   SDK의 query를 가져오는 파일을 찾고, 그 이름의 호출 하나하나가 이 지정을 담는지 본다.
/** 소스에서 SDK `query`를 런타임으로 가져온 지역 이름들(`query as q`, `const { query: q } = await loadClaudeSdk()`도 잡는다). */
function sdkQueryNames(src: string): string[] {
  const names: string[] = [];
  // sdk.ts를 거쳐 받는 형태 — `const { query, tool } = await loadClaudeSdk();`
  const destructure = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+loadClaudeSdk\s*\(\s*\)/g;
  for (let m = destructure.exec(src); m; m = destructure.exec(src)) {
    for (const part of m[1].split(",")) {
      const mm = /^\s*query(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (mm) names.push(mm[1] ?? "query");
    }
  }
  const re = /import\s+(?!type\b)\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[2] !== SDK) continue;
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (p.startsWith("type ")) continue;
      const mm = /^query(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(p);
      if (mm) names.push(mm[1] ?? "query");
    }
  }
  return names;
}
/** `name(`로 시작하는 호출의 괄호 안 글을 모두 돌려준다(괄호 짝을 맞춘다). 타입 위치(`typeof name`)는 뺀다. */
function callBodies(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (/typeof\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}
function queryOffendersOf(src: string): number {
  let bad = 0;
  for (const name of sdkQueryNames(src)) {
    for (const body of callBodies(src, name)) {
      if (!/pathToClaudeCodeExecutable\s*:\s*resolveClaudeBin\(\)/.test(body)) bad++;
    }
  }
  return bad;
}
// 검사기 자체 반증: 지정이 빠진 호출과 별칭 import를 실제로 잡는가.
const sdkLit = JSON.stringify(SDK);
check(
  queryOffendersOf(`import { query as q } from ${sdkLit};\nconst h = q({ prompt: x, options: { cwd } });`) === 1 &&
    queryOffendersOf(`import { query } from ${sdkLit};\nconst h = query({ options: { pathToClaudeCodeExecutable: resolveClaudeBin() } });`) === 0,
  "query 호출 검사기가 지정 누락과 별칭 import를 감지",
);
// 구조 분해 형태도 같은 기준으로 본다: 지정이 빠지면 위반 1, 있으면 0이어야 하고 이름 바꾸기(`query: q`)도 잡아야 한다.
check(
  queryOffendersOf(`const { query } = await loadClaudeSdk();\nconst h = query({ options: { cwd } });`) === 1 &&
    queryOffendersOf(`const { query: q, tool } = await loadClaudeSdk();\nconst h = q({ options: { cwd } });`) === 1 &&
    queryOffendersOf(`const { query } = await loadClaudeSdk();\nconst h = query({ options: { pathToClaudeCodeExecutable: resolveClaudeBin() } });`) === 0,
  "query 호출 검사기가 loadClaudeSdk 구조 분해 형태의 지정 누락을 감지",
);
const querySites: string[] = [];
const queryOffenders: string[] = [];
for (const rel of files) {
  if (rel === "test" || rel.startsWith("test" + path.sep)) continue;
  const src = stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"));
  if (!sdkQueryNames(src).length) continue;
  querySites.push(rel);
  if (queryOffendersOf(src) > 0) queryOffenders.push(rel);
}
check(
  querySites.includes("sessions/runtimes/claude.ts") && querySites.includes("providers/claude/distill.ts"),
  `query 호출 자리를 실제로 찾는다(검사기가 헛돌지 않음): ${querySites.join(", ")}`,
);
check(queryOffenders.length === 0, `Claude SDK query 호출은 모두 설치본 CLI를 띄운다 (위반: ${queryOffenders.join(", ") || "없음"})`);

// ── 4b. 모델 프로세스를 띄우는 자리는 환경을 걸러서 넘긴다(R21) ──
// 서버는 `.env`를 읽고 뜨므로 로그인 서명키·비밀번호 해시·푸시 개인키가 프로세스 환경에 있다. 그 환경이
//   자식에게 통째로 상속되면 모델이 읽기 명령 하나로 볼 수 있고, 그 출력은 경로 기반 가리기에 안 걸린다.
//   값이 실제로 빠지는지는 `test/model_env.ts`가 보고, 여기서는 **자리를 빠뜨리지 않았는지**를 고정한다.
// ⚠️ 이 목록은 **자동으로 발견한 것과 대조한다**(바로 아래). 손으로만 적어 두면 새 자리가 생겼을 때
//    아무도 안 고치고, 실제로 2026-08-18 외부 검토에서 `providers/claude/distill.ts`가 빠져 있었다.
const MODEL_SPAWN_SITES = [
  "sessions/runtimes/claude.ts", // query() options.env
  "providers/claude/distill.ts", // Claude 배경 작업(query) — 8f 외부 검토에서 누락 발견
  "sessions/runtimes/codex.ts", // 세션당 app-server 프로세스
  "providers/codex/distill.ts", // 배경 작업 격리 실행
  "codex/control.ts", // 인증 전용 프로세스
  "auth/claudeLogin.ts", // PTY 로그인·상태 조회
  "sessions/runtimes/grok.ts", // 세션당 grok agent stdio
  "providers/grok/distill.ts", // 배경 작업 grok -p
  "providers/grok/control.ts", // 인증 전용 로그인 프로세스
  "providers/grok/env.ts", // spawnGrokCli — 로그인·배경 작업 spawn 한곳
];
const envOffenders = MODEL_SPAWN_SITES.filter((rel) => {
  const src = stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"));
  return !/\bmodelEnv\s*\(/.test(src) && !/\bgrokChildEnv\s*\(/.test(src) && !/\bspawnGrokCli\s*\(/.test(src);
});
check(envOffenders.length === 0, `자식 프로세스를 띄우는 자리가 전부 환경을 걸러서 넘긴다 (빠진 곳: ${envOffenders.join(", ") || "없음"})`);
// 목록이 실재하는 파일을 가리키는지(이름이 바뀌면 게이트가 조용히 헐거워진다).
const missingSpawnSites = MODEL_SPAWN_SITES.filter((rel) => !fs.existsSync(path.join(SERVER_DIR, rel)));
check(missingSpawnSites.length === 0, `자식 프로세스 목록의 경로가 전부 실재 (없음: ${missingSpawnSites.join(", ") || "-"})`);
// ★ 손으로 적은 목록을 **자동 발견 결과와 대조한다.** 모델을 띄우는 구문을 저장소에서 직접 찾아, 목록에
//   없는 파일이 나오면 실패한다. 이게 없으면 새 자리가 생겼을 때 목록을 안 고쳐도 초록불이 뜬다.
const SPAWN_SYNTAX = /\bquery\s*\(\s*\{|\bnew\s+CodexAppServer\s*\(|\bnew\s+GrokStdio\s*\(|\bpty\s*\.\s*spawn\s*\(|\bspawnGrokCli\s*\(/;
//   `codex/appServer.ts`는 통신선 자체라 목록에 없다 — 여기선 `env` 기본값이 걸러진 환경인지를 따로 본다.
//   테스트·스파이크는 프로덕션 경로가 아니므로 제외한다(가짜 서버를 띄우는 자리가 여럿 있다).
const discovered = files.filter(
  (rel) =>
    rel !== "codex/appServer.ts" &&
    !rel.startsWith("test" + path.sep) &&
    !rel.startsWith("spikes" + path.sep) &&
    SPAWN_SYNTAX.test(stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"))),
);
const unlisted = discovered.filter((rel) => !MODEL_SPAWN_SITES.includes(rel));
check(unlisted.length === 0, `모델을 띄우는 구문이 전부 위 목록에 있다 (목록에 없는 곳: ${unlisted.join(", ") || "없음"})`);
// 통신선의 기본값도 걸러진 환경이어야 한다 — 새 호출자가 env를 잊었을 때 안전한 쪽으로 떨어지게.
const appServerSource = stripComments(fs.readFileSync(path.join(SERVER_DIR, "codex/appServer.ts"), "utf8"));
check(/env\s*:\s*opts\.env\s*\?\?\s*modelEnv\s*\(\)/.test(appServerSource), "app-server spawn의 env 기본값이 걸러진 환경이다(잊어도 비밀이 안 샌다)");
const grokStdioSource = stripComments(fs.readFileSync(path.join(SERVER_DIR, "providers/grok/transport.ts"), "utf8"));
check(/env\s*:\s*opts\.env\s*\?\?\s*modelEnv\s*\(\)/.test(grokStdioSource), "grok stdio spawn의 env 기본값이 걸러진 환경이다(잊어도 비밀이 안 샌다)");

// ── 4a-2. 질문 카드를 켜는 스위치와 codex 버전 핀(D5.4 · 위험 R1/R14 · 8g) ──
// 질문 카드는 개발 중 표시가 붙은 기능 위에 서 있다. 우리가 매번 켜는 설정 문자열과, 그 문자열이
//   통하는 것으로 확인된 CLI 버전을 함께 고정한다. 버전이 올라가면 이 검사가 먼저 실패해서
//   "카드가 조용히 안 뜨는" 상태로 넘어가지 않는다.
const { SESSION_CONFIG_OVERRIDES } = await import("../sessions/runtimes/codex");
check(
  SESSION_CONFIG_OVERRIDES.includes("tools.experimental_request_user_input.enabled=true") &&
    SESSION_CONFIG_OVERRIDES.includes("features.default_mode_request_user_input=true"),
  `질문 카드를 켜는 설정 두 개를 세션 프로세스에 못 박는다 (${SESSION_CONFIG_OVERRIDES.join(" · ")})`,
);
const pinnedVersion = (fs.readFileSync(path.join(SERVER_DIR, "codex/protocol/VERSION.md"), "utf8").match(/codex-cli\s+([0-9.]+)/) ?? [])[1] ?? "";
check(!!pinnedVersion, `프로토콜 타입에 적힌 codex 버전 핀을 읽었다 (${pinnedVersion || "못 읽음"})`);
let installedVersion = "";
try {
  installedVersion = (execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 20_000 }).match(/([0-9]+\.[0-9]+\.[0-9]+)/) ?? [])[1] ?? "";
} catch {
  /* codex 미설치 환경 — 아래에서 건너뛴다 */
}
if (!installedVersion) {
  console.log("  ⏭️  codex CLI가 없어 버전 핀 대조를 건너뛴다(설치된 환경에서는 반드시 대조한다)");
} else {
  check(
    installedVersion === pinnedVersion,
    `설치된 codex 버전이 핀과 같다 (설치=${installedVersion} 핀=${pinnedVersion}) — 다르면 프로토콜·질문 카드 기능이 조용히 달라질 수 있으므로 타입 재생성과 실측이 먼저다`,
  );
}

// ── 4a-1. 프로덕션이 넘기는 Codex 기능 이름은 공식 목록에만 있다(8i) ──
// Codex는 존재하지 않는 `features.<이름>=…` 설정도 오류 없이 무시한다. 따라서 이름 하나를 잘못
// 쓰면 보안상 꺼야 할 기능이 실제로는 켜진 채 남는다. 모든 설정을 손으로 적어 두면 새 실행 자리를
// 추가할 때 다시 빠질 수 있으므로, 테스트·스파이크를 뺀 서버 TypeScript 전체에서 직접 찾는다.
const FEATURE_SETTING = /\bfeatures\.([^\s=]+)\s*=/g;
const productionFiles = files.filter((rel) => !rel.startsWith("test" + path.sep));
const configuredFeatures: { name: string; rel: string }[] = [];
for (const rel of productionFiles) {
  const source = stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"));
  for (const match of source.matchAll(FEATURE_SETTING)) configuredFeatures.push({ name: match[1], rel });
}
check(
  configuredFeatures.length > 0,
  "프로덕션에서 Codex 기능 설정을 자동으로 찾았다(설정이 전부 사라져 검사가 헛돌지 않음)",
);

let officialFeatures: Set<string> | undefined;
try {
  const listed = execFileSync("codex", ["features", "list"], { encoding: "utf8", timeout: 20_000 });
  // 공식 목록은 `이름 상태 기본값` 세 열이다. 첫 열만 취해 이름 집합을 만든다.
  officialFeatures = new Set(
    listed
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => /^[a-z][a-z0-9_]*$/.test(name)),
  );
  check(officialFeatures.size > 0, `codex features list에서 공식 기능 이름 ${officialFeatures.size}개를 읽었다`);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.log(`  ⏭️  codex features list를 실행할 수 없어 기능 이름 대조를 건너뛴다(검사 못 함: ${reason})`);
}
if (officialFeatures) {
  const unknownFeatures = configuredFeatures.filter(({ name }) => !officialFeatures.has(name));
  check(
    unknownFeatures.length === 0,
    `프로덕션의 features.* 설정 ${configuredFeatures.length}건이 전부 공식 이름이다 (없는 이름: ${unknownFeatures.map(({ name, rel }) => `${name} (${rel})`).join(", ") || "없음"})`,
  );
}

const GROK_ADAPTER_PREFIXES = ["providers/grok", "sessions/runtimes/grok", "sessions/codec/grok", "sessions/normalize/grok"];
function isGrokAdapterPath(rel: string): boolean {
  return GROK_ADAPTER_PREFIXES.some((p) => rel === p || rel.startsWith(p + path.sep) || rel === `${p}.ts`);
}

// ── 4a-2. 지식 도구 창구는 중립이고, 어댑터끼리 서로의 폴더를 가져오지 않는다 ──
// 창구가 Codex 폴더에 있을 때 Grok 실행부가 그 폴더를 import해 어댑터 간 결합이 생겼다. 다시 그리되지 않게 고정한다.
// (Ollama가 Codex 실행부·프로그램을 재사용하는 것은 사용자 결정이므로 Ollama는 검사하지 않는다.)
const PROVIDER_WORD_RE = /codex|grok|claude|ollama/i;
check(
  PROVIDER_WORD_RE.test(stripComments("// c\nconst x = 1;\n/* c */ const codexThing = 2;")) &&
    !PROVIDER_WORD_RE.test(stripComments("// codex\n/* grok */ const y = 1;")),
  "창구 provider 이름 검사가 주석은 무시하고 코드는 잡는다",
);
const neutralBridgeCode = stripComments(fs.readFileSync(path.join(SERVER_DIR, "providers/knowledgeBridge.ts"), "utf8"));
check(!PROVIDER_WORD_RE.test(neutralBridgeCode), "providers/knowledgeBridge.ts 코드에 codex·grok·claude·ollama 문자열이 없다");

const IMPORT_SPEC_RE = /(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
/** 파일이 가져오는 상대경로를 서버 루트 기준으로 풀어 준다(확장자 없음). */
function resolvedImports(rel: string): string[] {
  const source = stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"));
  return [...source.matchAll(IMPORT_SPEC_RE)]
    .map((m) => m[1])
    .filter((spec) => spec.startsWith("."))
    .map((spec) => path.relative(SERVER_DIR, path.resolve(SERVER_DIR, path.dirname(rel), spec)).split(path.sep).join("/"));
}
function importsInto(rel: string, prefixes: string[]): string[] {
  return resolvedImports(rel).filter((r) => prefixes.some((p) => r === p || r.startsWith(p + "/")));
}
check(
  resolvedImports("sessions/runtimes/grok.ts").includes("providers/knowledgeBridge") &&
    importsInto("sessions/runtimes/codex.ts", ["providers/codex"]).length > 0,
  "어댑터 간 import 검사기가 실제 import를 읽는다",
);
const CODEX_SIDE = ["providers/codex", "codex", "sessions/runtimes/codex", "sessions/codec/codex", "sessions/normalize/codex"];
const GROK_SIDE = ["providers/grok", "sessions/runtimes/grok", "sessions/codec/grok", "sessions/normalize/grok"];
const isClaudeAdapterPath = (rel: string) =>
  rel.startsWith("providers/claude/") ||
  ["sessions/runtimes/claude.ts", "sessions/codec/claude.ts", "sessions/normalize/claude.ts"].includes(rel);
const grokFiles = files.filter((rel) => !rel.startsWith("test" + path.sep) && isGrokAdapterPath(rel));
const claudeFiles = files.filter((rel) => !rel.startsWith("test" + path.sep) && isClaudeAdapterPath(rel));
check(grokFiles.length >= 4 && claudeFiles.length >= 4, `어댑터 파일을 찾았다 (grok ${grokFiles.length}, claude ${claudeFiles.length})`);
const grokToCodex = grokFiles.flatMap((rel) => importsInto(rel, CODEX_SIDE).map((r) => `${rel} -> ${r}`));
check(grokToCodex.length === 0, `Grok 어댑터가 Codex 폴더를 import하지 않는다 (위반: ${grokToCodex.join(", ") || "없음"})`);
const claudeToOthers = claudeFiles.flatMap((rel) => importsInto(rel, [...CODEX_SIDE, ...GROK_SIDE]).map((r) => `${rel} -> ${r}`));
check(claudeToOthers.length === 0, `Claude 어댑터가 Codex·Grok 폴더를 import하지 않는다 (위반: ${claudeToOthers.join(", ") || "없음"})`);

// ── 4a-3. Grok에 넘기는 환경 이름·CLI 플래그는 공식 목록에만 있다(10h · 8i 교훈) ──
// Grok도 없는 키를 오류 없이 무시할 수 있다. disable_codebase_upload 같은 지어낸 이름을 보내면
// 관측 끄기가 실제로 안 걸린 채 통과한다. 프로덕션 grok adapter가 자식에 얹는 GROK_* 와
// `--플래그`를 설치본 문서·도움말과 대조한다.
const grokAdapterFiles = productionFiles.filter((rel) => isGrokAdapterPath(rel));
const grokEnvSent: { name: string; rel: string }[] = [];
const grokFlagSent: { flag: string; rel: string }[] = [];
/** 객체 리터럴 키만 — `const GROK_COMMANDS` 같은 TS 이름은 자식에 안 넘어간다. */
const GROK_ENV_ASSIGN = /[{,]\s*(GROK_[A-Z][A-Z0-9_]*)\s*:/g;
const GROK_CLI_FLAG = /"--([a-z][a-z0-9-]+)"/g;
for (const rel of grokAdapterFiles) {
  const source = stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"));
  for (const match of source.matchAll(GROK_ENV_ASSIGN)) grokEnvSent.push({ name: match[1], rel });
  // git worktree 인자는 Grok CLI가 아니다. spawn 조립 파일만 본다.
  if (!/spawnGrokCli|grokAgentArgs|distillArgv|resolveGrokBin\(/.test(source)) continue;
  for (const match of source.matchAll(GROK_CLI_FLAG)) grokFlagSent.push({ flag: `--${match[1]}`, rel });
}
check(grokEnvSent.length > 0, `프로덕션 Grok adapter가 넘기는 GROK_* ${grokEnvSent.length}건을 찾았다`);
check(grokFlagSent.length > 0, `프로덕션 Grok adapter가 넘기는 CLI 플래그 ${grokFlagSent.length}건을 찾았다`);

const grokDocsPath = path.join(os.homedir(), ".grok", "docs", "user-guide", "05-configuration.md");
let officialGrokEnv: Set<string> | undefined;
if (fs.existsSync(grokDocsPath)) {
  const docs = fs.readFileSync(grokDocsPath, "utf8");
  officialGrokEnv = new Set([...docs.matchAll(/\b(GROK_[A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]));
  check(officialGrokEnv.size > 0, `설치본 설정 문서에서 공식 GROK_* ${officialGrokEnv.size}개를 읽었다`);
} else {
  console.log("  ⏭️  ~/.grok/docs/user-guide/05-configuration.md 가 없어 GROK_* 대조를 건너뛴다");
}
if (officialGrokEnv) {
  const unknownEnv = grokEnvSent.filter(({ name }) => !officialGrokEnv.has(name));
  check(
    unknownEnv.length === 0,
    `프로덕션 GROK_* ${[...new Set(grokEnvSent.map((e) => e.name))].join(", ")} 가 전부 공식 이름이다 (없는 이름: ${unknownEnv.map(({ name, rel }) => `${name} (${rel})`).join(", ") || "없음"})`,
  );
}

let officialGrokFlags: Set<string> | undefined;
try {
  const helps = ["--help", "agent --help", "login --help"].map((args) => {
    try {
      return execFileSync("grok", args.split(" "), { encoding: "utf8", timeout: 15_000 });
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      return `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    }
  });
  officialGrokFlags = new Set(
    helps
      .join("\n")
      .split(/\r?\n/)
      .flatMap((line) => [...line.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]+)/g)].map((m) => m[1])),
  );
  officialGrokFlags.add("-m");
  officialGrokFlags.add("-p");
  officialGrokFlags.add("-c");
  officialGrokFlags.add("-h");
  check(officialGrokFlags.size > 0, `grok 도움말에서 공식 플래그 ${officialGrokFlags.size}개를 읽었다`);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.log(`  ⏭️  grok 도움말을 실행할 수 없어 CLI 플래그 대조를 건너뛴다(검사 못 함: ${reason})`);
}
if (officialGrokFlags) {
  const unknownFlags = grokFlagSent.filter(({ flag }) => !officialGrokFlags.has(flag));
  check(
    unknownFlags.length === 0,
    `프로덕션 Grok CLI 플래그가 전부 공식 이름이다 (없는 이름: ${unknownFlags.map(({ flag, rel }) => `${flag} (${rel})`).join(", ") || "없음"})`,
  );
}

const notifySrc = stripComments(fs.readFileSync(path.join(SERVER_DIR, "notify/worthNotifying.ts"), "utf8"));
check(!/\bkind\s*===?\s*["'](?:sdk|codex|grok)["']/.test(notifySrc), "알림 판정이 provider 원본 kind를 보지 않는다");
check(/turn_completed/.test(notifySrc) && /plan_request/.test(notifySrc), "알림 판정이 정규화 완료와 계획 대기를 본다");

// ── 4b-2. OMC 명령 제안은 서버에 없다 ──
// 예전에는 Claude 실행부만 이 문구를 붙였다. 다른 provider에 옮기면 없는 명령을 시키게 되어서다.
// 기능을 지운 뒤에는 안내 파일도, 그 파일을 가져오는 코드도 없어야 한다.
// 가져오는 곳이 0인지만 보면 검사 정규식이 깨져도 통과하므로, 파일 부재를 같이 확인한다.
const omcImportRe = new RegExp(String.raw`from\s+["'][^"']*` + "omc" + String.raw`/`);
const omcImporters = files.filter((rel) =>
  omcImportRe.test(stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"))),
);
check(omcImporters.length === 0, `OMC 안내를 가져오는 파일이 없다 (있음: ${omcImporters.join(", ") || "없음"})`);
check(!fs.existsSync(path.join(SERVER_DIR, "omc", "routingNudge.ts")), "OMC 라우팅 안내 파일이 없다");
check(!fs.existsSync(path.join(SERVER_DIR, "providers", "claude", "plugins.ts")), "OMC 로드 판정 파일이 없다");
const claudeRuntimeSrc = fs.readFileSync(path.join(SERVER_DIR, "sessions", "runtimes", "claude.ts"), "utf8");
check(
  !/omcRouting|OMC_ROUTING|shouldProposeRouting|isOmcEnabled/.test(claudeRuntimeSrc),
  "Claude 실행부가 OMC 제안을 붙이지 않는다",
);

// ── 4c. 지식툴 자격증명은 모델 프로세스의 환경으로 가지 않는다(8g) ──
// 8a는 토큰을 프로세스 환경변수로 넘기고 "실행 인자에는 안 보인다"까지만 확인했다. 8g 실측에서 macOS는
//   같은 계정의 아무 프로세스나 `ps eww`로 남의 환경변수를 읽는다는 것이 확인됐다 — 세션마다 프로세스를
//   나눠도 다른 세션 토큰을 주울 수 있다는 뜻이다. 그래서 자격증명을 **스레드 시작 설정**으로만 넘긴다.
//   이 게이트가 없으면 나중에 누군가 "환경변수가 편하다"며 8a 방식으로 되돌려 놓아도 아무도 모른다.
const bridgeSource = stripComments(fs.readFileSync(path.join(SERVER_DIR, "providers/codex/knowledgeThreadConfig.ts"), "utf8"));
check(/http_headers/.test(bridgeSource), "지식툴 자격증명은 스레드 설정의 헤더로 넘어간다");
//   스파이크는 두 통로를 일부러 비교하고, 테스트는 걸러지는지를 확인하므로 프로덕션 경로만 본다.
const envChannelUsers = files.filter(
  (rel) =>
    !rel.startsWith("spikes" + path.sep) &&
    !rel.startsWith("test" + path.sep) &&
    /bearer_token_env_var|AETHER_MCP_TOKEN/.test(stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"))),
);
check(
  envChannelUsers.length === 0,
  `지식툴 토큰을 환경변수로 넘기는 자리가 없다 (있는 곳: ${envChannelUsers.join(", ") || "없음"})`,
);
const grokRuntimeSource = stripComments(fs.readFileSync(path.join(SERVER_DIR, "sessions/runtimes/grok.ts"), "utf8"));
check(/\benv:\s*grokChildEnv\s*\(\s*(?:GROK_SESSION_EXTRA\s*)?\)/.test(grokRuntimeSource), "Grok 세션 spawn이 grokChildEnv()를 지난다");
check(!/AETHER_MCP_TOKEN/.test(grokRuntimeSource), "Grok 실행부가 지식 토큰을 환경변수 이름으로 안 둔다");
check(/httpAttach/.test(grokRuntimeSource) && /Authorization/.test(grokRuntimeSource), "Grok 지식 창구는 헤더로만 붙인다");
check(/openKnowledgeBridge/.test(grokRuntimeSource), "Grok가 같은 HTTP 창구를 재사용한다");

// 배경 작업의 "무해한 항목" 목록이 실제 프로토콜 이름과 맞는지 — 틀린 이름을 적으면 그 항목이 매번
//   도구 시도로 잡혀 거짓 경보가 나거나(있지도 않은 이름을 허용해) 감시가 헐거워진다.
const { HARMLESS_ITEM_TYPES } = await import("../providers/codex/distill");
const threadItemSource = fs.readFileSync(path.join(SERVER_DIR, "codex/protocol/v2/ThreadItem.ts"), "utf8");
const realItemTypes = new Set([...threadItemSource.matchAll(/"type":\s*"([A-Za-z]+)"/g)].map((m) => m[1]));
check(realItemTypes.size > 5, `항목 종류를 생성 타입에서 읽었다 (${realItemTypes.size}종)`);
const bogus = [...HARMLESS_ITEM_TYPES].filter((t) => !realItemTypes.has(t));
check(bogus.length === 0, `배경 작업의 무해 목록이 전부 실재하는 항목 종류다 (없는 이름: ${bogus.join(", ") || "없음"})`);

// GUI의 슬래시 목록 로직은 provider 명령 이름을 몰라야 한다. 명령을 더할 때 adapter 카탈로그만 바꾸면
//   화면에 나타나야 하며, 여기 설명표를 한 벌 더 추가하는 구조로 돌아가면 세 번째 provider에서 다시 갈라진다.
const WEB_SRC = path.resolve(SERVER_DIR, "../web/src");
const slashUiFiles = ["lib/slashCommands.ts", "lib/i18n/composer.ts"];
const providerCommandLiteral = /["'](?:clear|compact|context|cost|help|init|review|usage|verify|code-review)["']/g;
const slashUiLeaks = slashUiFiles.flatMap((rel) => {
  const source = stripComments(fs.readFileSync(path.join(WEB_SRC, rel), "utf8"));
  return [...source.matchAll(providerCommandLiteral)].map((match) => `${rel}:${match[0]}`);
});
check(slashUiLeaks.length === 0, `GUI 명령 카탈로그에 provider 명령 어휘가 없다 (누출: ${slashUiLeaks.join(", ") || "없음"})`);

// ── 6. 세 번째 실행기 이음매: 공통 계층에 ACP·grok 어휘가 생기면 실패(10b) ──
// 구현 디렉터리가 아직 없어도 검사는 존재해야 한다. adapter 안에만 둘 지식이다.
const ACP_LEAK_RE = /session\/(?:prompt|new|resume|load|cancel|update|request_permission)|_?x\.ai\/|grok agent/;
check(ACP_LEAK_RE.test('c.request("session/prompt")') && ACP_LEAK_RE.test("x.ai/auth") && ACP_LEAK_RE.test("grok agent --no-leader"), "ACP·grok 어휘 검사가 실제로 잡는다");
const acpOffenders = files.filter(
  (rel) =>
    !rel.startsWith("test" + path.sep) &&
    !isGrokAdapterPath(rel) &&
    ACP_LEAK_RE.test(stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"))),
);
check(acpOffenders.length === 0, `공통 계층에 ACP 메서드·grok agent 문자열 0건 (위반: ${acpOffenders.join(", ") || "없음"})`);

const GROK_CLI_LEAK_RE = /grok login|--device-auth|\bGROK_HOME\b/;
check(GROK_CLI_LEAK_RE.test("grok login --device-auth") && GROK_CLI_LEAK_RE.test("GROK_HOME"), "Grok 로그인·홈 경로 검사가 실제로 잡는다");
const grokCliOffenders = files.filter(
  (rel) =>
    !rel.startsWith("test" + path.sep) &&
    !isGrokAdapterPath(rel) &&
    GROK_CLI_LEAK_RE.test(stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"))),
);
check(grokCliOffenders.length === 0, `공통 계층에 grok login·GROK_HOME 분기 0건 (위반: ${grokCliOffenders.join(", ") || "없음"})`);

const GROK_NAME_BRANCH = /(?:provider|id)\s*===?\s*["']grok["']|["']grok["']\s*===?\s*(?:provider|id)|case\s+["']grok["']/;
function walkWeb(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkWeb(abs, out);
    else if (e.isFile() && (abs.endsWith(".ts") || abs.endsWith(".tsx"))) out.push(abs);
  }
  return out;
}
const webGrokOffenders = walkWeb(WEB_SRC)
  .filter((abs) => GROK_NAME_BRANCH.test(stripComments(fs.readFileSync(abs, "utf8"))))
  .map((abs) => path.relative(WEB_SRC, abs));
check(webGrokOffenders.length === 0, `웹 생산 코드에 grok 이름 분기 0건 (위반: ${webGrokOffenders.join(", ") || "없음"})`);

// ── 6b. 공통 파일에는 "claude" 문자열이 없다(기본 provider 가정 금지 — 옛 데이터 해석은 registry의 storedProviderId 한 곳) ──
const CLAUDE_LITERAL_RE = /["']claude["']/;
check(CLAUDE_LITERAL_RE.test('const p = "claude"') && CLAUDE_LITERAL_RE.test("p === 'claude'") && !CLAUDE_LITERAL_RE.test(stripComments('// "claude"')), "claude 문자열 검사가 실제로 잡는다");
const CLAUDE_FREE_COMMON = [
  "sessions/SessionManager.ts",
  "sessions/LiveSession.ts",
  "routes/sessions.ts",
  "routes/providers.ts",
  "search/rebuildLetter.ts",
  "index.ts",
  "providers/distillModel.ts",
];
const claudeLiteralOffenders = CLAUDE_FREE_COMMON.filter(
  (rel) => !fs.existsSync(path.join(SERVER_DIR, rel)) || CLAUDE_LITERAL_RE.test(stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"))),
);
check(claudeLiteralOffenders.length === 0, `공통 파일에 "claude" 문자열 0건 (위반 또는 없음: ${claudeLiteralOffenders.join(", ") || "없음"})`);

// ── 6c. index.ts는 provider 구현 폴더를 직접 import하지 않는다(부팅 정리는 services.cleanupAtBoot로 부른다) ──
const PROVIDER_DIR_IMPORT_RE = /providers\/(claude|codex|grok|ollama)\//;
check(
  importsFromSource('import { a } from "./providers/codex/distill";').some((i) => PROVIDER_DIR_IMPORT_RE.test(i.spec)) &&
    !importsFromSource('import { a } from "./providers/registry";').some((i) => PROVIDER_DIR_IMPORT_RE.test(i.spec)),
  "index.ts provider 폴더 import 검사가 실제로 잡는다",
);
const indexProviderImports = importsOf("index.ts").filter((i) => PROVIDER_DIR_IMPORT_RE.test(i.spec)).map((i) => i.spec);
check(indexProviderImports.length === 0, `index.ts가 providers/<구현>/ 경로를 import하지 않는다 (위반: ${indexProviderImports.join(", ") || "없음"})`);

// 웹 생산 코드에도 claude 이름으로 분기하는 코드가 없다(grok 검사와 같은 모양).
const CLAUDE_NAME_BRANCH = /(?:provider|id)\s*===?\s*["']claude["']|["']claude["']\s*===?\s*(?:provider|id)|case\s+["']claude["']/;
check(CLAUDE_NAME_BRANCH.test('if (provider === "claude")') && CLAUDE_NAME_BRANCH.test("case 'claude':"), "웹 claude 분기 검사가 실제로 잡는다");
const webClaudeOffenders = walkWeb(WEB_SRC)
  .filter((abs) => CLAUDE_NAME_BRANCH.test(stripComments(fs.readFileSync(abs, "utf8"))))
  .map((abs) => path.relative(WEB_SRC, abs));
check(webClaudeOffenders.length === 0, `웹 생산 코드에 claude 이름 분기 0건 (위반: ${webClaudeOffenders.join(", ") || "없음"})`);

// ── 7. 배경 작업 모델 측정의 공통 모듈에는 provider·기업 이름이 없다(배경 작업 모델 측정 계획 D8) ──
// 판단은 어댑터가 채운 중립 필드로만 한다. 이름이 들어오는 순간 provider별 분기가 생긴다.
const BACKGROUND_NEUTRAL = [
  "providers/backgroundDistill.ts",
  "providers/modelCatalogMemory.ts",
];
const PROVIDER_NAME_RE = /claude|codex|grok|ollama|anthropic|openai|\bxai\b|haiku|sonnet|opus|\bgpt-/i;
check(PROVIDER_NAME_RE.test('if (p === "codex")') && PROVIDER_NAME_RE.test("haiku"), "provider 이름 검사가 실제로 잡는다");
const bgOffenders = BACKGROUND_NEUTRAL.filter(
  (rel) => !fs.existsSync(path.join(SERVER_DIR, rel)) || PROVIDER_NAME_RE.test(stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"))),
);
check(bgOffenders.length === 0, `배경 작업 모델 공통 모듈에 provider 이름 0건 (위반 또는 없음: ${bgOffenders.join(", ") || "없음"})`);

// ── 7b. 준비 신호는 같은 결과 객체를 재사용한다 ──
// 공통 계층(LiveSession)은 같은 결과 객체면 모델 목록을 다시 기억·관측하지 않는다. 부를 때마다 새 객체를 만들면
//   열린 옛 세션의 재요청이 다른 세션이 본 새 목록을 옛 값으로 덮는다. Claude 런타임은 실제 CLI 없이 띄울 수 없어
//   소스로 고정한다(Codex·Grok은 각 런타임 시험이 실제로 확인한다).
{
  const src = stripComments(fs.readFileSync(path.join(SERVER_DIR, "sessions/runtimes/claude.ts"), "utf8"));
  check(/handshake\(\)[^{]*\{\s*return\s*\(this\.handshakeResult\s*\?\?=/.test(src), "Claude 런타임의 준비 신호는 첫 결과를 재사용한다");
}

// ── 5. 허용 목록이 실제 파일을 가리키는지(경로 오타로 게이트가 무력화되는 것 방지) ──
const missing = [...SDK_ALLOWED].filter((rel) => !fs.existsSync(path.join(SERVER_DIR, rel)));
check(missing.length === 0, `허용 목록의 경로가 전부 실재 (없음: ${missing.join(", ") || "-"})`);

console.log(`\n${fail === 0 ? "✅" : "❌"} provider_boundary: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
