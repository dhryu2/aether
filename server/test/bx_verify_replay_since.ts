/**
 * bx_verify_replay_since — LiveSession.replaySince 메모리/디스크 경로 대칭성 검증 (Claude 0).
 *
 * H3 수정(bx-verify): notice 이벤트를 디스크에 영속한다(ingest).
 *   - 과거 결함: notice가 seq를 소비만 하고 비영속 → ① 재시작 후 lastSeqFromDisk가 이미 SSE로 나간 seq를
 *     재발급(replay 침묵/충돌) ② replaySince 메모리(notice 포함)/디스크(notice 누락) 경로 비대칭.
 *   - 수정 후: notice도 events.jsonl에 영속 → 메모리/디스크 replay가 대칭, seq 재발급 방지.
 *
 * 잔여(Low, 미수정): #5 appendEvent 영속 실패 + 메모리 롤오버가 겹치면 비partial 이벤트 영구 누락
 *   (디스크 장애 전제의 좁은 엣지). Part C가 그 메커니즘을 고정한다.
 *
 * 관점:
 *   [Spec Tester / 블랙박스]  ?since=seq → seq>since 이벤트만 replay, partial 미포함(메모리·디스크 둘 다).
 *   [Code Tester / 화이트박스]  버퍼 롤오버 시 디스크 분기 진입 — notice가 메모리/디스크 양쪽에서 일관 반환됨.
 *
 * 버퍼 롤오버를 작은 buffer로 결정적으로 유발하기 위해 AETHER_BUFFER_CAP=4로 둔다.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bxreplay-data-"));
process.env.AETHER_BUFFER_CAP = "4"; // 작게 → 롤오버 결정적 유발

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bxreplay-cwd-"));
  const { LiveSession } = await import("../sessions/LiveSession");
  await (await import("./support/tempDb")).useTempDiary("bx_verify_replay_since"); // 임시 SQLite 일기
  const store = await import("../sessions/persistence");
  const { eventLogFor } = await import("../sessions/eventLog");

  // ───────────────────────────────────────────────────────────────────
  // Part A: 정상경로 + fix #3 (notice 메모리/디스크 대칭) — LiveSession.ingest 경유
  // ───────────────────────────────────────────────────────────────────
  const replayId = randomUUID();
  const s = new LiveSession({ id: replayId, cwd, provider: "claude", model: "haiku", eventLog: eventLogFor(replayId) }) as any;
  // ingest는 private — phase5/phase2 패턴대로 캐스팅 호출(canUseTool/Claude 미경유).
  s.ingest({ kind: "notice", notice: "resumed", detail: "이전 맥락 복원" }); // seq=1 (이제 영속됨)
  s.ingest({ kind: "status", status: "completed" });                         // seq=2
  s.ingest({ kind: "sdk", msg: { type: "assistant" } });                     // seq=3

  // [normal/Spec] 메모리 경로(buffer 상한 안): since=0 → seq>0 전부, 단조증가
  {
    const r = s.replaySince(0);
    check(r.length === 3 && r.every((e: any, i: number) => e.seq === i + 1),
      "[normal] 메모리 replaySince(0) → seq 1,2,3 단조증가", `seqs=${r.map((e: any) => e.seq)}`);
    const r2 = s.replaySince(2);
    check(r2.length === 1 && r2[0].seq === 3,
      "[normal] replaySince(2) → seq>2 만(=seq 3)", `seqs=${r2.map((e: any) => e.seq)}`);
  }

  // [fix #3] 메모리 경로에 notice 포함(종전대로).
  {
    const mem = s.replaySince(0);
    check(mem.some((e: any) => e.kind === "notice"), "[fix #3] 메모리 경로 replay에 notice 포함");
  }

  // [fix #3] notice가 이제 events.jsonl에 영속된다(seq 재발급/replay 비대칭 근원 제거).
  {
    const raw = JSON.stringify(store.readEventsSince(s.id, 0));
    check(/"kind":"notice"/.test(raw), "[fix #3] notice가 일기에 영속됨(H3)");
  }

  // 롤오버 유발: bufferCap=4 초과로 buffer[0]가 notice(seq=1)를 지나치게 함.
  for (let i = 0; i < 8; i++) s.ingest({ kind: "sdk", msg: { type: "assistant" } });
  check(s.buffer[0].seq > 2,
    "[fix #3] 롤오버 발생 — buffer[0].seq가 notice(1)를 지나침", `buffer[0].seq=${s.buffer[0].seq}`);

  // ★ 대칭 확인: 롤오버 후 since=0 → 디스크 경로 진입 → notice가 이제 포함된다(메모리와 일관).
  {
    const disk = s.replaySince(0);
    check(disk.some((e: any) => e.kind === "notice"),
      "[fix #3] 롤오버 후 디스크 경로 replay에도 notice 포함(메모리/디스크 대칭)");
    check(disk.length > 0 && disk.every((e: any) => e.seq > 0),
      "[fix #3] 디스크 경로 seq>since 이벤트 정상 반환", `count=${disk.length}`);
  }

  s.drainPending("Part A 종료");

  // ───────────────────────────────────────────────────────────────────
  // Part B: partial(stream_event) replay 제외 — 메모리/디스크 대칭(불변)
  // ───────────────────────────────────────────────────────────────────
  {
    const replayId2 = randomUUID();
    const s2 = new LiveSession({ id: replayId2, cwd, provider: "claude", model: "haiku", eventLog: eventLogFor(replayId2) }) as any;
    s2.ingest({ kind: "sdk", msg: { type: "assistant" } });           // 영속·replay 대상
    s2.ingest({ kind: "sdk", msg: { type: "stream_event" } });        // partial — 영속/replay 모두 제외
    s2.ingest({ kind: "sdk", msg: { type: "result" } });              // 영속·replay 대상
    const mem = s2.replaySince(0);
    check(!mem.some((e: any) => e.msg?.type === "stream_event"),
      "[normal] 메모리 replay에 partial(stream_event) 미포함(isPartialSdkEvent 제외)");
    const diskPartials = store.readEventsSince(s2.id, 0).filter((e: any) => e.msg?.type === "stream_event").length;
    check(diskPartials === 0, "[normal] partial은 일기 영속 제외(디스크 대칭)");
    s2.drainPending("Part B 종료");
  }

  // ───────────────────────────────────────────────────────────────────
  // Part C: 잔여 #5 (영속 실패 + 롤오버 → 디스크 경로 영구 누락) — Low, 미수정 메커니즘 고정
  // ───────────────────────────────────────────────────────────────────
  {
    const id = "p5-gap";
    // seq 3을 일부러 빠뜨리고 1,2,4를 영속(=seq 3의 appendEvent가 실패해 디스크에 안 남은 상황).
    for (const e of [
      { seq: 1, ts: 1, kind: "status", status: "completed" },
      { seq: 2, ts: 1, kind: "sdk", msg: { type: "assistant" } },
      // seq 3 누락 — 영속 실패 시뮬
      { seq: 4, ts: 1, kind: "sdk", msg: { type: "result" } },
    ]) store.appendEvent(id, e as never);

    const got = store.readEventsSince(id, 0);
    check(got.map((e: any) => e.seq).join(",") === "1,2,4",
      "[residual #5] readEventsSince(디스크)는 영속된 것만 반환 → 영속실패 seq 3 영구 부재", `seqs=${got.map((e: any) => e.seq)}`);
    check(!got.some((e: any) => e.seq === 3),
      "[residual #5] seq 3은 디스크 경로로 복원 불가(영속실패+롤오버 시 영구 유실 메커니즘 절반)");
    const got2 = store.readEventsSince(id, 2);
    check(got2.length === 1 && got2[0].seq === 4,
      "[residual #5] readEventsSince(2) → seq 4만(상한 밖 디스크 fallback 정상, 단 3은 부재)");
  }

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(process.env.AETHER_DATA_DIR!, { recursive: true, force: true });
  console.log("─".repeat(56));
  console.log(`bx_verify_replay_since: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("테스트 오류:", e); process.exit(1); });
