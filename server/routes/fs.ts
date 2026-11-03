import { FailureTracker } from "../providers/failureTracking";
import { reportError } from "../observability/report";
/**
 * 폴더 고르기(FolderPicker) 서버 쪽 — 서버 컴퓨터의 폴더 구조를 앱 안에서 탐색기처럼 보여 준다.
 *   GET /api/fs/places                         즐겨찾기(홈·데스크탑·문서·다운로드)와 장치(드라이브·루트·볼륨)
 *   GET /api/fs/list?path=<절대경로>&showHidden=0|1   그 폴더 안의 하위 폴더 목록(파일은 보내지 않는다)
 * 허용 범위(루트) 제한은 없다. 파일 이름·내용은 보내지 않고, .env/.git/node_modules와 홈의 비밀 폴더는 목록에서 빼고 진입도 막는다.
 * 인증 게이트 뒤에 마운트(보호). 읽기는 모두 비동기다(느린 디스크가 서버 전체를 붙잡지 않게).
 */
import { Router, type Request, type Response } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { folderReasonOf, isSensitiveEntry, isSensitiveRealAsync, resolveWorkFolderAsync, sensitiveIdsAsync, type FolderReason } from "../sessions/safePath";
import { isGitRepo } from "../sessions/isolatedWorkspace";
import { config } from "../config";
import { defaultProbe, isHiddenName, listPlaces } from "./fsPlaces";
import { st } from "../i18n";

const failures = new FailureTracker();

export const fsRouter = Router();

/** 한 번에 보내는 폴더 수 상한. 넘으면 정렬 뒤 앞부분만 보내고 truncated를 켠다. */
const MAX_ENTRIES = 5000;
/** 심볼릭 링크 확인을 동시에 진행하는 개수. */
const LINK_CONCURRENCY = 16;

const STATUS_OF: Record<FolderReason, number> = { invalid: 400, not_directory: 400, denied: 403, not_found: 404 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// 시크릿/성능 보호: showHidden과 무관하게 항상 제외. macOS APFS 대소문자 비구분 대응 → 소문자 비교.
const DENY = new Set([".env", ".git", "node_modules"]);
const isDenied = (name: string) => DENY.has(name.toLowerCase());
// 탐색 대상의 실제 경로에 deny 폴더가 하나라도 끼어 있으면 거부(?path=.git/?path=node_modules/x 우회 차단).
const hasDeniedSegment = (abs: string) => abs.split(/[\\/]+/).some((seg) => seg && isDenied(seg));

/** 탐색의 정상 거절과 기능 축소를 구분한다. */
function reportDirectoryFailure(error: unknown, target: string, phase: "read" | "stat" | "link") {
  const key = `${phase}:${target}`;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(code ?? "")) {
    // 사용자 폴더의 부재·권한 거절·깨진 링크는 정상 탐색 결과다.
    failures.clear(key);
    return;
  }
  failures.report(error, { component: "routes", operation: "filesystem.children.inspect", severity: "warning" }, key);
}

/** 하나씩 돌리되 동시에 limit개까지만 진행한다(결과 순서는 입력 순서). */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 루트부터 지금 폴더까지의 경로 구간. 서버가 dirname을 반복해 쪼개므로 화면은 경로 모양을 몰라도 된다. */
function crumbsOf(real: string): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (let cur = real; ; ) {
    const parent = path.dirname(cur);
    if (parent === cur) {
      out.unshift({ name: cur.replace(/[\\/]+$/, "") || cur, path: cur }); // 루트: 윈도우 `C:`, 맥·리눅스 `/`
      break;
    }
    out.unshift({ name: path.basename(cur), path: cur });
    cur = parent;
  }
  return out;
}

fsRouter.get("/places", async (_req: Request, res: Response) => {
  try {
    res.json(await listPlaces({ platform: process.platform, home: os.homedir(), volumesDir: config.volumesDir, env: process.env, probe: defaultProbe }));
  } catch (err) {
    void reportError(err, { component: "routes", operation: "filesystem.places.list" });
    console.error("[aether] fs/places 오류:", err);
    res.status(500).json({ error: st("routes.fs.readFailed") });
  }
});

fsRouter.get("/list", async (req: Request, res: Response) => {
  try {
    const real = await resolveWorkFolderAsync(req.query.path); // 절대 경로 + realpath + 폴더 확인 + 보호 폴더 거부
    if (hasDeniedSegment(real)) return res.status(403).json({ error: st("notice.path.accessDenied") }); // .git/node_modules 진입 차단
    const showHidden = req.query.showHidden === "1";

    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(real, { withFileTypes: true });
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException)?.code;
      if (code === "EACCES" || code === "EPERM") return res.status(403).json({ error: st("notice.path.accessDenied") });
      if (code === "ENOENT" || code === "ENOTDIR") return res.status(404).json({ error: st("notice.path.notFound") });
      throw cause;
    }

    const candidates = dirents.filter((d) => {
      if (isDenied(d.name)) return false;
      if (!showHidden && isHiddenName(d.name)) return false;
      return true;
    });
    const sensitiveIds = await sensitiveIdsAsync(); // 홈의 .ssh·Library 같은 보호 폴더의 정체(경로 표기가 달라도 걸러내려고)
    const checked = await mapLimited(candidates, LINK_CONCURRENCY, async (d) => {
      const abs = path.join(real, d.name);
      if (d.isDirectory()) return (await isSensitiveEntry(abs, d.name, sensitiveIds)) ? null : { name: d.name, abs };
      if (!d.isSymbolicLink()) return null; // 파일은 보내지 않는다
      try {
        // 심볼릭 링크는 가리키는 곳을 풀어 폴더인지, 보호 폴더가 아닌지 다시 확인한다.
        const linkReal = await fs.promises.realpath(abs);
        if (await isSensitiveRealAsync(linkReal, sensitiveIds)) return null;
        const isDir = (await fs.promises.stat(linkReal)).isDirectory();
        failures.clear(`link:${abs}`);
        return isDir ? { name: d.name, abs } : null;
      } catch (error) {
        reportDirectoryFailure(error, abs, "link");
        return null; // 깨진/순환 링크 skip
      }
    });
    const folders = checked.filter((x): x is { name: string; abs: string } => x !== null).sort((a, b) => collator.compare(a.name, b.name));
    const truncated = folders.length > MAX_ENTRIES;
    const parent = path.dirname(real);
    const crumbs = crumbsOf(real);
    res.json({
      path: real,
      name: crumbs[crumbs.length - 1].name,
      parent: parent === real ? null : parent,
      crumbs,
      canCopy: isGitRepo(real), // 이 폴더에서 복사본을 만들 수 있는지. git 명령 이름은 나가지 않는다.
      entries: folders.slice(0, MAX_ENTRIES).map((f) => ({ name: f.name, path: f.abs, hidden: isHiddenName(f.name) })),
      truncated,
    });
  } catch (err) {
    const reason = folderReasonOf(err);
    if (reason) return res.status(STATUS_OF[reason]).json({ error: (err as Error).message }); // 정상 거절 — 오류 기록 없음
    void reportError(err, { component: "routes", operation: "filesystem.directory.list" });
    console.error("[aether] fs/list 오류:", err);
    res.status(500).json({ error: st("routes.fs.readFailed") });
  }
});
