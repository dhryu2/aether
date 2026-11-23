/**
 * 다른 AI에게 검토 맡기기 — 검토 요청 글. 모델 없이 저장된 기록에서 서버가 바로 만든다.
 * provider 이름과 도구 이름을 쓰지 않는다. diff 본문은 넣지 않는다(검토 세션이 같은 폴더에서 직접 읽는다).
 */
import path from "node:path";
import { st } from "../i18n";
import type { ReviewSummary } from "../../shared/brain";
import { HANDOFF_FILES_MAX, HANDOFF_TEXT_MAX } from "./handoff";

const FAILED_MAX = 10;
const TODOS_MAX = 20;

export type ReviewRequestInput = {
  name: string;
  id: string;
  cwd: string;
  isGit: boolean;
  /** 기록이 길어 앞부분이 빠졌다. */
  partial: boolean;
  userTexts: string[];
  summary: ReviewSummary;
};

/** 폴더 안의 파일은 상대 경로로, 밖의 파일은 그대로 적는다. */
function shown(cwd: string, p: string): string {
  const rel = path.relative(cwd, path.resolve(cwd, p));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
}

export function reviewRequestText(i: ReviewRequestInput): string {
  const { changedFiles, failedCommands, openTodos } = i.summary;
  const out: string[] = [
    st("routes.reviewRequest.rules"),
    "",
    `${st("routes.reviewRequest.previous")}: ${i.name} (${i.id})`,
    `${st("routes.reviewRequest.folder")}: ${i.cwd} (${st(i.isGit ? "routes.reviewRequest.gitFolder" : "routes.reviewRequest.plainFolder")})`,
  ];
  if (i.userTexts.length) {
    out.push("", st("routes.reviewRequest.userTexts"));
    i.userTexts.forEach((t, n) => out.push(`${n + 1}. ${t}`));
  }
  if (changedFiles.length) {
    const more = changedFiles.length - HANDOFF_FILES_MAX;
    out.push("", st("routes.reviewRequest.files"), ...changedFiles.slice(0, HANDOFF_FILES_MAX).map((f) => `- ${shown(i.cwd, f.path)}`));
    if (more > 0) out.push(`- ${st("routes.reviewRequest.filesMore", { n: more })}`);
  }
  if (failedCommands.length) out.push("", st("routes.reviewRequest.failed"), ...failedCommands.slice(0, FAILED_MAX).map((c) => `- ${c.text}`));
  if (openTodos.length) out.push("", st("routes.reviewRequest.todos"), ...openTodos.slice(0, TODOS_MAX).map((t) => `- ${t.text}`));
  if (i.partial) out.push("", st("routes.reviewRequest.partial"));
  return out.join("\n").slice(0, HANDOFF_TEXT_MAX);
}
