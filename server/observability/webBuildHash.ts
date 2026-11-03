import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 화면 빌드가 소스와 맞는지 비교하는 해시 대상. 저장소 루트(web/·shared/를 가진 폴더) 기준. */
const ROOTS = ['web/src', 'web/public', 'web/index.html', 'web/vite.config.ts', 'web/package.json', 'shared'];

function walk(abs: string, rel: string, out: string[]): void {
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return; }
  if (st.isFile()) { out.push(rel); return; }
  if (!st.isDirectory()) return;
  for (const name of fs.readdirSync(abs)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    walk(path.join(abs, name), `${rel}/${name}`, out);
  }
}

/** 화면 소스가 이 저장소 루트에 있는가(소스 없는 설치본은 false). */
export function hasWebSource(repoRoot: string): boolean {
  return fs.existsSync(path.join(repoRoot, 'web', 'src'));
}

/** (상대경로 + 내용)을 경로순으로 이어 해시한다. 서버와 vite 빌드가 같은 함수를 쓴다. */
export function computeWebSourceHash(repoRoot: string): string {
  const files: string[] = [];
  for (const r of ROOTS) walk(path.join(repoRoot, r), r, files);
  files.sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f); h.update('\0');
    try { h.update(fs.readFileSync(path.join(repoRoot, f))); } catch { /* 읽는 사이 지워진 파일은 건너뛴다 */ }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

export type WebBuildInfo = { contractVersion: number; sourceHash: string; builtAt: string };
