/**
 * 새 버전 확인: 버전 비교, 주소 검사, 응답 검증(스키마·크기·시간 초과), 꺼짐, 라우트 인증, 설정 서버에 라우트 없음, 묶음 주입 우선순위.
 * 가짜 fetch와 임시 포트·임시 폴더만 쓴다. 모델 호출 0.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { bundledUpdateUrl } from "../setup/paths";

// 시험 서버: updateChecker 기본 인스턴스가 import 때 환경변수를 읽으므로 먼저 띄워 주소를 정한 뒤 불러온다.
// 실제 묶음 버전을 올려도 시험이 깨지지 않게 항상 더 높은 값을 쓴다.
const good = { version: "99.0.0", releasedAt: "2026-11-02T00:00:00.000Z", notes: "- 새 기능", pageUrl: "https://evil.example/", files: [{ os: "win", arch: "x64", name: "a.exe", size: 1, sha256: "a".repeat(64) }] };
const origin = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(req.url === "/version.json" ? JSON.stringify(good) : "{}"); });
await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
process.env.AETHER_UPDATE_URL = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
const { createUpdateChecker, isNewerVersion, normalizeUpdateUrl, parseSemver, MAX_BODY_BYTES, updateChecker } = await import("../update/check");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

// 1. 버전 비교
check(isNewerVersion("0.0.2", "0.0.1") && isNewerVersion("0.1.0", "0.0.9") && isNewerVersion("1.0.0", "0.99.99"), "높은 버전은 업데이트");
check(!isNewerVersion("0.0.1", "0.0.1") && !isNewerVersion("0.0.1", "0.0.2") && !isNewerVersion("0.9.0", "0.10.0"), "같거나 낮으면 아님(숫자 비교)");
check(isNewerVersion("0.10.0", "0.9.0"), "0.10.0 > 0.9.0 (문자열 비교가 아님)");
check(!isNewerVersion("0.0.2-beta.1", "0.0.1") && !isNewerVersion("0.0.2", "0.0.1-rc1"), "사전 표기가 있으면 업데이트로 치지 않는다");
check(!isNewerVersion("1.0", "0.0.1") && !isNewerVersion("x.y.z", "0.0.1") && !isNewerVersion("", "0.0.1") && !isNewerVersion("1.0.0.0", "0.0.1"), "세 칸이 아니면 아님");
check(parseSemver("1.2.3")?.join() === "1,2,3" && parseSemver("v1.2.3") === null, "parseSemver");

// 2. 주소 검사
check(normalizeUpdateUrl("http://127.0.0.1:1/") === "http://127.0.0.1:1" && normalizeUpdateUrl("https://a.example/x//") === "https://a.example/x", "http·https 통과, 끝 슬래시 정리");
check(["", "  ", "ftp://a/", "https://user:pw@a.example/", "https://u@a.example/", "https://a.example/?k=v", "https://a.example/#x", "file:///etc/x", "javascript:alert(1)", "data:text/plain,x", "a.example", "//a.example"].every((u) => normalizeUpdateUrl(u) === null), "http·https 외 거절");

// 3. 가짜 fetch로 확인기
const jsonRes = (b: unknown, init?: ResponseInit) => new Response(typeof b === "string" ? b : JSON.stringify(b), init);
const warns: string[] = [];
const mk = (url: string, fetchFn: typeof fetch) => createUpdateChecker({ url, current: "0.0.1", fetchFn, warn: (m) => warns.push(m) });

let calls: string[] = [];
const okFetch = (async (u: string | URL | Request, init?: RequestInit) => { calls.push(String(u)); calls.push(String(init?.headers ? Object.keys(init.headers as object) : "")); return jsonRes(good); }) as typeof fetch;
const a = mk("http://dl.example/aether/", okFetch);
check(a.status().enabled && !a.status().available && a.status().latest === undefined, "확인 전: 켜짐, 새 버전 없음");
await a.checkNow();
const sa = a.status();
check(calls[0] === "http://dl.example/aether/version.json", "version.json 주소로 GET", calls[0]);
check(sa.available && sa.latest === "99.0.0" && sa.current === "0.0.1" && !!sa.checkedAt && sa.notes === "- 새 기능", "새 버전을 받아 표시", sa);
check(sa.pageUrl === "http://dl.example/aether/", "pageUrl은 updateUrl만 쓴다(원격이 준 pageUrl 무시)", sa.pageUrl);
check(calls[1] === "accept", "보내는 헤더는 accept뿐(식별자 없음)", calls[1]);

// 실패는 마지막 값을 유지하고 경고는 한 번만
let mode: "ok" | "bad" = "bad";
const flaky = (async () => (mode === "bad" ? jsonRes({ version: "9.9.9" }) : jsonRes(good))) as typeof fetch;
const b = mk("https://dl.example", flaky);
await b.checkNow();
check(b.status().latest === undefined && !b.status().available, "스키마 어긋나면 거절(값 없음)");
check(warns.length === 1 && !/9\.9\.9/.test(warns[0]), "경고 한 번, 응답 내용은 담지 않음", warns);
await b.checkNow();
check(warns.length === 1, "연속 실패에도 경고는 한 번", warns.length);
mode = "ok"; await b.checkNow();
check(b.status().latest === "99.0.0", "복구되면 값을 받음");
mode = "bad"; await b.checkNow();
check(b.status().latest === "99.0.0" && b.status().available, "실패해도 마지막 값을 유지");
check(warns.length === 2, "복구 뒤 다시 실패하면 경고를 다시 한 번", warns.length);

for (const [label, body] of [
  ["os 값 거절", { ...good, files: [{ ...good.files[0], os: "linux" }] }],
  ["sha256 형식 거절", { ...good, files: [{ ...good.files[0], sha256: "zz" }] }],
  ["JSON 아님 거절", "not json"],
] as const) {
  const c = mk("https://dl.example", (async () => jsonRes(body as never)) as typeof fetch);
  await c.checkNow();
  check(c.status().latest === undefined, label);
}
const http500 = mk("https://dl.example", (async () => jsonRes("x", { status: 500 })) as typeof fetch);
await http500.checkNow();
check(http500.status().latest === undefined, "HTTP 오류 거절");

let sawRedirect: string | undefined;
await mk("https://dl.example", (async (_u: unknown, init?: RequestInit) => { sawRedirect = init?.redirect; return jsonRes(good); }) as typeof fetch).checkNow();
check(sawRedirect === "error", "리다이렉트를 따라가지 않는다");
const w1 = warns.length;
await mk("https://dl.example", (async () => jsonRes("비밀-응답-내용")) as typeof fetch).checkNow();
check(warns.length === w1 + 1 && !warns[w1].includes("비밀-응답-내용") && warns[w1].endsWith("SyntaxError"), "JSON 해석 오류는 이름만 로그에 남긴다", warns[w1]);

// 크기 제한: 1MB를 넘는 본문은 끊는다
const bigPad = "x".repeat(MAX_BODY_BYTES + 10);
const big = mk("https://dl.example", (async () => jsonRes({ ...good, notes: bigPad })) as typeof fetch);
await big.checkNow();
check(big.status().latest === undefined, "1MB 초과 응답 거절");
let pulled = 0;
const endless = (async () => new Response(new ReadableStream({ pull(c) { pulled += 65536; c.enqueue(new Uint8Array(65536)); } }))) as typeof fetch;
await mk("https://dl.example", endless).checkNow();
check(pulled < MAX_BODY_BYTES + 4 * 65536 * 2, "끝없는 본문은 한도 근처에서 읽기를 멈춘다", pulled);

// 시간 초과(5초). 신호가 끊기면 던지는 가짜 fetch.
let sawSignal = false;
const hang = ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => { sawSignal = init?.signal instanceof AbortSignal; init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)); })) as typeof fetch;
const keepAlive = setInterval(() => undefined, 1000); // AbortSignal.timeout은 프로세스를 붙잡지 않는다
const t0 = Date.now();
const slow = mk("https://dl.example", hang);
await slow.checkNow();
const took = Date.now() - t0;
clearInterval(keepAlive);
check(sawSignal && took >= 4500 && took < 8000 && slow.status().latest === undefined, "5초 안에 응답이 없으면 포기", took);

// 꺼짐
let called = 0;
const countFetch = (async () => { called++; return jsonRes(good); }) as typeof fetch;
const w0 = warns.length;
const off = mk("", countFetch);
await off.checkNow(); off.start();
check(!off.status().enabled && called === 0 && Object.keys(off.status()).sort().join() === "available,current,enabled", "updateUrl이 비면 꺼짐(요청 없음)", off.status());
check(warns.length === w0, "빈 값은 경고도 없다");
const badUrl = mk("ftp://dl.example", countFetch);
await badUrl.checkNow();
check(!badUrl.status().enabled && called === 0 && warns.length === w0 + 1, "http·https가 아니면 꺼짐과 경고 한 번");
off.stop(); a.stop();

// 4. 묶음 주입 우선순위
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aether-update-"));
const cfgNo = path.join(tmp, "a.json"); fs.writeFileSync(cfgNo, JSON.stringify({ port: 9000 }));
const cfgYes = path.join(tmp, "b.json"); fs.writeFileSync(cfgYes, JSON.stringify({ updateUrl: "" }));
check(bundledUpdateUrl("https://dl.example/a", cfgNo, {}) === "https://dl.example/a", "묶음 값은 다른 곳에 없으면 쓴다");
check(bundledUpdateUrl("https://dl.example/a", cfgYes, {}) === undefined, "config.json의 updateUrl(빈 값 포함)이 있으면 주입하지 않는다");
check(bundledUpdateUrl("https://dl.example/a", cfgNo, { AETHER_UPDATE_URL: "https://x" }) === undefined, "환경변수가 있으면 주입하지 않는다");
check(bundledUpdateUrl(undefined, cfgNo, {}) === undefined && bundledUpdateUrl("  ", cfgNo, {}) === undefined && bundledUpdateUrl(5, cfgNo, {}) === undefined, "묶음 값이 없으면 주입하지 않는다");
check(bundledUpdateUrl("https://dl.example/a", path.join(tmp, "none.json"), {}) === "https://dl.example/a", "설정 파일이 없어도 동작");

// 5. 라우트: 실제 시험 서버(임시 포트)가 version.json을 주고, 라우터는 인증 뒤에 둔다.
const { systemRouter } = await import("../routes/system");
const { createAuthMiddleware } = await import("../middleware/auth");
const app = express();
app.use("/api/system", createAuthMiddleware({ authenticate: async (req) => (req.get("authorization") === "test" ? { login: "test", via: "off" } : null) }), systemRouter);
const srv = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => srv.on("listening", r));
const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
check((await fetch(`${url}/api/system/update`)).status === 401, "인증 없으면 401");
const before = await (await fetch(`${url}/api/system/update`, { headers: { authorization: "test" } })).json();
check(before.enabled === true && before.available === false && before.pageUrl === `${process.env.AETHER_UPDATE_URL}/`, "확인 전 응답", before);
await updateChecker.checkNow();
const after = await (await fetch(`${url}/api/system/update`, { headers: { authorization: "test" } })).json();
check(after.available === true && after.latest === "99.0.0" && after.pageUrl === `${process.env.AETHER_UPDATE_URL}/` && !JSON.stringify(after).includes("evil"), "확인 뒤 응답", after);

// 6. 설정 서버에는 이 라우트가 없다
const { createSetupApp } = await import("../setup/app");
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "aether-update-setup-"));
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aether-update-dist-"));
fs.writeFileSync(path.join(dist, "index.html"), "<html></html>");
let setupPort = 0;
const setup = createSetupApp({ distDir: dist, paths: { configDir: cfg, defaultDataDir: path.join(cfg, "data"), configFile: path.join(cfg, "config.json"), envFile: path.join(cfg, ".env"), startLog: path.join(cfg, "start.log") }, getPort: () => setupPort, exit: () => undefined, log: () => undefined });
const ss = setup.listen(0, "127.0.0.1");
await new Promise<void>((r) => ss.on("listening", r));
setupPort = (ss.address() as AddressInfo).port;
const sres = await fetch(`http://127.0.0.1:${setupPort}/api/system/update`);
check(sres.status === 404, "설정 서버의 /api/system/update는 404", sres.status);
const setupSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../setup/app.ts"), "utf8");
check(!/systemRouter|update\/check/.test(setupSrc), "설정 서버 소스가 system 라우터와 확인기를 쓰지 않는다");

// 7. 공개키가 있으면 서명이 맞는 값만 받아들인다
{
  const crypto = await import("node:crypto");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const bodyOf = (version: string) => Buffer.from(JSON.stringify({ ...good, version }));
  let served = { json: bodyOf("0.0.5"), sig: "" as string | null };
  const sign = (buf: Buffer, key = privateKey) => crypto.sign(null, buf, key).toString("base64");
  const site = (async (u: string | URL | Request) => {
    const x = String(u);
    if (x.endsWith("/version.json")) return new Response(new Uint8Array(served.json));
    return served.sig === null ? new Response("", { status: 404 }) : new Response(served.sig);
  }) as typeof fetch;
  const kc = createUpdateChecker({ url: "https://dl.example", current: "0.0.1", fetchFn: site, publicKey: pubB64, warn: () => undefined });
  served = { json: bodyOf("0.0.5"), sig: sign(bodyOf("0.0.5")) };
  await kc.checkNow();
  check(kc.status().available && kc.status().latest === "0.0.5", "올바른 서명은 새 버전으로 표시된다", kc.status());
  served = { json: bodyOf("9.9.9"), sig: null };
  await kc.checkNow();
  check(kc.status().latest === "0.0.5", "서명 없는 9.9.9는 받아들이지 않고 앞선 값을 유지한다", kc.status());
  served = { json: bodyOf("9.9.9"), sig: sign(bodyOf("9.9.9"), crypto.generateKeyPairSync("ed25519").privateKey) };
  await kc.checkNow();
  check(kc.status().latest === "0.0.5", "틀린 서명의 9.9.9도 받아들이지 않는다", kc.status());
  const fresh = createUpdateChecker({ url: "https://dl.example", current: "0.0.1", fetchFn: site, publicKey: pubB64, warn: () => undefined });
  await fresh.checkNow();
  check(!fresh.status().available && fresh.status().latest === undefined, "처음부터 서명이 틀리면 새 버전이 없다", fresh.status());
}

srv.close(); ss.close(); origin.close();
console.log(`\n${fail === 0 ? "✅" : "❌"} update_check: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
