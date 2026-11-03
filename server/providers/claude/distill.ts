import { createClaudeTurnFailureTracker } from "./turnFailure";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClassifiedError } from "../../../shared/errors";
import { modelSelectionError } from "./errorOrigin";
import { classifyServiceError } from './errorOrigin';
import { classifyError } from '../../observability/event';
/**
 * Claude distill — 백그라운드 경량 모델 1회 실행기(검색 요약 등 배경 작업 공용 엔진).
 *
 * 경량 보조 query를 띄워 프롬프트를 넘기고, 한 턴의 최종 답 한 벌만 반환한다. result 글이 있으면 그것만 쓰고, 없거나 공백만 있으면 그 턴의 assistant 글을 쓴다.
 * 유저 세션을 오염시키지 않는 별도 query다. 쓸 모델은 `providers/distillModel`이 정한다(손으로 적어 두지 않는다).
 * 보안 불변식: 모든 툴 차단(deny-all) — bypassPermissions로 cwd에서 무허가 실행되는 것 방지.
 *
 * ⚠️ 이 파일은 Claude provider 구현이다(8d에서 `server/memory/distill.ts`에서 이관 — 내용 동등).
 *   호출측은 `ProviderServices.distill`로만 접근한다(D6: 직접 import는 provider 결합 = 조용한 fallback 통로).
 *
 * ## 왜 모델을 옵션으로 넘기지 않고, 띄운 뒤 setModel로 정하나
 *
 * 실측(2026-07-29): 없는 모델 이름으로 띄워도 CLI는 죽지 않고 **그 이름을 자기 모델 목록에 넣어서
 * 돌려준다**. `--model sol5.6`으로 띄우면 목록이 6개가 되고 6번째가 `sol5.6`이다. 그래서 "쓰려는
 * 이름으로 띄운 다음 목록에 있나 확인한다"로는 잘못된 이름을 절대 못 잡는다 — 자기가 넣은 값을 자기가
 * 확인하는 꼴이다.
 *
 * 반면 **모델을 주지 않고 띄운 뒤 `setModel(이름)`을 부르면 정확히 걸러진다.** 없는 이름만
 * `Model "..." is not a recognized model id.`로 거부되고, 별칭·정식 id·`[1m]` 변형은 전부 통과한다.
 * 판정에 1~3ms가 들고 턴을 소비하지 않는다. 그리고 턴 전에 부른 setModel은 첫 턴부터 적용된다.
 * 그래서 이 순서로 간다.
 *
 *   ① model 없이 띄운다 → ② supportedModels()로 깨끗한 목록 + 핸드셰이크 → ③ 쓸 이름 결정
 *   → ④ setModel으로 검증 → ⑤ 프롬프트 투입
 *
 * 목록 조회와 검증이 둘 다 턴을 안 쓰므로(토큰 0), 배경 작업 1회가 띄우는 프로세스는 여전히 하나다.
 *
 * ## 옵션 세 형태(배경 작업 모델 측정 계획 4절·8절)
 *
 *   - 옵션 없음: ③에서 지금의 자동 선택(`resolveAndApply`)을 탄다.
 *   - 계정 기본: ③④를 건너뛴다(`setModel`을 부르지 않는다). 가격 순서 질문 전용이다.
 *   - 명시: ④에서 그 이름만 `setModel`한다. 거부되면 다른 모델로 넘어가지 않고 `UnknownModelNameError`를 던진다.
 *     effort가 있으면 그다음 `applyFlagSettings({ effortLevel })`로 맞춘다. 첫 턴 전에 부르면 첫 요청부터
 *     적용된다(2026-10-15 실측 — 중계 서버로 본 첫 요청의 `output_config.effort`가 low·max 모두 그대로였다).
 */
import os from "node:os";
import { resolveClaudeBin } from "../../auth/claudeLogin";
import { config } from "../../config";
import { pick } from "../../i18n";
import { resolveAndApply } from "../distillModel";
import { modelEnv } from "../modelEnv";
import type { DistillOptions, RuntimeModel } from "../types";
import { claudeModelTraits } from "./modelTraits";
import { loadClaudeSdk } from "./sdk";
import { readTurns, TurnFailedError, type TurnInspection } from "../turnReader";

/** 프롬프트를 나중에 밀어 넣기 위한 입력 큐. 이게 있어야 턴이 시작되기 전에 setModel을 끼워 넣을 수 있다. */
function inputQueue() {
  const q: unknown[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  return {
    push(text: string) {
      q.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
      wake?.();
      wake = null;
    },
    close() {
      done = true;
      wake?.();
      wake = null;
    },
    async *stream(): AsyncGenerator<unknown> {
      while (true) {
        while (q.length) yield q.shift();
        if (done) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

/** 띄운 보조 query에서 이 파일이 쓰는 만큼. 시험이 가짜로 바꿔 끼운다. */
type ToollessQuery = AsyncIterable<unknown> & {
  supportedModels(): Promise<Array<{ value: string; displayName: string; description: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: string[] }>>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: unknown }): Promise<void>;
  interrupt(): Promise<unknown>;
  close?: () => unknown;
};
type Spawned = { input: ReturnType<typeof inputQueue>; qh: ToollessQuery };

/** 도구를 전부 막은 보조 query 하나. 모델은 아직 정하지 않은 채로 띄운다(위 주석 참고). */
async function spawnToolless(cwd: string): Promise<Spawned> {
  const { query } = await loadClaudeSdk();
  const input = inputQueue();
  const qh = query({
    prompt: input.stream() as never,
    options: {
      cwd,
      // 이 허브의 비밀 변수를 모델 프로세스에 넘기지 않는다(R21). 도구를 전부 막아 뒀지만, 그 방어가
      //   뚫렸을 때 볼 것이 남아 있으면 안 된다. 이 옵션은 환경을 **대체**하므로 modelEnv가 나머지를 복사한다.
      env: modelEnv(),
      // 대화 세션과 같은 설치본 CLI를 띄운다(`sessions/runtimes/claude.ts`와 같은 이유). SDK에 딸린 CLI는
      //   버전이 낡아 별칭이 옛 모델로 풀린다 — 실측(2026-10-15): 딸린 CLI는 haiku→Haiku 4.5, 설치본은 Haiku 5.5.
      pathToClaudeCodeExecutable: resolveClaudeBin(),
      // 보조 모델은 호스트/프로젝트 설정과 도구를 전혀 읽지 않는다. canUseTool만 두면
      // SDK의 안전 도구 선승인이나 호스트 allowlist가 이 콜백 앞에서 통과할 수 있다.
      settingSources: [],
      tools: [],
      persistSession: false,
      canUseTool: async () => ({ behavior: "deny", message: pick({ ko: "distill 패스에선 도구 사용 금지", en: "tool use is forbidden in the distill pass" }) }),
    },
  });
  return { input, qh: qh as unknown as ToollessQuery };
}

let spawnImpl: (cwd: string) => Spawned | Promise<Spawned> = spawnToolless;
/** 시험 전용 — 보조 query를 가짜로 바꾼다. null이면 원래대로. */
export function setClaudeDistillSpawnForTest(fn: ((cwd: string, input: ReturnType<typeof inputQueue>) => ToollessQuery) | null): void {
  spawnImpl = fn
    ? (cwd) => {
        const input = inputQueue();
        return { input, qh: fn(cwd, input) };
      }
    : spawnToolless;
}

/**
 * 한 턴의 최종 글만 고르는 검사 함수를 만든다. 시험이 가짜 메시지 흐름에 붙여 부른다.
 *
 * assistant 글은 여기에 모아 두고 아직 내보내지 않는다. 턴을 나누는 장치는 돌려준 text를
 * 버퍼에 이어 붙이기만 하므로, assistant 글과 result 글을 둘 다 내면 같은 답이 두 번이 된다.
 * result 글이 있으면 그것만 낸다. 그 글이 문자열이 아니거나 공백만 있으면 모아 둔 assistant 글을 낸다.
 * result를 볼 때마다 모은 글을 비운다. 모델 고르기 턴과 본 턴이 한 프로세스에서 이어질 수 있다.
 * result에 `is_error`가 참이면 그 턴은 실패다. 그 글을 답으로 내지 않고 오류로 낸다.
 *   실측(2026-10-16): 크레딧이 바닥난 모델은 답 대신 "You're out of usage credits. …"를 result 글로 주고 `is_error`를 참으로 둔다.
 */
type ClaudeMessageInspector = ((msg: unknown) => TurnInspection) & { failure?: Error & ClassifiedError };
export function createClaudeMessageInspector(): ClaudeMessageInspector {
  let assistant = "";
  const turnFailure = createClaudeTurnFailureTracker();
  const inspect: ClaudeMessageInspector = (msg: unknown): TurnInspection => {
    const m = msg as { type?: string; message?: { content?: unknown }; result?: unknown; is_error?: unknown };
    if (m.type !== "result") turnFailure(msg as SDKMessage);
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content as Array<Record<string, unknown>>) {
        if (b.type === "text" && typeof b.text === "string") assistant += b.text;
      }
      return {};
    }
    if (m.type === "result") {
      const text = typeof m.result === "string" && m.result.trim() !== "" ? m.result : assistant;
      assistant = "";
      // 기존 표시·턴 읽기 계약은 유지하고, 원인만 어댑터의 catch까지 함께 보관한다.
      inspect.failure = turnFailure({ subtype: "success", ...m, result: text } as SDKMessage) ?? undefined;
      if (m.is_error === true) return { turnEnded: true, error: text.trim().slice(0, 300) || "Claude가 오류로 턴을 끝냈다" };
      return { text, turnEnded: true };
    }
    return {};
  };
  return inspect;
}

/**
 * 정리 — 입력을 닫고 프로세스를 확실히 내린다. 여기서 안 내리면 배경 작업이 돌 때마다 프로세스가 쌓인다.
 *
 * `close()`는 정리를 시작만 하고 곧바로 반환한다(약속을 안 돌려준다). 그러니 이 `await`는 정리가 끝날
 * 때까지 기다리는 게 아니다. 다만 `close()`가 입력 스트림을 그 자리에서 닫으므로 소비 루프는 곧 끝난다.
 * 정리가 실제로 끝났는지는 호출자가 `reader.done`으로 확인한다.
 */
async function cleanup(input: { close(): void }, qh: { interrupt(): Promise<unknown>; close?: () => unknown }) {
  input.close();
  try { await qh.close?.(); } catch { /* 이미 죽음 */ }
  await qh.interrupt().catch(() => { /* 이미 종료된 질의의 중단 거절은 정리 중 허용한다. */ });
}

/** 프롬프트 1회 distill → 한 턴의 최종 답 한 벌 반환. 툴은 전부 deny. */
export async function runDistill(prompt: string, cwd: string, opts?: DistillOptions): Promise<string> {
  const { input, qh } = await spawnImpl(cwd);
  // 행(hang) 방지: distill이 무한히 매달리면 호출자(LiveSession)의 distilling 플래그가 영원히 true → 그 세션의 자동 캡처 전체가 죽는다.
  //   상한은 핸드셰이크·모델 결정·본 작업 전체에 하나로 건다 — 앞 단계에서 매달려도 똑같이 잠기기 때문이다.
  //   ★ interrupt()만으로는 부족하다. interrupt() 자체가 응답을 기다리는 제어 요청이라, CLI가 멈춰 있으면
  //   그것마저 같이 매달린다. 그러면 목록 받기(supportedModels)나 이름 맞추기(setModel)에서 멈춘 경우를
  //   못 깨운다. close()는 기다리는 제어 요청을 전부 실패시키므로 반드시 같이 부른다.
  //   상한이 한 번만 울리는 것도 close()가 해결한다 — 프로세스가 내려가면 뒤따르는 턴은 곧바로 빈 응답이 된다.
  let timedOut = false;
  const timer = setTimeout(() => {
    console.error(`[aether] 배경 작업이 ${config.distillTimeoutMs}ms를 넘겨 중단한다`);
    timedOut = true;
    void qh.interrupt().catch(() => { /* 시간 제한으로 닫는 질의가 이미 종료된 경우를 허용한다. */ });
    try { qh.close?.(); } catch { /* 이미 죽음 */ }
  }, config.distillTimeoutMs);
  timer.unref?.();
  const inspector = createClaudeMessageInspector();
  const reader = readTurns(qh, inspector);
  // 모델 선택 질문에서 잡히는 실패도 호출처에 도달하기 전에 중립 원인을 붙인다.
  const nextTurn = () => reader.nextTurn().catch((error: unknown) => {
    if (error instanceof TurnFailedError && inspector.failure) {
      error.cause = inspector.failure;
      const origin = inspector.failure.errorOrigin;
      if (origin) classifyError(error, origin);
    }
    throw error;
  });
  try {
    // ② 깨끗한 목록 + 핸드셰이크 완료(턴 미소비). 
    const models = await qh.supportedModels();
    // ③④ 쓸 모델 결정 + 적용. 서비스 고유 거절은 중립 원인으로 바꾼다.
    const setModel = async (model: string) => {
      try { await qh.setModel(model); } catch (error) { throw modelSelectionError(error, model); }
    };
    if (opts?.use === "explicit") {
      await setModel(opts.model);
      if (opts.effort) await qh.applyFlagSettings({ effortLevel: opts.effort });
    } else if (opts?.use !== "account_default") {
      // 순서·재시도 규칙은 provider 중립 모듈에 있다. 고르기 질문은 같은 프로세스에서 모델 미지정(= 계정 기본)으로 나간다.
      const ask = async (p: string) => {
        const turn = nextTurn(); // 보내기 전에 기다리기 시작한다(응답을 놓치지 않게)
        input.push(p);
        return turn;
      };
      // askAs: 기본 모델이 답하지 못할 때 후보 줄에 직접 묻는 길 — 이름을 맞춘 뒤 같은 질문 경로를 쓴다.
      let switched = false;
      const picked = await resolveAndApply("claude", models, setModel, ask, async (model, p) => {
        switched = true;
        await setModel(model);
        return ask(p);
      });
      // 후보에 묻느라 프로세스의 모델을 바꿨는데 끝내 못 골랐다면, 본 작업이 마지막 후보로 돌지 않게 계정 기본으로 되돌린다.
      if (switched && !picked) {
        const def = models.find((m) => m.value.trim().toLowerCase() === "default")?.value ?? "default";
        await setModel(def).catch((e: unknown) => { console.error("[aether] 배경 작업 — 계정 기본 모델로 되돌리지 못했다:", e); });
      }
    }
    // ⑤ 본 작업. 앞 단계에서 턴 종료 신호가 두 번 왔을 수 있으므로(중단 결과 + 본 결과) 찌꺼기를 먼저 버린다.
    //    안 버리면 그 찌꺼기가 본 작업의 답인 양 즉시 반환된다. 그러면 호출자는 빈 수확을 정상 완료로
    //    받아들이고, 그 대화 구간을 영영 다시 안 본다(기억 하나가 통째로 유실된다).
    //    한계: 버리는 시점에 아직 파이프를 타고 오는 중인 찌꺼기는 못 버린다. 다만 찌꺼기가 생기는
    //    유일한 경로가 "시간 제한으로 중단시켰을 때"이고, 그때는 프로세스를 함께 내리므로 뒤이은 턴은
    //    어차피 빈 응답이 된다. 실제로 걸릴 창이 매우 좁아 여기까지만 막는다.
    const stale = reader.drain();
    if (stale) console.error(`[aether] 배경 작업 — 앞 단계의 남은 응답 ${stale}건을 버린다`);
    const turn = nextTurn();
    input.push(prompt);
    return await turn;
  } catch (e) {
    if (e instanceof Error) throw timedOut ? classifyError(e, 'external_environment') : classifyServiceError(e);
    throw e;
  } finally {
    clearTimeout(timer);
    await cleanup(input, qh);
    await reader.done; // 소비 루프가 끝난 뒤에 나간다(프로세스가 뒤에 남지 않게)
  }
}

/** SDK 목록을 중립 줄로 옮긴다(중립 필드 포함). */
function toRows(models: Awaited<ReturnType<ToollessQuery["supportedModels"]>>): RuntimeModel[] {
  return models.map((m) => ({
    value: m.value,
    displayName: m.displayName,
    description: m.description,
    resolvedModel: m.resolvedModel,
    supportsEffort: m.supportsEffort,
    supportedEffortLevels: m.supportedEffortLevels,
    ...claudeModelTraits(m),
  }));
}

/**
 * 턴을 쓰지 않는 모델 목록 조회 — 배경 작업 측정용. 중립 필드를 채워 돌려준다.
 * 배경 작업과 같은 설치본 CLI를 띄우므로 실제로 쓸 별칭 대응이 그대로 나온다.
 */
export async function listClaudeBackgroundModels(): Promise<RuntimeModel[]> {
  // 프롬프트를 보내지 않으므로 어느 폴더든 같다. 사용자 폴더를 열지 않으려고 임시 폴더에서 띄운다.
  const { input, qh } = await spawnImpl(os.tmpdir());
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void qh.interrupt().catch(() => { /* 취소한 질의가 이미 종료된 경우를 허용한다. */ });
    try { qh.close?.(); } catch { /* 이미 죽음 */ }
  }, config.distillTimeoutMs);
  timer.unref?.();
  const reader = readTurns(qh, createClaudeMessageInspector());
  try {
    return toRows(await qh.supportedModels());
  } catch (e) {
    if (e instanceof Error) throw timedOut ? classifyError(e, 'external_environment') : classifyServiceError(e);
    throw e;
  } finally {
    clearTimeout(timer);
    await cleanup(input, qh);
    await reader.done;
  }
}
