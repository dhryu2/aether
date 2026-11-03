/**
 * Phase 5 통합 (haiku 1턴). 실제 canUseTool 경유:
 *   T18 Write 권한요청 SSE에 mutation(kind/before/hunks) 포함
 *   T19 디스크(일기)엔 mutation.before 부재(영속 strip — 평문 시크릿/내용 비영속)
 * 세션 cwd 안의 기존 파일을 Write로 덮어쓰게 유도(cwd 밖이면 mutation 생략되므로).
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8803;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, e = "") => { console.log(`  ${c ? "✅" : "❌"} ${n}${e ? " — " + e : ""}`); c ? pass++ : fail++; };

type Res = { status: number; body: string };
function req(method: string, p: string, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
}
function openSSE(p: string, sink: (e: any) => void) {
  const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "GET" }, (res) => {
    let buf = ""; res.setEncoding("utf8");
    res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); for (const ln of blk.split("\n")) if (ln.startsWith("data: ")) { try { sink(JSON.parse(ln.slice(6))); } catch {} } } });
  });
  r.on("error", () => {}); r.end(); return r;
}
async function waitHealthy(t = 15000) { const s = Date.now(); while (Date.now() - s < t) { try { if ((await req("GET", "/api/health")).status === 200) return true; } catch {} await delay(300); } return false; }

async function main() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-p5-root-")));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-p5-data-"));
  fs.writeFileSync(path.join(root, "target.txt"), "old line 1\nold line 2\n");

  const base = { ...process.env };
  for (const k of ["AETHER_PROJECT_ROOT", "AETHER_AUTH_MODE", "AETHER_DATA_DIR"]) delete (base as any)[k];
  const child: ChildProcess = spawn("npx", ["tsx", "index.ts"], {
    cwd: SERVER_DIR,
    env: { ...base, PORT: String(PORT), AETHER_MODEL: "haiku", ANTHROPIC_API_KEY: "", AETHER_PROJECT_ROOT: root, AETHER_DATA_DIR: dataDir },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitHealthy();
    const created = JSON.parse((await req("POST", "/api/sessions", JSON.stringify({ cwd: root, model: "haiku" }))).body);
    const id: string = created.id;
    const events: any[] = [];
    openSSE(`/api/sessions/${id}/stream?since=0`, (e) => events.push(e));
    await delay(300);
    await req("POST", `/api/sessions/${id}/message`, JSON.stringify({ text: `Use the Write tool to overwrite the file ${path.join(root, "target.txt")} with exactly:\nNEW LINE 1\nNEW LINE 2` }));

    // permission_request(mutation 포함) 대기
    const start = Date.now();
    while (!events.some((e) => e.kind === "permission_request" && e.req?.mutation) && Date.now() - start < 60000) await delay(200);
    const permEv = events.find((e) => e.kind === "permission_request" && e.req?.mutation);
    const m = permEv?.req?.mutation;
    check(!!m && m.kind === "write", "T18 Write 권한요청 SSE에 mutation(kind=write)", m ? `kind=${m.kind}` : "mutation 없음");
    check(m?.before === "old line 1\nold line 2\n", "T18 mutation.before=기존 파일 내용");
    check(Array.isArray(m?.hunks) && m.hunks.length > 0 && /NEW LINE/.test(JSON.stringify(m?.hunks)), "T18 mutation.hunks(diff) 존재");

    // 승인 → 적용
    if (permEv) await req("POST", `/api/sessions/${id}/permission`, JSON.stringify({ permissionId: permEv.req.id, decision: "allow" }));
    while (!events.some((e) => e.kind === "sdk" && e.msg?.type === "result") && Date.now() - start < 90000) await delay(200);
    await delay(300);

    // T19 디스크 영속 strip
    const lines = (await import("./support/diaryRows")).sessionEventLines(path.join(dataDir, "aether.sqlite"), id);
    const diskPerm = lines.map((l) => JSON.parse(l)).find((e) => e.kind === "permission_request" && e.req?.mutation);
    check(!!diskPerm, "T19 디스크에 permission_request 영속됨");
    check(diskPerm && diskPerm.req.mutation.before === undefined && diskPerm.req.mutation.hunks === undefined, "T19 디스크 mutation.before/hunks 부재(strip)", diskPerm ? `keys=${Object.keys(diskPerm.req.mutation)}` : "");
    check(diskPerm && diskPerm.req.mutation.kind === "write", "T19 디스크 mutation 메타(kind)는 잔존");
    // 제 strip 보장 = permission_request '그 줄'에 before 내용 미포함(SDK 자체 tool_result diff는 별개 대화기록이라 무관)
    const permLine = lines.find((l) => { const e = JSON.parse(l); return e.kind === "permission_request" && e.req?.mutation; });
    check(!!permLine && !permLine.includes("old line 1"), "T19 permission_request 영속줄에 mutation before 내용 미포함(strip)");
  } finally {
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch {}
    await delay(600);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log("─".repeat(50));
  console.log(`Phase 5 e2e: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("오류:", e); process.exit(1); });
