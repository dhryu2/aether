/**
 * 작업 폴더 파일 라우트(인증 게이트 뒤, 읽기 전용).
 *   GET /api/files/:id                 작업 폴더의 파일 목록(상대 경로)
 *   GET /api/files/:id/content?path=   파일 하나의 내용(앞부분 상한까지)
 * 기준 폴더는 세션 목록의 cwd다(격리 복사본을 쓰는 세션은 그 복사본). 경로는 폴더 밖·비밀 파일을 모두 거른다.
 */
import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import type { WorkspaceFileResponse, WorkspaceFilesResponse } from "../../shared/http";
import { st } from "../i18n";
import { reportResponseError, rejectRequest } from "../observability/http";
import { folderFileListAsync } from "../sessions/isolatedWorkspace";
import { readBefore } from "../sessions/mutationPreview";
import { isSensitivePath, resolveFileUnderCwd } from "../sessions/safePath";
import { isSecretPath } from "../sessions/secretPaths";
import { sessionManager } from "../sessions/SessionManager";
import { isSecretTarget } from "../sessions/workspaceFiles";
import { isHiddenName } from "./fsPlaces";

export const filesRouter = Router();

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILES = 20000;
const MAX_DIRS = 2000;
const SKIP = new Set([".env", ".git", "node_modules"]); // routes/fs.ts의 DENY와 같은 집합

/** git 저장소가 아닌 폴더를 너비 우선으로 훑는다. 숨은 이름·SKIP·링크는 건너뛰고, 폴더는 MAX_DIRS개까지만 연다. */
export async function walkFiles(root: string, max: number): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue = [""];
  let opened = 0;
  let truncated = false;
  while (queue.length) {
    if (opened >= MAX_DIRS) { truncated = true; break; }
    const dir = queue.shift() as string;
    opened++;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue; // 읽을 수 없는 폴더는 목록에서 빠질 뿐이다
    }
    for (const e of entries) {
      if (isHiddenName(e.name) || SKIP.has(e.name.toLowerCase()) || e.isSymbolicLink()) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (isSensitivePath(path.join(root, rel))) continue; // 홈의 보호 폴더는 열지 않는다(맥 권한 창도 띄우지 않는다)
      if (e.isDirectory()) queue.push(rel);
      else if (e.isFile()) {
        if (files.length >= max) return { files, truncated: true };
        files.push(rel);
      }
    }
  }
  return { files, truncated };
}

function sessionCwd(req: Request, res: Response): string | null {
  const id = String(req.params.id);
  const item = SESSION_ID_RE.test(id) ? sessionManager.list().find((s) => s.id === id) : undefined;
  if (!item) {
    rejectRequest(res, 404, { error: st("routes.common.sessionNotFound") });
    return null;
  }
  return item.cwd;
}

filesRouter.get("/:id", async (req: Request, res: Response) => {
  const cwd = sessionCwd(req, res);
  if (cwd === null) return;
  try {
    const listed = await folderFileListAsync(cwd);
    const found = listed ? { files: listed, truncated: false } : await walkFiles(cwd, MAX_FILES + 1);
    const depth = (f: string) => f.split("/").length;
    const sorted = found.files
      .filter((f) => !isSecretPath(f))
      .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
    const body: WorkspaceFilesResponse = { files: sorted.slice(0, MAX_FILES), truncated: found.truncated || sorted.length > MAX_FILES };
    res.json(body);
  } catch (error) {
    void reportResponseError(res, error, { component: "routes", operation: "files.list", session_id: String(req.params.id) });
    res.status(500).json({ error: st("routes.files.readFailed") });
  }
});

filesRouter.get("/:id/content", (req: Request, res: Response) => {
  const cwd = sessionCwd(req, res);
  if (cwd === null) return;
  const want = req.query.path;
  if (typeof want !== "string" || !want) return rejectRequest(res, 400, { error: st("routes.files.pathInvalid") });
  const redacted = () => {
    const body: WorkspaceFileResponse = { path: want, redacted: true };
    res.json(body);
  };
  try {
    if (isSecretTarget(cwd, want)) return redacted();
    let resolved: ReturnType<typeof resolveFileUnderCwd>;
    try {
      resolved = resolveFileUnderCwd(fs.realpathSync(cwd), want);
    } catch {
      return rejectRequest(res, 400, { error: st("routes.files.pathInvalid") }); // 폴더 밖·끊긴 링크·접근 불가
    }
    if (resolved.isNew) return rejectRequest(res, 404, { error: st("routes.files.notFound") });
    if (fs.statSync(resolved.real).isDirectory()) return rejectRequest(res, 400, { error: st("routes.files.notFile") });
    // 링크를 푼 실제 경로로 한 번 더 본다. 작업 폴더가 홈이면 폴더 고르기가 막는 보호 폴더(~/Library 등)도 가린다.
    if (isSecretTarget(cwd, resolved.real) || isSensitivePath(resolved.real)) return redacted();
    const r = readBefore(resolved.real);
    const body: WorkspaceFileResponse = r.binary
      ? { path: want, binary: true, totalBytes: r.totalBytes }
      : { path: want, text: r.before ?? "", truncated: r.truncated, totalBytes: r.totalBytes };
    res.json(body);
  } catch (error) {
    void reportResponseError(res, error, { component: "routes", operation: "files.content", session_id: String(req.params.id) });
    res.status(500).json({ error: st("routes.files.readFailed") });
  }
});
