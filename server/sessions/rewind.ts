import { FailureTracker } from "../providers/failureTracking";
import { classifyError } from "../observability/event";
import { isManagedWorkspacePath } from "./isolatedWorkspace";
/**
 * 대화 되돌리기.
 * 지운 구간은 사건 기록에서 빼지 않고, 순번 범위로 숨긴다.
 * 파일은 승인 당시에 남겨 둔 이전 내용만 되돌린다. 모델 실행기에는 손대지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import type { AetherEvent, MutationPreview, SessionMeta } from "../types";
import { readBefore } from "./mutationPreview";
import * as store from "./persistence";
import { resolveFileUnderCwd } from "./safePath";
import { isSecretPath } from "./secretPaths";

const failures = new FailureTracker();

export type HiddenRange = { after: number; until: number };

export type SkipReason = "secret" | "binary" | "truncated" | "unknown" | "outside";

export type CheckpointNote = {
  seq: number;
  path: string;
  before: string | null;
  isCreate: boolean;
  ok: boolean;
  skip?: SkipReason;
};

export class RewindError extends Error {
  constructor(readonly code: "busy" | "missing" | "tail" | "notfound") {
    super(code);
    this.name = "RewindError";
  }
}

export function parseHiddenRanges(raw: unknown): HiddenRange[] {
  if (!Array.isArray(raw)) return [];
  const out: HiddenRange[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const after = (item as { after?: unknown }).after;
    const until = (item as { until?: unknown }).until;
    if (typeof after !== "number" || typeof until !== "number") continue;
    if (!Number.isInteger(after) || !Number.isInteger(until) || until <= after) continue;
    out.push({ after, until });
  }
  return out;
}

export function sessionWasRewound(meta: Pick<SessionMeta, "rewound" | "hiddenRanges" | "reseedText"> | null | undefined): boolean {
  if (!meta) return false;
  return meta.rewound === true || (meta.hiddenRanges?.length ?? 0) > 0 || !!meta.reseedText?.trim();
}

/** 화면이 아직 서버 번호를 받기 전에 붙인 음수 순번은 숨기지 않는다. */
export function isHiddenSeq(seq: number, ranges: readonly HiddenRange[]): boolean {
  if (seq < 0) return false;
  return ranges.some((range) => seq > range.after && seq <= range.until);
}

export function checkpointFromMutation(seq: number, mutation: MutationPreview | undefined): CheckpointNote | null {
  if (!mutation?.path?.trim()) return null;
  const filePath = mutation.path;
  const isCreate = mutation.isCreate === true;
  if (mutation.redacted) return { seq, path: filePath, before: null, isCreate, ok: false, skip: "secret" };
  if (mutation.binary) return { seq, path: filePath, before: null, isCreate, ok: false, skip: "binary" };
  if (mutation.truncated) return { seq, path: filePath, before: null, isCreate, ok: false, skip: "truncated" };
  if (isCreate) return { seq, path: filePath, before: null, isCreate: true, ok: true };
  if (typeof mutation.before !== "string") {
    return { seq, path: filePath, before: null, isCreate: false, ok: false, skip: "unknown" };
  }
  return { seq, path: filePath, before: mutation.before, isCreate: false, ok: true };
}

/** 승인 순간 작업 폴더에 있는 이전 내용. 없으면 새 파일이라 되돌릴 때 지운다. */
function noteFromWorkdir(seq: number, filePath: string, cwd: string): CheckpointNote {
  const shown = filePath.trim();
  // 맥의 /var 처럼 폴더 자체가 심볼릭 링크면, 파일만 실제 경로로 풀었을 때 경계 검사가 실패한다.
  let base = cwd;
  try {
    base = fs.realpathSync(cwd);
  } catch (error) {
    if (!isManagedWorkspacePath(cwd) && ((error as NodeJS.ErrnoException)?.code === "EACCES" || (error as NodeJS.ErrnoException)?.code === "EPERM")) classifyError(error as Error, "user_action");
    failures.file(error, { component: "session", operation: "session.workspace.realpath", severity: "warning" }, cwd);
    // 폴더가 없으면 아래 경로 검사에서 실패로 남긴다.
  }
  try {
    if (isSecretPath(shown)) return { seq, path: shown, before: null, isCreate: false, ok: false, skip: "secret" };
    const { real, rel, isNew } = resolveFileUnderCwd(base, shown);
    const pathShown = rel || shown;
    if (isSecretPath(pathShown)) return { seq, path: pathShown, before: null, isCreate: isNew, ok: false, skip: "secret" };
    if (isNew) return { seq, path: pathShown, before: null, isCreate: true, ok: true };
    const read = readBefore(real);
    failures.clear(`preview:${cwd}:${shown}`);
    if (read.binary) return { seq, path: pathShown, before: null, isCreate: false, ok: false, skip: "binary" };
    if (read.truncated) return { seq, path: pathShown, before: null, isCreate: false, ok: false, skip: "truncated" };
    if (typeof read.before !== "string") return { seq, path: pathShown, before: null, isCreate: false, ok: false, skip: "unknown" };
    return { seq, path: pathShown, before: read.before, isCreate: false, ok: true };
  } catch (error) {
    failures.report(error, { component: "session", operation: "session.checkpoint.preview", severity: "warning" }, `preview:${cwd}:${shown}`);
    return { seq, path: shown, before: null, isCreate: false, ok: false, skip: "outside" };
  }
}

/**
 * 승인한 변경의 복원 기록.
 * 파일 목록이 있으면 승인 순간에 작업 폴더에서 파일마다 이전 내용을 읽는다.
 * 목록이 없고 미리보기에 이전 내용이 있으면 그 한 파일을 그대로 쓴다.
 */
export function checkpointsForApproval(seq: number, mutation: MutationPreview | undefined, cwd: string): CheckpointNote[] {
  if (!mutation) return [];
  const files = mutation.files?.filter((file) => file.path.trim()) ?? [];
  if (files.length) {
    if (mutation.redacted) {
      return files.map((file) => ({
        seq,
        path: file.path.trim(),
        before: null,
        isCreate: file.isCreate === true,
        ok: false,
        skip: "secret" as const,
      }));
    }
    return files.map((file) => noteFromWorkdir(seq, file.path, cwd));
  }
  const one = checkpointFromMutation(seq, mutation);
  return one ? [one] : [];
}

/** 범위 안에서 경로마다 가장 이른 기록만 쓴다. 그 기록이 불완전하면 그 파일은 건너뛴다. */
export function planRewind(
  notes: readonly CheckpointNote[],
  after: number,
  until: number,
): { restore: CheckpointNote[]; skipped: { path: string; reason: SkipReason }[] } {
  const earliest = new Map<string, CheckpointNote>();
  for (const note of notes) {
    if (note.seq <= after || note.seq > until) continue;
    const prev = earliest.get(note.path);
    if (!prev || note.seq < prev.seq) earliest.set(note.path, note);
  }
  const restore: CheckpointNote[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];
  for (const note of earliest.values()) {
    if (note.ok) restore.push(note);
    else skipped.push({ path: note.path, reason: note.skip ?? "unknown" });
  }
  restore.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { restore, skipped };
}

export function rewindTarget(
  events: readonly { seq: number; kind: string }[],
  seq: number,
  ranges: readonly HiddenRange[],
): { after: number; until: number } {
  const target = events.find((event) => event.seq === seq);
  if (!target || target.kind !== "user_msg" || isHiddenSeq(seq, ranges)) throw new RewindError("notfound");
  let until = seq;
  for (const event of events) {
    if (isHiddenSeq(event.seq, ranges)) continue;
    if (event.seq > until) until = event.seq;
  }
  if (until <= seq) throw new RewindError("tail");
  return { after: seq, until };
}

const RESEED_CAP = 16_000;

export function linesForReseed(
  events: readonly AetherEvent[],
  ranges: readonly HiddenRange[],
  normalize: (event: AetherEvent) => readonly { type: string; text?: string }[],
): { role: "user" | "assistant"; text: string }[] {
  const lines: { role: "user" | "assistant"; text: string }[] = [];
  for (const event of events) {
    if (isHiddenSeq(event.seq, ranges)) continue;
    if (event.kind === "user_msg" && "text" in event && typeof event.text === "string" && event.text.trim()) {
      lines.push({ role: "user", text: event.text.trim() });
      continue;
    }
    const assistant: string[] = [];
    let user = "";
    for (const piece of normalize(event)) {
      if (piece.type === "tool_result" || piece.type === "text_delta") continue;
      if (piece.type === "user_text" && piece.text?.trim()) user = piece.text.trim();
      else if (piece.type === "text" && piece.text?.trim()) assistant.push(piece.text.trim());
    }
    if (user) lines.push({ role: "user", text: user });
    else if (assistant.length) lines.push({ role: "assistant", text: assistant.join("\n") });
  }
  return lines;
}

export type RewindOutcome = {
  restored: string[];
  skipped: { path: string; reason: SkipReason }[];
  after: number;
  until: number;
  /** 숨김 범위 밖에 붙인 완료 순번. 이 순번이 보여야 되돌린 자리가 쉰 상태가 된다. */
  idleSeq?: number;
};

/** 잠든 세션. 실행기를 깨우지 않고 기록과 파일만 되돌린다. */
export function rewindDisk(
  meta: SessionMeta,
  seq: number,
  normalize: (event: AetherEvent) => readonly { type: string; text?: string }[],
): RewindOutcome {
  if (!meta.cwd) throw new RewindError("missing");
  const events = store.readEventsSince(meta.id, 0);
  const ranges = parseHiddenRanges(meta.hiddenRanges);
  const target = rewindTarget(events, seq, ranges);
  let until = target.until;
  for (const event of events) if (event.seq > until) until = event.seq;
  const plan = planRewind(loadCheckpoints(meta.id), target.after, until);
  const applied = applyRestore(meta.cwd, plan.restore);
  const hiddenRanges = [...ranges, { after: target.after, until }];
  const reseedText = buildReseed(linesForReseed(events, hiddenRanges, normalize));
  // 고른 말 뒤의 완료 사건은 숨는다. 그대로 두면 화면이 그 말을 아직 진행 중인 턴으로 본다.
  // 숨김 범위 밖에 조용한 완료를 붙여, 새로고침 뒤에도 쉰 상태로 읽히게 한다.
  const idleSeq = until + 1;
  store.appendEvent(meta.id, { seq: idleSeq, ts: Date.now(), kind: "status", status: "completed" });
  store.saveMeta({ ...meta, resumeKey: undefined, hiddenRanges, reseedText, rewound: true });
  return {
    restored: applied.restored,
    skipped: [...plan.skipped, ...applied.failed],
    after: target.after,
    until,
    idleSeq,
  };
}

export function buildReseed(
  lines: readonly { role: "user" | "assistant"; text: string }[],
  cap = RESEED_CAP,
): string {
  const header =
    "이 대화는 중간으로 되돌려졌다. 그 뒤에 오간 말과, 그때 승인했던 파일 변경은 취소됐다. 아래는 남겨 둔 대화다. 이 내용만 이어서 답하라.";
  const body = lines
    .map((line) => `${line.role === "user" ? "사용자" : "도우미"}: ${line.text.trim()}`)
    .filter((line) => !line.endsWith(":"))
    .join("\n\n");
  const room = cap - header.length - 2;
  if (body.length <= room) return `${header}\n\n${body}`.trim();
  const kept = body.slice(Math.max(0, body.length - Math.max(0, room - 40)));
  return `${header}\n\n(앞부분이 길어 잘랐다.)\n\n${kept}`.trim();
}

export function applyRestore(
  cwd: string,
  notes: readonly CheckpointNote[],
): { restored: string[]; failed: { path: string; reason: SkipReason }[] } {
  // 맥의 /var 처럼 폴더 자체가 심볼릭 링크면, 파일만 실제 경로로 풀었을 때 경계 검사가 실패한다.
  let base = cwd;
  try {
    base = fs.realpathSync(cwd);
  } catch (error) {
    if (!isManagedWorkspacePath(cwd) && ((error as NodeJS.ErrnoException)?.code === "EACCES" || (error as NodeJS.ErrnoException)?.code === "EPERM")) classifyError(error as Error, "user_action");
    failures.file(error, { component: "session", operation: "session.workspace.realpath", severity: "warning" }, cwd);
    // 폴더가 없으면 아래 경로 검사에서 실패로 남긴다.
  }
  const restored: string[] = [];
  const failed: { path: string; reason: SkipReason }[] = [];
  for (const note of notes) {
    if (!note.ok) {
      failed.push({ path: note.path, reason: note.skip ?? "unknown" });
      continue;
    }
    try {
      const { real, isNew } = resolveFileUnderCwd(base, note.path);
      if (note.isCreate || note.before == null) {
        if (!isNew) fs.rmSync(real, { force: true });
      } else {
        fs.mkdirSync(path.dirname(real), { recursive: true });
        fs.writeFileSync(real, note.before, { encoding: "utf8", mode: 0o600 });
        fs.chmodSync(real, 0o600);
      }
      failures.clear(`restore:${cwd}:${note.path}`);
      restored.push(note.path);
    } catch (error) {
      failures.report(error, { component: "session", operation: "session.checkpoint.restore", severity: "warning" }, `restore:${cwd}:${note.path}`);
      failed.push({ path: note.path, reason: "outside" });
    }
  }
  return { restored, failed };
}

function checkpointsFile(id: string): string {
  return path.join(config.dataDir, id, "checkpoints.json");
}

function isNote(value: unknown): value is CheckpointNote {
  if (!value || typeof value !== "object") return false;
  const note = value as CheckpointNote;
  return typeof note.seq === "number" && typeof note.path === "string" && typeof note.ok === "boolean" && typeof note.isCreate === "boolean";
}

export function loadCheckpoints(id: string): CheckpointNote[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointsFile(id), "utf8")) as { notes?: unknown };
    if (!parsed || !Array.isArray(parsed.notes)) {
      failures.file(new Error("파일 복원 기록 형식 손상"), { component: "session", operation: "session.checkpoints.read", session_id: id }, checkpointsFile(id));
      return [];
    }
    failures.recoveredFile(checkpointsFile(id));
    return parsed.notes.filter(isNote);
  } catch (error) {
    failures.file(error, { component: "session", operation: "session.checkpoints.read", session_id: id }, checkpointsFile(id));
    return [];
  }
}

export function appendCheckpoint(id: string, note: CheckpointNote): void {
  const notes = loadCheckpoints(id);
  notes.push(note);
  const file = checkpointsFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ notes }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
