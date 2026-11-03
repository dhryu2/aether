/**
 * 스킬 저장 위치 규약 — 여기가 유일한 정본 (Phase 8d-1 · D7).
 *
 * 8d-1 이전엔 옛 스킬 저장 코드가 같은 경로를 네 군데서 따로 조립했고, 그중 어디도 `CLAUDE_CONFIG_DIR`
 * 오버라이드를 존중하지 않았다(`os.homedir()` 직접 사용). 설정 디렉터리를 옮겨 쓰는 환경에서는 스킬을
 * 엉뚱한 곳에 쓰고, 정작 세션이 로드하는 곳은 비어 있었다. 조립을 이 파일 한 곳으로 모으고 결함도 함께 고친다.
 *
 * 저장소는 provider 공통 자산이다(D7). 위치가 Claude Code 관례(`.claude/skills`)인 것은 역사적 이유이고,
 * 옮기지 않는 것이 결정이다 — Codex 세션은 기동 시 이 경로들을 추가 스킬 루트로 등록해 같은 파일을 읽는다
 * (8a 실측: `~/.claude/skills`의 SKILL.md가 Codex 검증을 그대로 통과 → 별도 미러 불필요).
 */
import os from "node:os";
import path from "node:path";
import { config } from "../config";
import { pick } from "../i18n";
import type { SkillTarget } from "../../shared/brain";

export type { SkillTarget };

/**
 * Claude Code 설정 디렉터리 — `CLAUDE_CONFIG_DIR` 오버라이드를 존중하고, 없으면 `~/.claude`.
 * 세션을 스폰하는 CLI가 이 규칙을 쓰므로, 우리가 스킬을 쓰는 위치도 같은 규칙을 따라야 실제로 로드된다.
 */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

/**
 * 모든 프로젝트에서 로드되는 스킬 디렉터리.
 *
 * `AETHER_SKILLS_DIR`로 **이 경로만** 따로 옮길 수 있다(8d-2 신설). 카나리처럼 자동 스킬 생성을 켠 채
 * 돌려야 하는데 사용자의 진짜 `~/.claude/skills`를 건드리면 안 되는 경우가 있어서다. `CLAUDE_CONFIG_DIR`로
 * 옮기면 세션이 로드하는 설정·플러그인·서브에이전트까지 통째로 바뀌어 프로덕션과 다른 조건이 된다 —
 * 그래서 설정 디렉터리는 그대로 두고 스킬 쓰기 위치만 가르는 노브를 따로 뒀다.
 *
 * 주의(의도된 비대칭): 이 값을 바꾸면 Aether가 스킬을 *쓰는* 곳만 옮겨가고, 세션을 스폰하는 CLI가 스킬을
 * *읽는* 곳은 그대로다. 격리 실행에서 갓 만든 스킬이 그 세션에 안 뜨는 것은 정상이다.
 */
export function userSkillsDir(): string {
  return config.skillsDir || path.join(claudeConfigDir(), "skills");
}

/** 이 프로젝트 세션에서만 로드되는 스킬 디렉터리. */
export function projectSkillsDir(cwd: string): string {
  return path.join(cwd, ".claude", "skills");
}

/**
 * target에 해당하는 스킬 베이스 디렉터리.
 * project 스킬은 "어느 프로젝트"가 정해져야 위치가 결정되므로 cwd가 없으면 throw한다.
 */
export function skillsBaseDir(target: SkillTarget, cwd: string | undefined): string {
  if (target === "user") return userSkillsDir();
  if (!cwd) throw new Error(pick({ ko: "project 스킬은 cwd가 필요하다", en: "project skill requires cwd" }));
  return projectSkillsDir(cwd);
}
