/**
 * Claude 어댑터의 권한 모드 생성자 분기 — SDK를 일부러 못 찾게 막아 실제 생성자를 돌린다(모델 호출 0, 프로세스 0).
 * 생성자가 시작 모드와 "기본값 재설정" 여부를 어떻게 정하는지, 그리고 가짜 qh를 끼워 그 뒤 동작을 본다.
 * ⚠️ 훅은 앱 코드 import보다 먼저 걸려야 하므로 앱 코드는 전부 동적 import다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-permmodes-claude-"));
process.env.AETHER_CLAUDE_BIN = process.execPath;
const SDK = ["@anthropic-ai", "claude-agent-sdk"].join("/");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === SDK || specifier.startsWith(`${SDK}/`)) {
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
  console.log(`  ${c ? "✅" : "❌"} ${n}${c || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  c ? pass++ : fail++;
};

const { ClaudeRuntime } = await import("../sessions/runtimes/claude");
type PermissionMode = import("../../shared/http").PermissionMode;
type Priv = { permissionMode: PermissionMode; autoDefault: boolean; autoStart: Promise<void>; qh: unknown; model?: string; tryAutoMode(): Promise<void>; setModel(m: string): Promise<void>; setPermissionMode(m: PermissionMode): Promise<void> };

const make = (permissionMode: PermissionMode | undefined, model?: string) =>
  new ClaudeRuntime({
    sessionId: `claude-ctor-${permissionMode ?? "none"}`,
    cwd: os.tmpdir(),
    model,
    permissionMode,
    onPermission: async () => ({ allow: false, message: "시험" }),
    onQuestion: async () => ({ answered: false, reason: "시험" }),
    onResumeKey: () => {},
  }) as unknown as Priv;

console.log("=== 생성자 분기 ===");
for (const [wanted, mode, auto] of [[undefined, "manual", true], ["auto", "manual", false], ["manual", "manual", false], ["edits", "edits", false], ["full", "full", false]] as const) {
  const rt = make(wanted);
  check(rt.permissionMode === mode && rt.autoDefault === auto, `시작값 ${wanted ?? "미지정"} → 처음 모드 ${mode}, 기본값 재설정 ${auto}`, { m: rt.permissionMode, a: rt.autoDefault });
  await rt.autoStart; // SDK가 없어도 던지지 않는다(수동 유지)
  check(rt.permissionMode === mode, `${wanted ?? "미지정"}: 자동 전환이 실패해도 처음 모드를 유지한다`);
}

console.log("=== 가짜 qh로 이어서 ===");
{
  const sets: string[] = [];
  const fake = {
    supportedModels: async () => [
      { value: "default", displayName: "기본", description: "", supportsAutoMode: true },
      { value: "sonnet", displayName: "소넷", description: "", supportsAutoMode: true },
      { value: "haiku", displayName: "하이쿠", description: "" },
    ],
    setPermissionMode: async (m: string) => { sets.push(m); },
    setModel: async () => {},
  };
  const rt = make(undefined);
  await rt.autoStart;
  rt.qh = fake;
  await rt.tryAutoMode();
  check(rt.permissionMode === "auto" && sets.at(-1) === "auto", "새 세션은 지원 모델이면 자동으로 올라간다", sets);
  await rt.setModel("haiku");
  check(rt.permissionMode === "manual" && sets.at(-1) === "default", "첫 턴 전에 모델을 바꾸면 지원 여부를 다시 정한다(자동 → 수동)", { m: rt.permissionMode, sets });
  await rt.setModel("sonnet");
  check(rt.permissionMode === "auto", "다시 지원 모델이면 자동으로 돌아간다", rt.permissionMode);
  await rt.setPermissionMode("edits");
  await rt.setModel("haiku");
  await rt.setModel("sonnet");
  check(rt.permissionMode === "edits", "사용자가 정한 뒤에는 모델을 바꿔도 모드를 건드리지 않는다", rt.permissionMode);

  const restored = make("auto");
  await restored.autoStart;
  restored.qh = fake;
  await restored.setModel("haiku");
  check(restored.permissionMode === "manual", "복원 세션은 모델을 바꿔도 기본값 재설정을 하지 않는다(낮추는 일은 공통 계층 몫)");
  check(restored.autoDefault === false, "복원 세션의 기본값 재설정 표시는 꺼져 있다");
}
await new Promise((r) => setTimeout(r, 30));
check(unhandled === 0, "처리되지 않은 거부가 없다", { unhandled });
console.log(`\n${fail ? "❌" : "✅"} permission_modes_claude: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
