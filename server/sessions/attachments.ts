import { reportError } from "../observability/report";
/**
 * AttachmentStore — 첨부를 디스크 임시 파일로 실체화했을 때의 *수명* 관리 (Phase 8d-1 · D3).
 *
 * 왜 필요한가: 사용자가 붙인 이미지·문서를 모델에게 넘기는 방식이 provider마다 다르다.
 *   Claude는 파일 내용을 메시지 안에 문자열(base64)로 실어 보내므로 디스크에 아무것도 안 남는다.
 *   Codex는 로컬 이미지를 **경로로만** 받으므로(8a 실측: UserInput의 localImage), 서버가 먼저 임시 파일을
 *   만들어야 한다. 그러면 "언제 지우나"가 생긴다 — 큐에서 대기 중인 입력이 소비될 때까지는 살아 있어야 하고,
 *   턴이 끝나면 지워야 하며, 중단·크래시·서버 재시작·세션 삭제 어디서도 새면 안 된다.
 *
 * 계약(이 클래스가 지키는 것):
 *   - 파일은 **세션 1개 전용 디렉터리** 아래에만 만든다. 세션이 끝나면 디렉터리째 지우면 끝이다.
 *   - `release()`는 그 입력이 실제로 소비된 뒤에 부른다(큐 대기 중 삭제 금지).
 *   - `disposeAll()`은 멱등이다. 이미 지운 파일·없는 디렉터리에도 안전하다(runtime.dispose가 부른다).
 *   - 서버가 죽어 `disposeAll()`을 못 불러도 다음 부팅의 `purgeOrphans()`가 남은 디렉터리를 청소한다.
 *
 * Claude runtime은 임시 파일을 만들지 않으므로 이 저장소를 쓰지 않는다. 계약을 지금 고정해 두는 이유는,
 * 8e에서 Codex가 임시 파일을 처음 만들 때 수명 규칙을 즉흥으로 정하지 않게 하기 위해서다.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config";

/** 임시 첨부 루트 — 세션 데이터와 섞이지 않게 dataDir 아래 전용 dot-디렉터리. */
function attachmentsRoot(): string {
  return path.join(config.dataDir, ".attachments");
}

/** 한 세션의 임시 첨부 디렉터리. */
function sessionDir(sessionId: string): string {
  return path.join(attachmentsRoot(), sessionId);
}

/** 디스크에 실체화된 첨부 1개. `path`를 provider에 넘기고, 소비 후 `release()`한다. */
export type MaterializedAttachment = { path: string; release(): void };

export class AttachmentStore {
  private readonly dir: string;
  private disposed = false;

  constructor(private readonly sessionId: string) {
    this.dir = sessionDir(sessionId);
  }

  /**
   * base64 내용을 이 세션 전용 임시 파일로 쓴다. 반환된 `path`는 소비될 때까지 유효하다.
   * dispose 이후 호출은 파일을 만들지 않고 throw한다 — 지워진 디렉터리를 되살리지 않기 위해서(좀비 차단).
   */
  materialize(base64: string, ext: string): MaterializedAttachment {
    if (this.disposed) throw new Error(`AttachmentStore(${this.sessionId})는 이미 정리됐다`);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); // 사용자 전용(같은 맥 타유저 차단 — 세션 dir와 동일)
    const file = path.join(this.dir, `${randomUUID()}${ext.startsWith(".") ? ext : "." + ext}`);
    fs.writeFileSync(file, Buffer.from(base64, "base64"), { mode: 0o600 });
    let released = false;
    return {
      path: file,
      release: () => {
        if (released) return; // 멱등 — 같은 입력이 두 번 소비돼도 안전
        released = true;
        try { fs.rmSync(file, { force: true }); } catch { /* 이미 없으면 무해 */ }
      },
    };
  }

  /** 세션 종료·삭제 시 남은 임시 파일 전부 제거. 멱등 — 이미 지웠거나 만든 적 없어도 안전. */
  disposeAll(): void {
    this.disposed = true;
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (e) { void reportError(e, { component: "session", operation: "session.attachments.cleanup", session_id: this.sessionId }); console.error("[aether] 임시 첨부 정리 실패:", e); }
  }
}

/**
 * 부팅 시 고아 임시 첨부 청소 — 크래시로 `disposeAll()`을 못 부른 세션의 잔재.
 * 살아있는 세션이 없는 시점(부팅 직후)에만 부르므로 전부 지워도 안전하다. best-effort.
 */
export function purgeOrphanAttachments(): void {
  try { fs.rmSync(attachmentsRoot(), { recursive: true, force: true }); } catch { /* 없으면 무해 */ }
}
