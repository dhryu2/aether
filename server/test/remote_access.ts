/**
 * 폰에서 쓰기(tailscale serve) 시험. 가짜 tailscale 실행 파일을 쓴다. 실제 망 설정은 건드리지 않는다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform === "win32") { console.log("윈도우에서는 건너뛴다(가짜 실행 파일이 셸 스크립트)"); process.exit(0); }

const { config } = await import("../config");
const { disableRemoteAccess, enableRemoteAccess, remoteAccessStatus } = await import("../remote/tailscaleServe");
const { resetTailscaleCliCache } = await import("../auth/tailscale");

let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!cond) failed++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-remote-"));
const cli = path.join(dir, "tailscale");
const file = (name: string) => path.join(dir, name);
const write = (name: string, value: string) => fs.writeFileSync(file(name), value);
const c = config as { port: number; host: string; authMode: string; tailscaleCli: string };
Object.assign(c, { port: 18787, host: "127.0.0.1", authMode: "password", tailscaleCli: cli });

// status 파일과 serve 파일이 곧 망 상태다. mode 파일이 켜기 명령의 행동을 정한다.
const HOST = "box.example.ts.net";
const serving = (front: number, target: number) => JSON.stringify({ TCP: { [front]: { HTTPS: true } }, Web: { [`${HOST}:${front}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${target}` } } } } });
fs.writeFileSync(cli, `#!/bin/sh
D='${dir}'
echo "$*" >> "$D/calls"
case "$1 $2" in
  "status --json") [ -f "$D/down" ] && exit 1; cat "$D/status"; exit 0;;
  "serve status") cat "$D/serve"; exit 0;;
esac
case "$*" in
  *" off") echo '{}' > "$D/serve"; exit 0;;
esac
case "$(cat "$D/mode")" in
  ok) printf '%s' '${serving(18787, 18787)}' > "$D/serve"; exit 0;;
  denied) echo 'Access denied: serve config denied' >&2; exit 1;;
  noWait) echo 'Ask your admin'; echo; echo '  https://login.example.com/f/serve?node=1'; echo; exit 0;;
  consent)
    echo 'Serve is not enabled on your tailnet.'; echo '  https://login.example.com/f/serve?node=1'; echo; echo 'Waiting...'
    while [ ! -f "$D/approved" ]; do sleep 0.05; done
    printf '%s' '${serving(18787, 18787)}' > "$D/serve"; exit 0;;
esac
`, { mode: 0o755 });
const running = JSON.stringify({ BackendState: "Running", Self: { DNSName: `${HOST}.` } });
const reset = (mode = "ok") => { write("status", running); write("serve", "{}"); write("mode", mode); fs.rmSync(file("calls"), { force: true }); fs.rmSync(file("approved"), { force: true }); fs.rmSync(file("down"), { force: true }); };
const calls = () => { try { return fs.readFileSync(file("calls"), "utf8"); } catch { return ""; } };
const servedCommand = "serve --bg --https=18787 http://127.0.0.1:18787";

try {
  reset();
  c.authMode = "off";
  ok("인증 off면 쓸 수 없다", (await remoteAccessStatus()).state === "unsupported");
  ok("인증 off면 켜기가 CLI를 부르지 않는다", (await enableRemoteAccess()).state === "unsupported" && calls() === "", calls());
  c.authMode = "tailscale";
  ok("tailscale 인증이면 쓸 수 없다", (await remoteAccessStatus()).state === "unsupported");
  c.authMode = "password";
  c.host = "192.0.2.1";
  ok("루프백이 아니면 쓸 수 없다", (await remoteAccessStatus()).state === "unsupported");
  c.host = "127.0.0.1";

  c.tailscaleCli = "";
  resetTailscaleCliCache();
  const pathBefore = process.env.PATH;
  process.env.PATH = dir + "/none";
  const none = await remoteAccessStatus();
  process.env.PATH = pathBefore;
  c.tailscaleCli = cli;
  // 시험 기기에 Tailscale 앱이 있으면 알려진 위치에서 찾으므로 그때는 이 항목을 판정하지 않는다.
  if (!fs.existsSync("/Applications/Tailscale.app")) ok("실행 파일이 없으면 noTailscale", none.state === "noTailscale", none);

  write("down", "");
  ok("데몬이 꺼져 있으면 offline", (await remoteAccessStatus()).state === "offline");
  reset();
  write("status", JSON.stringify({ BackendState: "Stopped" }));
  ok("로그아웃 상태면 offline", (await remoteAccessStatus()).state === "offline");

  reset();
  ok("설정이 없으면 off", (await remoteAccessStatus()).state === "off");
  const on = await enableRemoteAccess();
  ok("켜면 주소가 나온다", on.state === "on" && on.url === `https://${HOST}:18787`, on);
  ok("켜기 명령이 포트와 대상을 맞게 쓴다", calls().includes(servedCommand), calls());
  const off = await disableRemoteAccess();
  ok("끄면 off로 돌아간다", off.state === "off" && calls().includes("serve --https=18787 off"), calls());

  reset();
  write("serve", serving(443, 18787));
  const front = await remoteAccessStatus();
  ok("직접 443으로 열어 둔 것도 켜짐으로 본다", front.state === "on" && front.url === `https://${HOST}`, front);
  await disableRemoteAccess();
  ok("끌 때 그 앞문 포트를 쓴다", calls().includes("serve --https=443 off"), calls());

  reset();
  write("serve", serving(18787, 9999));
  ok("같은 포트를 남이 쓰면 conflict", (await remoteAccessStatus()).state === "conflict");
  await enableRemoteAccess();
  ok("conflict면 덮어쓰지 않는다", !calls().includes(servedCommand), calls());

  reset("denied");
  const denied = await enableRemoteAccess();
  ok("거절되면 CLI의 오류와 명령을 돌려준다", denied.state === "off" && !!denied.error?.includes("Access denied") && denied.command === `tailscale ${servedCommand}`, denied);
  reset();
  ok("다시 켜면 앞 오류가 사라진다", !(await enableRemoteAccess()).error);
  await disableRemoteAccess();

  reset("noWait");
  const noWait = await enableRemoteAccess();
  ok("기다리지 않는 CLI는 링크만 남기고 다시 켤 수 있다", noWait.state === "off" && noWait.consentUrl === "https://login.example.com/f/serve?node=1", noWait);

  reset("consent");
  const waiting = await enableRemoteAccess();
  ok("허용 전에는 링크와 함께 먼저 답한다", waiting.state === "consent" && waiting.consentUrl === "https://login.example.com/f/serve?node=1", waiting);
  ok("대기 중 다시 눌러도 프로세스를 늘리지 않는다", (await enableRemoteAccess()).state === "consent" && calls().split(servedCommand).length === 2, calls());
  write("approved", "");
  let after = await remoteAccessStatus();
  for (let i = 0; i < 100 && after.state !== "on"; i++) { await new Promise((r) => setTimeout(r, 50)); after = await remoteAccessStatus(); }
  ok("허용되면 저절로 켜지고 링크가 사라진다", after.state === "on" && !after.consentUrl, after);
  await disableRemoteAccess();

  reset("consent");
  await enableRemoteAccess();
  const cancelled = await disableRemoteAccess();
  ok("대기를 취소하면 오류 없이 off", cancelled.state === "off" && !cancelled.error && !cancelled.consentUrl, cancelled);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `실패 ${failed}건` : "모두 통과");
process.exit(failed ? 1 : 0);
