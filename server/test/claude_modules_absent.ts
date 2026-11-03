/**
 * Claude SDK와 node-pty 모듈이 없는 PC에서의 동작 (모델 호출 0).
 *
 * 두 모듈은 쓰는 순간에만 불러온다(`providers/claude/sdk.ts`, `auth/claudeLogin.ts`의 `loadPty`).
 * 이 시험은 resolve 훅으로 두 모듈을 일부러 못 찾게 만들고 다음을 본다.
 *   - 부팅 경로(등록표·라우트·세션 관리자)를 불러와도 두 모듈을 건드리지 않는다.
 *   - Claude는 가용성이 sdk_unavailable로 나오고, 서버는 죽지 않는다(처리되지 않은 거부 0건).
 *
 * ⚠️ 훅은 이 파일의 어떤 import보다 먼저 걸려야 하므로, 앱 코드는 전부 `await import()`로 불러온다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

// 데이터 폴더와 Claude 실행 파일: 실제 데이터를 건드리지 않고, "프로그램은 있다"는 확인은 통과시켜 SDK 확인까지 가게 한다.
process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-modules-absent-"));
process.env.AETHER_CLAUDE_BIN = process.execPath;

const SDK = ["@anthropic-ai", "claude-agent-sdk"].join("/");
const PTY = "node-pty";

let blocked = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === SDK || specifier.startsWith(`${SDK}/`) || specifier === PTY || specifier.startsWith(`${PTY}/`)) {
      blocked++;
      const error = new Error(`Cannot find package '${specifier}' (시험에서 일부러 막음)`) as NodeJS.ErrnoException;
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    }
    return nextResolve(specifier, context);
  },
});

let unhandled = 0;
process.on("unhandledRejection", () => { unhandled++; });

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, detail?: unknown) => {
  console.log(`  ${c ? "✅" : "❌"} ${n}`);
  if (!c && detail !== undefined) console.log("     detail:", detail instanceof Error ? detail.message : JSON.stringify(detail));
  c ? pass++ : fail++;
};
async function rejection(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

// ── 1. 차단이 실제로 걸렸는가 ──
const r1 = await rejection(() => import(SDK));
const r2 = await rejection(() => import(PTY));
check(!!r1 && !!r2 && blocked === 2, "1 SDK와 node-pty 불러오기가 모두 막힌다(차단이 실제로 걸림)", { r1, r2, blocked });

// ── 2. 부팅 경로를 불러와도 두 모듈을 건드리지 않는다 ──
const before = blocked;
const { providerEntry, listProviders, providerAvailability } = await import("../providers/registry");
await import("../routes/sessions");
await import("../routes/providers");
await import("../routes/providerAuth");
await import("../sessions/SessionManager");
check(blocked === before, "2 등록표·라우트·세션 관리자를 불러와도 SDK·node-pty를 건드리지 않는다", { before, after: blocked });
check(listProviders().length > 0, "2b 등록표가 정상으로 불러와진다");

// ── 3. claude 가용성 ──
const claude = providerEntry("claude");
const availability = await providerAvailability(claude);
check(!availability.available && (availability as { reason?: string }).reason === "sdk_unavailable", "3 claude 가용성은 sdk_unavailable", availability);

// ── 4. 로그인 시작은 안내 문구로 거부된다 ──
const { st } = await import("../i18n");
const ptyMsg = st("routes.claudeAuth.ptyUnavailable");
const authErr = await rejection(() => claude.services.auth!.start());
check(authErr === ptyMsg, "4 auth.start()가 ptyUnavailable 문구로 거부된다", authErr);

// ── 5. 런타임: handshake·events는 sdkUnavailable로 실패하고 dispose는 정상 종료 ──
const sdkMsg = st("notice.claude.sdkUnavailable");
const runtime = claude.createRuntime({
  sessionId: "modules-absent",
  cwd: os.tmpdir(),
  permissionMode: "manual",
  onPermission: async () => { throw new Error("권한 요청이 오면 안 된다"); },
  onQuestion: async () => { throw new Error("질문이 오면 안 된다"); },
  onResumeKey: () => {},
});
const hsErr = await rejection(() => runtime.handshake());
const evErr = await rejection(async () => { for await (const _ of runtime.events()) { /* 이벤트가 오면 안 된다 */ } });
const disposeErr = await rejection(() => runtime.dispose());
check(hsErr === sdkMsg, "5a handshake()가 sdkUnavailable 문구로 실패한다", hsErr);
check(evErr === sdkMsg, "5b events()가 sdkUnavailable 문구로 실패한다", evErr);
check(disposeErr === null, "5c dispose()는 정상 종료한다", disposeErr);

// ── 6. 배경 작업(distill)·승인 정책도 거부된다 ──
const distillErr = await rejection(() => claude.services.distill("x", os.tmpdir()));
const { claudePermissionPolicy } = await import("../providers/claude/permissionPolicy");
const policyErr = await rejection(() => claudePermissionPolicy(os.tmpdir(), false));
check(distillErr === sdkMsg, "6a distill()이 sdkUnavailable 문구로 거부된다", distillErr);
check(policyErr === sdkMsg, "6b claudePermissionPolicy()가 sdkUnavailable 문구로 거부된다", policyErr);

// ── 7. 처리되지 않은 거부가 없다(있으면 index.ts가 서버를 내린다) ──
await new Promise((r) => setTimeout(r, 50));
check(unhandled === 0, "7 처리되지 않은 promise 거부가 0건이다", { unhandled });

console.log(`\n${fail ? "❌" : "✅"} claude_modules_absent: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
