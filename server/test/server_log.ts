/** 서버 로그 파일 단위 시험: 회전·파일 수 상한·마지막 N줄·수준 거르기·깨진 줄·자름·쓰기 불가. */
process.env.AETHER_DATA_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "aether-slog-"));
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const out = (m: string) => process.stdout.write(m + "\n"); // console은 시험 중 가로채므로 직접 쓴다
function check(cond: boolean, name: string, extra = "") {
  out(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

const { installServerLog, readServerLog } = await import("../observability/serverLog");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-slog-dir-"));
const real = { log: console.log, warn: console.warn, error: console.error };
const seen: string[] = [];
console.log = (...a: unknown[]) => { seen.push(a.join(" ")); };
console.warn = console.log; console.error = console.log;

installServerLog({ dir, maxBytes: 600, keep: 2 });
for (let i = 0; i < 40; i++) console.log(`줄 ${i}`);
console.warn("경고 하나");
console.error("오류 하나");
console.log("깨진 줄 앞");
fs.appendFileSync(path.join(dir, "server.jsonl"), "{깨짐\n");
console.log("마지막");

const files = fs.readdirSync(dir).sort();
check(files.join(",") === "server.1.jsonl,server.2.jsonl,server.jsonl", "회전 후 파일 수는 상한(keep=2)+1", files.join(","));
check(seen.length === 44, "원본 console 호출은 그대로 일어남", String(seen.length));
const last3 = readServerLog({ dir, lines: 3 });
check(last3.length === 3 && last3[2].msg === "마지막", "마지막 N줄을 시간순으로(깨진 줄 건너뜀)");
const errs = readServerLog({ dir, lines: 50, minLevel: "warn" }).map((e) => e.level);
check(errs.every((l) => l !== "log"), "수준 거르기(warn 이상)", errs.join(","));
check(readServerLog({ dir, lines: 1000 }).length < 44, "오래된 줄은 상한 밖으로 사라짐");

const big = "가".repeat(20000);
console.log(big);
const bigEntry = readServerLog({ dir, lines: 1 })[0];
check(Buffer.byteLength(bigEntry.msg) < 16 * 1024 + 20 && bigEntry.msg.endsWith("…(잘림)"), "16KiB 초과분은 자르고 표시");

// 쓰기 불가 폴더: 파일 경로 아래로 폴더를 만들 수 없다
const blocker = path.join(os.tmpdir(), `aether-slog-file-${process.pid}`);
fs.writeFileSync(blocker, "x");
const before = seen.length;
installServerLog({ dir: path.join(blocker, "sub") });
console.log("계속 동작");
check(seen[seen.length - 1] === "계속 동작" && seen.length > before, "쓰기 불가 폴더에서도 console 정상");

// (a) rename 실패: 보관본이 줄지 않고 계속 쓴다
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "aether-slog-rn-"));
  installServerLog({ dir: d2, maxBytes: 300, keep: 2 });
  for (let i = 0; i < 15; i++) console.log(`채움 ${i}`); // 회전을 몇 번 일으켜 보관본을 만든다
  const keptBefore = fs.readdirSync(d2).filter((f) => f !== "server.jsonl").sort().join(",");
  const origRename = fs.renameSync;
  let renameCalls = 0;
  fs.renameSync = (() => { renameCalls++; throw new Error("rename 불가"); }) as typeof fs.renameSync;
  for (let i = 0; i < 30; i++) console.log(`실패 중 ${i}`);
  fs.renameSync = origRename;
  const keptAfter = fs.readdirSync(d2).filter((f) => f !== "server.jsonl").sort().join(",");
  check(keptBefore !== "" && keptAfter === keptBefore, "rename 실패에도 보관본이 줄지 않는다", `${keptBefore} -> ${keptAfter}`);
  check(renameCalls < 30, "rename 실패 뒤 매 호출마다 회전을 재시도하지 않는다", String(renameCalls));
  check(readServerLog({ dir: d2, lines: 1 })[0]?.msg === "실패 중 29", "rename 실패 중에도 계속 쓴다");
  fs.rmSync(d2, { recursive: true, force: true });
}

// (b) 설치 뒤 로그 폴더 권한을 빼도 console은 계속 동작
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "aether-slog-perm-"));
  installServerLog({ dir: d3, maxBytes: 200 });
  console.log("권한 제거 전");
  fs.chmodSync(d3, 0o500);
  const before3 = seen.length;
  for (let i = 0; i < 10; i++) console.log(`권한 없음 ${i}`);
  fs.chmodSync(d3, 0o700);
  check(seen.length >= before3 + 10, "폴더 권한을 빼도 console은 계속 동작");
  fs.rmSync(d3, { recursive: true, force: true });
}

console.log = real.log; console.warn = real.warn; console.error = real.error;
fs.rmSync(blocker, { force: true });
fs.rmSync(dir, { recursive: true, force: true });
out(`\n${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
