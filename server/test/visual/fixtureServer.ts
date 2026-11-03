/**
 * 시각 확인용 격리 fixture 서버 (Phase 8d-3 완료 게이트 ③).
 *   실행: npx tsx server/test/visual/fixtureServer.ts [포트]
 *
 * 왜 있나: 8d-3은 프론트에서 provider 원본을 읽는 경로를 전부 지웠다. 단위 테스트는 조각의 *값*이 맞는지
 * 보지만, 실제 화면이 예전과 같은 모양으로 그려지는지는 눈으로 봐야 한다("퇴화도 변화다" — 게이트 ③).
 * 8c 때는 이걸 그때그때 손으로 만들었고 남기지 않아서 8d-3에서 처음부터 다시 만들어야 했다. 이번엔 남긴다.
 *
 * 어떻게: 빌드된 프론트(`web/dist`)를 그대로 서빙하고 `/api`만 가짜로 답한다. 대화 내용은 **실제 골든
 * 코퍼스**(`server/test/fixtures/*.jsonl`)를 **실제 정규화 경로**(`toWireEvent` + provider codec)에 통과시켜
 * 만든다. 손으로 지어낸 봉투가 아니라 프로덕션이 내보내는 것과 같은 값이라, 화면이 맞으면 진짜 맞는 것이다.
 *
 * 세션을 띄운다:
 *   - `fixture-claude` : Claude 코퍼스 → "화면 변화 0"을 눈으로 대조하는 쪽
 *   - `fixture-codex`  : 두 번째 provider 코퍼스 → 원본 폴백 없이도 같은 화면이 나오는지 보는 쪽
 *   - `fixture-grok`   : 세 번째 카탈로그 항목. 한도 창은 없고 문맥 게이지만 온다(10f).
 *
 * 모델을 부르지 않고 디스크도 건드리지 않는다.
 */
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_EVENT_CONTRACT_VERSION } from "../../../shared/agentEvent";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const DIST = process.env.AETHER_FIXTURE_DIST
  ? path.resolve(process.env.AETHER_FIXTURE_DIST)
  : path.join(REPO, "web", "dist");
const FIXTURES = path.join(REPO, "server", "test", "fixtures");
const FIXTURE_SEARCH_DELAY_MS = Number(process.env.AETHER_FIXTURE_SEARCH_DELAY_MS || 0);
// 눈으로 계약 불일치 안내를 확인할 때: AETHER_FIXTURE_CONTRACT_VERSION=0 npx tsx test/visual/fixtureServer.ts
// 기본값은 현재 화면과 같은 계약 버전이라 평소 시각 검증에는 안내가 뜨지 않는다.
const FIXTURE_CONTRACT_VERSION = process.env.AETHER_FIXTURE_CONTRACT_VERSION === undefined
  ? AGENT_EVENT_CONTRACT_VERSION
  : Number(process.env.AETHER_FIXTURE_CONTRACT_VERSION);
const pageVariant = (req: express.Request) => {
  try {
    return new URL(req.get("referer") || "http://fixture/").searchParams;
  } catch {
    return new URLSearchParams();
  }
};

// 서버 모듈은 임시 데이터 디렉터리로 격리한 뒤 로드한다(config가 import 시점에 굳는다).
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-fixture-"));
const { toWireEvent } = await import("../../sessions/wireEvent");
const { codecFor } = await import("../../providers/registry");

type Raw = { seq: number; ts: number; kind: string; [k: string]: unknown };

/** 골든 코퍼스 한 줄씩 → 실제 정규화를 거친 와이어 봉투. */
function wireOf(file: string, provider: string): unknown[] {
  const codec = codecFor(provider);
  return fs
    .readFileSync(path.join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Raw)
    .map((ev) => toWireEvent(ev as never, codec));
}

/**
 * 두 번째 provider 세션의 클라이언트 봉투.
 *
 * 프로덕션 문과 같이 원본 본문 없이 계약(`events`)만 싣는다. 화면이 원본을 몰래 읽고 있으면 여기서 빈다.
 */
let foreignSeq = 0;
const foreign = (events: Record<string, unknown>[]) => {
  const seq = ++foreignSeq;
  return {
    seq,
    ts: 1_700_000_000_000 + seq * 1000,
    kind: "agent",
    events: events.map((e, part) => ({ provider: "codex", seq, part, ts: 1_700_000_000_000 + seq * 1000, ...e })),
  };
};
const own = (o: Record<string, unknown>) => ({ seq: ++foreignSeq, ts: 1_700_000_000_000 + foreignSeq * 1000, ...o });

const FOREIGN_EVENTS: unknown[] = [
  own({ kind: "user_msg", text: "테스트를 돌리고 결과를 알려줘" }),
  // 8h: 답하기 전에 모델이 정리한 생각. 화면엔 접힌 한 줄로만 나와야 한다(펼치면 본문이 보인다).
  foreign([{ type: "reasoning", text: "먼저 어떤 테스트 명령이 있는지 확인하자.\n\npackage.json의 scripts를 보면 `npm test`가 결정적 스위트를 전부 돌린다. 실행 시간이 길 수 있으니 상한을 넉넉히 잡는다." }]),
  foreign([{ type: "text", text: "테스트를 실행하겠습니다." }]),
  foreign([{ type: "tool_call", toolId: "tc-1", name: "commandExecution", toolKind: "bash", target: "npm test", input: { command: "npm test", timeout: 120 } }]),
  foreign([{ type: "tool_result", toolId: "tc-1", output: "37 passed, 0 failed" }]),
  foreign([{ type: "text", text: "테스트 **37개**가 모두 통과했습니다." }]),
  foreign([{ type: "command_output", text: "context: 12k/200k tokens (6%)" }]),
  foreign([{ type: "provider_notice", kind: "rate_limit", severity: "warn", limitType: "weekly", utilization: 0.87, resetsAt: Math.floor(Date.now() / 1000) + 10_800 }]),
  foreign([{ type: "provider_notice", kind: "model_fallback", severity: "warn", detail: "gpt-small", originalModel: "gpt-large", category: "safety" }]),
  own({ kind: "notice", notice: "auth_expired" }),
  foreign([{ type: "turn_completed", status: "ok", durationMs: 4200, outputTokens: 512 }]),
  // 컨텍스트 사용률도 계약(`usage_update`)에서 온다 — 상단 ctx 게이지가 두 번째 provider에서도 차는지 본다.
  foreign([{ type: "usage_update", totalTokens: 24_000, maxTokens: 200_000 }]),
];

// 브리프 질문지 — 모델 글의 질문지 상자는 가려지고 그 뒤에 「추천이 채워진 검토지」 카드가 뜬다.
const QN_SUMMARY = "## 코드에서 정한 것\n- 재시도 대상은 `src/payments.js:12`의 `chargeCard`다.\n\n## 과거 이력에서 정한 것\n없음 — 결과 없음.\n\n## 가정 (틀리면 고쳐 주세요)\n- 시험은 `npm test`로 돌린다.\n\n## 이렇게 진행하겠습니다\n1. 답에 맞춰 재시도를 넣는다.\n2. 시험을 돌리고 보고한다.\n\n```aether-questions\n{\"questions\":[]}\n```";
const QN_USER = own({ kind: "user_msg", text: "결제 재시도 기능 넣어줘" });
const QN_TEXT = foreign([{ type: "text", text: QN_SUMMARY }]);
const QUESTIONNAIRE_EVENTS: unknown[] = [
  QN_USER,
  QN_TEXT,
  own({
    kind: "questionnaire",
    id: "fixture-qn",
    sourceSeq: (QN_TEXT as { seq: number }).seq,
    sourcePart: 0,
    questions: [
      { id: "q1", text: "재시도할 오류 종류", kind: "single", options: [{ label: "GATEWAY_TIMEOUT만", description: "일시 오류만 다시 시도한다" }, { label: "모든 결제 오류" }], recommended: "GATEWAY_TIMEOUT만" },
      { id: "q2", text: "재시도할 단계", kind: "multi", options: [{ label: "승인" }, { label: "취소" }, { label: "환불" }], recommended: ["승인"] },
      { id: "q3", text: "재시도 횟수와 간격", kind: "text", recommended: "2회, 100ms/300ms" },
      { id: "q4", text: "재시도 기록을 어디에 남길까요?", kind: "single", options: [{ label: "로그만" }, { label: "payments 표에 컬럼 추가" }] },
    ],
  }),
  foreign([{ type: "turn_completed", status: "ok", durationMs: 31000, outputTokens: 900 }]),
];

const ACTION_EVENTS: unknown[] = [
  own({ kind: "user_msg", text: "안전하게 변경을 적용하고 진행 방식을 확인해줘" }),
  own({
    kind: "permission_request",
    req: {
      id: "fixture-permission",
      toolName: "Edit",
      displayName: "Edit",
      toolUseID: "fixture-tool-permission",
      input: { file_path: "/fixture/project/src/app.ts", old_string: "const mode = 'legacy'", new_string: "const mode = 'seed'" },
      mutation: {
        kind: "edit",
        path: "/fixture/project/src/app.ts",
        additions: 1,
        deletions: 1,
        hunks: [{
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-const mode = 'legacy'", "+const mode = 'seed'"],
        }],
      },
      createdAt: 1_700_000_000_000,
    },
  }),
  own({
    kind: "question_request",
    req: {
      id: "fixture-question",
      toolUseID: "fixture-tool-question",
      questions: [
        {
          question: "다음 구현 단위를 어떻게 진행할까요?",
          header: "진행 방식",
          multiSelect: false,
          options: [
            { label: "검증 후 진행", description: "현재 단위를 검증한 뒤 다음 단계로 이동합니다." },
            { label: "연속 진행", description: "검증과 다음 단위를 같은 세션에서 이어갑니다." },
          ],
        },
      ],
      createdAt: 1_700_000_000_001,
    },
  }),
];

/**
 * 아직 돌고 있는 턴 — 턴 종료 이벤트가 없어서 프론트가 '진행 중'으로 본다(deriveTurn).
 * 모델이 작업 도중에 세 번 말했다. 화면엔 두 마디만 남아야 한다 — 도구가 뒤따라 확정된 알림 하나(두 번째 말)와
 * 아직 도구가 안 붙은 마지막 말. 첫 번째 말은 두 번째 말에 갈아끼워져 어디에도 없어야 한다.
 */
const LIVE_EVENTS: unknown[] = [
  own({ kind: "user_msg", text: "모달 껍데기랑 서랍을 손봐줘" }),
  foreign([{ type: "text", text: "이제 모달 껍데기를 고치겠습니다" }]),
  foreign([{ type: "tool_call", toolId: "lv-1", name: "Edit", input: { file_path: "/fixture/project/src/ui/Modal.tsx" } }]),
  foreign([{ type: "tool_result", toolId: "lv-1", output: "1 edit applied" }]),
  foreign([{ type: "text", text: "이제 Agent Brain 오버레이와 모바일 서랍을 고치겠습니다" }]),
  foreign([{ type: "tool_call", toolId: "lv-2", name: "Edit", input: { file_path: "/fixture/project/src/shell/MobileDrawer.tsx" } }]),
  foreign([{ type: "tool_result", toolId: "lv-2", output: "1 edit applied" }]),
  // 일부러 길게 — 모바일 폭(390)에서도 두 줄로 넘치지 않고 말줄임으로 잘리는지 보려는 것이다.
  foreign([{ type: "text", text: "마지막으로 스트림 목록의 간격을 맞추고 모바일 폭에서도 줄이 넘치지 않는지 확인하겠습니다" }]),
];

/** 답을 못 내고 끊긴 턴(D5) — 최종 답변이 없으므로 마지막에 하던 말이 말풍선 없이 중단 배너 위에 남아야 한다. */
const CUT_EVENTS: unknown[] = [
  own({ kind: "user_msg", text: "대용량 로그를 통째로 정리해줘" }),
  foreign([{ type: "text", text: "먼저 로그 파일 목록을 훑어보겠습니다" }]),
  foreign([{ type: "tool_call", toolId: "ct-1", name: "Bash", input: { command: "ls -la /var/log" } }]),
  foreign([{ type: "tool_result", toolId: "ct-1", output: "142 files" }]),
  foreign([{ type: "text", text: "이제 오래된 로그를 골라내는 중입니다" }]),
  own({ kind: "status", status: "crashed" }),
];

/** 오래 안 써서 잠든 세션 — 대화 기록은 남아 있지만 모델 목록을 물어볼 프로세스가 없다. */
const ASLEEP_EVENTS: unknown[] = [
  own({ kind: "user_msg", text: "지난주에 만든 설정 화면 정리해줘" }),
  foreign([{ type: "text", text: "설정 화면의 항목을 세 묶음으로 나눴습니다." }]),
  foreign([{ type: "turn_completed", status: "ok", durationMs: 3100, outputTokens: 210 }]),
];

type UsageShape = {
  windowsAvailable: boolean;
  windows: Array<{ key: string; utilization: number | null; windowMinutes?: number; resetsAt?: string | null }>;
  costUsd?: number;
  subscriptionType?: string;
  context?: { used: number; size: number };
};

/** 창마다 이름이 있는 사용량. Claude 실측 모양. */
const USAGE_NAMED: UsageShape = {
  costUsd: 1.234,
  subscriptionType: "max",
  windowsAvailable: true,
  windows: [
    { key: "five_hour", utilization: 42, resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString() },
    { key: "seven_day", utilization: 88, resetsAt: new Date(Date.now() + 4 * 86400_000).toISOString() },
    { key: "seven_day_oauth_apps", utilization: 12, resetsAt: null },
  ],
};

/** 이름 없이 길이만 있는 사용량. Codex 실측 모양. */
const USAGE_DURATION: UsageShape = {
  subscriptionType: "plus",
  windowsAvailable: true,
  windows: [
    { key: "codex_primary", utilization: 16, windowMinutes: 10080, resetsAt: new Date(Date.now() + 5 * 86400_000).toISOString() },
    { key: "codex_secondary", utilization: 63, windowMinutes: 300, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
  ],
};

/** 한도 창을 안 주는 서비스. 가짜 5시간 창을 만들지 않는다(10f). */
const USAGE_NONE: UsageShape = { windowsAvailable: false, windows: [] };

/** 한도 창은 주 단위 구독이고 문맥 점유량도 있는 서비스(Grok `_x.ai/billing` 실측). */
const USAGE_CONTEXT: UsageShape = {
  windowsAvailable: true,
  windows: [
    {
      key: "weekly",
      utilization: 42,
      windowMinutes: 10080,
      resetsAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
    },
  ],
  subscriptionType: "SuperGrok Plus",
  context: { used: 1200, size: 258400 },
};

const COMMON_COMMANDS = [
  { name: "model", description: { byLocale: { ko: "모델 변경", en: "Change model" } }, argumentHint: {}, startsTurn: false },
  { name: "effort", description: { byLocale: { ko: "생각 강도", en: "Thinking effort" } }, argumentHint: {}, startsTurn: false },
  { name: "new", description: { byLocale: { ko: "새 작업 만들기", en: "Start a new work item" } }, argumentHint: {}, startsTurn: false, uiAction: "newSession" },
  { name: "rename", description: { byLocale: { ko: "작업 이름 바꾸기", en: "Rename this work item" } }, argumentHint: { byLocale: { ko: "[새 이름]", en: "[new name]" } }, aliases: ["title"], startsTurn: false, uiAction: "rename" },
  { name: "delete", description: { byLocale: { ko: "이 작업 삭제", en: "Delete this work item" } }, argumentHint: {}, startsTurn: false, uiAction: "delete" },
  { name: "settings", description: { byLocale: { ko: "설정 열기", en: "Open settings" } }, argumentHint: {}, startsTurn: false, uiAction: "settings" },
  { name: "help", description: { byLocale: { ko: "단축키 도움말", en: "Keyboard shortcuts" } }, argumentHint: {}, startsTurn: false, uiAction: "help" },
  { name: "find", description: { byLocale: { ko: "이 세션에서 찾기", en: "Find in this session" } }, argumentHint: {}, startsTurn: false, uiAction: "find" },
  { name: "login", description: { byLocale: { ko: "다시 로그인", en: "Sign in again" } }, argumentHint: {}, startsTurn: false, uiAction: "login" },
  { name: "status", description: { byLocale: { ko: "사용량·세션 상태", en: "Usage and session status" } }, argumentHint: {}, aliases: ["info", "session-info", "context", "usage", "cost"], startsTurn: false, uiAction: "status" },
];
const GROK_COMMANDS = [
  ...COMMON_COMMANDS,
  { name: "compact", description: { byLocale: { ko: "대화 기록 압축", en: "Compact conversation history" } }, argumentHint: {}, startsTurn: true },
  { name: "clear", description: { byLocale: { ko: "대화 컨텍스트 초기화", en: "Clear conversation context" } }, argumentHint: {}, startsTurn: true },
];

type FixtureSession = {
  id: string;
  provider: string;
  displayName: string;
  events: unknown[];
  asleep?: boolean;
  model: string;
  effort: string;
  usage: UsageShape;
  models?: unknown[];
  isolated?: boolean;
  commands?: unknown[];
  attention?: "idle" | "running" | "background" | "waiting" | "done" | "failed";
  attentionKind?: string;
  attentionPreview?: string;
  /** 백그라운드 작업(attention이 background일 때). 중지 경로가 하나씩 뺀다. */
  backgroundTasks?: { id: string; kind: "agent" | "command" | "other"; description: string }[];
  backgroundCanStop?: boolean;
  lastMessage?: string;
  /** 기본은 `/fixture/<provider>`. 폴더 탐색기 시험용으로 다른 폴더를 줄 때만 쓴다. */
  cwd?: string;
};

const SESSIONS: FixtureSession[] = [
  { id: "fixture-claude", provider: "claude", displayName: "fixture · claude", events: wireOf("claude_events.jsonl", "claude"), model: "sonnet", effort: "high", usage: USAGE_NAMED },
  { id: "fixture-codex", provider: "codex", displayName: "fixture · second provider", events: FOREIGN_EVENTS, model: "gpt-small", effort: "deep", usage: USAGE_DURATION },
  { id: "fixture-actions", provider: "codex", displayName: "fixture · actions", events: ACTION_EVENTS, model: "gpt-small", effort: "deep", usage: USAGE_DURATION, attention: "waiting", attentionKind: "question", attentionPreview: "질문에 답해 주세요" },
  { id: "fixture-live", provider: "codex", displayName: "fixture · 진행 중인 턴", events: LIVE_EVENTS, model: "gpt-small", effort: "deep", usage: USAGE_DURATION, attention: "running" },
  { id: "fixture-background", provider: "claude", displayName: "fixture · 백그라운드 작업 중", events: wireOf("claude_events.jsonl", "claude"), model: "sonnet", effort: "high", usage: USAGE_NAMED, attention: "background", backgroundCanStop: true, backgroundTasks: [{ id: "bgt1", kind: "agent", description: "코드 구조 조사" }, { id: "bgt2", kind: "command", description: "npm run build 감시" }] },
  { id: "fixture-cut", provider: "codex", displayName: "fixture · 끊긴 턴", events: CUT_EVENTS, model: "gpt-small", effort: "deep", usage: USAGE_DURATION, attention: "failed", attentionKind: "failed", attentionPreview: "작업이 실패했습니다" },
  // 잠든 세션 — 모델 목록 조회가 404를 준다. 화면이 목록창 대신 "세션이 잠들어 있다"는 안내를 띄우는지 보는 자리.
  { id: "fixture-asleep", provider: "claude", displayName: "fixture · 잠든 세션", asleep: true, events: ASLEEP_EVENTS, model: "sonnet", effort: "high", usage: USAGE_NAMED },
  { id: "fixture-questionnaire", provider: "codex", displayName: "fixture · 브리프 질문지", events: QUESTIONNAIRE_EVENTS, model: "gpt-small", effort: "deep", usage: USAGE_DURATION },
  { id: "fixture-grok", provider: "grok", displayName: "fixture · third provider", events: wireOf("grok_events.jsonl", "grok"), model: "grok-4.6", effort: "high", usage: USAGE_CONTEXT, commands: GROK_COMMANDS },
  {
    id: "fixture-plan",
    provider: "grok",
    displayName: "fixture · plan",
    events: [
      own({ kind: "user_msg", text: "인증을 어떻게 붙일지 계획해 줘" }),
      own({ kind: "plan_request", req: { id: "fixture-plan", planId: "p1", text: "1. 인증 방식을 고른다\n2. 세션을 붙인다", createdAt: 1_700_000_000_000 } }),
    ],
    model: "grok-4.6",
    effort: "high",
    usage: USAGE_NONE,
    commands: GROK_COMMANDS,
    attention: "waiting",
    attentionKind: "plan",
    attentionPreview: "계획을 확인해 주세요",
  },
  {
    id: "fixture-done-unread",
    provider: "codex",
    displayName: "fixture · unread done",
    events: [
      own({ kind: "user_msg", text: "짧게 끝내 줘" }),
      foreign([{ type: "text", text: "끝냈습니다." }]),
      foreign([{ type: "turn_completed", status: "ok" }]),
    ],
    model: "gpt-small",
    effort: "deep",
    usage: USAGE_DURATION,
    attention: "done",
    attentionKind: "done",
    attentionPreview: "작업이 끝났습니다",
  },
  {
    id: "fixture-team",
    provider: "codex",
    displayName: "fixture · team",
    events: [
      own({ kind: "user_msg", text: "인증을 탐색하고 구현해 줘" }),
      foreign([{ type: "tool_call", toolId: "task-explore", name: "Task", toolKind: "task", target: "auth", input: { description: "로그인 탐색", subagent_type: "Explore", prompt: "로그인 진입점을 찾아라", files: ["src/auth.ts"] } }]),
      foreign([{ type: "tool_result", toolId: "task-explore", output: "src/auth.ts 에서 세션 쿠키를 확인했다" }]),
      foreign([{ type: "tool_call", toolId: "task-impl", name: "Task", toolKind: "task", target: "login", input: { description: "로그인 구현", subagent_type: "implementer", prompt: "세션 쿠키를 고친다" } }]),
      foreign([{ type: "tool_call", toolId: "bash-1", name: "Bash", toolKind: "bash", target: "ls", input: { command: "ls" } }]),
      foreign([{ type: "text", text: "탐색은 끝났고 구현이 진행 중입니다." }]),
      foreign([{ type: "turn_completed", status: "ok" }]),
    ],
    model: "gpt-small",
    effort: "deep",
    usage: USAGE_DURATION,
  },
  {
    id: "fixture-iso",
    provider: "grok",
    displayName: "fixture · isolated",
    events: wireOf("grok_events.jsonl", "grok"),
    model: "grok-4.6",
    effort: "high",
    usage: USAGE_NONE,
    isolated: true,
    commands: GROK_COMMANDS,
  },
  // 폴더 탐색기 시험용. 열 수 없는 폴더(403)와 숨김 폴더를 작업 폴더로 가진 세션이다. 가장 최근 활동이라 최근 폴더 맨 위에 온다.
  { id: "fixture-denied", provider: "claude", displayName: "fixture · 열 수 없는 폴더", cwd: "/fixture/denied", events: [], model: "sonnet", effort: "high", usage: USAGE_NAMED },
  { id: "fixture-hidden", provider: "claude", displayName: "fixture · 숨김 폴더", cwd: "/fixture/home/.hidden-work", events: [], model: "sonnet", effort: "high", usage: USAGE_NAMED },
];

const EFFORT_DESCRIPTIONS = {
  low: { byLocale: { ko: "빠른 응답", en: "Fast response" } },
  medium: { byLocale: { ko: "균형", en: "Balanced" } },
  high: { byLocale: { ko: "깊은 추론", en: "Deep reasoning" } },
  xhigh: { byLocale: { ko: "더 깊은 추론", en: "Deeper reasoning" } },
  max: { byLocale: { ko: "최대 추론", en: "Max reasoning" } },
};

const SESSION_MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "", isDefault: true, resolvedModel: "claude-opus-5[1m]", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportedEffortDescriptions: EFFORT_DESCRIPTIONS },
  { value: "sonnet", displayName: "Sonnet", description: "", isDefault: false, resolvedModel: "claude-sonnet-5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportedEffortDescriptions: EFFORT_DESCRIPTIONS },
  { value: "haiku", displayName: "Haiku", description: "", isDefault: false, resolvedModel: "claude-haiku-4-5-20251001", supportsEffort: false },
];

// 모델 목록을 주는 세션만 붙인다. provider 이름 분기가 아니라 세션 기록이다.
for (const id of ["fixture-claude", "fixture-asleep"]) {
  const s = SESSIONS.find((x) => x.id === id);
  if (s) s.models = SESSION_MODELS;
}

const FIXTURE_AUTH = (process.env.AETHER_FIXTURE_AUTH || "off") as "off" | "tailscale" | "password";
const FIXTURE_DESKTOP = process.env.AETHER_FIXTURE_DESKTOP === "1";
// 재인증 응답. 비우거나 알 수 없는 값이면 device(지금 응답)와 같다.
const FIXTURE_AUTH_MODE = ((): "device" | "code" | "success" | "error" => {
  const raw = process.env.AETHER_FIXTURE_AUTH_MODE;
  if (raw === "code" || raw === "success" || raw === "error") return raw;
  return "device";
})();
// password일 때 GET /api/sessions를 403으로 고정하면 로그인 화면이 막힘으로 간다.
const FIXTURE_SESSIONS_BLOCKED = process.env.AETHER_FIXTURE_SESSIONS_STATUS === "403";
const FIXTURE_TOKEN = "fixture-token";
const FIXTURE_COOKIE = "aether_session";

const app = express();
app.use(express.json());

function readCookie(req: express.Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function fixtureAuthed(req: express.Request): boolean {
  if (FIXTURE_AUTH === "off") return true;
  if (FIXTURE_AUTH === "tailscale") return false; // whois 없이 항상 거부
  const cookie = readCookie(req, FIXTURE_COOKIE);
  if (cookie === FIXTURE_TOKEN) return true;
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)/i.exec(auth.trim());
    if (m && m[1] === FIXTURE_TOKEN) return true;
  }
  return false;
}

app.get("/api/health", (_q, r) => r.json({ ok: true, defaultModel: "sonnet", auth: FIXTURE_AUTH }));
app.post("/api/auth/login", (q, r) => {
  const password = typeof q.body?.password === "string" ? q.body.password : "";
  if (FIXTURE_AUTH !== "password" || password !== "fixture") {
    return r.status(401).json({ error: "auth failed" });
  }
  r.setHeader(
    "Set-Cookie",
    `${FIXTURE_COOKIE}=${FIXTURE_TOKEN}; Path=/; HttpOnly; SameSite=Lax`,
  );
  r.json({ ok: true, token: FIXTURE_TOKEN });
});
app.post("/api/auth/logout", (_q, r) => {
  r.setHeader("Set-Cookie", `${FIXTURE_COOKIE}=; Path=/; Max-Age=0`);
  r.json({ ok: true });
});

// 보호 API — health·auth 제외. off면 통과.
app.use("/api", (q, r, next) => {
  // 막힘은 첫 세션 목록 응답으로 정해진다. 로그인 뒤에만 403이면 화면은 비밀번호 오류로 남는다.
  // 그래서 이 스위치는 로그인 전이든 뒤든 GET /sessions만 403이다. /sessions/stats는 그대로 둔다.
  if (FIXTURE_AUTH === "password" && FIXTURE_SESSIONS_BLOCKED && q.method === "GET" && q.path === "/sessions") {
    return r.status(403).json({ error: "forbidden" });
  }
  if (q.path === "/health" || q.path.startsWith("/auth/")) return next();
  if (fixtureAuthed(q)) return next();
  r.status(401).json({ error: "auth required" });
});

if (FIXTURE_DESKTOP) {
  app.get("/api/notify/stream", (q, r) => {
    r.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const frame = () => {
      try {
        r.write(
          `data: ${JSON.stringify({ title: "fixture-notify", body: "desktop smoke", sessionId: "fixture" })}\n\n`,
        );
      } catch {
        /* closed */
      }
    };
    frame(); // 연결 직후 1프레임
    const iv = setInterval(frame, 1500); // 스모크가 포커스 해제 뒤에도 받을 수 있게
    q.on("close", () => {
      clearInterval(iv);
      try {
        r.end();
      } catch {
        /* closed */
      }
    });
  });
}

app.post("/api/locale", (_q, r) => r.json({ ok: true }));
const PROVIDER_CATALOG = [
  { id: "claude", displayName: "Claude", authSupported: true },
  { id: "codex", displayName: "Codex", authSupported: false },
  { id: "grok", displayName: "Grok", authSupported: true, planReview: true },
];

app.get("/api/providers", (_q, r) =>
  r.json({
    providers: PROVIDER_CATALOG,
    reloginEnabled: true,
  }),
);
// 저장된 목록 예시: Claude는 있고, Codex는 없고(안내 문구), Grok은 긴 이름.
app.get("/api/providers/remembered-models", (_q, r) =>
  r.json({
    models: {
      claude: [
        { value: "opus", displayName: "Opus 5.5" },
        { value: "sonnet", displayName: "Sonnet 5.5" },
        { value: "haiku", displayName: "Haiku 5.5" },
      ],
      codex: [],
      grok: [{ value: "grok-long", displayName: "Grok 아주 긴 모델 이름이 칸을 넘을 때 어떻게 보이는지 확인하는 줄입니다" }],
    },
  }),
);
app.get("/api/sessions/stats", (_q, r) => r.json({ dataBytes: 12_345_678, sessions: SESSIONS.length }));
function presenceOf(s: FixtureSession, i: number) {
  return {
    id: s.id,
    attention: s.attention ?? "idle",
    attentionKind: s.attentionKind,
    attentionPreview: s.attentionPreview,
    ...(s.backgroundTasks?.length ? { backgroundTasks: s.backgroundTasks, backgroundCanStop: s.backgroundCanStop } : {}),
    lastActivityAt: 1_700_000_000_000 + i,
    status: "ended" as const,
  };
}

function roomOf(s: FixtureSession, i: number) {
  return {
    id: `dm:${s.id}`,
    kind: "dm" as const,
    title: s.displayName,
    sourceSessionId: s.id,
    cwd: s.cwd ?? `/fixture/${s.provider}`,
    provider: s.provider,
    status: "ended" as const,
    attention: s.attention ?? "idle",
    attentionKind: s.attentionKind,
    attentionPreview: s.attentionPreview,
    ...(s.backgroundTasks?.length ? { backgroundTasks: s.backgroundTasks, backgroundCanStop: s.backgroundCanStop } : {}),
    lastActivityAt: 1_700_000_000_000 + i,
    asleep: !!s.asleep,
  };
}

app.get("/api/sessions", (_q, r) => {
  const sessions = SESSIONS.map((s, i) => ({
    id: s.id,
    cwd: s.cwd ?? `/fixture/${s.provider}`,
    displayName: s.displayName,
    provider: s.provider,
    model: s.model,
    effort: s.effort,
    permissionMode: "manual" as const,
    status: "ended" as const,
    createdAt: 1_700_000_000_000 + i,
    lastActivityAt: 1_700_000_000_000 + i,
    isolated: !!s.isolated,
    needsApply: s.id === "fixture-iso",
    applyBlocked: false,
    attention: s.attention ?? "idle",
    attentionKind: s.attentionKind,
    attentionPreview: s.attentionPreview,
    ...(s.backgroundTasks?.length ? { backgroundTasks: s.backgroundTasks, backgroundCanStop: s.backgroundCanStop } : {}),
  }));
  const rooms = SESSIONS.map((s, i) => roomOf(s, i));
  r.json({
    contractVersion: FIXTURE_CONTRACT_VERSION,
    rooms,
    sessions,
  });
});
app.get("/api/search", async (q, r) => {
  const delayMs = pageVariant(q).get("slowSearch") === "1" ? 900 : FIXTURE_SEARCH_DELAY_MS;
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const term = String(q.query.q || "SEED");
  const marked = `\u0001${term}\u0002`;
  r.json({
    results: [
      {
        id: 1,
        sessionId: "fixture-claude",
        seq: 2,
        part: 0,
        role: "assistant",
        ts: 1_730_000_000_000,
        snippet: `${marked} Design 구조와 interaction state를 확인했습니다.`,
        session: { displayName: "fixture · claude", cwd: "/fixture/claude", model: "sonnet", createdAt: 1_700_000_000_000 },
      },
      {
        id: 2,
        sessionId: "fixture-claude",
        seq: 3,
        part: 0,
        role: "tool",
        ts: 1_730_000_001_000,
        snippet: `npm run test:${marked.toLowerCase()} — 39 passed`,
        session: { displayName: "fixture · claude", cwd: "/fixture/claude", model: "sonnet", createdAt: 1_700_000_000_000 },
      },
    ],
  });
});

const find = (id: string) => SESSIONS.find((s) => s.id === id);

app.get("/api/sessions/:id/models", (q, r) => {
  const s = find(q.params.id);
  // 잠든 세션은 물어볼 프로세스가 없어 404다. 실패가 아니라 정상 상태이므로 화면은 재시도하지 않고 안내만 띄워야 한다.
  if (s?.asleep) return r.status(404).json({ error: "실행 중인 세션에서만 쓸 수 있어요" });
  if (!s?.models) return r.status(501).json({ error: "미지원" });
  r.json({ models: s.models });
});
app.get("/api/sessions/:id/commands", (q, r) => {
  const s = find(q.params.id);
  if (s?.commands) return r.json({ commands: s.commands });
  r.json({ commands: COMMON_COMMANDS });
});
// 자동승인이 있는 폴더를 연 세션처럼 — ⑥ⓕ 배지가 실제로 어떻게 보이는지 확인하는 자리다.
app.get("/api/sessions/:id/permission-policy", (_q, r) => r.json({ bypassAll: false, autoApproveRules: 3, sources: ["user", "project"] }));
/**
 * 사용량 패널 — 세션 기록에 실린 창 목록을 그대로 준다(8h·10f).
 *
 * 창마다 이름이 있는 모양, 길이만 있는 모양, 창이 없는 모양을 세션별로 나눠 둔다.
 * 창이 없는 세션에 5시간 창을 지어내지 않는다.
 */
app.get("/api/sessions/:id/usage", (q, r) => {
  const s = find(String(q.params.id));
  if (!s) return r.status(404).json({ error: "없음" });
  r.json(s.usage);
});

// 가짜 폴더 구조. 홈(/fixture/home) 아래에 project(빈 폴더)가 있어서 탐색 화면이 들어가 빈 폴더를 고르는 길을 본다.
const FS_TREE: Record<string, string[]> = {
  "/": ["Volumes", "fixture"],
  "/Volumes": ["Disk1"],
  "/fixture": ["claude", "codex", "home"],
  "/fixture/home": [".cache", "Desktop", "Documents", "Downloads", "project", "project-archive-2024", "research notes", ".hidden-work"],
};
const FS_DIRS = new Set<string>(["/"]);
for (const [dir, kids] of Object.entries(FS_TREE)) {
  FS_DIRS.add(dir);
  for (const kid of kids) FS_DIRS.add(dir === "/" ? `/${kid}` : `${dir}/${kid}`);
}
const FS_HOME = "/fixture/home";
// 목록 요청이 403으로 거절되는 폴더(최근 작업 폴더로만 나온다).
const FS_DENIED = "/fixture/denied";
app.get("/api/fs/places", (_q, r) => {
  r.json({
    home: FS_HOME,
    favorites: [
      { kind: "home", name: "home", path: FS_HOME },
      { kind: "desktop", name: "Desktop", path: `${FS_HOME}/Desktop` },
      { kind: "documents", name: "Documents", path: `${FS_HOME}/Documents` },
      { kind: "downloads", name: "Downloads", path: `${FS_HOME}/Downloads` },
    ],
    devices: [
      { kind: "root", name: "/", path: "/" },
      { kind: "volume", name: "Disk1", path: "/Volumes/Disk1" },
    ],
  });
});
app.get("/api/fs/list", (q, r) => {
  const raw = typeof q.query.path === "string" ? q.query.path : "";
  const dir = raw === "" ? FS_HOME : raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  if (!dir.startsWith("/")) return r.status(400).json({ error: "전체 경로를 적어 주세요" });
  if (dir === FS_DENIED) return r.status(403).json({ error: "열 수 없는 폴더예요" });
  if (!FS_DIRS.has(dir)) return r.status(404).json({ error: "폴더를 찾을 수 없어요" });
  const showHidden = q.query.showHidden === "1";
  const segs = dir.split("/").filter(Boolean);
  const crumbs = [{ name: "/", path: "/" }, ...segs.map((name, i) => ({ name, path: `/${segs.slice(0, i + 1).join("/")}` }))];
  const kids = (FS_TREE[dir] ?? []).filter((name) => showHidden || !name.startsWith("."));
  r.json({
    path: dir,
    name: crumbs[crumbs.length - 1].name,
    parent: segs.length ? (segs.length === 1 ? "/" : `/${segs.slice(0, -1).join("/")}`) : null,
    crumbs,
    canCopy: true,
    entries: kids.map((name) => ({ name, path: dir === "/" ? `/${name}` : `${dir}/${name}`, hidden: name.startsWith(".") })),
    truncated: false,
  });
});

// 뒤 작업 중지 — 목록에서 그 작업을 빼고, 다 없어지면 쉼으로 돌린다(실제 서버가 목록을 다시 내보내는 흐름을 흉내).
app.post("/api/sessions/:id/background-tasks/:taskId/stop", (q, r) => {
  const s = SESSIONS.find((x) => x.id === q.params.id);
  if (!s) return r.status(404).json({ error: "unknown session" });
  if (!s.backgroundCanStop) return r.status(501).json({ error: "not supported" });
  if (!s.backgroundTasks?.some((x) => x.id === q.params.taskId)) return r.status(404).json({ error: "unknown task" });
  s.backgroundTasks = s.backgroundTasks.filter((x) => x.id !== q.params.taskId);
  if (s.backgroundTasks.length === 0) s.attention = "idle";
  r.json({ ok: true });
});
app.post("/api/sessions/:id/wake", (_q, r) => r.json({ ok: true, alreadyAwake: true }));
let failNextProvider: string | null = null;
app.post("/api/debug/fail-create", (q, r) => {
  failNextProvider = String((q.body as { provider?: unknown } | undefined)?.provider ?? "") || null;
  r.json({ ok: true, provider: failNextProvider });
});
app.post("/api/sessions", (q, r) => {
  const body = (q.body ?? {}) as { provider?: string; model?: string; cwd?: string; permissionMode?: string; isolateWorkspace?: boolean; name?: string };
  if (failNextProvider && body.provider === failNextProvider) {
    failNextProvider = null;
    return r.status(400).json({ error: "픽스처 거절" });
  }
  const catalog = PROVIDER_CATALOG.find((p) => p.id === body.provider) ?? PROVIDER_CATALOG[0];
  const id = `fixture-created-${catalog.id}-${Date.now()}`;
  const created: FixtureSession = {
    id,
    provider: catalog.id,
    displayName: body.name?.trim() || `새 세션 · ${catalog.displayName}`,
    events: [],
    model: body.model ?? "",
    effort: "",
    usage: USAGE_NONE,
    isolated: !!body.isolateWorkspace,
  };
  SESSIONS.push(created);
  r.json({ id, cwd: body.cwd || `/fixture/${catalog.id}`, model: created.model });
});

app.post("/api/sessions/:id/message", (q, r) => {
  const s = SESSIONS.find((x) => x.id === q.params.id);
  if (!s) return r.status(404).json({ error: "없음" });
  const text = String((q.body as { text?: unknown } | undefined)?.text ?? "");
  s.lastMessage = text;
  s.events = [...s.events, own({ kind: "user_msg", text })];
  r.json({ ok: true });
});

app.get("/api/debug/created", (_q, r) => {
  r.json({
    sessions: SESSIONS.filter((s) => s.id.startsWith("fixture-created-")).map((s) => ({
      id: s.id,
      provider: s.provider,
      lastMessage: s.lastMessage ?? "",
      isolated: !!s.isolated,
    })),
  });
});

let providerAuthPolls = 0;
app.post("/api/provider-auth/:provider/start", (_q, r) => {
  providerAuthPolls = 0;
  if (FIXTURE_AUTH_MODE === "error") {
    return r.status(400).json({ error: "다시 로그인하지 못했어요." });
  }
  if (FIXTURE_AUTH_MODE === "code") {
    return r.json({ loginId: "fixture-login", mode: "submitCode", url: "https://example.test/device" });
  }
  // device와 success는 같은 시작. success는 아래 조회가 한 번 만에 끝낸다.
  r.json({ loginId: "fixture-login", mode: "deviceCode", url: "https://example.test/device", userCode: "WDTE-XTJK" });
});
app.post("/api/provider-auth/:provider/poll", (_q, r) => {
  providerAuthPolls += 1;
  if (FIXTURE_AUTH_MODE === "success" && providerAuthPolls >= 1) {
    return r.json({ status: "success" });
  }
  r.json({ status: "pending" });
});
app.post("/api/provider-auth/:provider/cancel", (_q, r) => r.json({ ok: true }));

/**
 * 열려 있는 SSE 연결 — 세션 id → 응답 목록.
 * 카드에 답했을 때 그 결과를 화면으로 되돌려 보내기 위해 들고 있는다. 이게 없으면 권한·질문 카드가
 * 영원히 "답을 기다리는 중"이라, **답하는 순간에만 도는 움직임**(card-settle)을 브라우저에서 확인할 수 없다.
 */
const openStreams = new Map<string, Set<{ write: (chunk: string) => void }>>();
let pushSeq = 9000;
const pushEvent = (sessionId: string, ev: Record<string, unknown>) => {
  const payload = { seq: ++pushSeq, ts: Date.now(), ...ev };
  // 실제 서버처럼 남겨 둔다 — 새로고침하면 이 세션은 "이미 결정된 카드"를 과거 기록으로 다시 받는다.
  // 그 상태에서는 결정 순간의 움직임이 돌면 안 된다(지난 카드가 열 때마다 번쩍이는 것 방지). 그 검증에 쓴다.
  find(sessionId)?.events.push(payload);
  for (const res of openStreams.get(sessionId) ?? []) res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

// 카드에 답하면 실제 서버가 하듯 결과 이벤트를 SSE로 흘려보낸다(모델은 부르지 않는다).
app.post("/api/sessions/:id/permission", (q, r) => {
  const { permissionId, decision } = q.body as { permissionId: string; decision: "allow" | "deny" };
  pushEvent(q.params.id, { kind: "permission_resolved", id: permissionId, decision });
  r.json({ ok: true });
});
app.post("/api/sessions/:id/question", (q, r) => {
  const { questionId } = q.body as { questionId: string };
  pushEvent(q.params.id, { kind: "question_resolved", id: questionId, answered: true });
  r.json({ ok: true });
});
app.post("/api/sessions/:id/plan", (q, r) => {
  const { planId, decision } = q.body as { planId: string; decision: "approve" | "revise" | "cancel" };
  pushEvent(q.params.id, { kind: "plan_resolved", id: planId, decision });
  r.json({ ok: true });
});
app.post("/api/sessions/:id/workspace/apply", (_q, r) => r.json({ ok: true }));
app.post("/api/sessions/:id/workspace/discard", (_q, r) => r.json({ ok: true }));

const presenceClients = new Set<{ write: (chunk: string) => void }>();
app.get("/api/presence/stream", (q, r) => {
  r.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const channels = SESSIONS.map((s, i) => ({ ...presenceOf(s, i), id: `dm:${s.id}` }));
  const sessions = SESSIONS.map((s, i) => presenceOf(s, i));
  r.write(
    `event: snapshot\ndata: ${JSON.stringify({
      contractVersion: FIXTURE_CONTRACT_VERSION,
      channels,
      sessions,
    })}\n\n`,
  );
  const client = { write: (chunk: string) => { r.write(chunk); } };
  presenceClients.add(client);
  q.on("close", () => presenceClients.delete(client));
});
app.post("/api/debug/presence", (q, r) => {
  const body = q.body as { id?: string; attention?: FixtureSession["attention"]; attentionKind?: string; attentionPreview?: string };
  const rawId = String(body.id || "");
  const sid = rawId.startsWith("dm:") ? rawId.slice(3) : rawId;
  const s = find(sid);
  if (!s || !body.attention) return r.status(404).json({ error: "unknown session" });
  s.attention = body.attention;
  s.attentionKind = body.attentionKind;
  s.attentionPreview = body.attentionPreview;
  const i = SESSIONS.indexOf(s);
  const row = { ...presenceOf(s, i), id: `dm:${s.id}` };
  const payload = `data: ${JSON.stringify(row)}\n\n`;
  for (const c of presenceClients) c.write(payload);
  r.json({ ok: true });
});

app.get("/api/sessions/:id/stream", (q, r) => {
  const s = find(q.params.id);
  r.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  for (const ev of s?.events ?? []) r.write(`data: ${JSON.stringify(ev)}\n\n`);
  r.write(`event: caught_up\ndata: ${JSON.stringify({ contractVersion: FIXTURE_CONTRACT_VERSION })}\n\n`);
  // 안 본 done을 열면 손길에서 빠지게 — lastViewedAt 갱신 + attention idle.
  if (s && s.attention === "done") {
    s.attention = "idle";
    s.attentionKind = undefined;
    s.attentionPreview = undefined;
    const i = SESSIONS.indexOf(s);
    const row = {
      ...presenceOf(s, i),
      id: `dm:${s.id}`,
      lastViewedAt: Date.now(),
    };
    const payload = `data: ${JSON.stringify(row)}\n\n`;
    for (const c of presenceClients) c.write(payload);
  }
  // 연결은 열어두되 **주기 타이머를 걸지 않는다**. 하트비트가 있으면 헤드리스 브라우저의 가상 시간이
  //   끝없이 흘러 스크린샷이 영영 안 찍힌다(실제로 그렇게 한 번 막혔다). 프론트는 연결이 열려 있는 동안
  //   재연결 마스크를 띄우지 않으므로 하트비트 없이도 화면은 정상이다.
  const set = openStreams.get(q.params.id) ?? new Set();
  set.add(r);
  openStreams.set(q.params.id, set);
  q.on("close", () => set.delete(r));
});

app.use(express.static(DIST));
app.get(/.*/, (_q, r) => r.sendFile(path.join(DIST, "index.html")));

const port = Number(process.argv[2] || 8899);
const fixtureServer = app.listen(port, "127.0.0.1", () => {
  console.log(`fixture 서버: http://127.0.0.1:${port}/  (세션 ${SESSIONS.map((s) => s.id).join(", ")})`);
  if (process.env.AETHER_FIXTURE_AUTH_MODE && FIXTURE_AUTH_MODE !== "device") {
    console.log(`fixture 재인증 모드: ${FIXTURE_AUTH_MODE}`);
  }
  if (FIXTURE_SESSIONS_BLOCKED) console.log("fixture 세션 목록: 403");
});
fixtureServer.ref();
