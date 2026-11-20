/** 작업 폴더 파일 판정 공용 부분. 검토함 diff와 파일 보기가 같은 비밀 판정을 쓴다. */
import fs from "node:fs";
import path from "node:path";
import { isSecretPath } from "./secretPaths";

/** 없는 폴더도 다룬다: 존재하는 가장 가까운 조상을 실제 경로로 풀고 나머지를 붙인다(git은 실제 경로로 답한다). */
export function canonPath(p: string): string {
  const trailing = p.endsWith("/") ? "/" : "";
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest) + trailing; // 맥에서 대소문자를 디스크 표기로 맞춘다
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p) + trailing;
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

/** 비밀 판정은 요청 글자만 보지 않는다: 링크를 푼 실제 경로, 저장소 내부(.git), 이름이 바뀐 쪽의 경로도 본다. */
export function isSecretTarget(cwd: string, p: string): boolean {
  const real = canonPath(path.resolve(cwd, p));
  return isSecretPath(p) || isSecretPath(real) || /(^|\/)\.git(\/|$)/.test(real.replace(/\\/g, "/"));
}
