/**
 * 사람이 마지막으로 글을 보낸 시각 복원. 사이드바 정렬 기준이다.
 * 실제 모델, 네트워크, 운영 데이터는 쓰지 않는다.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AetherEvent } from "../types";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-last-input-"));

let fail = 0;
function check(cond: boolean, name: string) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

const { appendEvent, lastUserInputTs, saveMeta } = await import("../sessions/persistence");
await (await import("./support/tempDb")).useTempDiary("last_input_ts");

const msg = (seq: number, ts: number, extra: object = {}) => ({ seq, ts, kind: "user_msg", text: "글", ...extra }) as unknown as AetherEvent;
const id = crypto.randomUUID();
saveMeta({ id, cwd: "/tmp", createdAt: 1 } as never);
check(lastUserInputTs(id) === undefined, "글이 없으면 값이 없다");
appendEvent(id, msg(1, 100));
appendEvent(id, msg(2, 200));
appendEvent(id, msg(3, 300, { sentBy: "aether" }));
appendEvent(id, { seq: 4, ts: 400, kind: "status", status: "idle" } as unknown as AetherEvent);
check(lastUserInputTs(id) === 200, "Aether가 대신 보낸 글과 다른 사건은 세지 않는다");

process.exit(fail ? 1 : 0);
