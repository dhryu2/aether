/**
 * 라이브 버퍼 바이트 상한 + 세션 제목 요약 스위치 시험 (모델 호출 없음).
 *   - 바이트 상한으로 앞부분이 밀려도 replaySince/replayNewestFirst가 누락·중복 없이 전체를 낸다.
 *   - 스위치 off면 요약 호출을 건너뛰고 임시 제목만 남는다.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bufbytes-data-"));
process.env.AETHER_BUFFER_MAX_BYTES = "3000";

let pass = 0, fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

async function main() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aether-bufbytes-cwd-"));
  const { LiveSession } = await import("../sessions/LiveSession");
  await (await import("./support/tempDb")).useTempDiary("buffer_bytes_title_switch");
  const { eventLogFor } = await import("../sessions/eventLog");
  const { readTitleSummarize, writeTitleSummarize } = await import("../sessions/titleSummarySetting");

  const id = randomUUID();
  const s = new LiveSession({ id, cwd, provider: "claude", model: "haiku", eventLog: eventLogFor(id) }) as any;
  const N = 40;
  for (let i = 0; i < N; i++) s.ingest({ kind: "notice", notice: "resumed", detail: "x".repeat(300) });
  const all = Array.from({ length: N }, (_, i) => i + 1);

  check(s.buffer.length < N && s.buffer[0].seq > 1, "바이트 상한으로 앞부분이 밀림", `len=${s.buffer.length} first=${s.buffer[0].seq}`);
  check(s.bufferBytes <= 3000 && s.bufferBytes === s.bufferSizes.reduce((a: number, b: number) => a + b, 0), "합계가 상한 이하이고 크기 배열과 일치", `bytes=${s.bufferBytes}`);
  check(s.replaySince(0).map((e: any) => e.seq).join() === all.join(), "replaySince(0): 누락·중복 없음(디스크 경로)");
  const edge = s.buffer[0].seq;
  for (const since of [edge - 2, edge - 1, edge, N - 1, N]) {
    const got = s.replaySince(since).map((e: any) => e.seq).join();
    const want = all.filter((q) => q > since).join();
    check(got === want, `replaySince(${since}) 경계 정확`);
  }
  const rev = [...s.replayNewestFirst()].map((e: any) => e.seq);
  check(rev.join() === [...all].reverse().join(), "replayNewestFirst: 최신부터 누락·중복 없음");

  // 스위치
  check(readTitleSummarize() === true, "기본 켜짐");
  let called = 0;
  const mk = () => {
    const tid = randomUUID();
    const t = new LiveSession({ id: tid, cwd, provider: "claude", model: "haiku", eventLog: eventLogFor(tid) }) as any;
    t.adoptSummarizedName = async () => { called++; };
    return t;
  };
  writeTitleSummarize(false);
  const a = mk(); a.maybeAdoptGeneratedName("로그인 버그를 고쳐줘");
  check(called === 0 && !!a.generatedName, "끄면 요약 호출 없이 임시 제목 유지", `title=${a.generatedName}`);
  writeTitleSummarize(true);
  const b = mk(); b.maybeAdoptGeneratedName("로그인 버그를 고쳐줘");
  check(called === 1, "켜면 요약 호출");

  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(process.env.AETHER_DATA_DIR!, { recursive: true, force: true });
  console.log(`buffer_bytes_title_switch: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("테스트 오류:", e); process.exit(1); });
