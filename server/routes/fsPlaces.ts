/**
 * 폴더 고르기의 "위치" 목록(즐겨찾기·장치). 운영체제마다 다른 폴더 모양을 아는 유일한 파일이다.
 * 외부 프로그램(wmic·PowerShell 등)은 부르지 않고, 폴더 존재만 시간 제한을 두고 확인한다.
 */
import fs from "node:fs";
import path from "node:path";

export type FavoriteKind = "home" | "desktop" | "documents" | "downloads";
export type DeviceKind = "drive" | "root" | "volume";
export type Place<K extends string> = { kind: K; name: string; path: string };
export type PlacesResult = { home: string; favorites: Place<FavoriteKind>[]; devices: Place<DeviceKind>[] };

export type PlacesEnv = {
  platform: string;
  home: string;
  /** 맥 외장 디스크 폴더(예: /Volumes). 없으면 읽지 못한 것으로 보고 건너뛴다. */
  volumesDir: string;
  /** 환경변수(OneDrive 폴더 경로를 읽는 데만 쓴다). */
  env: Record<string, string | undefined>;
  /** 경로에 폴더가 있는지 시간 제한 안에 확인한다. 시간이 넘으면 false. */
  probe: (p: string) => Promise<boolean>;
};

/** 장치 하나를 기다리는 상한(ms). 끊긴 네트워크 드라이브가 목록 전체를 붙잡지 못하게 한다. */
export const PROBE_TIMEOUT_MS = 1500;

export function withTimeout<T>(task: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    task.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** 실제 파일시스템 확인. 없음·권한 없음·시간 초과는 모두 false. */
export function defaultProbe(p: string): Promise<boolean> {
  return withTimeout(fs.promises.stat(p).then((s) => s.isDirectory()), PROBE_TIMEOUT_MS, false);
}

const WINDOWS_HIDDEN_NAMES = new Set(["system volume information", "recovery", "config.msi", "documents and settings", "programdata"]);

/** 폴더 이름이 숨김인가. 점으로 시작하면 숨김이고, 윈도우는 시스템 폴더 이름도 숨긴다. */
export function isHiddenName(name: string, platform: string = process.platform): boolean {
  if (name.startsWith(".")) return true;
  if (platform !== "win32") return false;
  return name.startsWith("$") || WINDOWS_HIDDEN_NAMES.has(name.toLowerCase());
}

/** 후보 경로를 차례로 확인해 처음 있는 것. */
async function firstExisting(candidates: (string | undefined)[], probe: PlacesEnv["probe"]): Promise<string | null> {
  for (const c of candidates) {
    if (c && (await probe(c))) return c;
  }
  return null;
}

export async function listPlaces(e: PlacesEnv): Promise<PlacesResult> {
  const win = e.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const oneDrive = e.env.OneDrive || e.env.ONEDRIVE;

  const favorites: Place<FavoriteKind>[] = [{ kind: "home", name: p.basename(e.home) || e.home, path: e.home }];
  const extras: { kind: FavoriteKind; name: string; candidates: (string | undefined)[] }[] = [
    { kind: "desktop", name: "Desktop", candidates: [p.join(e.home, "Desktop"), win && oneDrive ? p.join(oneDrive, "Desktop") : undefined] },
    { kind: "documents", name: "Documents", candidates: [p.join(e.home, "Documents"), win && oneDrive ? p.join(oneDrive, "Documents") : undefined] },
    { kind: "downloads", name: "Downloads", candidates: [p.join(e.home, "Downloads")] },
  ];
  const found = await Promise.all(extras.map((x) => firstExisting(x.candidates, e.probe)));
  extras.forEach((x, i) => {
    const hit = found[i];
    if (hit) favorites.push({ kind: x.kind, name: x.name, path: hit });
  });

  const devices = win ? await windowsDrives(e) : await posixDevices(e);
  return { home: e.home, favorites, devices };
}

/** A:\ ~ Z:\ 26개를 동시에 확인해 있는 것만. */
async function windowsDrives(e: PlacesEnv): Promise<Place<DeviceKind>[]> {
  const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  const exists = await Promise.all(letters.map((l) => e.probe(`${l}:\\`)));
  return letters.flatMap((l, i) => (exists[i] ? [{ kind: "drive" as const, name: `${l}:`, path: `${l}:\\` }] : []));
}

/** 루트(`/`)와 외장 디스크 폴더 아래 볼륨. `/`로 이어지는 링크(Macintosh HD)는 루트의 이름이 된다. */
async function posixDevices(e: PlacesEnv): Promise<Place<DeviceKind>[]> {
  const root = "/";
  const rootPlace: Place<DeviceKind> = { kind: "root", name: root, path: root };
  const volumes: Place<DeviceKind>[] = [];
  let names: string[] = [];
  try {
    names = await withTimeout(fs.promises.readdir(e.volumesDir), PROBE_TIMEOUT_MS, []);
  } catch {
    /* 외장 디스크 폴더가 없는 환경(리눅스 등) */
  }
  const checked = await Promise.all(
    names
      .filter((n) => !n.startsWith("."))
      .map(async (name) => {
        const real = await withTimeout(fs.promises.realpath(path.join(e.volumesDir, name)).catch(() => null), PROBE_TIMEOUT_MS, null);
        if (!real) return null;
        const isDir = await e.probe(real);
        return isDir ? { name, real } : null;
      }),
  );
  for (const c of checked) {
    if (!c) continue;
    if (c.real === root) rootPlace.name = c.name;
    else volumes.push({ kind: "volume", name: c.name, path: c.real });
  }
  volumes.sort((a, b) => a.name.localeCompare(b.name));
  return [rootPlace, ...volumes];
}
