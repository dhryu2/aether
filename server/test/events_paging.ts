/**
 * 무한스크롤 페이징 단위: persistence.readEventsPage(이전 페이지 읽기) + stream.sliceTail(초기 replay 꼬리 절단).
 * 불변식: seq 오름차순 보존, hasOlder 정확성, from 모드 전 구간,
 * 꼬리 절단 시 잘린 구간의 마지막 model_info·commands_available 관측 extras 동봉.
 */
process.env.AETHER_DATA_DIR = `/tmp/aether-test-events-paging-${process.pid}`;

import fs from "node:fs";
import path from "node:path";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  cond ? pass++ : fail++;
}

async function main() {
  const { ensureSessionDir, appendEvent, readEventsPage } = await import("../sessions/persistence");
  await (await import("./support/tempDb")).useTempDiary("events_paging"); // 임시 SQLite 일기
  const { sliceTail } = await import("../routes/stream");
  const { config } = await import("../config");

  // ── 준비: seq 1..500 이벤트(중간에 gap: 250은 결번 — partial 미영속 상황 재현) ──
  const id = "pg-test";
  ensureSessionDir(id);
  for (let seq = 1; seq <= 500; seq++) {
    if (seq === 250) continue; // gap
    appendEvent(id, { seq, ts: seq, kind: "user_msg", text: `m${seq}` } as never);
  }

  // ── 1. limit 모드(위로 스크롤 페이징) ──
  const p1 = readEventsPage(id, 301, 100);
  check(p1.events.length === 100 && p1.events[0].seq === 200 && p1.events[99].seq === 300, "1a before=301 limit=100 → 200..300(gap 250 제외 100개)");
  check(p1.hasOlder === true, "1b 더 오래된 구간 존재 → hasOlder=true");
  check(p1.events.every((e, i) => i === 0 || p1.events[i - 1].seq < e.seq), "1c seq 오름차순");

  const p2 = readEventsPage(id, 301, 1000);
  check(p2.events[0].seq === 1 && p2.hasOlder === false, "2 limit이 남은 전부 커버 → 처음부터 + hasOlder=false");

  const p3 = readEventsPage(id, 2, 5);
  check(p3.events.length === 1 && p3.events[0].seq === 1 && p3.hasOlder === false, "3 경계: before=2 → seq 1만, hasOlder=false");

  // ── 2. from 모드(검색 점프 — from ≤ seq < before 전 구간) ──
  const p4 = readEventsPage(id, 301, 100, 50);
  check(p4.events[0].seq === 50 && p4.events[p4.events.length - 1].seq === 300, "4a from=50 → 50..300 전 구간(limit 무시)");
  check(p4.hasOlder === true, "4b seq<50 존재 → hasOlder=true");

  const p5 = readEventsPage(id, 301, 100, 1);
  check(p5.events[0].seq === 1 && p5.hasOlder === false, "5 from=1 → 전부 + hasOlder=false");

  // ── 3. sliceTail(초기 replay 꼬리 절단) ──
  // 원본 kind/msg가 아니라 정규화 사건 타입만 본다. 가짜 codec이 그 점을 고정한다.
  const codec = {
    normalize(ev: { seq: number; mark?: string }) {
      if (ev.mark === "init") return [{ type: "model_info" as const }, { type: "commands_available" as const }];
      if (ev.mark === "cmds") return [{ type: "commands_available" as const }];
      if (ev.mark === "model") return [{ type: "model_info" as const }];
      if (ev.mark === "plan") return [{ type: "plan_update" as const }];
      if (ev.mark === "user") return [{ type: "user_text" as const }];
      if (ev.mark === "text") return [{ type: "text" as const }];
      if (ev.mark === "done") return [{ type: "turn_completed" as const }];
      return [];
    },
  };
  const mk = (seq: number, body?: object) => ({ seq, ts: seq, kind: "user_msg", text: `m${seq}`, ...body }) as never;
  const initEv = { seq: 5, ts: 5, kind: "user_msg", text: "init", mark: "init" } as never;
  const cmdsEv = { seq: 40, ts: 40, kind: "user_msg", text: "cmds", mark: "cmds" } as never;
  const long: never[] = [];
  for (let seq = 1; seq <= 400; seq++) long.push(seq === 5 ? initEv : seq === 40 ? cmdsEv : mk(seq));

  const t1 = sliceTail(long, codec);
  check(t1.hasOlder === true && t1.oldestSeq === 101, "6a 400개 → 꼬리 300개(oldestSeq=101), hasOlder=true");
  check(t1.evs.length === 302 && t1.evs[0] === initEv && t1.evs[1] === cmdsEv, "6b 잘린 구간의 마지막 model_info·commands_available extras 동봉(맨 앞)");
  check(t1.evs[2].seq === 101 && t1.evs[t1.evs.length - 1].seq === 400, "6c 꼬리 구간 101..400 보존");

  const sameEv = { seq: 9, ts: 9, kind: "user_msg", text: "both", mark: "init" } as never;
  const longSame: never[] = [];
  for (let seq = 1; seq <= 400; seq++) longSame.push(seq === 9 ? sameEv : mk(seq));
  const tSame = sliceTail(longSame, codec);
  check(tSame.evs[0] === sameEv && tSame.evs.filter((e) => e === sameEv).length === 1, "6d 같은 사건이 두 관측을 겸하면 한 번만 동봉");

  const short = long.slice(0, 100);
  const t2 = sliceTail(short, codec);
  check(t2.evs.length === 100 && t2.hasOlder === false && t2.oldestSeq === 1, "7 짧은 백로그(≤300)는 전량 passthrough");

  const t3 = sliceTail([], codec);
  check(t3.evs.length === 0 && t3.hasOlder === false && t3.oldestSeq === 0, "8 빈 백로그 안전");

  // ── 4. 최근 raw 꼬리가 메타데이터뿐이어도 마지막 실제 대화 한 턴을 복원 씨앗으로 동봉 ──
  const buried: never[] = [
    { seq: 1, ts: 1, kind: "user_msg", text: "m1", mark: "user" } as never,
    { seq: 2, ts: 2, kind: "user_msg", text: "m2", mark: "text" } as never,
    { seq: 3, ts: 3, kind: "user_msg", text: "m3", mark: "done" } as never,
  ];
  for (let seq = 4; seq <= 703; seq++) buried.push({ seq, ts: seq, kind: "user_msg", text: `m${seq}`, mark: "cmds" } as never);
  const t4 = sliceTail(buried, codec);
  check(t4.oldestSeq === 404 && t4.hasOlder === true, "9a raw 꼬리 cursor는 300개 경계를 그대로 유지");
  check(
    t4.evs.slice(0, 3).map((e) => e.seq).join(",") === "1,2,3",
    "9b 700개 메타데이터 뒤에서도 마지막 실제 대화 한 턴을 작은 씨앗으로 동봉",
  );
  check(
    t4.evs.length === 304 && t4.evs[3].seq === 403 && t4.evs[4].seq === 404 && t4.evs.at(-1)?.seq === 703,
    "9c 씨앗+마지막 명령 관측+raw 꼬리만 보내 전송량 상한 유지",
  );

  // ── 5. 메타데이터-only 페이지가 여러 장이어도 cursor가 과거 대화까지 단조 감소 ──
  const buriedId = "pg-buried";
  ensureSessionDir(buriedId);
  appendEvent(buriedId, { seq: 1, ts: 1, kind: "user_msg", text: "찾아야 할 대화" });
  for (let seq = 2; seq <= 901; seq++) appendEvent(buriedId, { seq, ts: seq, kind: "status", status: "completed" });
  const cursors: number[] = [];
  let before = 902;
  let foundConversation = false;
  for (let pageNo = 0; pageNo < 4; pageNo++) {
    const page = readEventsPage(buriedId, before, 300);
    if (!page.events.length) break;
    cursors.push(page.events[0].seq);
    foundConversation ||= page.events.some((e) => e.kind === "user_msg");
    before = page.events[0].seq;
  }
  check(cursors.join(",") === "602,302,2,1", "10a 메타데이터-only 여러 페이지를 지나 cursor가 602→302→2→1로 감소");
  check(foundConversation, "10b 네 번째 페이지에서 오래된 실제 대화를 찾는다");
  const emptyOnly = readEventsPage(buriedId, 1, 300);
  check(emptyOnly.events.length === 0 && emptyOnly.hasOlder === false, "10c 끝까지 조회한 진짜 빈 나머지는 종료 상태");

  // ── 6. 꼬리보다 앞에 있는 마지막 할 일 목록은 함께 싣고, 꼬리에 더 나중 목록이 있으면 앞의 것은 싣지 않는다 ──
  const planA = { seq: 20, ts: 20, kind: "user_msg", text: "plan A", mark: "plan" } as never;
  const planB = { seq: 60, ts: 60, kind: "user_msg", text: "plan B", mark: "plan" } as never;
  const withPlan: never[] = [];
  for (let seq = 1; seq <= 400; seq++) withPlan.push(seq === 20 ? planA : seq === 60 ? planB : seq === 400 ? mk(seq, { mark: "text" }) : mk(seq)); // 꼬리에 대화 본문이 있어 대화 씨앗은 따로 안 붙는다
  const t6 = sliceTail(withPlan, codec);
  check(t6.oldestSeq === 101 && t6.evs.filter((e) => (e as { mark?: string }).mark === "plan").length === 1 && t6.evs[0] === planB, "11a 꼬리 앞의 목록 중 마지막 하나만 동봉, oldestSeq 불변");
  const planTail = { seq: 350, ts: 350, kind: "user_msg", text: "plan C", mark: "plan" } as never;
  const withTailPlan = withPlan.map((e) => ((e as { seq: number }).seq === 350 ? planTail : e));
  const t7 = sliceTail(withTailPlan, codec);
  check(t7.evs.length === 300 && !t7.evs.includes(planB), "11b 꼬리에 더 나중 목록이 있으면 앞의 목록은 싣지 않는다");

  // 정리
  fs.rmSync(config.dataDir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? "✅" : "❌"} events_paging: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
