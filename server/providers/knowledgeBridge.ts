import { failuresFor } from "./failureTracking";
import { reportError } from "../observability/report";
/**
 * 프로세스가 분리된 실행기(Codex·Grok 등)가 같이 쓰는 지식 도구 HTTP 창구 (Phase 8g · D8/D8.1).
 *
 * Claude는 지식툴을 프로세스 안에서 직접 붙이지만(`providers/claude/knowledgeMcp.ts`), 별도
 * 프로세스로 도는 실행기는 붙일 방법이 HTTP 창구 하나뿐이다. 이 파일은 **서술자를 그 창구 형식으로 옮기기만** 한다 —
 * 스키마도 핸들러도 권한 규칙도 여기서 다시 정의하지 않는다(두 벌이 되면 한쪽만 고치는 버그가 구조적으로 생긴다).
 *
 * ## 자격증명을 어디로 넘기나 (8g 실측으로 8a 결론을 바꿈)
 *
 * 8a는 토큰을 **프로세스 환경변수**로 넘기고 "실행 인자에는 안 보인다"까지 확인한 뒤, 환경변수 노출은
 * "자기 세션 권한이라 괜찮다"로 남겼다. 8g에서 그 전제를 다시 쟀고 두 가지가 나왔다.
 *   ① macOS에서 **같은 계정의 아무 프로세스나 `ps eww`로 남의 환경변수를 읽는다**(실측). 세션마다
 *      프로세스를 나눠도 A 세션이 B 세션 토큰을 주울 수 있다는 뜻이라, 자기 세션 범위를 넘는다.
 *   ② 그런데 **스레드를 시작할 때 설정을 통째로 넘기는 자리**(`thread/start`·`thread/resume`의 `config`)로
 *      서버 정의와 토큰을 같이 보낼 수 있다. 이러면 토큰이 환경변수에도 실행 인자에도 안 남는다(실측 성립,
 *      헤더 수신 확인, Codex 자기 대화 기록에도 안 남음).
 * 그래서 이 파일은 ②를 쓴다. 토큰은 이 서버 프로세스의 기억 안에만 있고, 모델이 도는 프로세스의
 * 관측 가능한 표면(환경·인자·기록 파일) 어디에도 두지 않는다. 재현 방법은
 * 내부 실측의 `bridgecred` 시나리오.
 *
 * ## 세션 경계
 *
 * 토큰 하나가 정확히 세션 하나(그 세션의 작업 폴더와 보조 모델)에 대응한다. 모델은 작업 폴더를 인자로 줄 수
 * 없고 스키마에도 없다 — Claude 경로와 같은 규칙이다(D8). 세션이 끝나면 토큰은 즉시 버려지고, 그 뒤의
 * 요청은 401이다.
 *
 * ## 승인
 *
 * 서술자에는 도구마다 "카드 없이 허용해도 되는가"가 붙어 있고 그 값은 사용자 설정을 따른다
 * (지금 도구는 모두 자동 허용이다). 카드가 필요한 도구는 **이 창구가**
 * 세션에 물어보고 답이 올 때까지 응답을 붙잡는다. Codex 쪽 MCP 승인 설정에 맡기지 않는 이유는 둘이다.
 * 그쪽은 도구 단위로 못 가르고, 카드에 우리 문맥(무엇을 어디에 쓰는지)을 실을 수 없다.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { pick } from "../i18n";
import { textResult, type KnowledgeParam, type KnowledgeToolDefinition, type KnowledgeToolResult } from "../knowledge/types";
import type { TodoItem } from "../../shared/agentEvent";
import type { ProviderServices } from "./types";

/** 모델이 보는 MCP 서버 이름 — Claude 쪽과 같은 이름을 쓴다(도구 이름 접두사가 같아진다). 실행기 어댑터도 이 이름으로 붙인다. */
export const MCP_SERVER_NAME = "aether";

/** 우리가 말하는 MCP 규약 버전. 8a에서 이 값으로 실호출이 성립했다. */
const PROTOCOL_VERSION = "2025-06-18";

/** 요청 본문 상한. 지식툴 인자는 짧다 — 이보다 큰 것은 정상 호출이 아니다. */
const MAX_BODY_BYTES = 1024 * 1024;

/** 카드가 필요한 도구를 부를 때 세션에 물어보는 통로. 세션이 승인 카드를 띄우고 답을 기다린다. */
export type BridgeApproval = (
  def: KnowledgeToolDefinition,
  args: Record<string, unknown>,
) => Promise<{ allow: boolean; message?: string }>;

/** 모델이 사용자에게 되묻는 통로(폴백). 답이 올 때까지 창구가 응답을 붙잡는다. */
export type BridgeAskUser = (question: string, header: string | undefined, options: string[]) => Promise<{ answered: boolean; text: string }>;

export type KnowledgeBridgeOptions = {
  sessionId: string;
  cwd: string;
  /** 이 세션 provider의 보조 모델 — 검색결과 요약이 세션 provider를 따르게 하는 통로(D6). */
  services: ProviderServices;
  tools: KnowledgeToolDefinition[];
  approve: BridgeApproval;
  /** 있으면 되물음 도구(`ask_user`)를 하나 더 연다 — 질문 카드 정본이 막혔을 때의 폴백(D5.4). */
  askUser?: BridgeAskUser;
  /** 관측 카운터 meta 전용. 화면 계약에 안 실음. */
  engine?: string;
  /** 할 일 도구가 목록을 넘기는 통로(없으면 도구가 쓸 수 없다고 답한다). */
  onTodoList?: (items: TodoItem[]) => void;
};

/** 창구 주소와 헤더 자격증명. 호출자(실행기 어댑터)가 자기 프로토콜 형식으로 옮긴다. */
export type KnowledgeHttpAttach = {
  url: string;
  /** `Bearer <token>` — 환경변수가 아니라 헤더 값이다. */
  authorization: string;
};

export type KnowledgeBridge = {
  /** 주소·헤더만. 호출자가 자기 프로토콜 형식으로 옮긴다. */
  readonly httpAttach: KnowledgeHttpAttach;
  /** 이 세션의 토큰을 버린다(멱등). 마지막 세션이 나가면 창구 자체가 닫힌다. */
  dispose(): void;
};

type Registration = KnowledgeBridgeOptions & { token: string };

/** 토큰 → 세션. 이 표가 곧 세션 경계다. */
const registry = new Map<string, Registration>();

let server: Server | null = null;
let listening: Promise<number> | null = null;
/**
 * 포트를 잡는 중이지만 아직 등록표에 안 들어간 세션 수.
 *
 * 이걸 안 세면 열기와 닫기가 엇갈린다. 새 세션이 `await ensureServer()`에서 한 번 양보하는 사이에
 * 마지막 세션이 나가면 "등록 0개"로 보여 창구가 닫히고, 돌아온 새 세션은 **방금 닫힌 포트**에 자기를
 * 등록한다. 그러면 등록은 있는데 서버는 없는 모순 상태가 되고 그 세션의 도구 호출이 전부 실패한다
 * (외부 검토 지적, 2026-08-18).
 */
let pendingOpens = 0;

/** 창구를 띄우고 포트를 돌려준다. 이미 떠 있으면 그 포트를 그대로 준다. */
function ensureServer(): Promise<number> {
  if (listening) return listening;
  const srv = createServer((req, res) => void handle(req, res));
  server = srv;
  listening = new Promise<number>((resolve, reject) => {
    srv.once("error", (e) => {
      // 실패한 약속을 그대로 두면 이후 모든 세션이 같은 실패를 물려받는다 — 상태를 비워 다음 시도가
      //   새로 띄우게 한다(그 사이 다른 서버가 떴으면 건드리지 않는다).
      if (server === srv) {
        server = null;
        listening = null;
      }
      reject(e);
    });
    // 127.0.0.1에만 묶는다 — 이 창구는 같은 기계의 실행기 프로세스만 부른다(D8).
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("지식툴 창구 포트를 확인하지 못했다"));
    });
  });
  return listening;
}

function closeServerIfIdle(): void {
  // 등록된 세션도 없고 **여는 중인 세션도 없을 때만** 닫는다(위 `pendingOpens` 주석).
  if (registry.size > 0 || pendingOpens > 0 || !server) return;
  const srv = server;
  server = null;
  listening = null;
  srv.close();
}

/**
 * 이 세션의 지식툴을 창구에 등록한다. 켜진 도구가 없으면 null(실행기 설정에 아무것도 안 얹는다).
 * 반환된 주소·헤더는 실행기가 세션을 시작하거나 이어갈 때마다 다시 넘겨야 한다.
 */
export async function openKnowledgeBridge(opts: KnowledgeBridgeOptions): Promise<KnowledgeBridge | null> {
  const tools = opts.askUser ? [...opts.tools, askUserTool(opts.askUser)] : opts.tools;
  if (!tools.length) return null;
  // ★ 포트를 잡는 것부터 등록표에 들어가는 것까지가 한 덩어리다. 중간에 세어지지 않는 순간이 있으면
  //   그 틈에 마지막 세션이 나가면서 창구를 닫아 버린다(위 `pendingOpens` 주석).
  pendingOpens++;
  try {
    const port = await ensureServer();
    // 32바이트 난수 — 추측으로 맞출 수 있는 크기가 아니다.
    const token = randomBytes(32).toString("base64url");
    registry.set(token, { ...opts, tools, token });
    const url = `http://127.0.0.1:${port}/mcp`;
    const authorization = `Bearer ${token}`;
    let disposed = false;
    return {
      httpAttach: { url, authorization },
      dispose() {
        if (disposed) return;
        disposed = true;
        registry.delete(token);
        closeServerIfIdle();
      },
    };
  } finally {
    pendingOpens--;
  }
}

/** 테스트가 창구 상태를 확인할 때 쓴다(등록 수·포트). 프로덕션 경로는 부르지 않는다. */
export function knowledgeBridgeStatus(): { registrations: number; listening: boolean } {
  return { registrations: registry.size, listening: !!server };
}

/**
 * 되물음 도구 — 질문 카드 정본이 막혔을 때의 폴백(D5.4, 8a에서 왕복 실증).
 *
 * 지식툴과 같은 모양으로 만들어 부착 경로를 하나로 유지한다. 다만 이건 지식이 아니라 **질문 통로**라
 * 중립 서술자 목록(`buildKnowledgeTools()`)에는 들어가지 않고 이 창구에서만 만들어진다.
 * 카드가 떠야 하는 도구이므로 자동 허용이 아니라 — 정확히는, 카드 자체가 이 도구의 동작이다.
 */
function askUserTool(ask: BridgeAskUser): KnowledgeToolDefinition {
  return {
    name: "ask_user",
    description: pick({
      ko: "사용자에게 물어보고 답을 받는다. 진행에 필요한 결정이 사용자에게 달렸을 때만 쓴다(추측 금지). 답이 올 때까지 기다린다.",
      en: "Ask the user a question and wait for the answer. Use only when a decision genuinely belongs to the user (do not guess). Blocks until answered.",
    }),
    parameters: {
      question: { kind: "string", description: pick({ ko: "물어볼 내용(완결된 문장).", en: "The question to ask (a complete sentence)." }) },
      header: { kind: "string", optional: true, description: pick({ ko: "짧은 제목(12자 이내).", en: "Short label (max 12 chars)." }) },
      options: { kind: "string", optional: true, description: pick({ ko: "선택지를 줄바꿈으로 구분해 적는다. 없으면 자유 입력.", en: "Newline-separated options. Omit for free-form input." }) },
    },
    binding: "session",
    // 이 도구는 그 자체가 사용자에게 묻는 일이라 앞단에 승인 카드를 또 세우지 않는다.
    autoApprove: true,
    async handler(args) {
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) return textResult(pick({ ko: "question이 필요하다", en: "question is required" }));
      const options = typeof args.options === "string" ? args.options.split("\n").map((o) => o.trim()).filter(Boolean) : [];
      const header = typeof args.header === "string" && args.header.trim() ? args.header.trim() : undefined;
      const out = await ask(question, header, options);
      return textResult(out.text || pick({ ko: "사용자가 답하지 않았다", en: "The user did not answer" }));
    },
  };
}

// ── 서술자 → MCP 스키마 ──

function paramSchema(p: KnowledgeParam): Record<string, unknown> {
  if (p.kind === "string") return { type: "string", description: p.description };
  if (p.kind === "integer") {
    return {
      type: "integer",
      description: p.description,
      ...(p.min !== undefined ? { minimum: p.min } : {}),
      ...(p.max !== undefined ? { maximum: p.max } : {}),
    };
  }
  if (p.kind === "list") {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, field] of Object.entries(p.fields)) {
      properties[name] = paramSchema(field);
      if (!field.optional) required.push(name);
    }
    return {
      type: "array",
      description: p.description,
      items: { type: "object", properties, ...(required.length ? { required } : {}) },
      ...(p.maxItems !== undefined ? { maxItems: p.maxItems } : {}),
    };
  }
  return { type: "string", enum: [...p.values], description: p.description };
}

/** 서술자 1개 → MCP `tools/list` 항목. 이름·설명·인자는 전부 서술자에서 나온다(재정의 없음). */
export function toMcpTool(def: KnowledgeToolDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(def.parameters)) {
    properties[name] = paramSchema(p);
    if (!p.optional) required.push(name);
  }
  return {
    name: def.name,
    description: def.description,
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
  };
}

// ── HTTP 처리 ──

type JsonRpcRequest = { id?: unknown; method?: unknown; params?: unknown };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("본문이 상한을 넘었다"));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** 요청 하나에 대한 응답 — streamable HTTP MCP 규약대로 이벤트 스트림 한 프레임으로 보낸다(8a 함정 8). */
function replyFrame(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "close" });
  res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

function bearerToken(req: IncomingMessage): string {
  const raw = req.headers["authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    // 본문 크기 제한 초과는 정상 입력 거절이다.
    res.writeHead(413).end();
    return;
  }
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(body) as JsonRpcRequest;
  } catch {
    // 잘못된 JSON 본문은 정상 입력 거절이다.
    res.writeHead(400).end();
    return;
  }
  // 알림(id 없음)은 본문 없는 202로 답한다 — 규약을 어기면 상대가 해석 오류 루프에 빠진다(8a 함정 8).
  if (msg?.id === undefined || msg.id === null) {
    res.writeHead(202).end();
    return;
  }
  const reg = registry.get(bearerToken(req));
  if (!reg) {
    // 토큰이 없거나 이미 버려진 세션 것이다. 어느 쪽인지 밝히지 않는다.
    res.writeHead(401).end();
    return;
  }
  const id = msg.id;
  const method = typeof msg.method === "string" ? msg.method : "";
  if (method === "initialize") {
    replyFrame(res, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "ping") {
    replyFrame(res, { jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    replyFrame(res, { jsonrpc: "2.0", id, result: { tools: reg.tools.map(toMcpTool) } });
    return;
  }
  if (method === "tools/call") {
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
    const def = reg.tools.find((t) => t.name === params.name);
    if (!def) {
      replyFrame(res, { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${String(params.name)}` } });
      return;
    }
    const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
    replyFrame(res, { jsonrpc: "2.0", id, result: await runTool(reg, def, args) });
    return;
  }
  // 우리가 여는 것은 도구뿐이다(초기화 응답에 그렇게 적었다). 나머지는 규약대로 "그런 것 없음"으로 답한다.
  replyFrame(res, { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

/** 서술자가 선언한 인자만 남긴다 — 모델이 끼워 넣은 나머지는 핸들러에 닿지 않는다. */
export function declaredArgsOnly(def: KnowledgeToolDefinition, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(def.parameters)) {
    if (key in args) out[key] = args[key];
  }
  return out;
}

/** 도구 1회 실행 — 필요하면 승인 카드를 먼저 띄우고, 실패는 오류 결과로 되돌린다. */
async function runTool(
  reg: Registration,
  def: KnowledgeToolDefinition,
  args: Record<string, unknown>,
): Promise<KnowledgeToolResult & { isError?: boolean }> {
  if (!def.autoApprove) {
    const out = await reg.approve(def, args).then(out => { failuresFor(reg).clear("mcp.approval.request"); return out; }).catch((e) => { failuresFor(reg).report(e, { component: "mcp", operation: "mcp.approval.request", session_id: reg.sessionId }); return ({ allow: false, message: String((e as Error)?.message ?? e) }); });
    if (!out.allow) {
      return { ...textResult(out.message || pick({ ko: "사용자가 거부했다", en: "The user declined" })), isError: true };
    }
  }
  try {
    // cwd와 보조 모델은 **서버가 세션에서 채운다** — 모델이 인자로 줄 수 없다(D8 보안 경계).
    //   ★ 선언되지 않은 인자는 여기서 버린다. 지금 핸들러들은 전부 서버가 준 값만 쓰지만, 모델이 보낸
    //   `cwd` 같은 것이 핸들러까지 도달하는 상태 자체를 남겨두면 나중에 누군가 그걸 읽는 순간 경계가
    //   뚫린다(외부 검토 지적, 2026-08-18). 방어는 관례가 아니라 어댑터에 있어야 한다.
    return await def.handler(declaredArgsOnly(def, args), {
      cwd: reg.cwd,
      services: reg.services,
      sessionId: reg.sessionId,
      engine: reg.engine,
      onTodoList: reg.onTodoList,
    });
  } catch (e) {
    void reportError(e, { component: "mcp", operation: "mcp.tool.call", context: { tool: def.name }, session_id: reg.sessionId });
    const message = String((e as Error)?.message ?? e);
    console.error(`[aether] 지식툴 '${def.name}' 실행 실패(세션 ${reg.sessionId}):`, message);
    return { ...textResult(pick({ ko: `도구 실행 실패: ${message}`, en: `Tool failed: ${message}` })), isError: true };
  }
}
