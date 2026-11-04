/**
 * 지식툴 HTTP 창구 (Phase 8g · D8/D8.1) — 모델 호출 0.
 *
 * 지키려는 문장 셋:
 *   ① **모델은 자기 세션의 작업 폴더 밖으로 갈 수 없다.** 폴더는 서버가 세션에서 채우고, 다른 세션의
 *      토큰으로도 남의 폴더에 닿지 못한다. 인자로 폴더를 지정하려는 시도는 무시된다.
 *   ② **도구 정의는 한 벌뿐이다.** 창구가 내놓는 이름·설명·필수 인자가 중립 서술자에서 그대로 나온다.
 *      여기서 다시 적으면 스키마가 두 벌이 되어 한쪽만 고치는 버그가 생긴다.
 *   ③ **승인 규칙이 Claude와 같다.** 카드가 필요한 도구는 창구가 세션에 물어보고, 거부면 핸들러가
 *      아예 안 돈다.
 * 여기에 수명(세션이 끝나면 그 토큰은 401)과 규약(알림은 202 무본문, 응답은 이벤트 스트림 한 프레임)을 더한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-kbridge-"));
process.env.AETHER_DATA_DIR ??= DATA_DIR;

const { openKnowledgeBridge, knowledgeBridgeStatus, toMcpTool } = await import("../providers/knowledgeBridge");
const { codexThreadConfig } = await import("../providers/codex/knowledgeThreadConfig");
const { buildKnowledgeTools } = await import("../knowledge/tools");
const { textResult } = await import("../knowledge/types");
const { codexServices } = await import("../providers/codex/services");
import type { KnowledgeToolDefinition } from "../knowledge/types";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (cond) pass++;
  else fail++;
}

/** 창구가 준 설정에서 주소와 토큰을 꺼낸다(런타임이 스레드 시작에 넘기는 바로 그 값). */
function wire(cfg: Record<string, unknown>, attach?: { url: string; authorization: string }): { url: string; token: string; approvalMode: string } {
  const server = (cfg.mcp_servers as Record<string, any>).aether;
  const auth = String(server.http_headers?.Authorization ?? "");
  if (attach) {
    check(attach.url === String(server.url) && attach.authorization === auth, "httpAttach가 스레드 설정의 주소·헤더와 같다");
  }
  return { url: String(server.url), token: auth.replace(/^Bearer /, ""), approvalMode: String(server.default_tools_approval_mode ?? "") };
}

/** MCP 요청 1건. 응답은 이벤트 스트림 한 프레임이라 `data:` 줄을 파싱한다. */
async function rpc(url: string, token: string | null, body: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, text, json: line ? JSON.parse(line.slice(6)) : null };
}

// ── 시험용 서술자 — 실제 3툴과 같은 모양이되 핸들러가 받은 컨텍스트를 그대로 돌려준다 ──

const seen: { cwd: string[]; approvals: string[] } = { cwd: [], approvals: [] };
let handlerRuns = 0;

const echoTool = (name: string, autoApprove: boolean): KnowledgeToolDefinition =>
  ({
    name: name as KnowledgeToolDefinition["name"],
    description: `echo ${name}`,
    parameters: {
      query: { kind: "string", description: "검색어" },
      limit: { kind: "integer", optional: true, min: 1, max: 10, description: "개수" },
      role: { kind: "enum", values: ["user", "assistant"], optional: true, description: "역할" },
    },
    binding: "session",
    autoApprove,
    async handler(args, ctx) {
      handlerRuns++;
      seen.cwd.push(ctx.cwd);
      return textResult(`cwd=${ctx.cwd} args=${JSON.stringify(args)} provider=${ctx.services.provider}`);
    },
  }) as KnowledgeToolDefinition;

// ── 세션 둘을 서로 다른 작업 폴더로 연다 ──

const cwdA = path.join(DATA_DIR, "projectA");
const cwdB = path.join(DATA_DIR, "projectB");
fs.mkdirSync(cwdA, { recursive: true });
fs.mkdirSync(cwdB, { recursive: true });

const bridgeA = await openKnowledgeBridge({
  sessionId: "sessionA",
  cwd: cwdA,
  services: codexServices,
  tools: [echoTool("session_search", true), echoTool("remember", false)],
  approve: async (def) => {
    seen.approvals.push(def.name);
    return { allow: false, message: "테스트에서 거부" };
  },
});
const bridgeB = await openKnowledgeBridge({
  sessionId: "sessionB",
  cwd: cwdB,
  services: codexServices,
  tools: [echoTool("session_search", true)],
  approve: async () => ({ allow: true }),
});
if (!bridgeA || !bridgeB) throw new Error("창구가 열리지 않았다");

const a = wire(codexThreadConfig(bridgeA.httpAttach), bridgeA.httpAttach);
const b = wire(codexThreadConfig(bridgeB.httpAttach), bridgeB.httpAttach);

// ── 규약 ──

const init = await rpc(a.url, a.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
check(init.status === 200 && init.json?.result?.protocolVersion === "2025-06-18", "initialize 응답이 규약 버전을 준다", init.json?.result);
check(init.text.startsWith("event: message\ndata: "), "응답이 이벤트 스트림 한 프레임이다(8a 함정 8)", init.text.slice(0, 24));

const notif = await fetch(a.url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.token}` },
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
check(notif.status === 202 && (await notif.text()) === "", "알림(id 없음)은 202 무본문이다", notif.status);

const unknown = await rpc(a.url, a.token, { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} });
check(unknown.json?.error?.code === -32601, "우리가 안 여는 기능은 '그런 것 없음' 오류로 답한다(빈 성공 금지)", unknown.json);

// ── ② 도구 정의는 한 벌뿐이다 ──

const list = await rpc(a.url, a.token, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
const listed = (list.json?.result?.tools ?? []) as Array<Record<string, any>>;
check(listed.map((t) => t.name).join(",") === "session_search,remember", "등록한 서술자만 목록에 나온다", listed.map((t) => t.name));
check(
  JSON.stringify(listed[0]) === JSON.stringify(toMcpTool(echoTool("session_search", true))),
  "목록 항목이 서술자 변환 결과와 글자 단위로 같다(창구가 스키마를 다시 적지 않는다)",
);
check(
  JSON.stringify(listed[0].inputSchema.required) === JSON.stringify(["query"]) &&
    listed[0].inputSchema.properties.limit.minimum === 1 &&
    listed[0].inputSchema.properties.role.enum.join(",") === "user,assistant",
  "필수·범위·선택지가 서술자에서 그대로 옮겨진다",
  listed[0].inputSchema,
);

// 실제 3툴도 같은 규칙으로 옮겨지는지 — 이름과 필수 인자가 서술자와 일치해야 한다.
const realTools = buildKnowledgeTools();
const todoSeen: unknown[] = [];
const realBridge = await openKnowledgeBridge({
  sessionId: "sessionReal",
  cwd: cwdA,
  services: codexServices,
  tools: realTools,
  approve: async () => ({ allow: true }),
  onTodoList: (items) => todoSeen.push(items),
});
if (realBridge) {
  const r = wire(codexThreadConfig(realBridge.httpAttach));
  const realList = await rpc(r.url, r.token, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
  const names = (realList.json?.result?.tools ?? []).map((t: any) => t.name);
  check(
    names.join(",") === realTools.map((t) => t.name).join(","),
    "실제 지식툴 목록이 중립 서술자 목록과 같다(재정의 0)",
    names,
  );
  check(
    !names.some((n: string) => JSON.stringify(realList.json.result.tools.find((t: any) => t.name === n)) !==
      JSON.stringify(toMcpTool(realTools.find((t) => t.name === n)!))),
    "실제 지식툴 스키마도 서술자 변환 결과와 글자 단위로 같다",
  );
}
/** 실제 세 도구를 실행해 볼 때 쓰는 창구 설정(아래 블록에서 소비하고 거기서 닫는다). */
const realBridgeConfig = realBridge ? codexThreadConfig(realBridge.httpAttach) : undefined;

// ── ① 세션 경계 ──

const callA = await rpc(a.url, a.token, {
  jsonrpc: "2.0",
  id: 5,
  method: "tools/call",
  // 모델이 남의 폴더를 인자로 지정하려 든다 — 스키마에 없는 값이라 무시돼야 한다.
  params: { name: "session_search", arguments: { query: "x", cwd: cwdB } },
});
const textA = String(callA.json?.result?.content?.[0]?.text ?? "");
check(textA.includes(`cwd=${cwdA}`), "핸들러가 받는 작업 폴더는 서버가 채운 이 세션의 것이다", textA.slice(0, 80));
check(!textA.includes(`cwd=${cwdB}`), "인자로 지정한 남의 폴더는 무시된다(모델이 폴더를 못 고른다)");
check(textA.includes("provider=codex"), "보조 모델은 이 세션 provider의 것이다(D6)");

const callCross = await rpc(b.url, a.token, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "session_search", arguments: { query: "x" } } });
const textCross = String(callCross.json?.result?.content?.[0]?.text ?? "");
check(textCross.includes(`cwd=${cwdA}`) && !textCross.includes(`cwd=${cwdB}`), "토큰 하나는 정확히 한 세션에 대응한다(주소가 같아도 토큰이 폴더를 정한다)", textCross.slice(0, 80));

const noToken = await rpc(a.url, null, { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
check(noToken.status === 401, "토큰 없는 요청은 401", noToken.status);
const badToken = await rpc(a.url, "not-a-real-token", { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} });
check(badToken.status === 401, "틀린 토큰은 401", badToken.status);

// 도구 이름에 문자열로 바꿀 수 없는 객체가 와도 거부가 새지 않고 500으로 끝나며 창구가 계속 산다
const weird = await rpc(a.url, a.token, { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: { toString: 1, valueOf: 1 }, arguments: {} } });
check(weird.status === 500, "처리 중 예외는 500으로 끝난다(미처리 거부로 새지 않는다)", weird.status);
const afterWeird = await rpc(a.url, a.token, { jsonrpc: "2.0", id: 21, method: "tools/list", params: {} });
check(afterWeird.status === 200 && afterWeird.json?.result?.tools?.length === 2, "예외 뒤에도 창구가 정상 응답한다", afterWeird.status);

// ── ③ 승인 규칙 ──

const runsBefore = handlerRuns;
const denied = await rpc(a.url, a.token, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "remember", arguments: { query: "x" } } });
check(seen.approvals.join(",") === "remember", "카드가 필요한 도구는 세션에 물어본다", seen.approvals);
check(denied.json?.result?.isError === true, "거부는 오류 결과로 되돌아간다", denied.json?.result);
check(handlerRuns === runsBefore, "거부되면 핸들러가 아예 안 돈다", { runsBefore, handlerRuns });
check(a.approvalMode === "approve", "Codex 쪽 MCP 승인은 창구에 맡긴다(도구별 판정을 우리가 한다)", a.approvalMode);

// ── 실제 도구가 창구를 지나 진짜로 일한다 ──
//   목록에 이름이 보이는 것만으로는 부족하다. 하나라도 실행 경로가 끊기면 목록 검사는 통과하는데
//   모델이 부르는 순간 실패한다. 여기서는 부작용까지 확인한다(외부 검토 지적).
{
  const realWire = wire(realBridgeConfig!);
  const call = (id: number, name: string, args: Record<string, unknown>) =>
    rpc(realWire.url, realWire.token, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

  const searched = await call(30, "session_search", { query: "aether" });
  check(String(searched.json?.result?.content?.[0]?.text ?? "").length > 0, "실제 과거검색이 창구를 지나 글을 돌려준다", searched.json?.result);

  // 할 일 도구: 스키마가 객체 배열이고, 호출하면 세션이 넘긴 콜백이 항목을 받는다.
  const listedReal = await rpc(realWire.url, realWire.token, { jsonrpc: "2.0", id: 31, method: "tools/list", params: {} });
  const todoSchema = (listedReal.json?.result?.tools ?? []).find((t: any) => t.name === "todo_update")?.inputSchema;
  check(
    todoSchema?.properties?.items?.type === "array" && todoSchema.properties.items.items?.type === "object" &&
      todoSchema.properties.items.maxItems === 50 && todoSchema.properties.items.items.required?.join(",") === "text,status",
    "todo_update 스키마가 객체 배열(text·status 필수, 최대 50)로 옮겨진다",
    todoSchema,
  );
  const todoOk = await call(32, "todo_update", { items: [{ text: " 읽기 ", status: "completed" }, { text: "고치기", status: "in_progress" }], cwd: cwdB });
  check(JSON.stringify(todoSeen) === JSON.stringify([[{ text: "읽기", status: "completed" }, { text: "고치기", status: "in_progress" }]]), "todo_update 호출이 세션 콜백에 항목을 넘긴다(공백은 잘림)", todoSeen);
  check(String(todoOk.json?.result?.content?.[0]?.text ?? "").includes("1/2"), "성공 결과에 완료 수가 담긴다", todoOk.json?.result);
  await call(33, "todo_update", { items: [{ text: "x", status: "done" }] });
  await call(34, "todo_update", { items: "문자열" });
  check(todoSeen.length === 1, "잘못된 입력은 콜백 없이 끝난다", todoSeen);
  realBridge?.dispose();
}

// ── 선언 안 한 인자는 핸들러에 닿지 않는다(외부 검토 지적) ──
//   지금 핸들러들은 전부 서버가 준 폴더만 쓰지만, 모델이 보낸 값이 핸들러까지 도달하는 상태를 남겨두면
//   나중에 누가 그걸 읽는 순간 경계가 뚫린다. 방어는 관례가 아니라 어댑터에 있어야 한다.
const sneaky = await rpc(a.url, a.token, {
  jsonrpc: "2.0",
  id: 12,
  method: "tools/call",
  params: { name: "session_search", arguments: { query: "x", cwd: cwdB, services: "가짜" } },
});
const sneakyText = String(sneaky.json?.result?.content?.[0]?.text ?? "");
check(!sneakyText.includes('"cwd"') && !sneakyText.includes('"services"'), "선언 안 한 인자는 핸들러에 전달되지 않는다", sneakyText.slice(0, 120));

// ── 되물음 폴백(D5.4) ──

const asked: Array<{ question: string; header?: string; options: string[] }> = [];
const askBridge = await openKnowledgeBridge({
  sessionId: "sessionAsk",
  cwd: cwdA,
  services: codexServices,
  tools: [], // 지식툴이 전부 꺼져 있어도 되물음 통로는 살아 있어야 한다
  approve: async () => ({ allow: true }),
  askUser: async (question, header, options) => {
    asked.push({ question, header, options });
    return { answered: true, text: "운영" };
  },
});
if (!askBridge) throw new Error("되물음 창구가 열리지 않았다");
const ask = wire(codexThreadConfig(askBridge.httpAttach));
const askList = await rpc(ask.url, ask.token, { jsonrpc: "2.0", id: 20, method: "tools/list", params: {} });
check(
  (askList.json?.result?.tools ?? []).map((t: any) => t.name).join(",") === "ask_user",
  "지식툴이 없어도 되물음 도구는 열린다(질문 카드 정본이 막혔을 때의 폴백)",
  (askList.json?.result?.tools ?? []).map((t: any) => t.name),
);
const askCall = await rpc(ask.url, ask.token, {
  jsonrpc: "2.0",
  id: 21,
  method: "tools/call",
  params: { name: "ask_user", arguments: { question: "어디에 배포할까?", header: "배포", options: "운영\n테스트" } },
});
check(asked.length === 1 && asked[0].question === "어디에 배포할까?", "되물음이 세션의 질문 카드로 넘어간다", asked);
check(asked[0].options.join(",") === "운영,테스트", "선택지가 줄 단위로 갈라져 전달된다", asked[0].options);
check(String(askCall.json?.result?.content?.[0]?.text ?? "") === "운영", "사용자가 고른 답이 도구 결과로 되돌아간다", askCall.json?.result);
// 카드가 뜨는 도구는 사용자가 답할 때까지 응답이 안 나간다 — 상대의 기본 상한(60초)으로는 폰에서 못 답한다.
check(Number((codexThreadConfig(askBridge.httpAttach).mcp_servers as any).aether.tool_timeout_sec) >= 600, "응답 대기 상한을 사람이 답할 만큼 늘려 둔다", (codexThreadConfig(askBridge.httpAttach).mcp_servers as any).aether.tool_timeout_sec);
askBridge.dispose();

// 되물음 통로를 안 주면 그 도구도 없다(Claude는 native 우회가 이미 있어 이 도구가 필요 없다).
const noAsk = await openKnowledgeBridge({ sessionId: "sessionNoAsk", cwd: cwdA, services: codexServices, tools: [echoTool("session_search", true)], approve: async () => ({ allow: true }) });
const noAskWire = wire(codexThreadConfig(noAsk!.httpAttach));
const noAskList = await rpc(noAskWire.url, noAskWire.token, { jsonrpc: "2.0", id: 22, method: "tools/list", params: {} });
check(!(noAskList.json?.result?.tools ?? []).some((t: any) => t.name === "ask_user"), "되물음 통로가 없으면 그 도구도 안 열린다");
noAsk!.dispose();

// ── 수명 ──

bridgeA.dispose();
const afterDispose = await rpc(a.url, a.token, { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
check(afterDispose.status === 401, "세션이 끝나면 그 토큰은 즉시 401", afterDispose.status);
const stillB = await rpc(b.url, b.token, { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} });
check(stillB.status === 200, "한 세션이 나가도 다른 세션은 계속 쓴다", stillB.status);

bridgeA.dispose(); // 멱등
check(knowledgeBridgeStatus().registrations === 1, "정리는 멱등이다(두 번 불러도 남은 세션이 안 지워진다)", knowledgeBridgeStatus());

bridgeB.dispose();
check(knowledgeBridgeStatus().listening === false, "마지막 세션이 나가면 창구 자체가 닫힌다", knowledgeBridgeStatus());

// ── 열기와 닫기가 겹쳐도 창구가 사라지지 않는다(외부 검토 지적) ──
//   새 세션이 포트를 잡는 사이에 마지막 세션이 나가면, 예전에는 그 틈에 창구가 닫혀 새 세션이
//   **이미 닫힌 포트**를 물려받았다(등록은 있는데 서버는 없는 모순).
{
  const solo = await openKnowledgeBridge({ sessionId: "solo", cwd: cwdA, services: codexServices, tools: [echoTool("session_search", true)], approve: async () => ({ allow: true }) });
  const opening = openKnowledgeBridge({ sessionId: "racer", cwd: cwdA, services: codexServices, tools: [echoTool("session_search", true)], approve: async () => ({ allow: true }) });
  solo!.dispose(); // 여는 도중에 마지막 세션이 나간다
  const racer = await opening;
  const racerWire = wire(codexThreadConfig(racer!.httpAttach));
  const racerCall = await rpc(racerWire.url, racerWire.token, { jsonrpc: "2.0", id: 13, method: "tools/list", params: {} });
  check(racerCall.status === 200, "여는 도중 마지막 세션이 나가도 새 세션의 창구는 살아 있다", `status=${racerCall.status}`);
  check(knowledgeBridgeStatus().listening === true, "그 순간에도 창구는 떠 있다", knowledgeBridgeStatus());
  racer!.dispose();
}


fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} knowledge_bridge: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
