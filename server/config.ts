/**
 * Aether 백엔드 설정. 시크릿은 절대 여기 두지 않는다(.env/env로만).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // .../aether/server

// ── 설정 파일(선택) ──
//   AETHER_CONFIG가 가리키는 JSON을 부팅 때 한 번만 읽는다. 우선순위: 환경변수 > 설정 파일 > 기본값.
//   키는 아래 config 필드 이름 그대로(한 층). 비밀은 .env에만 두므로 비밀 이름이 보이면 부팅을 거부한다.
//   이 파일은 오류 기록 모듈 등을 import하지 않는다(순환 방지) — 로그는 console로만 남긴다.
function loadConfigFile(): Record<string, unknown> {
  const file = process.env.AETHER_CONFIG?.trim();
  if (!file) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    // JSON.parse 오류 문구에는 파일 원문 일부(비밀 포함 가능)가 들어가므로 버리고 위치만 남긴다.
    const detail = e instanceof SyntaxError ? `JSON 문법 오류${/position (\d+)/.exec(e.message) ? ` (위치 ${/position (\d+)/.exec(e.message)![1]})` : ""}` : (e as Error).message;
    throw new Error(`AETHER_CONFIG 설정 파일을 읽을 수 없습니다(${file}): ${detail}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`AETHER_CONFIG 설정 파일의 최상위는 객체여야 합니다: ${file}`);
  }
  for (const key of Object.keys(parsed)) {
    if (/jwt|password|vapid|secret|token|private|api_?key/i.test(key)) {
      throw new Error(`설정 파일에는 비밀 값을 둘 수 없습니다(.env에만): ${key}`);
    }
  }
  console.log(`[aether config] 설정 파일 적용: ${file}`);
  return parsed as Record<string, unknown>;
}

const fileConfig = loadConfigFile();
const usedKeys = new Set<string>();
usedKeys.add("termsAccepted"); // 첫 설정이 남기는 동의 기록. 서버가 읽지 않는다.
const warnedOverrides = new Set<string>();

function fromFile<T extends "string" | "number" | "boolean">(key: string, type: T): (T extends "string" ? string : T extends "number" ? number : boolean) | undefined {
  usedKeys.add(key);
  const v = fileConfig[key];
  if (v === undefined) return undefined;
  if (typeof v !== type) throw new Error(`설정 파일 ${key} 값의 형식이 올바르지 않습니다 (${type} 필요)`);
  return v as never;
}

/** 환경변수가 설정 파일 값을 덮어쓸 때 이름만 경고한다(값은 찍지 않는다). */
function noteOverride(envName: string, present: boolean) {
  if (present && !warnedOverrides.has(envName)) {
    warnedOverrides.add(envName);
    console.warn(`[aether config] 환경변수 ${envName}가 설정 파일 값을 덮어씁니다`);
  }
}

/** 경로 필드: 설정 파일 값의 선행 `~/`만 홈으로 푼다(환경변수 경로의 기존 동작은 그대로). */
function filePath(key: string): string | undefined {
  const v = fromFile(key, "string");
  return v === undefined ? undefined : expandHome(v);
}

function envStr(name: string, key: string, isPath = false): string | undefined {
  const f = isPath ? filePath(key) : fromFile(key, "string");
  const e = process.env[name];
  noteOverride(name, e !== undefined && f !== undefined);
  return e ?? f;
}

/** 스위치. 기본이 켜진 것은 환경변수 "0"일 때만, 기본이 꺼진 것은 "1"일 때만 바뀐다. 파일에서는 true/false. */
function flag(name: string, key: string, def: boolean): boolean {
  const f = fromFile(key, "boolean");
  const e = process.env[name];
  if (e === undefined) return f ?? def;
  noteOverride(name, f !== undefined);
  return def ? e !== "0" : e === "1";
}

function envList(name: string, key: string): string[] {
  usedKeys.add(key);
  const f = fileConfig[key];
  if (f !== undefined && !(Array.isArray(f) && f.every((x) => typeof x === "string"))) {
    throw new Error(`설정 파일 ${key} 값의 형식이 올바르지 않습니다 (문자열 배열 필요)`);
  }
  const e = process.env[name];
  noteOverride(name, e !== undefined && f !== undefined);
  const list = e !== undefined ? e.split(",") : ((f as string[] | undefined) ?? []);
  return list.map((s) => s.trim()).filter(Boolean);
}

function envNumber(name: string, key: string, fallback: number, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
  const raw = process.env[name];
  const f = fromFile(key, "number");
  const useEnv = raw != null && raw.trim() !== "";
  noteOverride(name, useEnv && f !== undefined);
  const value = useEnv ? Number(raw) : (f ?? fallback);
  if (!Number.isFinite(value) || (opts.integer !== false && !Number.isInteger(value)) || (opts.min !== undefined && value < opts.min) || (opts.max !== undefined && value > opts.max)) {
    const range = [opts.min, opts.max].filter((v) => v !== undefined).join("..");
    throw new Error(`${useEnv || f === undefined ? name : `설정 파일 ${key}`} 값이 올바르지 않습니다${range ? ` (허용 범위 ${range})` : ""}: "${useEnv ? raw : value}"`);
  }
  return value;
}

// authMode는 화이트리스트 검증 후 사용 — 오타/대소문자 불일치(예: "Password")가 조용히 off로
// fail-open되는 것을 차단(보안: 알 수 없는 값은 부팅 거부 = fail-closed).
const AUTH_MODE = envStr("AETHER_AUTH_MODE", "authMode") ?? "off";
if (!["off", "tailscale", "password"].includes(AUTH_MODE)) {
  throw new Error(`AETHER_AUTH_MODE는 off|tailscale|password만 허용됩니다 (받음: "${AUTH_MODE}")`);
}

// 기본 폴더. 새 세션의 cwd를 비웠을 때 쓰는 폴더이며 작업 폴더 범위를 제한하지 않는다. 기본=실행 유저의 홈 디렉터리.
//   다른 폴더를 기본으로 쓰려면 AETHER_PROJECT_ROOT로 명시한다. `:`로 여러 개를 적으면 첫 항목만 쓴다.
//   선행 `~`는 셸이 아닌 우리가 푼다(.env 값은 셸을 거치지 않아 `~`가 문자 그대로 들어온다).
function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(1)) : p;
}
const PROJECT_ROOT = path.resolve(
  expandHome(
    (envStr("AETHER_PROJECT_ROOT", "projectRoot") ?? "")
      .split(path.delimiter)
      .map((p) => p.trim())
      .find(Boolean) ?? os.homedir(),
  ),
);

// 시험·실험 파일을 직접 실행하면 데이터 폴더 지정이 빠져 운영 server/data에 쓰게 된다. 그래서 새 임시 폴더를 쓰게 하고,
//   환경변수에 적어 그 파일이 띄우는 서버도 같은 폴더를 물려받게 한다. scripts/는 운영 도구라 넣지 않는다.
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const sandboxed = ["test", "spikes", "../.private/spikes"].some((d) => entry.startsWith(path.join(here, d) + path.sep));
if (sandboxed && !process.env.AETHER_DATA_DIR?.trim()) {
  process.env.AETHER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-test-"));
}

// 데이터 폴더·DB 경로는 부팅 때 한 번 정하는 고정값이다(원래 동작). errorDir만 환경변수 원문을 다시 본다.
const DATA_DIR_RAW = envStr("AETHER_DATA_DIR", "dataDir", true);
const DATA_DIR = DATA_DIR_RAW ? path.resolve(DATA_DIR_RAW) : path.join(here, "data");
const DB_PATH_RAW = envStr("AETHER_DB_PATH", "dbPath", true);

// 아래 폴더들은 시험이 import 뒤에 환경변수를 바꾸므로 환경변수는 읽을 때마다 보고, 파일 값만 부팅 때 잡아 둔다.
const FILE_ERROR_DIR = filePath("errorDir");
const FILE_BACKUP_DIR = filePath("backupDir");
const FILE_WORKTREE_DIR = filePath("worktreeDir");
const FILE_WEB_DIST = filePath("webDist");
const FILE_SKILLS_DIR = filePath("skillsDir");
const FILE_WEB_AUTOBUILD = fromFile("webAutoBuild", "boolean");

function realRoot(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    throw new Error(`projectRoot를 해소할 수 없습니다(존재/권한 확인): ${root}`);
  }
}

// 원격 재인증 스위치: 환경변수(새 이름·옛 이름)가 하나라도 있으면 그쪽이 이기고, 없으면 설정 파일 값.
const FILE_RELOGIN = fromFile("enableProviderRelogin", "boolean");
const RELOGIN_ENV_SET = process.env.AETHER_ENABLE_PROVIDER_RELOGIN !== undefined || process.env.AETHER_ENABLE_CLAUDE_RELOGIN !== undefined;
noteOverride("AETHER_ENABLE_PROVIDER_RELOGIN", process.env.AETHER_ENABLE_PROVIDER_RELOGIN !== undefined && FILE_RELOGIN !== undefined);
noteOverride("AETHER_ENABLE_CLAUDE_RELOGIN", process.env.AETHER_ENABLE_CLAUDE_RELOGIN !== undefined && FILE_RELOGIN !== undefined);
const RELOGIN_ENABLED = RELOGIN_ENV_SET
  ? process.env.AETHER_ENABLE_PROVIDER_RELOGIN !== "0" && process.env.AETHER_ENABLE_CLAUDE_RELOGIN !== "0"
  : (FILE_RELOGIN ?? true);

export const config = {
  port: envNumber("PORT", "port", 8787, { min: 1, max: 65535 }),

  /**
   * 바인드 호스트. 기본 127.0.0.1(루프백) — 인증(Phase 3) 전이라 LAN 노출 차단.
   * 원격 접속은 `tailscale serve`(루프백 프록시) 또는 AETHER_HOST=<tailscale IP> 명시.
   */
  host: envStr("AETHER_HOST", "host") ?? "127.0.0.1",

  /** 기본 폴더 — 새 세션 cwd가 비었을 때 쓴다(작업 폴더 범위 제한은 없다). 기본값은 실행 유저의 홈 디렉터리. */
  projectRoot: PROJECT_ROOT,

  /**
   * projectRoot의 realpath(부팅 1회 해소). macOS /private 심볼릭 대응.
   * 해소 실패(폴더 부재/권한) 시 부팅 거부(fail-fast).
   */
  projectRootReal: realRoot(PROJECT_ROOT),

  /** 새 버전 확인 주소(배포 사이트 루트). 비우면 확인 기능 전체가 꺼진다. http 또는 https만 쓴다. */
  updateUrl: (envStr("AETHER_UPDATE_URL", "updateUrl") ?? "").trim(),

  /** 맥에서 외장 디스크가 마운트되는 폴더. 폴더 고르기의 "장치" 목록 전용이며 시험에서 임시 폴더로 바꾼다. */
  volumesDir: envStr("AETHER_VOLUMES_DIR", "volumesDir", true) ?? "/Volumes",

  /** 이벤트/메타/seq 디스크 영속 위치 (gitignore됨) */
  dataDir: DATA_DIR,

  /** SQLite 파일 하나. 세션 일기, 글자 색인, 검색 감사, 공통 오류가 여기 있다. */
  dbPath: DB_PATH_RAW ? path.resolve(DB_PATH_RAW) : path.join(DATA_DIR, "aether.sqlite"),

  /** Claude 세션 전용 기본 모델. 미설정 = 모델 미지정(query에 model 안 넘김 → plain `claude` → 계정 기본 모델). /model로 세션별 변경. */
  claudeDefaultModel: envStr("AETHER_MODEL", "claudeDefaultModel"),

  /**
   * 새 세션이 "대화를 받을 준비가 됐다"고 답할 때까지 기다리는 상한(ms).
   * 모델 이름을 지정한 생성 요청만 이걸 기다린다 — 그 이름이 실제로 있는 이름인지 물어봐야 하기 때문이다.
   * 실측 응답은 약 0.9초라 기본 10초는 넉넉한 여유다. 넘기면 세션을 지우고 실패로 답한다.
   */
  sessionReadyTimeoutMs: envNumber("AETHER_SESSION_READY_TIMEOUT_MS", "sessionReadyTimeoutMs", 10_000, { min: 1000 }),

  /**
   * 쉬는 세션을 잠재우기까지의 기본 대기 시간(ms). 0이면 끈다.
   * 사용자가 설정 화면에서 고른 값(`idle-sleep.json`)이 있으면 그쪽이 우선하고, 이 값은 저장값이 없을 때만 쓴다.
   */
  idleSleepMs: envNumber("AETHER_IDLE_SLEEP_MS", "idleSleepMs", 30 * 60_000, { min: 0 }),

  /** in-memory 이벤트 버퍼 상한(초과분은 디스크에서 replay) */
  bufferCap: envNumber("AETHER_BUFFER_CAP", "bufferCap", 2000, { min: 1 }),

  /** in-memory 이벤트 버퍼의 바이트 상한(사건 JSON 길이 합). 개수 상한과 먼저 닿는 쪽이 적용된다 */
  bufferMaxBytes: envNumber("AETHER_BUFFER_MAX_BYTES", "bufferMaxBytes", 16 * 1024 * 1024, { min: 1 }),

  /**
   * 영속(events.jsonl) 시 sdk 메시지 내 거대 문자열(tool_result.content·tool_use.input) 1건당 상한(문자 길이≈바이트).
   * 초과분은 절단 마커로 대체 — 라이브/SSE는 full, 디스크 영속본만 축소(파일 무한성장·per-line 폭탄 차단).
   * assistant 답변 text·thinking은 클램프 대상 아님(스크롤백 보존).
   */
  persistMaxFieldChars: envNumber("AETHER_PERSIST_MAX_FIELD_CHARS", "persistMaxFieldChars", 16 * 1024, { min: 256 }),

  /** SSE heartbeat 주기(ms) */
  heartbeatMs: 15000,

  // ── Phase 2 하드닝 (모두 env-driven, 시크릿 아님) ──

  /** 보안 헤더(helmet). 기본 ON. */
  helmet: flag("AETHER_HELMET", "helmet", true),

  /** 응답 압축. 기본 OFF(SSE 충돌 위험 — 켜도 SSE는 filter로 자동 제외). */
  compression: flag("AETHER_COMPRESSION", "compression", true),

  /** JSON body 크기 제한. Aether 바디는 작음 → 256kb 기본(DoS 표면 축소). */
  bodyLimit: envStr("AETHER_BODY_LIMIT", "bodyLimit") ?? "256kb",

  /** 이미지 첨부(vision) 메시지 라우트 전용 body 한도 — base64 이미지 수용(전역은 256kb 유지).
   *  정합: 최대 5장 × 개당 base64 7MB = ~35MB < 40MB. 개당·개수 검증을 통과한 페이로드가 body단에서 413되지 않게 여유. */
  imageBodyLimit: envStr("AETHER_IMAGE_BODY_LIMIT", "imageBodyLimit") ?? "40mb",

  /** 빌드된 프론트 단일포트 서빙 플래그. 기본 ON. 경로·CSP는 static 설치 함수가 가진다. */
  serveStatic: flag("AETHER_SERVE_STATIC", "serveStatic", true),

  /** 토큰 단위 스트리밍(SDK partial 메시지). 기본 OFF. 켜면 events.jsonl 영속에서 partial 제외(LiveSession). */
  includePartialMessages: flag("AETHER_PARTIAL", "includePartialMessages", false),

  /**
   * 과거이력 검색(SQLite FTS5) 기능 on/off. 기본 ON.
   * 켜면: 라이브 인덱싱(ingest) + 부팅 백필 + GET /api/search + 에이전트 session_search 툴 주입.
   * 끄면 인덱싱·검색·툴 모두 비활성(킬스위치).
   */
  search: flag("AETHER_SEARCH", "search", true),

  /**
   * 검색결과 LLM 요약. 기본 ON(search도 켜져 있어야 실효). 끄려면 AETHER_SEARCH_SUMMARIZE=0.
   * session_search DISCOVERY 결과 원문을 배경 작업용 경량 모델로 요약해 주입 → 토큰 평평·노이즈 제거.
   * SCROLL 앵커(session_id/around_id)는 푸터로 보존(요약 후에도 원문 파고들기 가능). 요약 실패 시 원문 폴백.
   */
  searchSummarize: flag("AETHER_SEARCH_SUMMARIZE", "searchSummarize", true),

  /**
   * 배경 모델 고정 — distill(배경 작업)에 쓸 모델을 **운영자가 못 박을 때만** 쓰는 값. 기본값은 없다.
   * 이름의 reflect는 옛 기억 추출에서 왔고, 지금은 Claude 배경 모델 고정에만 쓴다.
   *
   * 비워 두면 `server/providers/distillModel.ts`가 알아서 정한다 — 계정에서 실제로 쓸 수 있는 모델
   * 목록을 받아 가장 싼 것을 골라 파일에 저장하고, 그 이름이 더는 안 통하면 다시 고른다. 예전에는
   * 여기 `"haiku"`가 기본값으로 적혀 있었는데, 그 이름이 사라지면 배경 작업(검색 요약)이 조용히 죽는 구조였다.
   */
  reflectModel: envStr("AETHER_REFLECT_MODEL", "reflectModel"),
  /** distill 보조 query 상한(ms). 초과 시 interrupt — 행이 세션의 자동 캡처(distilling 플래그)를 영구 잠그는 것 방지. 기본 2분. */
  distillTimeoutMs: envNumber("AETHER_DISTILL_TIMEOUT_MS", "distillTimeoutMs", 120_000, { min: 1000 }),

  // ── Phase 3 인증 (모두 비-시크릿. 시크릿 AETHER_JWT_SECRET·AETHER_PASSWORD_HASH는 .env에만, auth 모듈이 process.env로 직접 읽음) ──

  /** 인증 모드. 기본 off(프론트 dev 무마찰). tailscale|password. (위에서 화이트리스트 검증됨) 루프백 밖에 묶으려면 인증 필수 — off면 부팅 거부(index.ts). */
  authMode: AUTH_MODE as "off" | "tailscale" | "password",

  /** tailscale 모드 허용 login 화이트리스트(콤마구분). 비면 "검증된 신원 누구나"(단일망 전제). */
  allowedLogins: envList("AETHER_ALLOWED_LOGINS", "allowedLogins"),

  /** tailscale CLI 경로. 비우면 PATH와 알려진 설치 위치에서 찾는다(auth/tailscale.ts). */
  tailscaleCli: envStr("AETHER_TAILSCALE_CLI", "tailscaleCli", true) ?? "",

  // ── 원격 재인증(중계) ──

  /**
   * 원격 재인증 기능 on/off. 기본 ON. 끄면 `/api/provider-auth/:provider/start`가 403.
   * 이 스위치는 **모든 provider**에 걸린다 — 라우트가 provider 공통이라 Claude만 끄는 의미가 될 수 없다.
   * 구 이름(`AETHER_ENABLE_CLAUDE_RELOGIN`)도 계속 읽는다: 기존 `.env`를 고치지 않아도 끈 상태가 유지돼야 한다.
   */
  enableProviderRelogin: RELOGIN_ENABLED,
  /** 위를 끈 env 이름(안내 문구용). 둘 다 켜져 있으면 undefined. */
  reloginDisabledBy:
    process.env.AETHER_ENABLE_PROVIDER_RELOGIN === "0" ? "AETHER_ENABLE_PROVIDER_RELOGIN"
    : process.env.AETHER_ENABLE_CLAUDE_RELOGIN === "0" ? "AETHER_ENABLE_CLAUDE_RELOGIN"
    : !RELOGIN_ENV_SET && FILE_RELOGIN === false ? "enableProviderRelogin" // 설정 파일 키 이름
    : undefined,

  /** claude CLI 절대경로 override(미설정 시 which→~/.local/bin/claude→PATH로 자동 해석). node-pty spawn은 절대경로 필요. */
  claudeBin: envStr("AETHER_CLAUDE_BIN", "claudeBin", true),

  // ── Phase 8e: Codex(app-server) ──

  /**
   * codex CLI 절대경로 override(미설정 시 which→PATH로 자동 해석).
   * 테스트는 이 값으로 가짜 app-server를 가리켜 실모델 없이 프로토콜 전체를 돌린다.
   */
  codexBin: envStr("AETHER_CODEX_BIN", "codexBin", true),

  /**
   * Codex 세션의 기본 모델(미지정 = 계정 기본).
   * Claude용 `defaultModel`과 따로 두는 이유: 모델 이름은 provider마다 어휘가 다르다. 하나로 쓰면
   * `AETHER_MODEL=sonnet`을 설정해 둔 서버에서 Codex 세션이 없는 이름으로 시작해 곧바로 거부당한다.
   */
  codexDefaultModel: envStr("AETHER_CODEX_MODEL", "codexDefaultModel"),

  /**
   * codex app-server 요청 1건의 응답 대기 상한(ms).
   * 이 상한이 없으면 상대가 답을 안 줄 때 promise가 영원히 매달리고, 그 응답을 기다리는 HTTP 요청도 같이 매달린다.
   * `turn/start`는 즉시 진행중 응답만 오고 최종 결과는 알림으로 오므로(8a 실측) 이 값이 턴 길이 제한은 아니다.
   */
  codexRequestTimeoutMs: envNumber("AETHER_CODEX_REQUEST_TIMEOUT_MS", "codexRequestTimeoutMs", 120_000, { min: 1000 }),

  /**
   * app-server 표준출력 한 줄의 크기 상한(바이트). 넘으면 그 줄을 버린다.
   * 줄 하나가 통째로 메모리에 쌓이는 구조라 상한이 없으면 거대 명령 출력 한 건이 서버를 먹는다.
   * 실제 이벤트를 잃지 않도록 넉넉히 잡는다 — 버릴 때는 반드시 로그로 알린다.
   */
  codexMaxLineBytes: envNumber("AETHER_CODEX_MAX_LINE_BYTES", "codexMaxLineBytes", 8 * 1024 * 1024, { min: 64 * 1024 }),

  /** 정상 종료를 기다리는 시간(ms). 이 시간이 지나면 강제 종료한다. */
  codexShutdownGraceMs: envNumber("AETHER_CODEX_SHUTDOWN_GRACE_MS", "codexShutdownGraceMs", 3000, { min: 100 }),

  /**
   * 지식 도구 창구가 답을 돌려줄 때까지 Codex가 기다리는 상한(초) — Phase 8g.
   *
   * Codex 기본값은 60초다(8a). 그 값이면 **사용자가 카드에 답하는 데 걸리는 시간**을 못 버틴다 —
   * 쓰기 승인을 켠 환경의 승인 카드와 되물음 카드가 이 통로를 탄다. 폰에서 답하는 제품이라 넉넉히 둔다.
   * 너무 길게 잡아도 손해는 없다: 사용자가 답을 안 하면 그 턴은 중단 버튼으로 끝낼 수 있다.
   */
  codexMcpToolTimeoutSec: envNumber("AETHER_CODEX_MCP_TOOL_TIMEOUT_SEC", "codexMcpToolTimeoutSec", 1800, { min: 60 }),

  // ── Phase 8f: Codex 인증 ──

  /**
   * 인증 조회 전용 프로세스가 아무 요청 없이 살아 있는 시간(ms). 지나면 스스로 내려간다.
   *
   * 이 프로세스는 대화 스레드를 하나도 만들지 않고 계정 조회와 로그인만 맡는다(D9). 설정 화면을 한 번
   * 열었다고 프로세스가 계속 떠 있을 이유가 없으므로 짧게 잡는다. 다만 **로그인이 진행 중이면 이 시간이
   * 지나도 내려가지 않는다** — 프로세스를 내리면 진행 중인 로그인이 통째로 끊어지기 때문이다.
   */
  codexControlIdleMs: envNumber("AETHER_CODEX_CONTROL_IDLE_MS", "codexControlIdleMs", 60_000, { min: 1000 }),

  /**
   * Codex 배경 작업(기억 자동 저장·압축·검색 요약·스킬 생성)에 쓸 모델 이름을 못 박는다.
   *
   * 비워 두면 자동으로 고른다(계정 기본 모델에게 목록을 주고 제일 싼 것을 한 번 물어본 뒤 저장 —
   * `providers/distillModel.ts`). Claude용 `AETHER_REFLECT_MODEL`과 따로 두는 이유는 세션 기본 모델을
   * 따로 둔 것과 같다: 모델 이름 어휘가 provider마다 달라, 하나로 쓰면 한쪽이 없는 이름으로 시작한다.
   */
  codexDistillModel: envStr("AETHER_CODEX_DISTILL_MODEL", "codexDistillModel"),

  // ── Phase 10c: Grok Build(ACP stdio) ──

  /**
   * grok CLI 절대경로 override(미설정 시 which→PATH로 자동 해석).
   * 테스트는 이 값으로 가짜 stdio 프로세스를 가리켜 실모델 없이 프로토콜을 돈다.
   */
  grokBin: envStr("AETHER_GROK_BIN", "grokBin", true),

  /**
   * Grok 세션의 기본 모델. 비우면 adapter가 `grok-4.6`을 쓰고, 그 이름도 없으면 계정 기본에 맡긴다.
   * Claude/Codex 모델 설정을 공유하지 않는다(어휘가 다르다).
   */
  grokDefaultModel: envStr("AETHER_GROK_MODEL", "grokDefaultModel"),

  /** grok ACP 요청 1건의 응답 대기 상한(ms). `session/prompt`처럼 턴 전체는 0(무제한)으로 보낸다. */
  grokRequestTimeoutMs: envNumber("AETHER_GROK_REQUEST_TIMEOUT_MS", "grokRequestTimeoutMs", 120_000, { min: 1000 }),

  /** grok 표준출력 한 줄의 크기 상한(바이트). 넘으면 그 줄을 버린다. */
  grokMaxLineBytes: envNumber("AETHER_GROK_MAX_LINE_BYTES", "grokMaxLineBytes", 8 * 1024 * 1024, { min: 64 * 1024 }),

  /** 정상 종료를 기다리는 시간(ms). 이 시간이 지나면 강제 종료한다. */
  grokShutdownGraceMs: envNumber("AETHER_GROK_SHUTDOWN_GRACE_MS", "grokShutdownGraceMs", 3000, { min: 100 }),

  /**
   * Grok 배경 작업(기억 자동 저장·압축·검색 요약·스킬 생성)에 쓸 모델 이름을 못 박는다.
   *
   * 비워 두면 adapter가 `grok-4.5`를 쓴다. Claude/Codex 핀과 어휘가 달라서 설정도 따로 둔다.
   * 공통 distill은 등록표 `distillModel`만 본다.
   */
  grokDistillModel: envStr("AETHER_GROK_DISTILL_MODEL", "grokDistillModel"),

  /**
   * Grok 로그인 제어 프로세스가 아무 요청 없이 살아 있는 시간(ms). 지나면 스스로 내린다.
   *
   * 로그인이 진행 중이면 이 시간이 지나도 내리지 않는다 — 내리면 기기코드 대기 중이던 로그인이 끊긴다.
   */
  grokControlIdleMs: envNumber("AETHER_GROK_CONTROL_IDLE_MS", "grokControlIdleMs", 60_000, { min: 1000 }),

  // ── Ollama(로컬 모델) ──
  //   Ollama는 모델 서버일 뿐 도구를 돌리지 않는다. 그래서 세션은 Codex 실행기를 띄우고 모델 공급처만
  //   Ollama로 바꿔 쓴다(파일 수정·명령 실행·승인 카드·이어가기가 Codex 세션과 같다). 로그인은 없다.

  /** Ollama 서버 주소(경로 없이). 비우면 이 맥의 기본 포트를 쓴다. */
  ollamaUrl: (envStr("AETHER_OLLAMA_URL", "ollamaUrl") || "http://127.0.0.1:11434").replace(/\/+$/, ""),

  /**
   * Ollama 세션의 기본 모델(`ollama list`의 이름). 비우면 Ollama가 돌려주는 목록의 첫 모델을 쓴다.
   * 다른 provider와 어휘가 달라서 설정을 공유하지 않는다.
   */
  ollamaDefaultModel: envStr("AETHER_OLLAMA_MODEL", "ollamaDefaultModel"),

  /** Ollama 배경 작업(기억 자동 저장·압축·검색 요약·스킬 생성) 모델. 비우면 세션 기본 모델을 쓴다. */
  ollamaDistillModel: envStr("AETHER_OLLAMA_DISTILL_MODEL", "ollamaDistillModel"),

  /**
   * Ollama가 모델을 올릴 때 쓰는 대화 길이(토큰). Codex에 그대로 알려 준다.
   *
   * Codex는 Ollama 모델의 대화 길이를 모른다. 알려 주지 않으면 넘치기 전에 대화를 압축하지 못하고,
   * 그러면 Ollama가 앞부분을 조용히 잘라낸다. 이 값은 Ollama 서버 쪽 설정과 같아야 한다.
   */
  ollamaContextWindow: envNumber("AETHER_OLLAMA_CONTEXT_WINDOW", "ollamaContextWindow", 32_768, { min: 4096 }),

  /** bcrypt work factor. 2026 권장 12(~250ms). */
  bcryptCost: envNumber("AETHER_BCRYPT_COST", "bcryptCost", 12, { min: 4, max: 31 }),

  // ── Phase 5 권한 카드 ──

  /** 권한카드 diff before 읽기 상한(바이트). 초과 시 truncate. bodyLimit 256kb와 결 맞춤. */
  diffMaxBytes: envNumber("AETHER_DIFF_MAX_BYTES", "diffMaxBytes", 256 * 1024, { min: 1024 }),

  /** 권한 보류 만료(ms). 0=만료 없음(기본). 하드 만료는 모델 혼란 위험 → 기본 비활성. */
  permissionTimeoutMs: envNumber("AETHER_PERMISSION_TIMEOUT_MS", "permissionTimeoutMs", 0, { min: 0 }),

  // ── 설정 창구 밖에서 환경변수를 직접 읽던 값들. 환경변수 > 설정 파일 > 기본값 ──

  /**
   * 오류 기록 폴더. 기본은 모든 OS에서 데이터 폴더 아래 errors다.
   * 시험이 운영 폴더에 쓰지 못하게 막는 검사는 오류 기록 모듈이 가진다.
   */
  get errorDir(): string {
    return process.env.AETHER_ERROR_DIR || FILE_ERROR_DIR || path.join(process.env.AETHER_DATA_DIR || DATA_DIR, "errors");
  },

  /** DB 백업 폴더. 기본 <데이터폴더>/backups. */
  get backupDir(): string {
    const dir = (process.env.AETHER_BACKUP_DIR || FILE_BACKUP_DIR)?.trim();
    return dir ? path.resolve(dir) : path.join(process.env.AETHER_DATA_DIR || DATA_DIR, "backups");
  },

  /** 수동 백업을 남기는 개수. 복원 전 백업은 세지 않는다. */
  backupKeep: envNumber("AETHER_BACKUP_KEEP", "backupKeep", 7, { min: 1 }),

  /** 격리 작업 복사본을 만드는 폴더. 기본 ~/.aether/worktrees. */
  get worktreeDir(): string {
    const dir = (process.env.AETHER_WORKTREE_DIR ?? FILE_WORKTREE_DIR)?.trim();
    return dir ? path.resolve(dir) : path.join(os.homedir(), ".aether", "worktrees");
  },

  /** 빌드된 프론트 폴더. 기본 <저장소>/web/dist. */
  get webDist(): string {
    const dir = process.env.AETHER_WEB_DIST || FILE_WEB_DIST;
    return dir ? path.resolve(dir) : path.join(here, "..", "web", "dist");
  },

  /**
   * 서버가 켜질 때 화면을 자동으로 다시 빌드해도 되는가. 운영일 때만 켠다:
   * NODE_ENV=production(launchd plist가 지정)이고, 시험·실험 실행이 아니며, 데이터 폴더·DB 경로가 기본값이고,
   * 화면 폴더가 저장소 web/dist이며, AETHER_WEB_AUTOBUILD=0이 아닐 때. 서버 잠금을 잡은 서버만 실제로 빌드한다.
   * 시험·실험 서버가 라이브 web/dist를 덮어쓰지 못하게 하는 안전 조건이다.
   */
  get webAutoBuild(): boolean {
    const off = process.env.AETHER_WEB_AUTOBUILD !== undefined ? process.env.AETHER_WEB_AUTOBUILD === "0" : FILE_WEB_AUTOBUILD === false;
    return process.env.NODE_ENV === "production" && !sandboxed && !off && !DB_PATH_RAW && DATA_DIR === path.join(here, "data") && this.webDist === path.join(here, "..", "web", "dist");
  },

  /** 에이전트가 쓰는 사용자 스킬 폴더. 비면 undefined(호출자가 설정 폴더 아래 skills로 대신한다). */
  get skillsDir(): string | undefined {
    return (process.env.AETHER_SKILLS_DIR ?? FILE_SKILLS_DIR)?.trim() || undefined;
  },
};

// 위 getter들은 환경변수를 읽을 때마다 보므로, 덮어쓰기 경고는 부팅 시점 기준으로 한 번만 낸다.
for (const [env, f] of [["AETHER_ERROR_DIR", FILE_ERROR_DIR], ["AETHER_WORKTREE_DIR", FILE_WORKTREE_DIR], ["AETHER_WEB_DIST", FILE_WEB_DIST], ["AETHER_SKILLS_DIR", FILE_SKILLS_DIR]] as const) {
  noteOverride(env, process.env[env] !== undefined && f !== undefined);
}

for (const key of Object.keys(fileConfig)) {
  if (!usedKeys.has(key)) console.warn(`[aether config] 모르는 설정 파일 키를 무시합니다: ${key}`);
}
