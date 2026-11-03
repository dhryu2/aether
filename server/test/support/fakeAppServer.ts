/**
 * 가짜 codex app-server (Phase 8e 시험대) — 모델 호출 0, 사용량 0.
 *
 * 진짜 `codex app-server`처럼 표준입출력으로 JSON-RPC 2.0을 말하되, 응답 내용은 대본대로만 낸다.
 * 이걸 만드는 이유: 승인 왕복·프로세스 크래시·통신 이상처럼 **실제 모델로는 매번 재현할 수 없는 상황**을
 * 결정적으로 반복 검증하기 위해서다. 실모델 카나리는 "정말 되나"를 보고, 이 시험대는 "언제나 되나"를 본다.
 *
 * 쓰는 법: 이 파일을 실행하는 작은 실행 스크립트를 만들고 그 경로를 `AETHER_CODEX_BIN`으로 지정한다
 * (`makeFakeCodexBin()` 참고). 그러면 서버 코드는 자기가 진짜 codex를 띄운 줄 안다.
 *
 * 8e 단위 1 범위 = 통신선 자체의 계약만. 스레드·턴 흉내는 단위 3에서 더한다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 이 가짜 서버를 `codex` 실행 파일인 척 띄우는 실행 스크립트를 임시 폴더에 만든다.
 * 반환 경로를 `AETHER_CODEX_BIN`에 넣으면 서버의 실제 spawn 경로를 그대로 지나간다(인자 조립 포함).
 */
export function makeFakeCodexBin(): { bin: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-fake-codex-"));
  const bin = path.join(dir, "codex");
  const tsx = path.resolve(HERE, "..", "..", "node_modules", ".bin", "tsx");
  const script = path.join(HERE, "fakeAppServer.ts");
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(tsx)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return { bin, dir };
}

// ── 아래는 자식 프로세스로 실행됐을 때만 도는 본체 ──

/** 이 파일이 직접 실행됐는가(라이브러리로 import된 경우와 구분). */
const isMain = process.argv[1] ? fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) : false;

type Json = Record<string, unknown>;

/** 이 시험대가 돌려주는 스레드 식별자 — 진짜처럼 UUID 모양이어야 한다(형식 검증을 지나가야 하므로). */
export const FAKE_THREAD_ID = "01a01111-2222-7333-8444-555566667777";

function send(obj: Json) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function main() {
  // 진짜 app-server는 첫 인자가 `app-server`다. 서버가 인자를 제대로 조립했는지 여기서 확인해 준다.
  const argv = process.argv.slice(2);
  if (argv[0] !== "app-server") {
    process.stderr.write(`fake app-server: 첫 인자가 app-server가 아니다(${argv.join(" ")})\n`);
    process.exit(2);
  }
  // `-c key=value` 오버라이드를 그대로 보관 — 테스트가 `test/configOverrides`로 확인한다.
  const overrides: string[] = [];
  for (let i = 1; i < argv.length; i++) if (argv[i] === "-c" && argv[i + 1]) overrides.push(argv[++i]);

  if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR + "\n");

  let initialized = false;
  let nextId = 1;
  /** 우리가 클라이언트에 보낸 요청의 답을 기다리는 자리. */
  const awaitingAnswer = new Map<number, (result: unknown) => void>();

  // ── 계정·로그인 상태(8f) ──
  let loginSeq = 0;
  let lastLoginId = "login-0";

  // ── 스레드·턴 상태(단위 3) ──
  let threadId = "";
  let turnSeq = 0;
  let activeTurn: string | null = null;
  /** 스킬 목록 읽기를 느리게 실패시킬까(8g 회귀 — 실패 중에 들어온 변경 신호를 잃지 않는지). */
  let skillsListFailSlow = false;
  /**
   * `config/read`가 돌려줄 사용자 설정(8g · R22 — 승인 정책 배지 검증용).
   *
   * 기본값이 `{}`이면 안 된다. 실제 응답은 값이 null이어도 **키는 있다**(생성 타입 `Config`). 빈 객체를
   * 기본값으로 두면 "설정을 못 알아봤다"를 잡는 검사가 통과해 버려 아무것도 안 지킨다(2026-08-19 검토).
   */
  let fakeConfig: Json = { model: null, approval_policy: null };
  /** `config/read`가 함께 돌려줄 출처 메타(키 → 어느 설정 층에서 왔나). */
  let fakeOrigins: Json = {};
  /** `account/rateLimits/read`가 돌려줄 값(8h). 기본은 실측 그대로 — 창 하나·이름 없음·초 단위 리셋 시각. */
  let fakeRateLimits: Json = {
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: 1787617478 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: "plus",
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
  };
  const interrupted = new Set<string>();
  /** 받은 요청 기록 — 테스트가 "무엇을 어떤 순서로 보냈나"를 대조한다. */
  const calls: { method: string; params: Json }[] = [];
  /**
   * 기록을 파일로도 흘린다(`FAKE_CALLS_FILE`).
   *
   * 프로세스를 서버 코드가 직접 띄우고 직접 내리는 경우(배경 작업 격리 실행)에는 테스트가 그 프로세스에
   * 질문을 보낼 통로가 없다. 그래서 관측 결과를 파일에 남겨 두고 끝난 뒤에 읽는다.
   */
  const CALLS_FILE = process.env.FAKE_CALLS_FILE;
  function record(entry: { method: string; params: Json }) {
    calls.push(entry);
    if (!CALLS_FILE) return;
    try {
      fs.appendFileSync(CALLS_FILE, JSON.stringify(entry) + "\n");
    } catch {
      /* 관측용이라 실패해도 본 흐름을 막지 않는다 */
    }
  }
  // 뜨자마자 우리가 어떤 환경·설정으로 떠 있는지 남긴다 — 격리 구성 검증의 근거다.
  if (CALLS_FILE) {
    const home = process.env.CODEX_HOME ?? null;
    let entries: { name: string; mode: string }[] = [];
    try {
      entries = home
        ? fs.readdirSync(home).map((name) => ({ name, mode: (fs.statSync(path.join(home, name)).mode & 0o777).toString(8) }))
        : [];
    } catch {
      /* 없으면 빈 목록 */
    }
    // 환경변수는 **이름만** 남긴다 — 값을 기록에 담으면 그 파일이 새 비밀 저장소가 된다(R21 검증용).
    const aetherEnvNames = Object.keys(process.env).filter((n) => n.startsWith("AETHER_")).sort();
    record({ method: "__spawn", params: { codexHome: home, overrides, homeEntries: entries, aetherEnvNames } as unknown as Json });
  }
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** 한 턴을 알림으로 진행한다: 시작 → (필요하면 승인 요청) → 답변 → 사용량 → 종료. */
  async function runTurn(turnId: string, text: string) {
    const slow = text.includes("@@slow@@");
    if (text.includes("@@subthread@@")) send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "th-sub", turn: { id: "t-sub", items: [], itemsView: "full", status: "inProgress", error: null } } });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId, turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
    /** 서버 → 클라이언트 요청 한 번. 답을 기록에 남긴다(테스트가 무엇을 답했는지 대조한다). */
    async function askClient(label: string, method: string, params: Json) {
      const rid = nextId++;
      const answer = await new Promise<unknown>((resolve) => {
        awaitingAnswer.set(rid, resolve);
        send({ jsonrpc: "2.0", id: rid, method, params });
      });
      record({ method: label, params: answer as Json });
    }

    if (text.includes("@@ask@@")) {
      await askClient("approvalAnswer", "item/commandExecution/requestApproval", {
        threadId, turnId, itemId: "it-ask", startedAtMs: 1, environmentId: null,
        command: "rm -rf /tmp/demo", cwd: "/tmp", reason: "위험한 명령입니다", commandActions: [],
      });
    }
    if (text.includes("@@net@@")) {
      await askClient("networkAnswer", "item/commandExecution/requestApproval", {
        threadId, turnId, itemId: "it-net", startedAtMs: 1, environmentId: null,
        command: "curl https://example.com", cwd: "/tmp", reason: "네트워크 접근을 허용할까요?",
        commandActions: [], networkApprovalContext: { host: "example.com", protocol: "https" },
      });
    }
    if (text.includes("@@patch@@")) {
      // 파일 변경은 diff가 **항목 알림**에 먼저 오고 승인 요청엔 없다(8a 실측) — 그 순서를 그대로 흉내 낸다.
      const changes = [{ path: "src/app.ts", kind: { type: "update", move_path: null }, diff: "@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n context\n" }];
      send({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, startedAtMs: 1, item: { type: "fileChange", id: "it-patch", changes, status: "inProgress" } } });
      await askClient("fileChangeAnswer", "item/fileChange/requestApproval", { threadId, turnId, itemId: "it-patch", startedAtMs: 1, reason: "파일을 고쳐도 될까요?" });
    }
    if (text.includes("@@outpatch@@")) {
      // 작업 폴더 밖(상위 폴더로 빠지는 상대 경로)을 고치려는 변경 — 편집 자동 수락이어도 카드로 물어야 한다.
      const changes = [{ path: "../outside.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" }];
      send({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, startedAtMs: 1, item: { type: "fileChange", id: "it-out", changes, status: "inProgress" } } });
      await askClient("outPatchAnswer", "item/fileChange/requestApproval", { threadId, turnId, itemId: "it-out", startedAtMs: 1, reason: null });
    }
    if (text.includes("@@movepatch@@") || text.includes("@@movepatch2@@")) {
      // 폴더 안 파일을 폴더 밖으로 이름 바꾸는 변경. 원래 경로만 보면 폴더 안이라 오판하기 쉽다.
      const changes = [{ path: "src/inside.txt", kind: { type: "update", move_path: "../moved.txt" }, diff: "@@ -1 +1 @@\n-a\n+a\n" }];
      if (text.includes("@@movepatch2@@")) send({ jsonrpc: "2.0", method: "item/fileChange/patchUpdated", params: { threadId, turnId, itemId: "it-move", changes } });
      else send({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, startedAtMs: 1, item: { type: "fileChange", id: "it-move", changes, status: "inProgress" } } });
      await askClient("movePatchAnswer", "item/fileChange/requestApproval", { threadId, turnId, itemId: "it-move", startedAtMs: 1, reason: null });
    }
    if (text.includes("@@secretpatch@@")) {
      const changes = [{ path: "deploy/.env", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-TOKEN=old-1111\n+TOKEN=new-2222\n" }];
      send({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, startedAtMs: 1, item: { type: "fileChange", id: "it-secret", changes, status: "inProgress" } } });
      await askClient("secretPatchAnswer", "item/fileChange/requestApproval", { threadId, turnId, itemId: "it-secret", startedAtMs: 1, reason: null });
    }
    if (text.includes("@@perm@@")) {
      await askClient("permissionsAnswer", "item/permissions/requestApproval", {
        threadId, turnId, itemId: "it-perm", environmentId: null, startedAtMs: 1, cwd: "/tmp",
        reason: "작업 폴더 밖에 쓰고 싶습니다", permissions: { network: null, fileSystem: { read: null, write: ["/etc"] } },
      });
    }
    if (text.includes("@@question@@")) {
      await askClient("questionAnswer", "item/tool/requestUserInput", {
        threadId, turnId, itemId: "it-q", autoResolutionMs: null,
        questions: [{ id: "q1", header: "배포 대상", question: "어디에 배포할까요?", isOther: true, isSecret: false, options: [{ label: "운영", description: "실서버" }, { label: "테스트", description: "임시" }] }],
      });
    }
    if (text.includes("@@unknown@@")) {
      // 우리가 처리하지 않는 역방향 요청 — 빈 성공이 아니라 오류로 답해야 한다.
      await askClient("unknownAnswer", "account/chatgptAuthTokens/refresh", { threadId });
    }
    if (text.includes("@@hang@@")) {
      // 답을 기다리는 채로 턴을 끝낸다 — 보류 카드가 취소 신호로 정리되는지 보는 시나리오.
      void askClient("hangAnswer", "item/commandExecution/requestApproval", {
        threadId, turnId, itemId: "it-hang", startedAtMs: 1, environmentId: null,
        command: "sleep 999", cwd: "/tmp", reason: null, commandActions: [],
      });
      await wait(100);
    }
    if (text.includes("@@weirdtool@@")) {
      // 우리가 감시 목록에 적어 둔 적 없는 항목 종류 — 새 도구가 생겼을 때를 흉내 낸다.
      send({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, startedAtMs: 1, item: { type: "dynamicToolCall", id: "it-weird", status: "inProgress" } } });
    }
    if (text.includes("@@failturn@@")) {
      // 턴이 실패로 끝난다 — "끝났다"를 "됐다"로 읽으면 안 되는 경우다.
      activeTurn = null;
      send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "full", status: "failed", error: { message: "시험대 실패" }, startedAt: 1, completedAt: 2, durationMs: 3 } } });
      return;
    }
    if (slow) await wait(Number(process.env.FAKE_TURN_DELAY_MS ?? 400));
    if (interrupted.has(turnId)) {
      activeTurn = null;
      send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "full", status: "interrupted", error: null, startedAt: 1, completedAt: 2, durationMs: 5 } } });
      return;
    }
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId, completedAtMs: 2, item: { type: "agentMessage", id: `it-${turnId}`, text: `받음: ${text}`, phase: null, memoryCitation: null } } });
    // 8h에서 실제 계정으로 관측한 sparse 갱신 모양이다. 사용률만 알려 주므로 정보성으로 남고 배너는 뜨지 않는다.
    send({ jsonrpc: "2.0", method: "account/rateLimits/updated", params: { rateLimits: { limitId: null, limitName: null, primary: { usedPercent: 16, windowDurationMins: 10080, resetsAt: 1787617478 }, secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: "plus", rateLimitReachedType: null } } });
    send({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        tokenUsage: {
          total: { totalTokens: 9000, inputTokens: 8000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 0 },
          last: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
          modelContextWindow: 258400,
        },
      },
    });
    activeTurn = null;
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 7 } } });
  }

  const decoder = new StringDecoder("utf8");
  let buf = "";
  process.stdin.on("data", (chunk: Buffer) => {
    buf += decoder.write(chunk);
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) handleLine(line);
    }
  });
  // 표준입력이 닫히면(클라이언트가 정상 종료 절차를 밟았다) 우리도 끝낸다.
  process.stdin.on("end", () => process.exit(0));

  function handleLine(line: string) {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      return;
    }
    // 우리가 보낸 서버 요청에 대한 답
    if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
      const fn = awaitingAnswer.get(Number(msg.id));
      if (fn) {
        awaitingAnswer.delete(Number(msg.id));
        fn("error" in msg ? { error: msg.error } : msg.result);
      }
      return;
    }
    const method = typeof msg.method === "string" ? msg.method : "";
    if (msg.id === undefined) {
      if (method === "initialized") initialized = true;
      return;
    }
    void handleRequest(method, (msg.params ?? {}) as Json, msg.id as number | string);
  }

  async function handleRequest(method: string, params: Json, id: number | string) {
    const ok = (result: unknown) => send({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

    switch (method) {
      case "initialize":
        // 실제 app-server처럼 자기가 쓰는 설정 폴더를 알려준다 — 승인 정책 요약이 여기서 규칙 파일을 찾는다.
        return ok({ userAgent: "fake-app-server/0", codexHome: process.env.CODEX_HOME ?? "/tmp/fake-codex-home", platformFamily: "unix", platformOs: "macos" });

      // 응답 모양은 실제 codex 0.145.0에서 확인한 그대로다: 목록 키는 `data`이고,
      // 추론 강도는 문자열이 아니라 `{reasoningEffort, description}` 객체 배열이다.
      case "model/list":
        return ok({
          data: [
            {
              id: "gpt-5.4-mini",
              model: "gpt-5.4-mini",
              displayName: "GPT-5.4 mini",
              description: "가짜 저비용 모델",
              hidden: false,
              isDefault: false,
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "빠름" },
                { reasoningEffort: "medium", description: "보통" },
              ],
              defaultReasoningEffort: "medium",
            },
            {
              id: "gpt-5.6-terra",
              model: "gpt-5.6-terra",
              displayName: "GPT-5.6 terra",
              description: "가짜 상위 모델",
              hidden: false,
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "빠름" },
                { reasoningEffort: "medium", description: "보통" },
                { reasoningEffort: "high", description: "깊게" },
              ],
              defaultReasoningEffort: "medium",
            },
            {
              id: "gpt-5.4-nano",
              model: "gpt-5.4-nano",
              displayName: "GPT-5.4 nano",
              description: "가짜 강도 미지원 모델",
              hidden: false,
              isDefault: false,
              supportedReasoningEfforts: [],
              defaultReasoningEffort: "low",
            },
          ],
          nextCursor: null,
        });

      // ── 계정·로그인 흉내(8f) ──
      //   진짜와 같은 모양으로만 답한다: `account/read`는 계정 또는 null, 기기 코드 로그인은 주소와
      //   코드를 함께 주고, 완료는 나중에 별도 알림으로 온다. 그 "나중에"를 테스트가 `test/completeLogin`으로
      //   직접 당긴다 — 실제 로그인 없이 완료 통보 배선을 검증하기 위해서다.

      case "account/read":
        record({ method, params });
        if (process.env.FAKE_ACCOUNT === "none") return ok({ account: null, requiresOpenaiAuth: true });
        if (process.env.FAKE_ACCOUNT === "fail") return fail(-32000, "계정을 읽을 수 없다(시험대)");
        return ok({ account: { type: "chatgpt", email: "fake@example.invalid", planType: "plus" }, requiresOpenaiAuth: true });

      // 로그인 식별자는 시작할 때마다 다르다 — 진짜가 그렇고, 같은 값을 주면 "이전 로그인이 접혔는가"를
      //   구분할 수 없어 그 검사가 헛돈다.
      case "account/login/start":
        record({ method, params });
        if (process.env.FAKE_LOGIN_FAIL) return fail(-32000, process.env.FAKE_LOGIN_FAIL);
        lastLoginId = `login-${++loginSeq}`;
        if (params.type !== "chatgptDeviceCode") return ok({ type: "chatgpt", loginId: lastLoginId, authUrl: "https://example.invalid/oauth" });
        return ok({ type: "chatgptDeviceCode", loginId: lastLoginId, verificationUrl: "https://example.invalid/device", userCode: "FAKE-CODE" });

      case "account/login/cancel":
        record({ method, params });
        return ok({ status: "canceled" });

      /** 시험대 전용 — 완료 알림을 지금 보낸다(진짜에선 사용자가 폰에서 끝냈을 때 온다). */
      case "test/completeLogin":
        send({
          jsonrpc: "2.0",
          method: "account/login/completed",
          params: { loginId: params.loginId ?? lastLoginId, success: params.success !== false, error: params.error ?? null },
        });
        return ok({ sent: true });

      // ── 스레드·턴 흉내(단위 3) ──

      case "thread/start":
        record({ method, params });
        threadId = FAKE_THREAD_ID;
        return ok({
          thread: { id: threadId, ephemeral: false, status: "idle", turns: [] },
          model: params.model ?? "gpt-5.4-mini",
          instructionSources: [],
          approvalPolicy: params.approvalPolicy ?? "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
          reasoningEffort: "medium",
        });

      case "thread/resume":
        record({ method, params });
        threadId = String(params.threadId ?? FAKE_THREAD_ID);
        return ok({
          thread: { id: threadId, ephemeral: false, status: "idle", turns: [] },
          model: params.model ?? "gpt-5.4-mini",
          instructionSources: [],
          approvalPolicy: params.approvalPolicy ?? "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
          reasoningEffort: "medium",
        });

      /**
       * 사용자 설정 읽기(8g · R22) — 승인 정책 배지가 사실을 말하는지 보려면 이 응답이 필요하다.
       * `test/setConfig`로 시험대가 원하는 설정을 심는다(기본은 아무것도 안 켜진 깨끗한 설정).
       */
      case "config/read":
        record({ method, params });
        return ok({ config: fakeConfig, origins: fakeOrigins, layers: null });

      case "test/setConfig":
        fakeConfig = (params.config as Json) ?? {};
        fakeOrigins = (params.origins as Json) ?? {};
        return ok({ ok: true });

      /**
       * 구독 한도 조회(8h). 기본 응답은 실제 codex 0.145.0에서 찍은 모양 그대로다 —
       * 창에 이름이 없고 길이(분)와 사용률만 있으며, `resetsAt`은 초 단위 정수다.
       */
      case "account/rateLimits/read":
        record({ method, params });
        return ok(fakeRateLimits);

      case "test/setRateLimits":
        fakeRateLimits = params.value as Json;
        return ok({ ok: true });

      // ── 스킬 저장소 등록·읽기(8g) ──
      //   등록은 프로세스가 다시 뜨면 사라지므로 스레드를 열 때마다 다시 온다. 기록만 남기고 성립시킨다.
      case "skills/extraRoots/set":
        record({ method, params });
        return ok({});

      case "skills/list":
        record({ method, params });
        // 실패 모드: 목록 읽기가 느리게 실패한다 — 그 사이 들어온 변경 신호를 잃지 않는지 보려고 둔다.
        if (skillsListFailSlow) {
          await wait(200);
          return fail(-32000, "스킬 목록을 읽지 못했다(시험대)");
        }
        return ok({ data: [{ cwd: String((params.cwds as string[] | undefined)?.[0] ?? ""), skills: [{ name: "fake-skill" }], errors: [] }] });

      /** 목록 읽기를 느리게 실패시키는 스위치. */
      case "test/skillsListFailSlow":
        skillsListFailSlow = params.on !== false;
        return ok({ on: skillsListFailSlow });

      // 매 턴 회상을 스레드의 모델 시야 기록에 덧붙이는 자리(8g). 진짜 서버처럼 빈 객체로 답하고,
      //   **알림을 내지 않는다** — 얹은 내용이 세션 이벤트로 되돌아오지 않는 것이 실측된 성질이다.
      case "thread/inject_items":
        record({ method, params });
        // 느린 주입 — 턴을 보내기 전 구간에서 중단을 눌렀을 때 어떻게 되는지 보려고 둔다.
        if (JSON.stringify(params).includes("@@slowinject@@")) await wait(400);
        // 되돌려 보내는 상대 — 얹은 글을 **사용자 메시지 항목으로 다시 보내는** 서버를 흉내 낸다.
        //   실측한 0.145.0은 이러지 않지만, 언젠가 그렇게 바뀌어도 화면·기록이 오염되지 않아야 한다.
        if (JSON.stringify(params).includes("@@echoinject@@")) {
          const text = JSON.stringify(params).includes("@@echoinject@@") ? String((params.items as any[])?.[0]?.content?.[0]?.text ?? "") : "";
          send({
            jsonrpc: "2.0",
            method: "item/completed",
            params: { threadId, turnId: activeTurn ?? "tn-echo", completedAtMs: 1, item: { type: "userMessage", id: "it-echo", clientId: null, content: [{ type: "text", text, text_elements: [] }] } },
          });
        }
        return ok({});

      case "thread/compact/start": {
        record({ method, params });
        const turnId = `compact-${++turnSeq}`;
        const item = { type: "contextCompaction", id: `compact-item-${turnSeq}` };
        ok({});
        // 실제 app-server의 현재 정본: 별도 thread/compacted 없이 contextCompaction 항목이 한 턴 안에서 끝난다.
        // 지연을 둬야 클라이언트가 완료 전 진행 상태를 실제로 관측하는지 검증할 수 있다.
        send({ jsonrpc: "2.0", method: "turn/started", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
        send({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, startedAtMs: 1, item } });
        setTimeout(() => {
          send({ jsonrpc: "2.0", method: "item/completed", params: { threadId, turnId, completedAtMs: 2, item } });
          send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 30 } } });
        }, 30);
        return;
      }

      case "review/start": {
        record({ method, params });
        const turnId = `review-${++turnSeq}`;
        activeTurn = turnId;
        ok({
          turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
          reviewThreadId: threadId,
        });
        void runTurn(turnId, `review:${JSON.stringify(params.target ?? {})}`);
        return;
      }

      /**
       * 한 턴. 응답은 즉시 "진행 중"으로 돌려주고 결과는 알림으로 낸다 — 진짜 app-server와 같은 순서다.
       * 입력 텍스트에 표시를 심어 시나리오를 고른다: `@@slow@@`(천천히 끝냄), `@@ask@@`(승인을 물어봄).
       */
      case "turn/start": {
        record({ method, params });
        const text = (Array.isArray(params.input) ? params.input : []).filter((i: any) => i?.type === "text").map((i: any) => i.text).join("");
        // 시작 요청 자체가 거절되는 경우 — 그 입력은 상대 대화에 들어가지 못한다.
        if (text.includes("@@rejectturn@@")) return fail(-32000, "턴을 시작할 수 없다(시험대)");
        const turnId = `tn-${++turnSeq}`;
        activeTurn = turnId;
        // 완료 알림이 시작 응답보다 **먼저** 나가는 순서를 강제로 재현한다.
        //   실제로도 두 줄이 한 덩어리로 도착하면 받는 쪽에서 이 순서가 된다.
        if (text.includes("@@instant@@")) {
          send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1 } } });
          activeTurn = null;
          ok({ turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
          return;
        }
        ok({ turn: { id: turnId, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } });
        void runTurn(turnId, text);
        return;
      }

      case "turn/interrupt":
        record({ method, params });
        interrupted.add(String(params.turnId));
        return ok({});

      // 응답 키는 실제 codex 0.145.0 그대로 `data`다(생성 타입 `ListMcpServerStatusResponse`).
      //   `FAKE_MCP_SERVERS`로 붙어 있는 서버가 있는 상황을 흉내 낼 수 있다 — 격리가 깨졌을 때를 재현한다.
      case "mcpServerStatus/list":
        record({ method, params });
        // 조회 자체가 실패하는 상황(버전 드리프트 등) — 그때 "0개"로 답하면 격리가 깨끗하다고 오해된다.
        if (process.env.FAKE_MCP_FAIL) return fail(-32000, "MCP 목록을 읽을 수 없다(시험대)");
        return ok({
          data: (process.env.FAKE_MCP_SERVERS ?? "").split(",").filter(Boolean).map((name) => ({ name })),
          nextCursor: null,
        });

      case "config/mcpServer/reload":
        record({ method, params });
        return ok({});

      // ── 아래는 시험대 전용 메서드(진짜 app-server엔 없다) ──

      /** 지금까지 받은 요청 기록 — 테스트가 "무엇을 어떤 순서로 보냈나"를 대조한다. */
      case "test/calls":
        return ok({ calls });

      case "test/echo":
        return ok({ echo: params, initialized });

      case "test/configOverrides":
        return ok({ overrides });

      /** 알림을 n건 먼저 흘린 뒤 응답한다 — 알림과 응답이 뒤섞여도 짝짓기가 맞는지 본다. */
      // 스킬 파일이 바뀌었다는 무효화 신호를 흘린다(8g) — 받는 쪽이 목록을 다시 읽는지 본다.
      case "test/skillsChanged":
        send({ jsonrpc: "2.0", method: "skills/changed", params: {} });
        return ok({ sent: true });

      case "test/notify": {
        const n = Number(params.count ?? 3);
        for (let i = 0; i < n; i++) send({ jsonrpc: "2.0", method: "test/tick", params: { i } });
        return ok({ sent: n });
      }

      /** 깨진 줄을 하나 흘린 뒤 정상 응답 — 한 줄이 깨져도 통신선이 죽지 않는지 본다. */
      case "test/malformed":
        process.stdout.write("{ 이건 JSON이 아니다\n");
        return ok({ recovered: true });

      /**
       * 상한을 넘기는 거대한 줄을 흘린 뒤 정상 응답 — 버리고 다음 줄로 넘어가는지 본다.
       * 64KB씩 나눠 쓴다: 파이프 한 번에 실리는 양이 그 정도라 받는 쪽에서 여러 번에 걸쳐 도착하고,
       * 그래야 "줄이 안 끝났는데 버퍼가 상한을 넘었다"는 실제 상황이 재현된다.
       */
      case "test/hugeLine": {
        const bytes = Number(params.bytes ?? 1_000_000);
        const piece = "x".repeat(64 * 1024);
        process.stdout.write('{"jsonrpc":"2.0","method":"test/huge","params":{"blob":"');
        for (let written = 0; written < bytes; written += piece.length) process.stdout.write(piece);
        process.stdout.write('"}}\n');
        return ok({ hugeSent: bytes });
      }

      /** 영원히 답하지 않는다 — 요청 시간 초과가 실제로 동작하는지 본다. */
      case "test/silent":
        return;

      /** 늦게 답한다 — 요청이 도는 중에 프로세스가 밑에서 사라지지 않는지 보는 용도. */
      case "test/slow":
        await wait(Number(params.ms ?? 1000));
        return ok({ slept: params.ms ?? 1000 });

      /**
       * 서버 → 클라이언트 방향 요청을 보내고 그 답을 결과로 돌려준다.
       * 승인 왕복이 정확히 이 모양이다(단위 4에서 진짜 승인으로 바뀐다).
       */
      case "test/serverRequest": {
        const rid = nextId++;
        const answer = await new Promise<unknown>((resolve) => {
          awaitingAnswer.set(rid, resolve);
          send({ jsonrpc: "2.0", id: rid, method: String(params.method ?? "test/ask"), params: params.payload ?? {} });
        });
        return ok({ answer });
      }

      /** 응답을 준 뒤 곧바로 죽는다. */
      case "test/exitAfterReply":
        ok({ bye: true });
        setTimeout(() => process.exit(Number(params.code ?? 0)), 10);
        return;

      /** 응답 없이 즉사 — 대기 중인 요청이 전부 실패로 정리되는지 본다. */
      case "test/crash":
        if (params.stderr) process.stderr.write(String(params.stderr) + "\n");
        setTimeout(() => process.exit(Number(params.code ?? 9)), 10);
        return;

      default:
        return fail(-32601, `알 수 없는 메서드: ${method}`);
    }
  }
}

if (isMain) main();
