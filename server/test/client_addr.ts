/**
 * Tailscale 대역만 클라 주소로 인정한다. 소켓은 가짜다. 모델 호출 0.
 * 실행: node --env-file=.env --import tsx test/client_addr.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";
import { clientAddr } from "../auth/clientAddr";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "aether-client-addr-"));
process.env.AETHER_DATA_DIR = data;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}

function req(ip: string, port = 4321): Request {
  return { socket: { remoteAddress: ip, remotePort: port } } as Request;
}

check(clientAddr(req("100.64.0.1", 9))?.ip === "100.64.0.1" && clientAddr(req("100.64.0.1", 9))?.port === 9, "CGNAT 시작은 통과한다");
check(clientAddr(req("100.127.255.255"))?.ip === "100.127.255.255", "CGNAT 끝은 통과한다");
check(clientAddr(req("100.63.255.255")) == null, "CGNAT 바로 아래는 거절한다");
check(clientAddr(req("100.128.0.1")) == null, "CGNAT 바로 위는 거절한다");
check(clientAddr(req("10.1.2.3")) == null, "사설망은 거절한다");
check(clientAddr(req("8.8.8.8")) == null, "공인 IPv4는 거절한다");
check(clientAddr(req("fd7a:115c:a1e0::1"))?.ip === "fd7a:115c:a1e0::1", "tailnet IPv6는 통과한다");
check(clientAddr(req("FD7A:115C:A1E0::2"))?.ip === "FD7A:115C:A1E0::2", "tailnet IPv6 대문자는 통과한다");
check(clientAddr(req("fd7a:115c:a1e1::1")) == null, "앞 48비트가 다르면 거절한다");
check(clientAddr(req("::ffff:100.67.1.2"))?.ip === "100.67.1.2", "IPv4-mapped CGNAT는 점 표기로 푼다");
check(clientAddr(req("::ffff:10.0.0.1")) == null, "IPv4-mapped 사설망은 거절한다");
check(clientAddr(req("::ffff:fd7a:1")) == null, "점 표기가 아닌 mapped 주소는 거절한다");
check(clientAddr(req("100.64.1.2%eth0")) == null, "zone id는 거절한다");
check(clientAddr(req("100.64.999.1")) == null, "옥텟이 벗어나면 거절한다");
check(clientAddr(req("")) == null, "빈 주소는 거절한다");
check(clientAddr(req("100.64.0.1extra")) == null, "주소 뒤 쓰레기는 거절한다");

console.log(`\n${fail === 0 ? "✅" : "❌"} client_addr: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
