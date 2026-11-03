/** 반복 호출의 연속 실패는 대상별 첫 건만 남긴다. 성공하거나 파일이 바뀌면 다시 기록한다. */
import fs from "node:fs";
import { isExpectedError, type ErrorDetails } from "../observability/event";
import { reportError } from "../observability/report";

export class FailureTracker {
  private failed = new Map<string, string>();

  report(error: unknown, details: ErrorDetails, key = details.operation, revision = ""): void {
    if (isExpectedError(error) || this.failed.get(key) === revision) return;
    this.failed.set(key, revision);
    void reportError(error, details);
  }

  clear(key: string): void { this.failed.delete(key); }

  file(error: unknown, details: ErrorDetails, file: string): void {
    // 선택적 파일 부재와 읽는 중 삭제된 파일은 정상 부재다.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") { this.recoveredFile(file); return; }
    this.report(error, details, `${details.operation}\0${file}`, fileRevision(file));
  }

  recoveredFile(file: string): void {
    for (const key of this.failed.keys()) if (key.endsWith(`\0${file}`)) this.failed.delete(key);
  }
}

const trackers = new WeakMap<object, FailureTracker>();
export function failuresFor(owner: object): FailureTracker {
  let tracker = trackers.get(owner);
  if (!tracker) trackers.set(owner, tracker = new FailureTracker());
  return tracker;
}

/** 읽기 실패 중에도 교체·수정은 관측한다. stat 부재는 원래 작업의 오류와 따로 수집하지 않는다. */
export function fileRevision(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    // 파일 상태를 관측할 수 없으면 같은 연속 장애로 취급한다. 실제 실패는 호출처에서 기록한다.
    return "unavailable";
  }
}
