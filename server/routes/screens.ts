/**
 * 화면 등록 목록 — 어느 폴더의 정적 화면을 어느 접두어로 제공할지. 서버는 화면 이름을 모른다.
 * 파일 <dataDir>/screens.json. 파일이 없으면 config.serveStatic을 따르는 첫 값을 쓰고 파일로는 쓰지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";

export type ScreenEntry = { prefix: string; dir: string };
export type ScreenError = "prefix_unsupported" | "dir_invalid" | "body_invalid";

export function createScreenRegistry(o: { file: string; initial: ScreenEntry[] }) {
  function load(): ScreenEntry[] {
    if (!fs.existsSync(o.file)) return o.initial;
    try {
      const v = JSON.parse(fs.readFileSync(o.file, "utf8"));
      if (Array.isArray(v)) {
        if (v.every((e) => fs.existsSync(path.join(String(e?.dir), "index.html")))) return v as ScreenEntry[];
        // 묶음을 옮기거나 바꿔 등록한 폴더가 사라졌다. 켜 둔 화면이 조용히 404가 되지 않게 첫 값으로 돌아간다.
        console.warn(`[aether] 등록된 화면 폴더가 없어 첫 값을 씁니다: ${o.file}`);
        return o.initial;
      }
    } catch { /* 아래에서 경고 */ }
    console.warn(`[aether] 화면 등록 파일을 읽지 못해 비워 둡니다: ${o.file}`);
    return [];
  }
  let list = load();
  return {
    list: (): ScreenEntry[] => list,
    /** "/" 항목의 폴더. 없으면 null. */
    rootDir: (): string | null => list.find((e) => e.prefix === "/")?.dir ?? null,
    replace(next: unknown): { ok: true; screens: ScreenEntry[] } | { ok: false; error: ScreenError } {
      if (!Array.isArray(next)) return { ok: false, error: "body_invalid" };
      // shortcut: 접두어는 "/" 하나만 건다. 두 번째 화면을 등록할 때 접두어별 장착으로 넓힌다
      if (next.length > 1) return { ok: false, error: "prefix_unsupported" };
      const screens: ScreenEntry[] = [];
      for (const e of next) {
        if (!e || typeof e !== "object" || typeof e.prefix !== "string" || typeof e.dir !== "string") return { ok: false, error: "body_invalid" };
        if (e.prefix !== "/") return { ok: false, error: "prefix_unsupported" };
        if (!path.isAbsolute(e.dir) || !fs.existsSync(path.join(e.dir, "index.html")) || !fs.statSync(e.dir).isDirectory()) return { ok: false, error: "dir_invalid" };
        screens.push({ prefix: e.prefix, dir: e.dir });
      }
      const tmp = `${o.file}.tmp`;
      fs.mkdirSync(path.dirname(o.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(screens));
      fs.renameSync(tmp, o.file);
      list = screens;
      return { ok: true, screens };
    },
  };
}

export const screenRegistry = createScreenRegistry({
  file: path.join(config.dataDir, "screens.json"),
  initial: config.serveStatic ? [{ prefix: "/", dir: config.webDist }] : [],
});
