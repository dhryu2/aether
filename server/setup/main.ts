/**
 * 설정 서버 시작. 127.0.0.1에만 묶고(환경변수 무시), 시작 포트부터 20개를 시도하다 안 되면 OS가 주는 포트를 쓴다.
 * 듣기 시작하면 바로가기를 쓰고 브라우저를 연다(AETHER_SETUP_NO_BROWSER=1이면 열지 않는다).
 */
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSetupApp, type SetupAppOptions } from "./app";
import { announceListening } from "../supervision";
import { openBrowser, writeShortcut } from "./desktop";

const TRIES = 20;

function listenOn(app: ReturnType<typeof createSetupApp>, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Express 5의 app.listen은 듣기 실패도 콜백으로 넘기므로 http.Server를 직접 만든다.
    const s = http.createServer(app);
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

export async function startSetupServer(
  o: Omit<SetupAppOptions, "getPort"> & { startPort: number; log: (m: string) => void },
): Promise<Server> {
  let port = 0;
  const app = createSetupApp({ ...o, getPort: () => port });
  let server: Server | undefined;
  for (let i = 0; i <= TRIES && !server; i++) {
    // 마지막 시도(i === TRIES)는 0번 포트 = OS가 비어 있는 포트를 준다.
    const want = i < TRIES ? o.startPort + i : 0;
    if (want > 65535) continue;
    try {
      port = want; // Host 검사가 쓰므로 듣기 전에 맞춘다(듣기 실패 시 다음 시도가 덮어쓴다)
      server = await listenOn(app, want);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" && (e as NodeJS.ErrnoException).code !== "EACCES") throw e;
    }
  }
  if (!server) throw new Error("설정 서버가 쓸 포트를 찾지 못했습니다.");
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/`;
  writeShortcut(o.paths.configDir, port);
  o.log(`첫 설정 서버가 ${url} 에서 기다립니다.`);
  announceListening(port, true);
  if (process.env.AETHER_SETUP_NO_BROWSER !== "1") openBrowser(url);
  return server;
}
