import { FailureTracker } from "../providers/failureTracking";
/**
 * 인증 전략 3종(off/tailscale/password) 팩토리 + 게이트 미들웨어.
 * hardening.ts 패턴(팩토리 + config 게이트, on/off 책임은 index.ts)과 일관.
 * 외부 의존(whois resolver, JWT verify)은 DI로 주입 가능 → mock 단위테스트.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { config } from "../config";
import type { AuthStrategy, IdentityResolver } from "../auth/types";
import { clientAddr } from "../auth/clientAddr";
import { tailscaleResolver } from "../auth/tailscale";
import { verifySession } from "../auth/jwt";
import { st } from "../i18n";

/** off: 인증 없음(기본). 항상 통과. */
export function createOffStrategy(): AuthStrategy {
  return { authenticate: async () => ({ login: "dev", via: "off" }) };
}

/** tailscale: 소켓 IP → whois(resolver, DI) → 화이트리스트 대조. */
export function createTailscaleStrategy(opts: { resolver?: IdentityResolver } = {}): AuthStrategy {
  const resolver = opts.resolver ?? tailscaleResolver;
  const failures = new FailureTracker();
  return {
    authenticate: async (req) => {
      const addr = clientAddr(req);
      if (!addr) return null; // 비-Tailscale 대역
      const id = await resolver(addr.ip, addr.port).then(id => {
        failures.clear("auth.identity.resolve");
        return id;
      }).catch(error => {
        failures.report(error, { component: "auth", operation: "auth.identity.resolve" });
        return null;
      });
      if (!id) return null;
      // 화이트리스트 비면 "검증된 신원 누구나"(단일망 전제), 있으면 일치만.
      if (config.allowedLogins.length && !config.allowedLogins.includes(id.login)) return null;
      return { login: id.login, via: "tailscale" };
    },
  };
}

/** password: 쿠키 JWT 우선, 없으면 Authorization Bearer. 쿠키가 있는데 실패하면 Bearer로 우회하지 않는다. */
export function createPasswordStrategy(opts: { verify?: (t: string) => Promise<boolean> } = {}): AuthStrategy {
  const verify = opts.verify ?? verifySession;
  return {
    authenticate: async (req) => {
      const cookie = req.cookies?.aether_session as string | undefined;
      if (cookie) {
        return (await verify(cookie)) ? { login: "owner", via: "password" } : null;
      }
      const raw = req.headers?.authorization;
      if (typeof raw !== "string") return null;
      const m = /^Bearer\s+(\S+)/i.exec(raw.trim());
      if (!m) return null;
      return (await verify(m[1]!)) ? { login: "owner", via: "password" } : null;
    },
  };
}

/** config.authMode로 전략 선택(index.ts 배선). 알 수 없는 모드는 throw(fail-closed). */
export function selectStrategy(): AuthStrategy {
  switch (config.authMode) {
    case "off":
      return createOffStrategy();
    case "tailscale":
      return createTailscaleStrategy();
    case "password":
      return createPasswordStrategy();
    default:
      // config.ts에서 이미 검증되지만, 새 모드 추가 시 off로 fail-open되지 않도록 명시 거부.
      throw new Error(`알 수 없는 authMode: ${config.authMode}`);
  }
}

/** 게이트: 실패 시 401 JSON 후 return(next 금지), 성공 시 req.auth 주입 후 next. */
export function createAuthMiddleware(strategy: AuthStrategy): RequestHandler {
  const failures = new FailureTracker();
  return (req: Request, res: Response, next: NextFunction) => {
    strategy
      .authenticate(req)
      .then((id) => {
        failures.clear("auth.strategy.authenticate");
        if (!id) {
          res.status(401).json({ error: st("routes.common.authRequired") });
          return;
        }
        req.auth = id;
        next();
      })
      .catch(error => {
        failures.report(error, { component: "auth", operation: "auth.strategy.authenticate" });
        res.status(401).json({ error: st("routes.auth.failed") }); // whois 오류 등도 거부(5xx 아님)
      });
  };
}
