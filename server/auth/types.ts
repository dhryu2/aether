/**
 * 인증 도메인 타입. 3-전략(off/tailscale/password) 공통 인터페이스.
 */
import type { Request } from "express";

export type AuthMode = "off" | "tailscale" | "password";

export interface AuthIdentity {
  login: string;
  via: AuthMode;
  /** 이 신원을 만든 자격이 아직 유효한지. 오래 열려 있는 스트림이 주기적으로 묻는다. 없으면 폐기 개념이 없는 방식이다. */
  stillValid?: () => Promise<boolean>;
}

export interface AuthStrategy {
  /** 인증 성공 시 신원, 실패 시 null. throw는 게이트가 401로 처리. */
  authenticate(req: Request): Promise<AuthIdentity | null>;
}

/** whois resolver DI 시그니처 — 테스트는 mock 주입(CLI/네트워크 없이 검증). */
export type IdentityResolver = (ip: string, port: number) => Promise<{ login: string } | null>;

// Express Request에 req.auth 보강
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthIdentity;
    }
  }
}
