/**
 * 신뢰 경계 게이트 (Phase 8d-3 ⑥ · 완료 게이트 ④) — 모델 호출 0.
 *
 * 지키려는 문장 하나: **"프론트는 LLM을 직접 호출할 수 없고 인터페이스만 부른다."**
 * 그러려면 클라이언트가 보낸 값 중 모델에 도달하는 것은 전부 아래 셋 중 정확히 하나여야 한다.
 *
 *   (A) 사용자 콘텐츠   — 대화 텍스트·첨부·질문 답변. 원래 모델에 가야 하는 것.
 *   (B) 검증된 선택값   — 카탈로그·화이트리스트를 통과해야만 쓰이는 값(model·effort·cwd·MCP 이름 등).
 *   (C) 명시적 정책 플래그 — UI에 토글과 배지로 드러나 사용자가 의식적으로 켜는 것(archived 등).
 *
 * 어디에도 안 들어가는 입력이 생기면 그게 구멍이다. 그래서 이 파일은 두 층으로 검사한다.
 *   1) **정적** — 라우트 소스에서 클라이언트가 채우는 필드 이름을 전부 긁어, 아래 분류표에 없으면 실패.
 *      새 입력 경로가 분류 없이 추가되는 것을 막는 것이 목적이다(허용 목록을 사람이 갱신하게 강제).
 *   2) **행동** — (B)로 분류한 값이 *실제로* 거부되는지 라우터를 띄워 확인(잘못된 model·미등록 MCP 이름·
 *      루트 밖 cwd·제시되지 않은 선택지가 400인지). 분류표가 장식이 되지 않게 하는 반증이다.
 *
 * 마지막으로 ⑥ⓕ(실효 승인 정책 노출)이 provider 중립인지 본다 — 자동승인이 있는 폴더와 없는 폴더에서
 * 계약이 서로 다른 값을 돌려주고, 그 계산 근거가 Claude와 전혀 다른 가짜 provider에서도 성립하는지.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 세션이 건드릴 디스크를 임시로 격리 — config import보다 먼저.
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-trust-"));
// 이 테스트의 세션 cwd가 될 루트. 화이트리스트 경계 검사의 기준점이다.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-trust-root-")));
process.env.AETHER_PROJECT_ROOT = ROOT;
// 설정 디렉터리도 빈 임시 폴더로 — 안 그러면 ⑥ⓕ 검사가 이 맥의 진짜 `~/.claude/settings.json`을 세어
//   기대값이 사람마다 달라진다(실제로 실행한 맥에서 25개가 잡혔다).
process.env.CLAUDE_CONFIG_DIR = path.join(ROOT, "__claude_config");
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const express = (await import("express")).default;
const { __registerProviderForTest } = await import("../providers/registry");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("trust_boundary"); // 임시 SQLite 일기
const store = await import("../sessions/persistence");
const { sessionsRouter } = await import("../routes/sessions");
const { providersRouter } = await import("../routes/providers");
const mock = await import("./support/mockProvider");
const { claudePermissionPolicy } = await import("../providers/claude/permissionPolicy");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. 정적 — 클라이언트 입력 분류표
// ────────────────────────────────────────────────────────────────────────────

type InputClass = "A" | "B" | "C" | "id";
/**
 * 라우트 파일별로 **클라이언트가 채우는 모든 필드**와 그 분류.
 *
 * "id"는 위 셋과 별개로, 우리가 발급한 식별자를 되돌려 받는 자리다(세션 id·권한 id·질문 id·seq 커서).
 * 모델에 도달하지 않고 서버 자료구조 조회에만 쓰이며, 못 찾으면 404다 — 그래서 검증할 화이트리스트가
 * 따로 필요 없다. 다만 분류에서 빠뜨린 것과 구분되도록 이름을 붙여 명시한다.
 */
const INPUT_TABLE: Record<string, Record<string, InputClass>> = {
  "routes/sessions.ts": {
    id: "id", // 세션 식별자(경로) — 우리가 randomUUID로 발급
    name: "B", // rename의 표시 이름은 body의 name
    cwd: "B", // resolveWorkFolder가 존재하는 절대 경로인지 확인(SessionManager.create)
    provider: "B", // 등록표에 있는 이름만(providerEntry가 미등록 이름을 명시 거부 — 8e)
    model: "B", // 형식 가드(길이·제어문자·앞의 '-') + provider가 이름 판정(없는 이름은 거부)
    effort: "B", // 형식 가드 + provider가 값 판정(모델마다 받는 강도가 다르다)
    resume: "B", // provider가 형식 판정(isValidResumeKey)
    permissionMode: "B", // 정해진 네 값만 받고, 세션 중 변경은 그 세션이 알려 준 목록에 있는 값만
    purge: "C", // DELETE /:id?purge=1. 0 또는 1만 받고 그 밖은 400. 1이면 검색 글자까지 지운다
    archived: "C", // 보관·해제 토글. boolean만 받고, 일하는 중·대기 중이면 서버가 거절
    isolateWorkspace: "C", // 새 작업 창 토글. git이 아니면 서버가 거절
    planId: "id", // 우리가 발급한 계획 카드 식별자
    message: "A", // 계획 수정 요청에 사용자가 직접 적은 글
    text: "A", // 대화 텍스트
    brief: "C", // 이번 글만 브리프. 불리언 true만 인정한다
    questionnaire: "B", // 질문지 카드 답. id는 열린 질문지와 대조하고 답은 그 질문지의 선택지·길이 규칙으로 검사한다
    images: "A", // 첨부(MIME·개수·용량 화이트리스트)
    documents: "A", // 첨부(PDF만)
    command: "B", // runtime adapter가 자기 카탈로그·별칭으로 판정(모르는 이름은 일반 메시지로 폴백 금지)
    arguments: "A", // 사용자가 명령에 직접 적은 인자 원문(provider가 구조화 의미를 판정)
    permissionId: "id",
    decision: "B", // 'allow' | 'deny' 리터럴만
    questionId: "id",
    taskId: "B", // 뒤 작업 id(경로) — 형식 정규식(길이·문자)과 현재 목록에 있는 id만 통과
    answers: "B", // 제시된 선택지 이름과 대조
    custom: "A", // 사용자가 직접 적은 문장(자유 입력은 정당 — 대신 모델에게 구분해 전달)
    before: "id", // 이벤트 페이지 커서(seq)
    limit: "id",
    from: "id",
    seq: "id", // POST /:id/rewind. 서버가 매긴 사건 순번을 되돌려 받는다. 모델 입력이 아니다(730339d)
    purpose: "B", // POST /:id/handoff. 이어서·다시 토의·다음 작업 세 값만 인정한다
    focus: "A", // 넘기기에서 사람이 직접 적은 초점 글(4000자 이하). 모델에게는 사람 글로 전달한다
    includeMethod: "C", // 넘기기 창의 진행 방식 토글. boolean만 받는다
    copyOnly: "C", // 넘기기 창의 다른 컴퓨터(복사만) 토글. boolean만 받는다
    force: "C", // POST /:id/workspace/discard. 확인 창을 통과한 요청만 true. 아니면 더러운 복사본을 거절한다
  },
  // 8f에서 표에 들였다. 이 라우트의 입력은 모델이 아니라 provider의 로그인 프로세스로 가는데, 그 통로가
  //   구독 자격증명을 발급하는 가장 민감한 자리라 같은 규율로 고정해 둔다.
  "routes/providerAuth.ts": {
    provider: "B", // 등록표에 있는 이름만(resolveAuth가 미등록 이름을 404로 거부)
    loginId: "id", // 우리가 발급한 로그인 식별자 — 되돌려 받아 조회에만 쓴다(모르는 값이면 오류)
    code: "A", // 사용자가 provider 로그인 화면에서 받아 옮겨 적은 코드(provider가 진위를 판정)
  },
};

/** 주석 속 문구가 위반으로 잡히지 않게 라인·블록 주석을 지운 뒤 검사한다. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * 소스에서 클라이언트가 채우는 필드 이름을 전부 뽑는다.
 *   `req.body.x` · `req.body?.x` · `req.query.x` · `req.params.x` — 점 접근
 *   `req.body["x"]`                                              — 대괄호 접근
 *   `const { a, b } = req.body ?? {}`                            — 구조분해
 *
 * 대괄호 접근까지 잡는 이유: 점 접근만 보면 `req.body["새필드"]`로 분류표를 우회할 수 있고, 그러면
 * "분류 안 된 입력이 생기면 실패한다"는 이 게이트의 약속이 깨진다.
 * 한계는 남는다 — `const b = req.body; b.x` 처럼 지역 변수로 옮기면 못 잡는다(아래 자기 반증에 명시).
 */
function clientFieldsOf(src: string): string[] {
  const found = new Set<string>();
  const REQ = String.raw`\breq\s*\.\s*(?:body|query|params)\s*\??\s*`;
  const dot = new RegExp(`${REQ}\\.\\s*([A-Za-z_$][\\w$]*)`, "g");
  for (let m = dot.exec(src); m; m = dot.exec(src)) found.add(m[1]);
  const bracket = new RegExp(`${REQ}\\[\\s*["'\`]([^"'\`]+)["'\`]\\s*\\]`, "g");
  for (let m = bracket.exec(src); m; m = bracket.exec(src)) found.add(m[1]);
  const destructure = /(?:const|let)\s*\{([^}]*)\}\s*=\s*req\s*\.\s*(?:body|query|params)/g;
  for (let m = destructure.exec(src); m; m = destructure.exec(src)) {
    for (const part of m[1].split(",")) {
      const nm = part.split(":")[0].trim();
      if (nm) found.add(nm);
    }
  }
  return [...found];
}

for (const [rel, table] of Object.entries(INPUT_TABLE)) {
  const src = stripComments(fs.readFileSync(path.join(SERVER_DIR, rel), "utf8"));
  const fields = clientFieldsOf(src);
  const unclassified = fields.filter((f) => !(f in table));
  check(unclassified.length === 0, `${rel}: 클라이언트 입력이 전부 분류됨 (미분류: ${unclassified.join(", ") || "없음"})`);
  // 분류표에만 있고 소스엔 없는 항목 = 낡은 표(게이트가 헐거워진다).
  const stale = Object.keys(table).filter((f) => !fields.includes(f));
  check(stale.length === 0, `${rel}: 분류표에 낡은 항목 없음 (지울 것: ${stale.join(", ") || "없음"})`);
}
// 검사기가 헛돌지 않는지 — 실제로 필드를 뽑아내고 있나.
check(
  clientFieldsOf(`const { a, b: c } = req.body ?? {}; req.query.d; req.params?.e; req.body["f"]`).sort().join(",") === "a,b,d,e,f",
  "필드 추출기가 구조분해·점 접근·대괄호 접근을 모두 잡는다",
);

// ────────────────────────────────────────────────────────────────────────────
// 2. 행동 — (B)로 분류한 값이 실제로 거부되는가
// ────────────────────────────────────────────────────────────────────────────

const unregister = __registerProviderForTest(mock.mockEntry);
const app = express();
app.use(express.json());
app.use("/api/sessions", sessionsRouter);
app.use("/api/providers", providersRouter);
const server = app.listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${url}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* 본문 없음 */
  }
  return { status: res.status, json };
}

// 가짜 provider 세션 1개(모델 프로세스 없음). 라우트가 provider를 가리지 않는지도 함께 본다.
const session = sessionManager.create({ cwd: ROOT, provider: mock.MOCK_PROVIDER });
const SID = session.id;

// ── provider 목록 — 표시 이름과 인증 capability만 노출(모델·강도 목록은 세션이 뜬 뒤에야 알 수 있다) ──
const providerList = await call("GET", "/api/providers");
check(
  providerList.status === 200 &&
    providerList.json.providers.every((p: any) => typeof p.displayName === "string" && typeof p.authSupported === "boolean"),
  "④ provider 목록이 displayName과 인증 지원 여부를 노출",
  providerList.json,
);
// 모델·강도 목록이 여기로 새는 것을 막는 것이 이 검사의 목적이므로 허용 키를 표로 고정한다.
const PROVIDER_ITEM_KEYS = new Set(["id", "displayName", "authSupported", "planReview"]);
check(
  providerList.json.providers.every((p: any) => Object.keys(p).every((k) => PROVIDER_ITEM_KEYS.has(k))),
  "④ provider 항목은 신원·capability뿐 — 하드코딩된 모델 목록이 남아 있지 않다",
  providerList.json.providers,
);
const { auth: _mockAuth, ...servicesWithoutAuth } = mock.mockEntry.services;
const restoreAuthProvider = __registerProviderForTest({ ...mock.mockEntry, services: servicesWithoutAuth });
const providerListWithoutAuth = await call("GET", "/api/providers");
check(
  providerListWithoutAuth.json.providers.find((p: any) => p.id === mock.MOCK_PROVIDER)?.authSupported === false,
  "④ 인증 구현이 없는 provider는 authSupported=false(죽은 재인증 버튼 방지)",
  providerListWithoutAuth.json,
);
restoreAuthProvider();

// ── (B) cwd — 루트 밖은 거부 ──
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-trust-outside-")));
// ── (B) 모델 이름 — 형식 가드는 서버가, 이름의 존재는 provider가 판정 ──
const badModel = await call("POST", `/api/sessions/${SID}/model`, { model: "totally-made-up" });
check(badModel.status === 400, "⑥ⓓ 모델: provider가 모르는 이름은 거부", badModel.json);
check(
  typeof badModel.json?.error === "string" && badModel.json.error.includes("totally-made-up"),
  "⑥ⓓ 모델: 거부 문구에 어떤 이름이 막혔는지 그대로 실린다(사용자가 오타를 고칠 수 있게)",
  badModel.json,
);
// 거부된 이름이 메타에 남으면 다음에 깨어날 때 그 잘못된 이름으로 뜬다 — 되돌려졌는지 확인.
check(session.model !== "totally-made-up", "⑥ⓓ 모델: 거부된 이름은 세션에 저장되지 않는다", session.model);
check((await call("POST", `/api/sessions/${SID}/model`, { model: "mock-small" })).status === 200, "⑥ⓓ 모델: provider가 아는 이름은 통과");
check((await call("POST", `/api/sessions/${SID}/model`, { model: mock.MOCK_ALT_MODEL })).status === 200, "⑥ⓓ 모델: 정식 id로 부른 이름도 통과");
// 형식 가드는 프로세스를 띄우기 전에 걸러야 한다 — 그래서 세션 생성 경로는 형식이 틀린 값으로 확인한다.
//   (존재하지 않는 이름으로 생성을 시도하면 기본 provider의 실제 프로세스가 떠서 이 테스트가 모델을 부르게 된다.)
check((await call("POST", "/api/sessions", { cwd: ROOT, model: "-flag-like" })).status === 400, "⑥ⓓ 모델: 생성 시 '-'로 시작하는 값 거부(설정 항목 오인 방지)");
check((await call("POST", "/api/sessions", { cwd: ROOT, model: "x".repeat(65) })).status === 400, "⑥ⓓ 모델: 생성 시 지나치게 긴 이름 거부");
check((await call("POST", "/api/sessions", { cwd: ROOT, model: "ok\nname" })).status === 400, "⑥ⓓ 모델: 생성 시 제어 문자 거부");

// ── (B) effort — 형식 가드는 서버가, 값의 유효성은 provider가 판정 ──
check((await call("POST", `/api/sessions/${SID}/effort`, { effort: "high" })).status === 400, "effort: 남의 provider 어휘 거부(mock은 brisk|deep)");
check(session.effort !== "high", "effort: 거부된 값은 세션에 저장되지 않는다", session.effort);
check((await call("POST", `/api/sessions/${SID}/effort`, { effort: "-flag" })).status === 400, "effort: '-'로 시작하는 값은 형식 가드가 거부");
check((await call("POST", `/api/sessions/${SID}/effort`, { effort: "deep" })).status === 200, "effort: 자기 provider 어휘는 통과");

// 판정의 근거가 되는 목록이 프론트에도 같은 모양으로 전달되는가 — 화면이 고를 수 있는 값의 출처다.
const modelList = await call("GET", `/api/sessions/${SID}/models`);
check(modelList.status === 200 && Array.isArray(modelList.json?.models), "모델 목록 조회가 live 세션에서 200", modelList.json);
check(
  modelList.json?.models?.some((m: any) => typeof m.resolvedModel === "string"),
  "모델 목록이 정식 id(resolvedModel)를 싣는다 — 화면이 현재 모델을 맞춰볼 때 필요",
  modelList.json?.models,
);
check(
  modelList.json?.models?.some((m: any) => Array.isArray(m.supportedEffortLevels)),
  "모델 목록이 모델별 추론 강도(supportedEffortLevels)를 싣는다",
  modelList.json?.models,
);

// ── capability 가드와 명령 핵심 계약 ──
check((await call("GET", `/api/sessions/${SID}/usage`)).status === 501, "미지원 조회(usage)는 명시적 501");
const commands = await call("GET", `/api/sessions/${SID}/commands`);
check(
  commands.status === 200 && commands.json?.commands?.some((c: any) => c.name === "model") && commands.json?.commands?.some((c: any) => c.name === "mock-ping"),
  "명령 목록은 capability로 숨기지 않고 Aether 공통분+provider 선언분을 돌려준다",
  commands.json,
);
const beforeUnknown = mock.mockState.commandCalls.length;
check((await call("POST", `/api/sessions/${SID}/commands`, { command: "does-not-exist", arguments: "hello" })).status === 400, "명령: provider가 모르는 이름은 거부");
check(mock.mockState.commandCalls.length === beforeUnknown, "명령: 모르는 이름은 provider 실행부의 허용 경로에 기록되지 않는다");
check((await call("POST", `/api/sessions/${SID}/commands`, { command: "mock-ping", arguments: "hello" })).status === 200, "명령: provider가 선언한 이름은 통과");
check(mock.mockState.commandCalls.at(-1)?.arguments === "hello", "명령: 사용자 인자는 adapter에 원문으로 전달된다", mock.mockState.commandCalls.at(-1));
check((await call("POST", `/api/sessions/${SID}/commands`, { command: "bad\nname", arguments: "" })).status === 400, "명령: 제어 문자가 든 이름은 adapter 전에 거부");

// ── (B) 질문 답변 — 제시된 선택지만. 자유 입력은 custom으로 ──
const QUESTIONS = [{ question: "저녁?", options: [{ label: "피자" }, { label: "파스타" }] }];
type Outcome = { answered: boolean; answers?: { chosen: string[]; custom?: string }[]; reason?: string };
function askQuestion(): { qid: string; done: Promise<Outcome> } {
  const done = (session as any).requestQuestion({
    toolUseID: `t-${Math.random()}`,
    questions: QUESTIONS,
    signal: new AbortController().signal,
  }) as Promise<Outcome>;
  return { qid: (session as any).pendingQuestionList().at(-1).id, done };
}

const q1 = askQuestion();
const bad = await call("POST", `/api/sessions/${SID}/question`, { questionId: q1.qid, answers: [["없는선택지"]] });
check(bad.status === 400, "⑥ⓒ 질문: 제시되지 않은 문자열을 '고른 답'으로 보내면 거부", bad.json);
const countBad = await call("POST", `/api/sessions/${SID}/question`, { questionId: q1.qid, answers: [["피자"], ["파스타"]] });
check(countBad.status === 400, "⑥ⓒ 질문: 답변 개수가 질문 개수와 다르면 거부");
const good = await call("POST", `/api/sessions/${SID}/question`, { questionId: q1.qid, answers: [["피자"]], custom: [null] });
check(good.status === 200, "⑥ⓒ 질문: 제시된 선택지는 통과", good.json);
const out1 = await q1.done;
check(out1.answered === true && out1.answers?.[0]?.chosen.join() === "피자" && !out1.answers?.[0]?.custom, "⑥ⓒ 질문: 고른 선택지가 chosen으로 전달");

const q2 = askQuestion();
const freeOk = await call("POST", `/api/sessions/${SID}/question`, { questionId: q2.qid, answers: [[]], custom: ["직접 쓴 답"] });
check(freeOk.status === 200, "⑥ⓒ 질문: 자유 입력 자체는 여전히 허용(금지가 아니라 형태 강제)", freeOk.json);
const out2 = await q2.done;
check(out2.answered === true && out2.answers?.[0]?.custom === "직접 쓴 답" && out2.answers?.[0]?.chosen.length === 0, "⑥ⓒ 질문: 자유 입력은 custom으로 분리되어 전달");

const q3 = askQuestion();
check(
  (await call("POST", `/api/sessions/${SID}/question`, { questionId: q3.qid, answers: [["피자", "파스타"]], custom: [null] })).status === 400,
  "⑥ⓒ 질문: 단일 선택 질문에 복수 선택을 위조하면 거부",
);
check(
  (await call("POST", `/api/sessions/${SID}/question`, { questionId: q3.qid, answers: [["피자"]], custom: ["직접 쓴 답"] })).status === 400,
  "⑥ⓒ 질문: 단일 선택 질문에 선택지와 자유 입력을 동시에 보내면 거부",
);
check(
  (await call("POST", `/api/sessions/${SID}/question`, { questionId: q3.qid, answers: [["피자"]], custom: [null, "extra"] })).status === 400,
  "⑥ⓒ 질문: 질문 수보다 긴 custom 배열을 거부",
);
const q3Good = await call("POST", `/api/sessions/${SID}/question`, { questionId: q3.qid, answers: [["파스타"]], custom: [null] });
check(q3Good.status === 200, "⑥ⓒ 질문: malformed 재시도 뒤 정상 단일 답은 통과", q3Good.json);
await q3.done;

const multiQuestions = [{ question: "토핑?", multiSelect: true, options: [{ label: "치즈" }, { label: "버섯" }] }];
const multiDone = (session as any).requestQuestion({
  toolUseID: "t-multi",
  questions: multiQuestions,
  signal: new AbortController().signal,
}) as Promise<Outcome>;
const multiQid = (session as any).pendingQuestionList().at(-1).id;
const multiOk = await call("POST", `/api/sessions/${SID}/question`, {
  questionId: multiQid,
  answers: [["치즈", "버섯"]],
  custom: ["올리브도"],
});
check(multiOk.status === 200, "⑥ⓒ 질문: 복수 선택 질문은 여러 선택지 + 자유 입력 동시 제출 허용", multiOk.json);
const multiOut = await multiDone;
check(
  multiOut.answers?.[0]?.chosen.join() === "치즈,버섯" && multiOut.answers?.[0]?.custom === "올리브도",
  "⑥ⓒ 질문: 복수 선택과 자유 입력을 구분해 전달",
  multiOut,
);

// ── 권한 승인은 리터럴만(H1 재확인 — 이번 단계에서 깨지지 않았는지) ──
const permBad = await call("POST", `/api/sessions/${SID}/permission`, { permissionId: "x", decision: { behavior: "allow" } });
check(permBad.status === 400, "권한: allow/deny 리터럴이 아니면 거부(H1 유지)");

// ── 권한 칩: 세션 중 권한 모드 변경은 정해진 값 + 그 세션이 알려 준 목록에 있는 값만, provider 인터페이스를 거쳐 정책 요약까지 바뀐다 ──
const modeBad = await call("POST", `/api/sessions/${SID}/permissions`, { permissionMode: "true" });
check(modeBad.status === 400, "권한 칩: 정해진 값이 아니면 거부", modeBad.json);
check((await call("POST", `/api/sessions/${SID}/permissions`, { skipPermissions: true })).status === 400, "권한 칩: 옛 skipPermissions 본문은 받지 않는다");
const modeList = await call("GET", `/api/sessions/${SID}/permission-modes`);
check(modeList.status === 200 && Array.isArray(modeList.json.modes) && typeof modeList.json.current === "string", "권한 칩: 모드 목록을 준다", modeList.json);
const modeFull = await call("POST", `/api/sessions/${SID}/permissions`, { permissionMode: "full" });
check(modeFull.status === 200 && modeFull.json.permissionMode === "full", "권한 칩: full로 바꾸기 성공", modeFull.json);
check((await call("GET", `/api/sessions/${SID}/permission-policy`)).json.bypassAll === true, "권한 칩: full이면 실효 정책도 전부 우회");
check(sessionManager.get(SID)?.permissionMode === "full", "권한 칩: 세션 값이 바뀐다");
check(store.loadMeta(SID)?.permissionMode === "full", "권한 칩: meta에 영속된다(깨어나도 유지)");
const modeManual = await call("POST", `/api/sessions/${SID}/permissions`, { permissionMode: "manual" });
check(modeManual.status === 200 && (await call("GET", `/api/sessions/${SID}/permission-policy`)).json.bypassAll === false, "권한 칩: 수동으로 돌리면 다시 묻기", modeManual.json);
check((await call("POST", `/api/sessions/no-such-session/permissions`, { permissionMode: "full" })).status === 404, "권한 칩: 없는 세션은 404");
check((await call("GET", `/api/sessions/no-such-session/permission-modes`)).status === 404, "권한 모드 목록: 없는 세션은 404");

// ────────────────────────────────────────────────────────────────────────────
// 3. ⑥ⓕ 실효 승인 정책 — provider 중립 계약인가
// ────────────────────────────────────────────────────────────────────────────

// 가짜 provider: 자기만의 출처(`.mock/approvals.json`)에서 계산한다.
const plain = await call("GET", `/api/sessions/${SID}/permission-policy`);
check(plain.status === 200 && plain.json.autoApproveRules === 0 && plain.json.bypassAll === false, "⑥ⓕ 자동승인 없는 폴더 → 규칙 0(배지 없음)", plain.json);

const approveCwd = path.join(ROOT, "with-approvals");
fs.mkdirSync(path.join(approveCwd, ".mock"), { recursive: true });
fs.writeFileSync(path.join(approveCwd, ".mock", "approvals.json"), JSON.stringify({ allow: ["Bash(ls:*)", "Read(*)"] }));
const s2 = sessionManager.create({ cwd: approveCwd, provider: mock.MOCK_PROVIDER });
const withRules = await call("GET", `/api/sessions/${s2.id}/permission-policy`);
check(
  withRules.status === 200 && withRules.json.autoApproveRules === 2 && withRules.json.sources.join() === "project",
  "⑥ⓕ 자동승인 있는 폴더 → 규칙 수·출처를 돌려준다(같은 계약, 다른 provider 출처)",
  withRules.json,
);
check(!JSON.stringify(withRules.json).includes("Bash(ls:*)"), "⑥ⓕ 허용 패턴 원문은 노출하지 않는다(요약 수준 한정)");

// Claude 구현: 근거가 `.claude/settings.json`의 permissions.allow인지 — 같은 계약, 전혀 다른 출처.
const claudeCwd = path.join(ROOT, "claude-proj");
fs.mkdirSync(path.join(claudeCwd, ".claude"), { recursive: true });
check((await claudePermissionPolicy(claudeCwd, false)).autoApproveRules === 0, "⑥ⓕ Claude: 설정 없으면 규칙 0");
fs.writeFileSync(path.join(claudeCwd, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git status:*)"] } }));
fs.writeFileSync(path.join(claudeCwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Read(//tmp/**)", "Grep(*)"] } }));
const cp = await claudePermissionPolicy(claudeCwd, false);
check(cp.autoApproveRules === 3 && cp.sources.join() === "project,local", "⑥ⓕ Claude: 설정 범위별로 세고 출처를 표시", cp);
check((await claudePermissionPolicy(claudeCwd, true)).bypassAll === true, "⑥ⓕ Claude: 전면 우회 플래그는 그대로 반영");

// 규칙 목록이 비어도 **기본 동작 자체**가 승인을 건너뛰게 설정돼 있으면 카드는 안 뜬다 → 그것도 표면화해야 한다.
const modeCwd = path.join(ROOT, "mode-proj");
fs.mkdirSync(path.join(modeCwd, ".claude"), { recursive: true });
fs.writeFileSync(path.join(modeCwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));
const modePolicy = await claudePermissionPolicy(modeCwd, false);
check(
  modePolicy.autoApproveRules === 0 && modePolicy.autoApproveMode === "acceptEdits" && modePolicy.sources.join() === "local",
  "⑥ⓕ Claude: 규칙이 0개여도 기본 동작이 승인을 건너뛰면 그 모드를 알린다",
  modePolicy,
);
fs.writeFileSync(path.join(modeCwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
check((await claudePermissionPolicy(modeCwd, false)).bypassAll === true, "⑥ⓕ Claude: bypassPermissions 모드는 전면 우회와 같은 표시로 합친다");
// 묻지 않고 *거부*하는 모드는 승인을 건너뛰는 게 아니다 — 배지를 띄우면 거짓 경고가 된다.
fs.writeFileSync(path.join(modeCwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { defaultMode: "dontAsk" } }));
const denyMode = await claudePermissionPolicy(modeCwd, false);
check(!denyMode.autoApproveMode && denyMode.bypassAll === false, "⑥ⓕ Claude: 묻지 않고 거부하는 모드(dontAsk)는 자동승인으로 세지 않는다", denyMode);
// 리포지토리에 커밋되는 project 범위의 escalating 모드는 CLI가 채택하지 않는다 → 화면에도 뜨면 안 된다.
fs.rmSync(path.join(modeCwd, ".claude", "settings.local.json"));
fs.writeFileSync(path.join(modeCwd, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
const projMode = await claudePermissionPolicy(modeCwd, false);
check(!projMode.autoApproveMode && projMode.bypassAll === false, "⑥ⓕ Claude: project 범위의 승인 우회 모드는 CLI가 무시하므로 표시도 안 한다", projMode);

fs.writeFileSync(path.join(claudeCwd, ".claude", "settings.json"), "{ 깨진 json");
check((await claudePermissionPolicy(claudeCwd, false)).autoApproveRules === 2, "⑥ⓕ Claude: 설정 파일 하나가 깨져도 나머지로 계산(세션은 떠야 한다)");

// 넓은 범위의 자동승인 모드는 더 좁은 범위의 명시적 비승인 모드가 덮는다. 기존 수동 합산 구현은
// escalating mode만 골라 읽어 이 override를 놓쳤고, 실제 CLI는 dontAsk인데 배지를 자동승인으로 표시했다.
fs.writeFileSync(path.join(modeCwd, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));
fs.writeFileSync(path.join(modeCwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { defaultMode: "dontAsk" } }));
const overriddenMode = await claudePermissionPolicy(modeCwd, false);
check(
  !overriddenMode.autoApproveMode && overriddenMode.bypassAll === false,
  "⑥ⓕ Claude: 좁은 범위의 dontAsk가 넓은 자동승인 모드를 덮으면 배지를 지운다",
  overriddenMode,
);

// ── 정리 ──
sessionManager.delete(SID);
sessionManager.delete(s2.id);
unregister();
await new Promise<void>((r) => server.close(() => r()));
fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(outside, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "✅" : "❌"} trust_boundary: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
