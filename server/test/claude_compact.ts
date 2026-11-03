/**
 * Claude `/compact` 진행 카드 계약 (모델 호출 0).
 *
 * Codex는 `/compact`를 받으면 공통 operation 사건(started → completed/failed)을 내보내 화면이 진행 카드를 그린다.
 * Claude도 같은 사건을 내야 한다. SDK 메시지 순서는 실측(2026-09-30, haiku)을 그대로 옮긴 가짜 스트림으로 흘린다.
 *   정상:   status(compacting) → status(null, compact_result) → init → compact_boundary(manual) → user×2 → result
 *   빈 대화: init → assistant("Error: No messages to compact") → result
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRuntime } from "../sessions/runtimes/claude";
import { compactOutcome } from "../providers/claude/compactSignal";
import type { RuntimeCommandOperation } from "../providers/types";

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, detail?: unknown) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}`);
  if (!c && detail !== undefined) console.log("     detail:", JSON.stringify(detail));
  c ? pass++ : fail++;
};

const sdk = (m: Record<string, unknown>) => ({ session_id: "s", uuid: "u", ...m }) as unknown as SDKMessage;
const STATUS_COMPACTING = sdk({ type: "system", subtype: "status", status: "compacting" });
const STATUS_DONE = (r: "success" | "failed") => sdk({ type: "system", subtype: "status", status: null, compact_result: r });
const RESULT = sdk({ type: "result", subtype: "success", is_error: false, result: "" });

// ── 1. 신호 해석 ──
check(compactOutcome(STATUS_COMPACTING) === null, "1a 압축 중 상태는 끝이 아니다");
check(compactOutcome(STATUS_DONE("success")) === "completed", "1b 성공 결과 신호는 완료");
check(compactOutcome(STATUS_DONE("failed")) === "failed", "1c 실패 결과 신호는 실패");
check(compactOutcome(RESULT) === "failed", "1d 결과 신호 없이 턴이 끝나면 압축이 안 된 것");
check(compactOutcome(sdk({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } })) === null, "1e 경계 메시지는 끝 판정에 쓰지 않는다");

/**
 * 생성자는 실제 SDK 프로세스를 띄우므로 우회한다. 이벤트 스트림과 명령 목록 조회만 가짜로 채운다.
 * 가짜 스트림은 테스트가 `feed()`로 메시지를 넣을 때마다 한 건씩 내보낸다.
 */
function harness() {
  const operations: RuntimeCommandOperation[] = [];
  const pushed: string[] = [];
  const queue: SDKMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const qh = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (!queue.length) {
          if (ended) return;
          await new Promise<void>((r) => (wake = r));
          continue;
        }
        yield queue.shift()!;
      }
    },
    supportedCommands: async () => [],
  };
  const rt = Object.create(ClaudeRuntime.prototype) as ClaudeRuntime;
  Object.assign(rt, {
    opts: { onResumeKey: () => {}, onCommandOperation: (o: RuntimeCommandOperation) => operations.push(o) },
    qh,
    input: { push: (text: string) => pushed.push(text), close: () => {} },
    commandOperation: null,
    idle: true,
  });
  const seen: unknown[] = [];
  const pump = (async () => {
    for await (const ev of rt.events()) seen.push(ev);
  })();
  const flush = () => new Promise((r) => setTimeout(r, 5));
  const feed = async (...msgs: SDKMessage[]) => {
    queue.push(...msgs);
    wake?.();
    await flush();
  };
  const end = async () => {
    ended = true;
    wake?.();
    await pump;
  };
  return { rt, operations, pushed, seen, feed, end };
}

async function main() {
  // ── 2. 정상 압축: 시작 카드 → 완료 카드, 같은 작업 id ──
  {
    const h = harness();
    const r = await h.rt.executeCommand({ name: "compact", arguments: "" });
    check(r.accepted && !r.startsTurn, "2a /compact는 턴이 아닌 명령으로 받아들여진다", r);
    check(h.pushed[0] === "/compact", "2b Claude 입력 통로에 /compact가 들어간다", h.pushed);
    check(h.operations.length === 1 && h.operations[0].state === "started" && h.operations[0].blocksInput, "2c 결과가 오기 전에 입력을 막는 시작 카드를 먼저 알린다", h.operations);
    const busy = await h.rt.executeCommand({ name: "compact", arguments: "" });
    check(!busy.accepted, "2d 압축 중에는 새 /compact를 받지 않는다", busy);
    await h.feed(STATUS_COMPACTING, STATUS_COMPACTING);
    check(h.operations.length === 1, "2e 반복되는 압축 중 상태는 카드를 늘리지 않는다", h.operations);
    await h.feed(STATUS_DONE("success"));
    check(h.operations.length === 2 && h.operations[1].state === "completed", "2f 성공 결과 신호가 완료 카드로 바뀐다", h.operations);
    check(h.operations[1]?.operationId === h.operations[0].operationId, "2g 완료 카드가 시작 카드와 같은 작업을 닫는다", h.operations);
    await h.feed(sdk({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } }), RESULT);
    check(h.operations.length === 2, "2h 뒤따르는 턴 종료가 이미 닫힌 작업을 다시 건드리지 않는다", h.operations);
    check(h.seen.length === 5, "2i 원본 메시지는 삼키지 않고 그대로 흘려보낸다", h.seen.length);
    await h.end();
    check(h.operations.length === 2, "2j 스트림이 끝나도 닫힌 작업을 다시 닫지 않는다", h.operations);
  }

  // ── 3. 빈 대화: 결과 신호 없이 턴이 끝나면 실패로 닫는다(영원히 압축 중으로 남지 않게) ──
  {
    const h = harness();
    await h.rt.executeCommand({ name: "compact", arguments: "" });
    await h.feed(sdk({ type: "assistant", message: { content: [{ type: "text", text: "Error: No messages to compact" }] } }), RESULT);
    check(h.operations.map((o) => o.state).join(",") === "started,failed", "3a 압축할 게 없으면 실패 카드로 닫힌다", h.operations);
    const again = await h.rt.executeCommand({ name: "compact", arguments: "" });
    check(again.accepted, "3b 닫힌 뒤에는 다시 /compact를 받는다", again);
    await h.end();
    check(h.operations.at(-1)?.state === "failed", "3c 압축 중에 스트림이 끝나면 실패로 닫는다", h.operations);
  }

  // ── 4. 진행 중인 턴 뒤에는 줄 세우지 않는다(그 턴의 종료가 압축 카드를 닫아 버리므로) ──
  {
    const h = harness();
    h.rt.push({ text: "긴 작업 해줘" });
    const r = await h.rt.executeCommand({ name: "compact", arguments: "" });
    check(!r.accepted && h.operations.length === 0, "4a 턴이 도는 중에는 /compact를 거절한다", { r, ops: h.operations });
    await h.feed(RESULT);
    const ok = await h.rt.executeCommand({ name: "compact", arguments: "" });
    check(ok.accepted && h.operations.length === 1, "4b 턴이 끝나면 받는다", { ok, ops: h.operations });
    await h.end();
  }

  // ── 5. 공책 압축(compactContext)도 같은 카드를 낸다 ──
  {
    const h = harness();
    await h.rt.compactContext();
    check(h.pushed[0] === "/compact" && h.operations[0]?.state === "started", "5a compactContext도 시작 카드를 낸다", { pushed: h.pushed, ops: h.operations });
    await h.feed(STATUS_COMPACTING, STATUS_DONE("failed"));
    check(h.operations[1]?.state === "failed", "5b 실패 결과 신호는 실패 카드로 닫힌다", h.operations);
    await h.end();
  }

  console.log(`\n${fail ? "❌" : "✅"} claude_compact: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

void main();
