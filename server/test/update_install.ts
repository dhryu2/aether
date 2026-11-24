/**
 * 앱 안 업데이트: 서명·지문 검사, 진행 상태, 취소, 넘기기와 실패, 되돌림 표시, 맥 dmg 넘기기.
 * 가짜 사이트와 임시 폴더만 쓴다. 실제 설치, 모델 호출은 없다.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createUpdateInstaller, handoffMac, targetFor, verifySignature, type UpdateInstallerOptions } from "../update/install";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-update-install-")));
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const payload = Buffer.alloc(4096, 7);
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

type Site = { version?: string; name?: string; body?: Buffer; fileSha?: string; size?: number; sign?: "good" | "other" | "none"; hang?: boolean };
function site(o: Site = {}): typeof fetch {
  const version = o.version ?? "0.0.3";
  const name = o.name ?? `Aether-${version}-win-x64.exe`;
  const body = o.body ?? payload;
  const json = Buffer.from(JSON.stringify({ version, releasedAt: "2026-11-02T00:00:00.000Z", notes: "", files: [{ os: "win", arch: "x64", name, size: o.size ?? body.length, sha256: o.fileSha ?? sha(body) }] }));
  const signer = o.sign === "other" ? crypto.generateKeyPairSync("ed25519").privateKey : privateKey;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/version.json")) return new Response(new Uint8Array(json));
    if (u.endsWith("/version.json.sig")) return o.sign === "none" ? new Response("", { status: 404 }) : new Response(crypto.sign(null, json, signer).toString("base64"));
    if (o.hang) {
      return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(body.subarray(0, 100))); init?.signal?.addEventListener("abort", () => c.error(new DOMException("취소", "AbortError"))); } }));
    }
    return new Response(new Uint8Array(body));
  }) as typeof fetch;
}

let n = 0;
function make(fetchFn: typeof fetch, over: Partial<UpdateInstallerOptions> = {}) {
  const updatesDir = path.join(tmp, `u${n++}`);
  const handoffs: string[] = [];
  const exits: number[] = [];
  const inst = createUpdateInstaller({
    url: "https://site.example", current: "0.0.2", publicKey: pub, supervised: true, platform: "win32", arch: "x64", updatesDir, fetchFn,
    beforeHandoff: async () => undefined,
    handoff: async (f, v) => { handoffs.push(`${path.basename(f)}:${v}:${fs.existsSync(f)}`); return 75; },
    warn: () => undefined,
    ...over,
  });
  inst.onExit((c) => exits.push(c));
  return { inst, updatesDir, handoffs, exits };
}
const settled = async (inst: ReturnType<typeof make>["inst"]) => {
  for (let i = 0; i < 400; i++) {
    const p = inst.status().install.phase;
    if (p === "failed" || p === "idle" || p === "installing") return inst.status().install;
    await new Promise((r) => setTimeout(r, 5));
  }
  return inst.status().install;
};
const failedWith = async (s: Site, reason: string, name: string) => {
  const m = make(site(s));
  m.inst.start(s.version ?? "0.0.3");
  const st = await settled(m.inst);
  check(st.phase === "failed" && st.reason === reason && m.handoffs.length === 0, name, st);
  check(!fs.existsSync(path.join(m.updatesDir, "Aether-update.exe")) && !fs.existsSync(path.join(m.updatesDir, "Aether-update.exe.part")), `${name}: 받은 파일이 남지 않는다`);
};

// 1. 켜지는 조건
check(!!targetFor("win32", "x64") && !!targetFor("darwin", "arm64") && !targetFor("win32", "arm64") && !targetFor("linux", "x64"), "배포하는 조합만 설치 대상");
check(make(site()).inst.status().canInstall, "자동 실행 장치 아래 설치본이면 켜진다");
check(!make(site(), { supervised: false }).inst.status().canInstall, "자동 실행 장치 밖이면 꺼진다");
check(!make(site(), { publicKey: undefined }).inst.status().canInstall, "공개키가 없으면 꺼진다");
check(!make(site(), { url: "" }).inst.status().canInstall, "배포 주소가 없으면 꺼진다");
const off = make(site(), { supervised: false });
check(off.inst.start("0.0.3") === false && off.inst.status().install.phase === "idle", "꺼져 있으면 시작하지 않는다");

// 2. 서명 함수
const sample = Buffer.from("x");
check(verifySignature(sample, crypto.sign(null, sample, privateKey).toString("base64"), pub), "맞는 서명 통과");
check(!verifySignature(Buffer.from("y"), crypto.sign(null, sample, privateKey).toString("base64"), pub), "내용이 바뀌면 거절");
check(!verifySignature(sample, "!!!", pub) && !verifySignature(sample, "", "not-a-key"), "모양이 잘못돼도 예외 없이 거절");

// 3. 정상 흐름
{
  const m = make(site());
  check(m.inst.start("0.0.3") === true, "시작");
  check(m.inst.start("0.0.3") === false, "진행 중에는 다시 시작하지 않는다");
  const st = await settled(m.inst);
  check(st.phase === "installing" && st.version === "0.0.3", "설치 단계까지 간다", st);
  check(fs.readFileSync(path.join(m.updatesDir, "Aether-update.exe")).equals(payload), "받은 파일 내용이 같다");
  check(m.handoffs[0] === "Aether-update.exe:0.0.3:true", "검사가 끝난 고정 이름 파일을 넘긴다", m.handoffs);
  check(m.inst.cancel() === false, "설치 단계에서는 취소할 수 없다");
  await new Promise((r) => setTimeout(r, 900));
  check(m.exits[0] === 75, "넘긴 뒤 약속한 코드로 끝낸다", m.exits);
}

// 4. 거절
await failedWith({ sign: "none" }, "signature", "서명 파일이 없으면 거절");
await failedWith({ sign: "other" }, "signature", "다른 키 서명은 거절");
await failedWith({ version: "0.0.2", name: "Aether-0.0.2-win-x64.exe" }, "signature", "같은 버전은 거절");
await failedWith({ version: "0.0.1", name: "Aether-0.0.1-win-x64.exe" }, "signature", "낮은 버전은 거절");
await failedWith({ name: "../../evil.exe" }, "signature", "경로가 든 파일 이름은 거절");
await failedWith({ name: "Aether-9.9.9-win-x64.exe" }, "signature", "버전과 다른 파일 이름은 거절");
await failedWith({ fileSha: "0".repeat(64) }, "verify", "지문이 다르면 거절");
await failedWith({ size: payload.length - 1 }, "verify", "선언보다 크면 거절");
await failedWith({ size: payload.length + 1 }, "verify", "선언보다 작으면 거절");

// 사용자가 동의한 버전과 서명된 최신 값이 다르면 설치 파일을 요청하지 않는다
{
  const requested: string[] = [];
  const inner = site({ version: "0.0.4" });
  const m = make(((u: string | URL | Request, init?: RequestInit) => (requested.push(String(u)), inner(u, init))) as typeof fetch);
  m.inst.start("0.0.3");
  const st = await settled(m.inst);
  check(st.phase === "failed" && st.reason === "signature" && !requested.some((u) => u.endsWith(".exe")) && m.handoffs.length === 0, "동의한 버전과 서명된 버전이 다르면 파일을 받지 않고 거절", { st, requested });
}

// 5. 실패 처리
{
  const m = make(site(), { beforeHandoff: async () => { throw new Error("디스크"); } });
  m.inst.start("0.0.3");
  const st = await settled(m.inst);
  // 설치 단계로 잠깐 간 뒤 실패로 바뀌므로 다시 기다린다.
  await new Promise((r) => setTimeout(r, 50));
  check(m.inst.status().install.phase === "failed" && m.handoffs.length === 0 && m.exits.length === 0, "백업 실패면 넘기지 않고 끝내지 않는다", st);
}
{
  const m = make(site(), { handoff: async () => { throw new Error("launchctl"); } });
  m.inst.start("0.0.3");
  await settled(m.inst);
  await new Promise((r) => setTimeout(r, 50));
  const st = m.inst.status().install;
  check(st.phase === "failed" && st.reason === "handoff" && m.exits.length === 0, "넘기기 실패면 서버는 계속 돈다", st);
  check(m.inst.start("0.0.3") === true, "실패 뒤 다시 시작할 수 있다");
  await settled(m.inst);
}

// 6. 취소와 멈춤
{
  const m = make(site({ hang: true }));
  m.inst.start("0.0.3");
  for (let i = 0; i < 200 && m.inst.status().install.phase !== "downloading"; i++) await new Promise((r) => setTimeout(r, 5));
  check(m.inst.status().install.phase === "downloading", "다운로드 중 상태");
  check(m.inst.cancel() === true, "다운로드 중 취소");
  const st = await settled(m.inst);
  check(st.phase === "idle" && m.handoffs.length === 0, "취소하면 실패 없이 처음으로", st);
  check(!fs.existsSync(path.join(m.updatesDir, "Aether-update.exe.part")), "취소하면 받던 파일을 지운다");
}
{
  const m = make(site({ hang: true }), { stallMs: 50 });
  m.inst.start("0.0.3");
  const st = await settled(m.inst);
  check(st.phase === "failed" && st.reason === "network", "받기가 멈추면 실패", st);
}

// 7. 정상 표시와 되돌림 표시
{
  const m = make(site());
  m.inst.markHealthy();
  check(!fs.existsSync(m.updatesDir), "updates 폴더가 없으면 아무것도 만들지 않는다");
  fs.mkdirSync(m.updatesDir);
  m.inst.markHealthy();
  check(fs.existsSync(path.join(m.updatesDir, "ok-0.0.2")), "정상 표시를 남긴다");
  fs.writeFileSync(path.join(m.updatesDir, "rolled-back"), "0.0.3");
  check(m.inst.status().rolledBackVersion === "0.0.3", "되돌림을 알린다");
  fs.writeFileSync(path.join(m.updatesDir, "rolled-back"), "0.0.2");
  check(m.inst.status().rolledBackVersion === undefined, "이미 지난 버전의 되돌림은 무시한다");
  m.inst.start("0.0.3");
  check(await settled(m.inst).then(() => !fs.existsSync(path.join(m.updatesDir, "rolled-back"))), "다시 시도하면 되돌림 표시를 지운다");
}

{
  const m = make(site(), { supervised: false });
  fs.mkdirSync(m.updatesDir);
  fs.writeFileSync(path.join(m.updatesDir, "Aether-update.exe"), "x");
  m.inst.markHealthy();
  check(!fs.existsSync(path.join(m.updatesDir, "ok-0.0.2")), "자동 실행 장치 밖의 서버는 설치본의 정상 표시를 쓰지 않는다");
}
{
  const m = make(site(), { cleanupDelayMs: 5 });
  fs.mkdirSync(m.updatesDir);
  for (const f of ["Aether-update.exe", "rolled-back", "update.log"]) fs.writeFileSync(path.join(m.updatesDir, f), "x");
  m.inst.markHealthy();
  await new Promise((r) => setTimeout(r, 60));
  check(!fs.existsSync(path.join(m.updatesDir, "Aether-update.exe")) && !fs.existsSync(path.join(m.updatesDir, "ok-0.0.2")), "정상 부팅 뒤 받은 파일을 치운다");
  check(fs.existsSync(path.join(m.updatesDir, "rolled-back")) && fs.existsSync(path.join(m.updatesDir, "update.log")), "되돌림 표시와 설치 기록은 남긴다");
}

// 맥 대상은 dmg이고, 넘기기가 null이면 서버는 스스로 끝내지 않는다(교체 스크립트가 앱을 끈다).
{
  const t = targetFor("darwin", "arm64")!;
  check(t.staged === "Aether-update.dmg" && t.pattern.test("Aether-1.2.3-mac-arm64.dmg") && !t.pattern.test("Aether-1.2.3-mac-arm64.pkg"), "맥 대상은 dmg만 받는다", t);
  const m = make(site(), { handoff: async () => null });
  m.inst.start("0.0.3");
  await settled(m.inst);
  await new Promise((r) => setTimeout(r, 900));
  check(m.exits.length === 0 && m.inst.status().install.phase === "installing", "넘기기가 null이면 서버가 스스로 끝내지 않는다", m.exits);
  const stuck = make(site(), { handoff: async () => null, handoffWaitMs: 50 });
  stuck.inst.start("0.0.3");
  await settled(stuck.inst);
  await new Promise((r) => setTimeout(r, 1200));
  const st = stuck.inst.status().install;
  check(st.phase === "failed" && st.reason === "handoff", "넘긴 뒤에도 서버가 살아 있으면 실패로 돌린다", st);
}

// 8. 맥 dmg 넘기기: 임시 폴더, 임시 서명, 가짜 apply-update.sh만 쓴다.
if (process.platform === "darwin") {
  const mounts = () => spawnSync("hdiutil", ["info"], { encoding: "utf8" }).stdout;
  const scenario = (name: string, breakSignature: boolean) => {
    const dir = path.join(tmp, name);
    const conf = path.join(dir, "conf");
    const core = path.join(dir, "res", "core");
    const src = path.join(dir, "src");
    const app = path.join(src, "Aether.app");
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.mkdirSync(core, { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Aether</string><key>CFBundleIdentifier</key><string>test.aether.fake</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
    fs.writeFileSync(path.join(app, "Contents", "MacOS", "Aether"), "#!/bin/bash\n", { mode: 0o755 });
    spawnSync("codesign", ["--force", "--sign", "-", app]);
    if (breakSignature) fs.appendFileSync(path.join(app, "Contents", "MacOS", "Aether"), "# 변조\n");
    const dmg = path.join(dir, "Aether-update.dmg");
    spawnSync("hdiutil", ["create", "-volname", "Aether", "-srcfolder", src, "-format", "UDZO", "-ov", dmg]);
    const record = path.join(dir, "record.txt");
    fs.writeFileSync(path.join(dir, "res", "apply-update.sh"), `#!/bin/bash\necho "$1|$AETHER_APP_BASE|$AETHER_UPDATE_VERSION|$(ls "$AETHER_APP_BASE/update")" > "${record}"\n`, { mode: 0o755 });
    return { dmg, conf, core, record };
  };
  const before = mounts();

  const ok = scenario("mac-ok", false);
  await handoffMac(ok.dmg, "0.0.9", ok.conf, ok.core);
  check(fs.existsSync(path.join(ok.conf, "update", "Aether.app", "Contents", "MacOS", "Aether")), "맥: 대기 폴더에 새 앱이 복사된다");
  check(fs.existsSync(ok.record) && fs.readFileSync(ok.record, "utf8").trim() === `--detach|${ok.conf}|0.0.9|Aether.app`, "맥: 교체 스크립트에 인자·설정 폴더·버전을 넘긴다", fs.existsSync(ok.record) && fs.readFileSync(ok.record, "utf8"));
  check(mounts() === before, "맥: dmg 마운트가 남지 않는다");

  const bad = scenario("mac-bad", true);
  let err = false;
  await handoffMac(bad.dmg, "0.0.9", bad.conf, bad.core).catch(() => { err = true; });
  check(err && !fs.existsSync(bad.record) && !fs.existsSync(path.join(bad.conf, "update", "Aether.app")), "맥: 서명이 망가진 앱이면 교체 스크립트를 부르지 않고 실패한다");
  check(mounts() === before, "맥: 실패해도 마운트가 남지 않는다");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`update_install: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
