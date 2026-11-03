import { FailureTracker } from "../failureTracking";
import { classifyError } from "../../observability/event";
import { reportError } from "../../observability/report";
/**
 * Codex 세션의 실효 승인 정책 요약 (Phase 8g · 위험 R22 · 2026-08-19 후속 검토로 대폭 수정).
 *
 * ## 왜 필요한가
 *
 * 8e까지 Codex 쪽은 "자동승인 규칙 0개"라고 **무조건** 답했다. 근거는 "우리가 승인 정책과 샌드박스를
 * 매 턴 지정하므로 카드를 건너뛰는 길은 세션 만들 때 켠 우회 하나뿐"이었다. 그 근거는 절반만 맞다.
 * 우리가 못 박는 것은 `approval_policy`와 **승인을 누가 판단하는가**(`approvals_reviewer`) 둘뿐이고,
 * 사용자의 전역 설정에는 그 밖의 축이 더 있다.
 *
 * 화면의 승인 정책 배지가 사실과 다르면 사용자는 "이 세션은 전부 물어본다"고 믿는다. 그건 이 제품에서
 * 가장 위험한 종류의 거짓말이라, **읽어서 정직하게 보고**하는 것까지를 이 모듈이 맡는다(유저 결정
 * 2026-08-18). 동작은 하나도 바꾸지 않는다 — 자동승인을 막지도, 설정을 고치지도 않는다.
 *
 * ## 8g 초판이 틀렸던 것 (2026-08-19 실측으로 확인)
 *
 * 초판은 규칙 기반 자동 허용을 `config/read` 응답의 최상위에서 "이름에 execpolicy·rules가 들어간 키"를
 * 찾아 셌다. **그런 키는 오지 않는다.** 실측한 응답의 최상위 키 96개에 `execpolicy`도 `rules`도 없다.
 * 실제 허용 규칙은 `$CODEX_HOME/rules/*.rules` 파일에 산다(이 맥에서 `decision="allow"` 27건 관측).
 * 즉 그 축은 **언제나 0으로 보고되고 있었다** — 배지가 없애려던 거짓말이 그대로 남아 있었던 것이다.
 *
 * ## 무엇을 세나 (전부 실측한 모양대로)
 *
 * 우리가 매 턴 못 박는 축(승인 정책·승인 판단 주체)은 이미 무력화돼 있으므로 세지 않는다.
 *   ① **MCP 서버별 승인 모드** — `mcp_servers.<이름>.default_tools_approval_mode`가 안 물어보는 값이면
 *      그 서버의 도구는 카드 없이 실행된다. **꺼진 서버(`enabled:false`)는 세지 않는다** — 실행될 수
 *      없는 도구는 우회 경로가 아니다. 우리 지식 도구 창구는 스레드 설정으로만 붙고 사용자 설정 파일에는
 *      없으므로 여기 안 잡힌다(그쪽은 도구별 판정을 창구가 직접 한다).
 *   ② **앱(커넥터)별 승인 모드** — `apps.<id>.default_tools_approval_mode`와 도구별 `approval_mode`.
 *      MCP와 같은 어휘를 쓴다(`AppToolApproval`).
 *   ③ **규칙 기반 자동 허용** — `$CODEX_HOME/rules/*.rules`의 `decision="allow"` 개수.
 *   ④ **이 작업 폴더의 신뢰 설정** — `projects.<경로>.trust_level`.
 *
 * ## 못 보는 축은 0이 아니라 "모름"이다
 *
 * 이 모듈의 규율은 하나다 — **못 본 것을 0으로 답하지 않는다.** 그래서 아래 경우엔 개수와 함께
 * `autoApproveMode:"unknown"`을 실어 화면이 "모른다"고 말하게 한다.
 *   - 설정을 아예 못 읽었다.
 *   - 읽긴 했는데 정상 응답의 모양이 아니다(필수 키 부재 — 빈 객체가 "설정 없음"으로 둔갑하는 것 방지).
 *   - 규칙 파일 폴더를 못 읽었다.
 *   - **훅이 걸려 있다** — `permissionRequest` 훅은 카드를 대신 승인할 수 있는데, 그 판단은 실행해 봐야
 *     알 수 있다. 훅이 있다는 사실만으로 "0"이라고 말할 수 없다.
 *
 * ## 한계(정직하게 적어 둔다)
 *
 * ① 여기서 세는 것은 **설정에 그렇게 적혀 있다**는 사실이지, 그 설정이 실제로 카드를 건너뛰게 만드는지를
 *    실행으로 확인한 것이 아니다. 축별 실측은 8i 보안 점검 몫이다(R22).
 * ② 이 요약은 **물어본 그 순간의 사진**이다. 화면은 세션을 고를 때와 잠든 세션을 깨울 때 다시 묻는다.
 *    그 사이에 사용자가 Codex 설정을 바꾸면 배지가 낡은 값을 보여준다. 매 턴 다시 묻는 것은 지금 안 한다 —
 *    설정을 세션 도중에 바꾸는 일이 드물고, 이 요약은 표시 전용이라 낡아도 실행 경로에 영향이 없다.
 */
import fs from "node:fs";
import path from "node:path";
import type { PermissionMode } from "../../../shared/http";
import type { PermissionPolicy, PermissionPolicyScope } from "../types";
import type { ConfigLayerSource } from "../../codex/protocol/v2/ConfigLayerSource";

const failures = new FailureTracker();

/** `config/read`가 돌려주는 실효 설정에서 우리가 보는 부분만. 나머지 필드는 관심 없다. */
type EffectiveConfig = Record<string, unknown>;
/** `config/read`의 출처 메타 — 어느 설정 층에서 온 값인지 키별로 알려준다. */
export type ConfigOrigins = Record<string, { name?: ConfigLayerSource } | undefined>;

/**
 * 이 값이면 그 서버·앱의 도구가 카드 없이 실행될 수 있다.
 * 어휘는 생성 타입 `AppToolApproval = "auto" | "prompt" | "writes" | "approve"`에서 온다.
 *   - `approve` = 자동 승인(우리 지식 창구가 쓰는 값 — 8a에서 이 값으로 실호출이 성립했다)
 *   - `auto`    = 자동
 *   - `writes`  = 쓰기만 물어봄 → 읽기 계열은 카드 없이 실행된다(부분 우회도 우회다)
 * `prompt`만 매번 물어본다. 초판에 있던 `always`·`never_ask`는 이 어휘에 없는 이름이라 지웠다.
 */
const AUTO_APPROVE_MODES = new Set(["approve", "auto", "writes"]);

/** 신뢰로 잡힌 폴더를 나타내는 값. */
const TRUSTED_LEVELS = new Set(["trusted", "trust"]);

/** 우리가 스레드 설정으로 붙이는 창구 — 사용자 설정이 아니므로 셈에서 뺀다. */
const OUR_BRIDGE_NAME = "aether";

/**
 * 정상 응답이라면 반드시 있는 키. 생성 타입 `Config`는 값이 null일 수는 있어도 키 자체는 필수라,
 * 이 키가 없으면 그건 "설정이 비었다"가 아니라 "우리가 아는 그 응답이 아니다"라는 뜻이다.
 */
const REQUIRED_CONFIG_KEYS = ["model", "approval_policy"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function isAutoMode(value: unknown): boolean {
  return typeof value === "string" && AUTO_APPROVE_MODES.has(value);
}

/** 우리가 아는 모양의 응답인가. 아니면 개수를 세는 것 자체가 의미 없다. */
export function looksLikeConfig(config: EffectiveConfig): boolean {
  return REQUIRED_CONFIG_KEYS.every((k) => k in config);
}

/** ① 카드 없이 도구를 실행하는 MCP 서버 이름들. 꺼진 서버는 뺀다. */
export function autoApproveMcpServers(config: EffectiveConfig): string[] {
  return Object.entries(asRecord(config.mcp_servers))
    .filter(([name, raw]) => {
      if (name === OUR_BRIDGE_NAME) return false;
      const entry = asRecord(raw);
      if (entry.enabled === false) return false; // 실행될 수 없는 도구는 우회 경로가 아니다
      return isAutoMode(entry.default_tools_approval_mode);
    })
    .map(([name]) => name);
}

/**
 * ② 카드 없이 도구를 실행하는 앱(커넥터) 이름들.
 * 앱 하나가 기본 모드로 열려 있으면 그 앱이 한 경로, 기본은 물어보는데 특정 도구만 열려 있으면 그것도 한 경로다.
 * `_default`는 개별 앱이 아니라 기본값 묶음이라 건너뛴다.
 */
export function autoApproveApps(config: EffectiveConfig): string[] {
  const out: string[] = [];
  for (const [id, raw] of Object.entries(asRecord(config.apps))) {
    if (id === "_default") continue;
    const app = asRecord(raw);
    if (app.enabled === false) continue;
    if (isAutoMode(app.default_tools_approval_mode)) {
      out.push(id);
      continue;
    }
    const openTool = Object.entries(asRecord(app.tools)).some(([, t]) => {
      const tool = asRecord(t);
      return tool.enabled !== false && isAutoMode(tool.approval_mode);
    });
    if (openTool) out.push(id);
  }
  return out;
}

/** 신뢰로 잡은 항목의 설정 키(출처 조회에 쓴다). 없으면 null. */
export function trustedProjectKey(config: EffectiveConfig, cwd: string): string | null {
  // 윈도우 드라이브 경로(`C:\x`, `c:/x`)는 구분자를 `/`로, 드라이브 문자를 대문자로 맞춰 비교한다. 그 밖의 경로는 끝 슬래시만 뗀다.
  const norm = (p: string) =>
    /^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^./, (c) => c.toUpperCase()) : p.replace(/\/+$/, "");
  const target = norm(cwd);
  for (const [key, raw] of Object.entries(asRecord(config.projects))) {
    if (norm(key) !== target) continue;
    const level = asRecord(raw).trust_level;
    return typeof level === "string" && TRUSTED_LEVELS.has(level) ? key : null;
  }
  return null;
}

/**
 * 훅이 걸려 있나 — 걸려 있으면 개수를 셀 수 없다.
 *
 * `permissionRequest` 훅은 카드를 대신 승인할 수 있는데(생성 타입 `HookEventName`), 그 결정은 훅을
 * 실제로 실행해야 나온다. 그래서 여기서는 "판단할 수 없는 축이 있다"까지만 말한다.
 */
export function hasHooks(config: EffectiveConfig): boolean {
  const hooks = config.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  return Array.isArray(hooks) ? hooks.length > 0 : Object.keys(hooks).length > 0;
}

/**
 * ③ 규칙 파일의 자동 허용 개수.
 *
 * `config/read`에는 안 온다 — 규칙은 `$CODEX_HOME/rules/*.rules` 파일에 산다(실측). 형식은
 * `prefix_rule(pattern=[...], decision="allow")` 한 줄이 규칙 하나다. 의미까지 해석하지 않고 **허용
 * 결정의 개수만** 센다(배지가 보여주는 것도 개수뿐이다).
 *
 * 폴더가 아예 없으면 규칙이 없는 것이라 0이다. 있는데 못 읽으면 0이라고 답할 근거가 없으므로 null이다.
 */
export function countAllowRules(codexHome: string): number | null {
  const dir = path.join(codexHome, "rules");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".rules"));
    failures.recoveredFile(dir);
  } catch (e) {
    // $CODEX_HOME의 규칙은 사용자가 관리한다. 접근 권한만으로 Aether 결함이라 보지 않는다.
    if ((e as NodeJS.ErrnoException)?.code === "EACCES" || (e as NodeJS.ErrnoException)?.code === "EPERM") classifyError(e as Error, "user_action");
    failures.file(e, { component: "providers", operation: "provider.rules.list", severity: "warning" }, dir);
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? 0 : null;
  }
  let count = 0;
  for (const f of files) {
    try {
      count += (fs.readFileSync(path.join(dir, f), "utf8").match(/decision\s*=\s*"allow"/g) ?? []).length;
      failures.recoveredFile(path.join(dir, f));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EACCES" || (error as NodeJS.ErrnoException)?.code === "EPERM") classifyError(error as Error, "user_action");
      failures.file(error, { component: "providers", operation: "provider.rules.read", severity: "warning" }, path.join(dir, f));
      return null; // 하나라도 못 읽으면 개수가 완전하지 않다
    }
  }
  return count;
}

/** 설정 층 → 화면이 쓰는 범위 이름. 우리 어휘는 셋뿐이라 가장 가까운 쪽으로 접는다. */
function scopeOf(source: ConfigLayerSource | undefined): PermissionPolicyScope {
  if (source?.type === "project") return "project";
  if (source?.type === "sessionFlags") return "local";
  return "user"; // user·system·mdm·enterpriseManaged·legacy* — 전부 이 기기 밖에서 온 전역 설정이다
}

/**
 * 이 세션에서 실제로 적용 중인 승인 정책 요약.
 * `readConfig`는 `config/read`를 부르고 응답 전체(설정 + 출처 메타 + $CODEX_HOME)를 돌려준다.
 */
export async function codexPermissionPolicy(
  cwd: string,
  bypassAll: boolean,
  readConfig: () => Promise<{ config: EffectiveConfig; origins?: ConfigOrigins; codexHome?: string }>,
): Promise<PermissionPolicy> {
  let read: { config: EffectiveConfig; origins?: ConfigOrigins; codexHome?: string };
  try {
    read = await readConfig();
  } catch (e) {
    // 못 읽었으면 "0건"이라고 답하지 않는다 — 그게 바로 이 모듈이 없애려는 거짓말이다.
    void reportError(e, { component: "providers", severity: "warning", operation: "provider.codex.permission_policy_read" }); console.error("[aether] Codex 승인 설정을 읽지 못해 실효 정책을 확인할 수 없다:", e);
    return { bypassAll, autoApproveRules: 0, autoApproveMode: "unknown", sources: [] };
  }
  const config = read.config ?? {};
  if (!looksLikeConfig(config)) {
    // 빈 객체가 "설정 없음"으로 둔갑하면 배지가 다시 0이라고 거짓말한다.
    void reportError(new Error("실효 승인 설정 응답 해석 실패"), { component: "provider", operation: "provider.permission_policy.parse", severity: "warning", provider: "codex" });
    console.error("[aether] Codex 설정 응답이 아는 모양이 아니다 — 실효 정책을 확인할 수 없다");
    return { bypassAll, autoApproveRules: 0, autoApproveMode: "unknown", sources: [] };
  }

  const servers = autoApproveMcpServers(config);
  const apps = autoApproveApps(config);
  const rules = read.codexHome ? countAllowRules(read.codexHome) : null;
  const trustedKey = trustedProjectKey(config, cwd);
  // 셀 수 없는 축이 하나라도 있으면 개수가 완전하지 않다는 사실을 드러낸다.
  const incomplete = rules === null || hasHooks(config);

  const origins = read.origins ?? {};
  const scopes = new Set<PermissionPolicyScope>();
  for (const name of servers) scopes.add(scopeOf(origins[`mcp_servers.${name}.default_tools_approval_mode`]?.name));
  for (const id of apps) scopes.add(scopeOf(origins[`apps.${id}.default_tools_approval_mode`]?.name));
  if (rules) scopes.add("user"); // 규칙 파일은 $CODEX_HOME에 있다 = 이 계정 전역
  if (trustedKey) scopes.add(scopeOf(origins[`projects.${trustedKey}.trust_level`]?.name));

  return {
    bypassAll,
    // 카드 없이 실행될 수 있는 경로의 수 — MCP 서버·앱 하나가 곧 그 서버·앱의 도구 전부다.
    autoApproveRules: servers.length + apps.length + (rules ?? 0),
    // 모른다는 사실이 폴더 신뢰보다 중요한 경고다 — 자리가 하나뿐이라 그쪽을 먼저 싣는다.
    ...(incomplete ? { autoApproveMode: "unknown" } : trustedKey ? { autoApproveMode: "trusted" } : {}),
    sources: [...scopes],
  };
}

/**
 * 권한 모드 → Codex 턴 설정. 한 곳에 모아 두어 실측으로 값을 바꾸기 쉽게 한다.
 * 승인 정책·샌드박스·판단 주체는 턴마다 실려 간다.
 *   manual·edits: 신뢰하지 않는 명령은 사람에게 묻는다(`untrusted`). edits의 편집 자동 수락은 승인 요청 쪽(`editsAutoAccept`)에서 한다.
 *   auto: 필요할 때 요청하고(`on-request`) 판단은 Codex의 자동 검토 하위 에이전트가 한다.
 *   full: 묻지 않고(`never`) 샌드박스도 연다.
 */
export function codexModePolicy(mode: PermissionMode): {
  approvalPolicy: "untrusted" | "on-request" | "never";
  approvalsReviewer: "user" | "auto_review";
  fullAccess: boolean;
} {
  switch (mode) {
    case "auto":
      return { approvalPolicy: "on-request", approvalsReviewer: "auto_review", fullAccess: false };
    case "full":
      return { approvalPolicy: "never", approvalsReviewer: "user", fullAccess: true };
    default:
      return { approvalPolicy: "untrusted", approvalsReviewer: "user", fullAccess: false };
  }
}

/**
 * 파일 변경이 전부 작업 폴더 안인가(편집 자동 수락 판정). 경로가 비었거나 하나라도 밖이면 false.
 * `..`와 심볼릭 링크로 빠져나가는 경로를 막으려고 실제 경로(realpath)로 비교한다.
 * 아직 없는 파일(새로 만들기)은 가장 가까운 기존 상위 폴더의 실제 경로에 나머지를 붙여 판정한다.
 */
const CONTROL_DIRS = new Set([".git", ".codex"]);

export function changesInsideFolder(cwd: string, paths: readonly string[]): boolean {
  if (!paths.length) return false;
  let root: string;
  try {
    root = fs.realpathSync(cwd);
  } catch {
    return false;
  }
  return paths.every((p) => {
    if (!p.trim()) return false;
    const abs = path.resolve(cwd, p);
    let existing = abs;
    const tail: string[] = [];
    // lstat으로 조각마다 확인한다. existsSync는 끊어진 링크에 false라, 링크 뒤의 밖 경로가 "없는 파일"로 오판된다.
    for (;;) {
      try {
        fs.lstatSync(existing);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
      const parent = path.dirname(existing);
      if (parent === existing) return false;
      tail.unshift(path.basename(existing));
      existing = parent;
    }
    let real: string;
    try {
      real = path.join(fs.realpathSync(existing), ...tail); // 링크가 있는데 실제 경로를 못 풀면(끊어진 링크) 안 된 것으로 본다
    } catch {
      return false;
    }
    const rel = path.relative(root, real);
    if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) return false;
    // 저장소·도구 제어 폴더(.git/hooks, .codex 등)는 다음 실행에 영향을 주므로 폴더 안이어도 카드로 묻는다. 대소문자는 구분하지 않는다.
    return ![...p.split(/[\\/]+/), ...rel.split(path.sep)].some((seg) => CONTROL_DIRS.has(seg.toLowerCase()));
  });
}
