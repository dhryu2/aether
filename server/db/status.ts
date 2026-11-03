import { FailureTracker } from "../providers/failureTracking";
/**
 * SQLite 생존 프로브. 파일을 열지 못하거나 SELECT 1이 실패하면 "down"이다.
 * 실패는 첫 건만 수집하고, 성공하면 억제를 푼다.
 */
import { database } from "./sqlite";

const failures = new FailureTracker();

export function probeDatabase(): "up" | "down" {
  try {
    database().prepare("SELECT 1").get();
    failures.clear("database.health.probe");
    return "up";
  } catch (error) {
    failures.report(error, { component: "database", operation: "database.health.probe" });
    return "down";
  }
}
