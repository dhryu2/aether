/**
 * Claude Agent SDK를 실제로 쓰는 순간에만 불러오는 얇은 통로.
 *
 * SDK를 파일 맨 위에서 값으로 가져오면 서버 부팅 때 무조건 로드되어, 모듈이 없거나 깨진 PC에서는
 * Claude를 쓰지 않아도 서버가 뜨지 못한다. 그래서 SDK 값은 이 파일의 동적 import로만 얻는다.
 * 타입은 실행 때 지워지는 `import type`이라 어디서 가져와도 된다.
 */
import type * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { FailureTracker } from "../failureTracking";
import { st } from "../../i18n";

export type ClaudeSdkModule = typeof ClaudeSdk;

const failures = new FailureTracker();
let loading: Promise<ClaudeSdkModule> | undefined;

/** SDK를 불러온다. 성공하면 같은 promise를 재사용하고, 실패하면 다음 호출이 다시 시도하도록 비운다. */
export function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  loading ??= import("@anthropic-ai/claude-agent-sdk").then(
    (mod) => {
      failures.clear("claude.sdk.load");
      return mod;
    },
    (cause) => {
      loading = undefined;
      // 실패가 반복돼도 오류 기록은 연속 첫 건만 남긴다.
      failures.report(cause, { component: "provider", operation: "claude.sdk.load", severity: "warning" });
      throw new Error(st("notice.claude.sdkUnavailable"), { cause });
    },
  );
  return loading;
}

/** SDK를 불러올 수 있는가. 가용성 확인용이라 예외를 던지지 않는다. */
export async function claudeSdkLoadable(): Promise<boolean> {
  try {
    await loadClaudeSdk();
    return true;
  } catch {
    return false;
  }
}
