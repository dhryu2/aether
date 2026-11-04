/**
 * 앱 안 업데이트: 서명·지문 검사, 진행 상태, 취소, 넘기기와 실패, 되돌림 표시, 맥 설치 스크립트의 되돌리기.
 * 가짜 사이트와 임시 폴더만 쓴다. 실제 설치, launchctl, 모델 호출은 없다.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUpdateInstaller, targetFor, verifySignature, type UpdateInstallerOptions } from "../update/install";

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

// 8. 맥 설치 스크립트: 가짜 launchctl, installer와 임시 폴더만 쓴다.
if (process.platform === "darwin") {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "deploy", "installer", "mac", "aether-update.sh");
  const scenario = (name: string, installerBody: string, prepare?: (ctx: { app: string; fake: string }) => void) => {
    const dir = path.join(tmp, name);
    const home = path.join(dir, "home");
    const app = path.join(home, "Applications", "Aether");
    const updates = path.join(dir, "updates");
    const fake = path.join(dir, "fake");
    const log = path.join(dir, "calls.log");
    for (const d of ["bin", "node", "server", "web"]) { fs.mkdirSync(path.join(app, d), { recursive: true }); fs.writeFileSync(path.join(app, d, "old"), "old"); }
    fs.mkdirSync(updates, { recursive: true });
    fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake, "launchctl"), `#!/bin/bash\necho "$*" >> "${log}"\n[ "$1" = print ] && exit 1\nexit 0\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(fake, "installer"), `#!/bin/bash\nAPP="${app}"; UPDATES="${updates}"\n${installerBody}\n`, { mode: 0o755 });
    prepare?.({ app, fake });
    const r = spawnSync("bash", [script, app, updates, "0.0.3"], { env: { PATH: `${fake}:/usr/bin:/bin`, HOME: home, AETHER_UPDATE_WAIT: "2" }, encoding: "utf8" });
    return { app, updates, status: r.status, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
  };
  const newFiles = `for d in bin node server web; do mkdir -p "$APP/$d"; echo new > "$APP/$d/new"; done`;
  const isOld = (app: string) => ["bin", "node", "server", "web"].every((d) => fs.existsSync(path.join(app, d, "old")) && !fs.existsSync(path.join(app, d, "new")));

  const ok = scenario("mac-ok", `${newFiles}\ntouch "$UPDATES/ok-0.0.3"`);
  check(ok.status === 0 && fs.existsSync(path.join(ok.app, "server", "new")) && !fs.existsSync(path.join(ok.app, "server", "old")), "맥: 정상이면 새 파일만 남는다", ok);
  check(!fs.existsSync(path.join(ok.app, ".old")) && !fs.existsSync(path.join(ok.updates, "rolled-back")) && !fs.existsSync(path.join(ok.updates, "ok-0.0.3")), "맥: 정상이면 이전 파일과 표시를 치운다");

  const refused = scenario("mac-refused", "exit 1");
  check(isOld(refused.app) && fs.readFileSync(path.join(refused.updates, "rolled-back"), "utf8") === "0.0.3", "맥: 설치 명령이 실패하면 되돌리고 표시한다", refused);
  check(refused.calls.includes("bootstrap"), "맥: 되돌린 뒤 이전 버전을 다시 띄운다", refused.calls);

  const sick = scenario("mac-sick", newFiles);
  check(isOld(sick.app) && !fs.existsSync(path.join(sick.app, ".old")) && fs.readFileSync(path.join(sick.updates, "rolled-back"), "utf8") === "0.0.3", "맥: 새 서버가 뜨지 않으면 되돌린다", sick);

  // 되돌리다 mv가 실패하면 이전 파일을 잃지 않게 .old를 남긴다.
  const stuck = scenario("mac-stuck", "exit 1", ({ app, fake }) => {
    fs.writeFileSync(path.join(fake, "mv"), `#!/bin/bash\n[ "$2" = "${app}/server" ] && exit 1\nexec /bin/mv "$@"\n`, { mode: 0o755 });
  });
  check(fs.existsSync(path.join(stuck.app, ".old", "server", "old")) && fs.readFileSync(path.join(stuck.updates, "rolled-back"), "utf8") === "0.0.3", "맥: 되돌리지 못한 폴더는 .old에 남는다", stuck);

  // 지난 .old를 지우지 못하면 아무것도 옮기지 않고 그대로 다시 띄운다.
  const leftover = scenario("mac-leftover", `echo called > "$UPDATES/installer-called"`, ({ app, fake }) => {
    fs.mkdirSync(path.join(app, ".old", "bin"), { recursive: true });
    fs.writeFileSync(path.join(fake, "rm"), `#!/bin/bash\n[ "$2" = "${app}/.old" ] && exit 1\nexec /bin/rm "$@"\n`, { mode: 0o755 });
  });
  check(isOld(leftover.app) && !fs.existsSync(path.join(leftover.updates, "installer-called")) && fs.existsSync(path.join(leftover.updates, "rolled-back")), "맥: 지난 .old가 남아 있으면 설치하지 않고 되돌림으로 끝낸다", leftover);
  check(leftover.calls.includes("bootstrap"), "맥: 그 경우에도 이전 버전을 다시 띄운다", leftover.calls);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`update_install: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
