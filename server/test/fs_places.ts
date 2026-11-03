/**
 * 폴더 고르기 위치 목록(fsPlaces) 시험 — 순수 함수 + 가짜 probe. 서버 부팅·모델 호출 없음.
 *   윈도우 드라이브·즐겨찾기(OneDrive 대체)·응답 없는 드라이브 제한 시간, 맥 볼륨 링크(Macintosh HD → /), 숨김 이름.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { listPlaces, isHiddenName, defaultProbe, withTimeout } = await import("../routes/fsPlaces");

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}
const fakeProbe = (existing: string[]) => async (p: string) => existing.includes(p);
const base = { volumesDir: "/nonexistent-volumes", env: {} as Record<string, string | undefined> };

console.log("\n[윈도우]");
{
  const home = "C:\\Users\\kim";
  const r = await listPlaces({ ...base, platform: "win32", home, probe: fakeProbe(["C:\\", "D:\\", "C:\\Users\\kim\\Desktop", "C:\\Users\\kim\\Downloads"]) });
  check(r.devices.map((d) => d.name).join() === "C:,D:" && r.devices.every((d) => d.kind === "drive") && r.devices[0].path === "C:\\", "C·D만 drive", JSON.stringify(r.devices));
  check(r.home === home && r.favorites[0].kind === "home" && r.favorites[0].name === "kim", "홈은 항상 즐겨찾기 첫 항목");
  check(r.favorites.map((f) => f.kind).join() === "home,desktop,downloads", "없는 문서는 빠진다", r.favorites.map((f) => f.kind).join());

  const oneDrive = await listPlaces({ ...base, platform: "win32", home, env: { OneDrive: "C:\\Users\\kim\\OneDrive" }, probe: fakeProbe(["C:\\Users\\kim\\OneDrive\\Desktop", "C:\\Users\\kim\\OneDrive\\Documents"]) });
  check(oneDrive.favorites.find((f) => f.kind === "desktop")?.path === "C:\\Users\\kim\\OneDrive\\Desktop", "Desktop이 없고 OneDrive\\Desktop이 있으면 뒤의 것");
  check(oneDrive.favorites.find((f) => f.kind === "documents")?.path === "C:\\Users\\kim\\OneDrive\\Documents", "문서도 같은 규칙");
  const both = await listPlaces({ ...base, platform: "win32", home, env: { OneDrive: "C:\\Users\\kim\\OneDrive" }, probe: fakeProbe(["C:\\Users\\kim\\Desktop", "C:\\Users\\kim\\OneDrive\\Desktop"]) });
  check(both.favorites.find((f) => f.kind === "desktop")?.path === "C:\\Users\\kim\\Desktop", "둘 다 있으면 홈\\Desktop 우선");

  // 응답 없는 드라이브(E:)는 실제 withTimeout이 제한 시간 뒤에 false로 만든다(withTimeout이 사라지면 이 시험은 걸려서 실패한다).
  const never = new Promise<boolean>(() => {});
  const t0 = Date.now();
  const guarded = (p: string) => (p === "E:\\" ? withTimeout(never, 300, false) : Promise.resolve(p === "C:\\"));
  const withSlow = await Promise.race([listPlaces({ ...base, platform: "win32", home, probe: guarded }), new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
  check(withSlow !== null && withSlow.devices.map((d) => d.name).join() === "C:" && Date.now() - t0 < 2000, "응답 없는 드라이브는 withTimeout 제한 뒤 빠진다", `${Date.now() - t0}ms`);
  check((await withTimeout(Promise.reject(new Error("x")), 300, "fb")) === "fb" && (await withTimeout(Promise.resolve("ok"), 300, "fb")) === "ok", "withTimeout: 실패는 대체값, 정상은 그대로");
}

console.log("\n[맥]");
{
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-places-")));
  const vols = path.join(tmp, "Volumes");
  fs.mkdirSync(path.join(vols, "Disk1"), { recursive: true });
  fs.mkdirSync(path.join(vols, ".Spotlight"));
  fs.symlinkSync("/", path.join(vols, "Macintosh HD"));
  try {
    const r = await listPlaces({ platform: "darwin", home: "/Users/kim", volumesDir: vols, env: {}, probe: defaultProbe });
    const root = r.devices.find((d) => d.kind === "root");
    check(root?.path === "/" && root.name === "Macintosh HD", "Macintosh HD → / 링크가 루트 이름이 된다", JSON.stringify(root));
    check(!r.devices.some((d) => d.kind === "volume" && d.name === "Macintosh HD"), "그 링크는 볼륨 목록에서 빠진다");
    check(!r.devices.some((d) => d.name === ".Spotlight"), ".Spotlight 빠짐");
    check(r.devices.some((d) => d.kind === "volume" && d.name === "Disk1" && d.path === path.join(vols, "Disk1")), "Disk1은 volume");
    check(r.favorites[0].path === "/Users/kim" && r.favorites[0].name === "kim", "홈 즐겨찾기");
    const noVols = await listPlaces({ platform: "linux", home: "/home/kim", volumesDir: path.join(tmp, "none"), env: {}, probe: defaultProbe });
    check(noVols.devices.length === 1 && noVols.devices[0].kind === "root" && noVols.devices[0].name === "/", "볼륨 폴더가 없으면 `/`만");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("\n[숨김 이름]");
check(isHiddenName("$Recycle.Bin", "win32") && isHiddenName("System Volume Information", "win32") && isHiddenName("ProgramData", "win32") && isHiddenName(".git", "win32"), "윈도우 시스템 폴더·점 시작은 숨김");
check(!isHiddenName("$Recycle.Bin", "darwin") && !isHiddenName("Recovery", "darwin") && isHiddenName(".hidden", "darwin"), "맥은 `$` 시작이 숨김이 아니다");
check(!isHiddenName("Projects", "win32"), "보통 폴더는 숨김 아님");

console.log("\n" + "─".repeat(40));
console.log(`fs_places: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
