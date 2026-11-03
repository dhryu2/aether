import { reportError } from "../observability/report";
/**
 * 인증 조회 전용 codex 프로세스 (Phase 8f · D9) — 대화 스레드를 하나도 만들지 않는다.
 *
 * ## 왜 따로 필요한가
 *
 * 인증 상태 조회는 **대화 세션이 하나도 없을 때도** 불린다. 설정 화면을 열기만 해도, 재로그인을 시작할
 * 때도 그렇다. 그런데 Codex는 세션마다 프로세스를 하나씩 띄우는 구조라(D4), 세션이 없으면 물어볼 상대가
 * 아예 없다. 그래서 계정 조회와 로그인만 맡는 가벼운 프로세스를 따로 둔다.
 *
 * ## 대화 세션과 무엇이 다른가
 *
 * 이 프로세스는 `thread/start`를 부르지 않는다. 그래서 대화도, 턴도, 승인도 모른다. 반대로 대화 세션의
 * 프로세스는 이 프로세스를 쓰지 않는다 — 둘은 서로의 존재를 모르고, 한쪽이 죽어도 다른 쪽은 멀쩡하다.
 * 승인·질문 같은 역방향 요청이 여기로 오면 **오류로 답한다**. 스레드가 없는데 그런 요청이 온다는 것은
 * 우리가 모르는 일이 벌어졌다는 뜻이고, 빈 성공으로 넘기면 그 사실이 아무 데도 안 남는다.
 *
 * ## 수명
 *
 *   - **뜨는 때**: 첫 요청이 들어올 때. 미리 띄우지 않는다.
 *   - **내려가는 때**: 마지막 요청 이후 `codexControlIdleMs` 동안 아무 요청이 없을 때.
 *     단 **붙잡아 둔 것(hold)이 하나라도 있으면 안 내려간다** — 로그인이 진행 중인데 프로세스를 내리면
 *     그 로그인이 통째로 끊어진다.
 *   - **죽었을 때**: 다음 요청에서 다시 뜬다. 죽었다는 사실은 `onControlExit`로 알린다 — 진행 중이던
 *     로그인을 정직하게 실패로 마감하라는 신호다(조용히 성공한 척하지 않는다 — §0.1-4).
 *   - **서버 종료**: `disposeControl()`. `ProviderAuth.disposeAll`이 부른다.
 *
 * 알림 수신자와 종료 수신자는 **프로세스가 아니라 이 모듈에** 등록된다. 그래야 프로세스가 죽고 다시 떠도
 * 수신자를 다시 붙일 필요가 없다.
 */
import { config } from "../config";
import { modelEnv } from "../providers/modelEnv";
import { CLIENT_INFO, CodexAppServer, type CodexExitInfo, type CodexNotification } from "./appServer";

type NotificationListener = (n: CodexNotification) => void;
type ExitListener = (info: CodexExitInfo) => void;

const listeners = new Set<NotificationListener>();
const exitListeners = new Set<ExitListener>();

let server: CodexAppServer | null = null;
let booting: Promise<CodexAppServer> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** 지금 프로세스를 붙잡고 있는 것의 수(진행 중인 로그인). 0보다 크면 놀고 있어도 안 내려간다. */
let holds = 0;
/**
 * 지금 답을 기다리는 요청 수.
 *
 * 붙잡은 것(holds)만 세면 **동시에 도는 요청 하나가 다른 요청을 죽인다**: 먼저 끝난 요청이 "이제 논다"고
 * 판단해 내려갈 시각을 잡고, 아직 답을 기다리던 요청이 그 시각을 넘기면 프로세스가 밑에서 사라진다.
 * (2026-08-18 외부 검토 지적.)
 */
let inFlight = 0;
/**
 * 종료 세대. `disposeControl()`마다 하나 오른다.
 *
 * 프로세스가 뜨는 중(초기화 대기)에 서버가 내려가면 `server`가 아직 null이라 닫을 대상을 못 찾는다.
 * 그 사이 초기화가 끝나면 아무도 안 보는 프로세스가 그대로 살아남는다. 세대를 비교해 그 경우를 잡는다.
 */
let epoch = 0;

function clearIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

/** 지금 정말 노는 중인가 — 붙잡은 것도 없고 답을 기다리는 요청도 없다. */
function idle(): boolean {
  return holds === 0 && inFlight === 0;
}

/** 놀기 시작했다 — 프로세스가 살아 있고 아무도 안 쓰면 내려갈 시각을 잡는다. */
function armIdle() {
  clearIdle();
  if (!idle() || !server) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!idle() || !server) return;
    const s = server;
    server = null; // 먼저 떼어 놓는다 — 그래야 이 종료가 "지금 쓰는 프로세스의 크래시"로 오해되지 않는다
    void s.close();
  }, config.codexControlIdleMs);
  idleTimer.unref?.();
}

async function ensure(): Promise<CodexAppServer> {
  if (server?.alive) return server;
  if (booting) return booting;
  const myEpoch = epoch;
  booting = (async () => {
    const s = new CodexAppServer({
      // 이 프로세스는 스레드가 없어 도구를 못 쓰지만, 세션 프로세스와 같은 규율을 건다(R21).
      env: modelEnv(),
      onNotification: (n) => {
        for (const l of [...listeners]) {
          try {
            l(n);
          } catch (e) {
            void reportError(e, { component: "provider", operation: "provider.auth.notify" });
            console.error("[aether] codex 인증 알림 처리 실패:", e);
          }
        }
      },
      // 스레드가 없으니 승인·질문이 올 리 없다. 오면 우리가 모르는 상황이므로 오류로 답한다.
      onServerRequest: async (r) => {
        throw new Error(`인증 전용 codex 프로세스는 역방향 요청을 받지 않는다(${r.method})`);
      },
      onExit: (info) => {
        // ★ **지금 쓰고 있는 프로세스가 죽었을 때만** 알린다.
        //   우리가 일부러 내린 프로세스(놀아서·종료 절차)는 내리기 전에 `server`에서 떼어 놓는다. 그 뒤늦은
        //   종료 소식을 그대로 방송하면, 이미 새로 뜬 프로세스에서 진행 중인 로그인이 "프로세스가 죽었다"고
        //   잘못 마감된다(2026-08-18 외부 검토 지적).
        if (server !== s) return;
        server = null;
        for (const l of [...exitListeners]) {
          try {
            l(info);
          } catch (e) {
            void reportError(e, { component: "provider", operation: "provider.auth.exit" });
            console.error("[aether] codex 인증 프로세스 종료 처리 실패:", e);
          }
        }
      },
    });
    try {
      await s.initialize(CLIENT_INFO);
    } catch (e) {
      // 악수에 실패하면 프로세스를 남기지 않는다 — 안 그러면 요청할 때마다 좀비가 하나씩 쌓인다.
      void s.close();
      throw e;
    }
    // 뜨는 사이에 서버가 내려갔으면(종료 세대가 바뀌었으면) 이 프로세스는 아무도 안 쓴다 — 여기서 닫는다.
    if (epoch !== myEpoch) {
      void s.close();
      throw new Error("인증 전용 codex 프로세스가 종료 중이라 요청을 취소했다");
    }
    server = s;
    return s;
  })();
  try {
    return await booting;
  } finally {
    booting = null;
  }
}

/** 요청 1건. 필요하면 프로세스를 띄우고, 끝나면 다시 놀기 시작한 것으로 친다. */
export async function controlRequest<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
  inFlight++;
  clearIdle(); // 요청이 도는 중에 내려가지 않게
  try {
    const s = await ensure();
    return await s.request<T>(method, params, timeoutMs);
  } finally {
    inFlight--;
    armIdle();
  }
}

/** 알림 수신 등록. 반환 함수로 해제한다. */
export function onControlNotification(cb: NotificationListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 프로세스가 끝났다는 통보 등록. 진행 중이던 일을 실패로 마감하라는 신호다. */
export function onControlExit(cb: ExitListener): () => void {
  exitListeners.add(cb);
  return () => exitListeners.delete(cb);
}

/**
 * 프로세스를 붙잡는다 — 놀고 있어도 안 내려가게. 반환 함수로 놓는다(여러 번 불러도 한 번만 센다).
 * 로그인처럼 "요청과 요청 사이에 상대가 살아 있어야 하는" 일이 이걸 쓴다.
 */
export function holdControl(): () => void {
  holds++;
  clearIdle();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    armIdle();
  };
}

/** 지금 프로세스가 떠 있는가 — 수명 검증용(테스트가 본다). */
export function controlAlive(): boolean {
  return !!server?.alive;
}

/**
 * 서버 종료 시 정리. 멱등이다.
 * 세대를 올리므로 **지금 뜨는 중인 프로세스도** 초기화가 끝나는 자리에서 스스로 닫힌다.
 */
export function disposeControl(): void {
  epoch++;
  holds = 0;
  clearIdle();
  const s = server;
  server = null;
  void s?.close();
}
