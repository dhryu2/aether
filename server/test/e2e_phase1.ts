/**
 * Phase 1 백엔드 E2E (인증 전, 로컬). 실제 서버를 부팅해 HTTP/SSE로 전 계약을 검증.
 *   1) health  2) 세션 생성  3) message→SSE 응답  4) ?since=seq 재접속 replay
 *   5) canUseTool 권한요청 SSE → POST /permission allow → 파일 생성 확인
 * 모델 haiku, 최소 턴(쿼터 절약). PASS면 exit 0.
 */
import { existsSync, rmSync } from "node:fs";
import { config } from "../config";
import { isControlEvent, type AetherEvent } from "../types";

const BASE = `http://localhost:${config.port}`;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const events: AetherEvent[] = [];
let waiters: { pred: (e: AetherEvent) => boolean; resolve: () => void }[] = [];

function onEvent(ev: AetherEvent) {
  events.push(ev);
  waiters = waiters.filter((w) => {
    if (w.pred(ev)) {
      w.resolve();
      return false;
    }
    return true;
  });
}

function waitFor(pred: (e: AetherEvent) => boolean, timeoutMs = 60000, label = "event"): Promise<void> {
  if (events.some(pred)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`타임아웃 대기: ${label}`)), timeoutMs);
    waiters.push({ pred, resolve: () => { clearTimeout(t); resolve(); } });
  });
}

/** SSE 연결을 열고 파싱된 이벤트를 sink로 흘림. AbortController로 닫음. */
async function openSSE(id: string, since: number, sink: (e: AetherEvent) => void): Promise<AbortController> {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/sessions/${id}/stream?since=${since}`, { signal: ac.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  (async () => {
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) {
              try { sink(JSON.parse(line.slice(6)) as AetherEvent); } catch { /* skip */ }
            }
          }
        }
      }
    } catch { /* aborted */ }
  })();
  return ac;
}

async function main() {
  await import("../index"); // 서버 부팅
  await delay(800);

  const log = (s: string) => console.log(s);
  let pass = true;
  const check = (cond: boolean, name: string) => {
    log(`${cond ? "✅" : "❌"} ${name}`);
    if (!cond) pass = false;
  };

  // 1) health
  const health = await (await fetch(`${BASE}/api/health`)).json();
  check(health.ok === true, `health (model=${health.defaultModel})`);

  // 2) 세션 생성 (cwd 기본=화이트리스트 루트)
  const created = await (await fetch(`${BASE}/api/sessions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "haiku" }),
  })).json();
  const id: string = created.id;
  check(typeof id === "string", `세션 생성 (id=${id?.slice(0, 8)}…)`);

  // 메인 SSE 연결
  const main1 = await openSSE(id, 0, onEvent);

  // 3) message → SSE 응답
  await fetch(`${BASE}/api/sessions/${id}/message`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Reply with only: PONG" }),
  });
  const sdkType = (e: AetherEvent) =>
    e.kind === "sdk" && "msg" in e && e.msg && typeof e.msg === "object" ? (e.msg as { type?: unknown }).type : undefined;
  await waitFor((e) => sdkType(e) === "result", 60000, "turn1 result");
  const assistantText = events
    .filter((e) => sdkType(e) === "assistant")
    .flatMap((e) => (("msg" in e ? (e.msg as { message?: { content?: unknown } }).message?.content : []) ?? []) as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  check(/PONG/i.test(assistantText), `turn1 응답 수신 ("${assistantText.trim().slice(0, 30)}")`);
  const maxSeq = Math.max(...events.map((e) => e.seq));
  check(maxSeq >= 2, `seq 단조증가 부여됨 (maxSeq=${maxSeq})`);

  // 4) 재접속 replay: since=2로 새 연결 → seq>2 이벤트가 다시 흘러야 함
  const replayed: AetherEvent[] = [];
  const main2 = await openSSE(id, 2, (e) => replayed.push(e));
  await delay(1200);
  main2.abort();
  check(replayed.length > 0 && replayed.every((e) => e.seq > 2),
    `?since=2 재접속 replay (${replayed.length}개, 전부 seq>2)`);

  // 5) 권한 플로우: Write 툴 → permission_request SSE → allow → 파일 생성
  const OUT = "/tmp/aether_e2e.txt";
  try { rmSync(OUT); } catch {}
  await fetch(`${BASE}/api/sessions/${id}/message`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `Use the Write tool to create the file ${OUT} containing exactly: E2E_OK` }),
  });
  await waitFor((e) => e.kind === "permission_request", 60000, "permission_request");
  const permEv = [...events].reverse().find((e) => isControlEvent(e, "permission_request"));
  check(!!permEv && permEv.req.toolName === "Write", `권한요청 SSE 수신 (tool=${permEv?.req.toolName})`);
  const permRes = await (await fetch(`${BASE}/api/sessions/${id}/permission`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ permissionId: permEv!.req.id, decision: "allow" }),
  })).json();
  check(permRes.ok === true, "POST /permission allow 응답 ok");
  await waitFor((e) => sdkType(e) === "result", 60000, "turn2 result");
  await delay(300);
  check(existsSync(OUT), `allow 후 파일 실제 생성됨 (${OUT})`);
  try { rmSync(OUT); } catch {}

  main1.abort();
  console.log("─".repeat(56));
  console.log(pass ? "✅ PHASE 1 E2E PASS" : "❌ PHASE 1 E2E FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((err) => { console.error("E2E 오류:", err); process.exit(1); });
