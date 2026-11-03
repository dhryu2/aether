/**
 * 클라 소켓 주소 취득 + Tailscale 대역 검증.
 * ⚠️ 신원은 req.socket.remoteAddress(실제 TCP 피어)에서만. req.ip/XFF는 위조 가능 → 쓰지 않는다.
 * Tailscale 대역(100.64.0.0/10 CGNAT 또는 fd7a:115c:a1e0::/48 tailnet IPv6)이 아니면 거부(null).
 * net.isIP로 정규 IP만 통과(zone-id %·대괄호 등 비정규 입력 차단).
 */
import net from "node:net";
import type { Request } from "express";

// 100.64.0.0/10 = 100.64.0.0 ~ 100.127.255.255 (둘째 옥텟 64~127). end-anchored(뒤 garbage 차단).
const CGNAT = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
// Tailscale tailnet ULA는 정확히 fd7a:115c:a1e0::/48 (fd7a::/16 전체 과대신뢰 금지).
const TS_V6 = /^fd7a:115c:a1e0:/i;
// IPv4-mapped IPv6는 점-십진 형태일 때만 ::ffff: 제거(::ffff:fd7a:1 같은 위장 차단).
const V4_MAPPED = /^::ffff:(\d{1,3}\.){3}\d{1,3}$/;

export function clientAddr(req: Request): { ip: string; port: number } | null {
  const raw = req.socket.remoteAddress ?? "";
  const ip = V4_MAPPED.test(raw) ? raw.replace(/^::ffff:/, "") : raw;
  const port = req.socket.remotePort ?? 0;
  if (net.isIP(ip) === 0) return null; // 비정규 IP(zone-id·대괄호 등) 거부
  if (!CGNAT.test(ip) && !TS_V6.test(ip)) return null;
  return { ip, port };
}
