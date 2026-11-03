/**
 * 서버가 켜질 때 화면 빌드 확인 — 판단 함수, 빌드 호출 여부, 503 안내, 시험 환경 자동 빌드 꺼짐.
 * 임시 폴더만 쓴다. 실제 vite·운영 web/dist는 건드리지 않는다. 모델 호출 0.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { config } from "../config";
import { createStaticAddon, judgeBuild, readBuildInfo } from "../routes/static";
import { computeWebSourceHash } from "../observability/webBuildHash";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

const CONTRACT = 5;
const info = (contractVersion: number, sourceHash = "h") => ({ contractVersion, sourceHash, builtAt: "x" });

/** 임시 저장소 모양(<root>/web/dist, 선택으로 web/src). */
function fixture(opts: { buildInfo?: ReturnType<typeof info>; source?: boolean }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aether-wbg-"));
  const dist = path.join(root, "web", "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<html>APP</html>");
  if (opts.buildInfo) fs.writeFileSync(path.join(dist, "build-info.json"), JSON.stringify(opts.buildInfo));
  if (opts.source) {
    fs.mkdirSync(path.join(root, "web", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "web", "src", "a.ts"), "1");
  }
  return { root, dist };
}

async function get(dist: string, addonOpts: Parameters<typeof createStaticAddon>[0], p: string) {
  const addon = createStaticAddon({ enabled: true, distDir: dist, contractVersion: CONTRACT, ...addonOpts });
  const app = express();
  addon.prepare();
  addon.mount(app);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`);
    return { status: r.status, body: await r.text(), cache: r.headers.get("cache-control") };
  } finally {
    srv.close();
  }
}

// 판단 함수
check(judgeBuild(null, CONTRACT) === "missing", "build-info 없음 → missing");
check(judgeBuild(info(4), CONTRACT) === "contract", "계약 다름 → contract");
check(judgeBuild(info(5, "a"), CONTRACT, "b") === "source", "해시 다름 → source");
check(judgeBuild(info(5, "a"), CONTRACT, "a") === "ok", "해시 같음 → ok");
check(judgeBuild(info(5, "a"), CONTRACT, undefined) === "ok", "소스 없으면 계약만 비교");

// 시험 환경에서 자동 빌드가 꺼진다(이 파일은 server/test 아래에서 실행된다)
check(config.webAutoBuild === false, "시험 실행에서는 config.webAutoBuild가 꺼져 있다");

// 해시: 내용이 바뀌면 달라진다
{
  const f = fixture({ source: true });
  const h1 = computeWebSourceHash(f.root);
  fs.writeFileSync(path.join(f.root, "web", "src", "a.ts"), "2");
  check(h1 !== computeWebSourceHash(f.root), "소스 내용이 바뀌면 해시가 달라진다");
}

// autoBuild 꺼짐(기본): 빌드를 호출하지 않는다
{
  const f = fixture({ buildInfo: info(4), source: true });
  let called = 0;
  const r = await get(f.dist, { runBuild: () => (called++, { ok: true }) }, "/");
  check(called === 0, "자동 빌드 꺼짐이면 빌드 함수를 부르지 않는다");
  check(r.status === 503 && r.body.includes("화면과 서버 버전이 맞지 않습니다") && r.body.includes("화면이 서버보다 오래됐습니다") && r.body.includes('href="/"') && !r.body.includes("<script"), "계약 다르면 503 안내(스크립트 없음)", String(r.status));
  check(r.cache === "no-cache", "503 안내는 no-cache");
  const r2 = await get(f.dist, {}, "/some/deep/link");
  check(r2.status === 503, "SPA 경로도 503");
  const r3 = await get(f.dist, {}, "/build-info.json");
  check(r3.status === 200 && r3.cache === "no-cache", "build-info.json은 막히지 않고 no-cache");
}

// autoBuild 켜짐: 계약 다름 → 빌드 호출, 성공하면 정상 서빙
{
  const f = fixture({ buildInfo: info(4), source: true });
  let called = 0;
  const runBuild = (webDir: string) => {
    called++;
    fs.writeFileSync(path.join(webDir, "dist", "build-info.json"), JSON.stringify(info(CONTRACT, computeWebSourceHash(f.root))));
    return { ok: true };
  };
  const r = await get(f.dist, { autoBuild: true, runBuild }, "/");
  check(called === 1 && r.status === 200 && r.body.includes("APP"), "자동 빌드가 켜지면 빌드 후 정상 서빙");
}

// 해시만 다름 → 빌드 호출
{
  const f = fixture({ buildInfo: info(CONTRACT, "old"), source: true });
  let called = 0;
  await get(f.dist, { autoBuild: true, runBuild: () => (called++, { ok: false, error: "x" }) }, "/");
  check(called === 1, "해시만 달라도 빌드를 부른다");
  const r = await get(f.dist, { autoBuild: true, runBuild: () => ({ ok: false, error: "x" }) }, "/");
  check(r.status === 200, "계약이 같으면 빌드가 실패해도 화면을 막지 않는다");
}

// 빌드 실패 + 계약 다름 → 503, 원인이 안내에 보인다
{
  const f = fixture({ buildInfo: info(4), source: true });
  const r = await get(f.dist, { autoBuild: true, runBuild: () => ({ ok: false, error: "vite 폭발" }) }, "/");
  check(r.status === 503 && r.body.includes("vite 폭발"), "빌드 실패 + 계약 다름 → 503에 원인 표시");
}

// 일치하면 빌드하지 않는다
{
  const f = fixture({ source: true });
  fs.writeFileSync(path.join(f.dist, "build-info.json"), JSON.stringify(info(CONTRACT, computeWebSourceHash(f.root))));
  let called = 0;
  const r = await get(f.dist, { autoBuild: true, runBuild: () => (called++, { ok: true }) }, "/");
  check(called === 0 && r.status === 200, "일치하면 빌드하지 않는다");
}

// build-info 없음: 요청 때는 막지 않는다 / 소스 없는 설치본은 빌드하지 않는다
{
  const f = fixture({});
  let called = 0;
  const r = await get(f.dist, { autoBuild: true, runBuild: () => (called++, { ok: true }) }, "/");
  check(r.status === 200 && called === 0, "build-info 없고 소스도 없으면 통과·빌드 안 함");
  const g = fixture({ source: true });
  const r2 = await get(g.dist, {}, "/");
  check(r2.status === 200, "build-info 없으면 요청 때 막지 않는다");
}

// 요청 중에 build-info가 바뀜: 화면이 서버보다 오래되면 503, 새로우면(빌드만 하고 재시작 전) 막지 않는다
{
  const f = fixture({ buildInfo: info(CONTRACT) });
  const addon = createStaticAddon({ enabled: true, distDir: f.dist, contractVersion: CONTRACT });
  const app = express();
  addon.prepare();
  addon.mount(app);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const status = async () => (await fetch(`http://127.0.0.1:${port}/`)).status;
  const bump = (v: number, plus: number) => {
    const bi = path.join(f.dist, "build-info.json");
    fs.writeFileSync(bi, JSON.stringify(info(v)));
    fs.utimesSync(bi, new Date(), new Date(Date.now() + plus));
  };
  const s1 = await status();
  bump(CONTRACT + 1, 5000);
  const s2 = await status();
  bump(CONTRACT - 1, 10000);
  const s3 = await status();
  srv.close();
  check(s1 === 200 && s2 === 200 && s3 === 503, "화면이 서버보다 높으면 통과(경고만), 낮으면 503", `${s1}/${s2}/${s3}`);
  check(readBuildInfo(f.dist)?.contractVersion === CONTRACT - 1, "readBuildInfo가 읽는다");
}

// 부팅 확인이 예외를 내도 서버는 계속 뜬다
{
  const f = fixture({ buildInfo: info(4), source: true });
  const r = await get(f.dist, { autoBuild: true, runBuild: () => { throw new Error("boom"); } }, "/");
  check(r.status === 200 || r.status === 503, "빌드 함수가 던져도 prepare가 던지지 않는다", String(r.status));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} web_build_guard: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
