/**
 * 저장돼 있는 옛 브리프 행이 있어도 서버가 멈추지 않는지 본다.
 * 브리프 카드를 만들고 그리는 코드는 지웠다. 옛 행은 알 수 없는 사건으로 빈 봉투가 되어야 한다.
 * 실제 모델, 네트워크, 운영 데이터는 쓰지 않는다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AetherEvent } from "../types";
import type { ProviderEventCodec } from "../sessions/codec/types";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-brief-legacy-"));
process.env.AETHER_DATA_DIR = DATA_DIR;
delete process.env.AETHER_DATABASE_URL;
delete process.env.AETHER_READ_CANON;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra?: unknown) {
  const shown = cond || extra === undefined ? "" : ` — ${String(JSON.stringify(extra)).slice(0, 240)}`;
  console.log(`  ${cond ? "✅" : "❌"} ${name}${shown}`);
  cond ? pass++ : fail++;
}

async function main(): Promise<void> {
  const { appendEvent, readEventsSince, readEventsPage, saveMeta, tailInfo } = await import("../sessions/persistence");
  await (await import("./support/tempDb")).useTempDiary("brief_legacy_rows"); // 임시 SQLite 일기
  const { toWireEvent } = await import("../sessions/wireEvent");
  const codec = {
    normalize: () => [],
    endsTurn: () => false,
  } as unknown as ProviderEventCodec;
  const fixture = JSON.parse(fs.readFileSync(path.join(TEST_DIR, "fixtures", "legacy_brief_events.json"), "utf8")) as {
    proceeded: AetherEvent[];
    unproceeded: AetherEvent[];
    broken: AetherEvent[];
  };

  const id = crypto.randomUUID();
  saveMeta({ id, cwd: DATA_DIR, createdAt: Date.now() } as never);
  const rows = [...fixture.proceeded, ...fixture.unproceeded, ...fixture.broken];
  for (const ev of rows) appendEvent(id, ev);
  const stored = readEventsSince(id, 0);
  check(stored.some((ev) => (ev.kind as string) === "brief_opened") && stored.some((ev) => (ev.kind as string) === "brief_updated"), "옛 브리프 행이 저장돼 있다");

  const wired = stored.map((ev) => toWireEvent(ev, codec) as Record<string, unknown>);
  const oldWire = wired.filter((_, i) => ["brief_opened", "brief_updated"].includes(stored[i].kind as string));
  check(oldWire.length > 0 && oldWire.every((w) => w.kind === "agent" && !("state" in w) && !("text" in w) && !("briefId" in w)), "옛 브리프 행은 빈 봉투로 나간다", oldWire[0]);
  check(wired.length === stored.length && wired.every((w, i) => w.seq === stored[i].seq), "봉투는 순번을 하나도 잃지 않는다");
  check(wired.some((w) => w.kind === "user_msg" && typeof w.text === "string"), "옛 브리프 옆의 사람 글은 그대로 나간다");

  const page = readEventsPage(id, Number.MAX_SAFE_INTEGER, 1000);
  check(page.events.length === stored.length, "이전 페이지 조회가 옛 행을 읽는다", page.events.length);

  // 꼬리 판정: 옛 브리프 행이 끝에 있어도 턴 상태 판정에 끼지 않는다.
  const tailId = crypto.randomUUID();
  saveMeta({ id: tailId, cwd: DATA_DIR, createdAt: Date.now() } as never);
  appendEvent(tailId, { seq: 1, ts: 1, kind: "user_msg", text: "안녕" } as AetherEvent);
  appendEvent(tailId, { seq: 2, ts: 2, kind: "status", status: "completed" } as AetherEvent);
  appendEvent(tailId, fixture.proceeded[0]);
  const tail = tailInfo(tailId, codec);
  check(tail.turnOpen === false && tail.lastStatus === "completed", "끝의 옛 브리프 행은 턴 판정에 끼지 않는다", tail);
}

try {
  await main();
} catch (err) {
  check(false, "옛 브리프 행 시험", err instanceof Error ? err.stack : err);
} finally {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "✅" : "❌"} brief_legacy_rows: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
