import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 명시한 배포 버전이 없으면 소스 저장소를 확인한다. Git 실패는 부팅을 막지 않는다. */
export function detectRelease(override = process.env.AETHER_RELEASE): string | null {
  if (override !== undefined) return override;
  try {
    const options = { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' as const, timeout: 2000, maxBuffer: 1024 * 1024 };
    const head = childProcess.spawnSync('git', ['rev-parse', '--short', 'HEAD'], options);
    if (head.status !== 0 || !/^[0-9a-f]+$/.test(head.stdout.trim())) return null;
    const status = childProcess.spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], options);
    if (status.status !== 0) return null;
    return head.stdout.trim() + (status.stdout.trim() ? '-dirty' : '');
  } catch { return null; }
}

// 서버 시작과 웹 빌드의 모듈 초기화 때 한 번만 결정한다.
export const currentRelease = detectRelease();
