/**
 * 검색 결과 요약 스위치.
 * 저장·읽기, 입력 검증(boolean이 아니면 400), 꺼지면 요약 모델(distill)을 부르지 않는다.
 * 쓰기는 임시 데이터 폴더와 임시 SQLite 파일만. 실제 모델은 부르지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import express from "express";
import { config } from "../config";
import type { ProviderServices } from "../providers/types";
import { __resetSessionLetterForTest, openSessionLetter, replaceSessionLetter } from "../db/sessionLetter";
import { searchToolDef } from "../search/agentTool";
import { readSearchSummarize, writeSearchSummarize } from "../search/summarySetting";
import { searchRouter } from "../routes/search";
import { useTempDatabase } from "./support/tempDb";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

if (path.resolve(config.dataDir) === path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "data")) {
  throw new Error("데이터 폴더가 운영 data다");
}
const file = path.join(config.dataDir, "search-summary.json");
fs.rmSync(file, { force: true });

check(readSearchSummarize() === config.searchSummarize, "저장값이 없으면 config 값을 따른다");
check(writeSearchSummarize(false) === false && readSearchSummarize() === false, "끄면 읽기도 꺼짐이다");
check(writeSearchSummarize(true) === true && readSearchSummarize() === true, "켜면 읽기도 켜짐이다");
fs.writeFileSync(file, "{깨짐");
check(readSearchSummarize() === config.searchSummarize, "파일이 깨졌으면 config 값으로 돌아간다");
fs.rmSync(file, { force: true });

// 라우트: GET/PUT과 검증
const app = express();
app.use(express.json());
app.use("/api/search", searchRouter);
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/search/summary-setting`;
const put = (body: unknown) => fetch(base, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const got = async () => ((await (await fetch(base)).json()) as { enabled: boolean }).enabled;
check((await put({ enabled: false })).status === 200 && (await got()) === false, "PUT false 뒤 GET이 false다");
check((await put({ enabled: true })).status === 200 && (await got()) === true, "PUT true 뒤 GET이 true다");
for (const bad of [{}, { enabled: "false" }, { enabled: 0 }, { enabled: null }]) {
  check((await put(bad)).status === 400, `boolean이 아니면 400이다 ${JSON.stringify(bad)}`);
}
check((await got()) === true, "거절된 요청은 저장값을 바꾸지 않는다");
server.close();

// 요약 호출: 스위치가 꺼지면 distill을 부르지 않는다
const calls: string[] = [];
const services = { distill(prompt: string) { calls.push(prompt); return Promise.resolve("가짜요약 한줄"); } } as unknown as ProviderServices;
const tool = searchToolDef();
const search = async () => (await tool.handler({ query: "sumtoken" }, { cwd: "/tmp/sum-proj", services, sessionId: "sum-runner" })).content.map((p) => p.text).join("\n");
const tempDb = useTempDatabase("sumsetting");
try {
  __resetSessionLetterForTest();
  await openSessionLetter();
  await replaceSessionLetter("sum-a", [{ seq: 1, part: 0, role: "user", ts: Date.UTC(2026, 8, 26), content: "sumtoken 배포 기록" }], [], {
    displayName: null, cwd: "/tmp/sum-other", model: null, createdAt: 1, lineageId: "sum-a",
  });
  writeSearchSummarize(true);
  await search();
  check(calls.length === 1, "켜면 요약 모델을 부른다", calls.length);
  writeSearchSummarize(false);
  const raw = await search();
  check(calls.length === 1 && raw.includes("sumtoken"), "끄면 부르지 않고 원문을 돌려준다", calls.length);
  writeSearchSummarize(true);
  await search();
  check(calls.length === 2, "다시 켜면 재시작 없이 바로 부른다", calls.length);
} finally {
  tempDb.dispose();
  fs.rmSync(file, { force: true });
}
console.log(`\n${fail === 0 ? "✅" : "❌"} search_summary_setting: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
