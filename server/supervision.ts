/**
 * 관리 앱이 서버를 자식으로 띄울 때의 약속: 부모 감시와 관리 토큰.
 * 환경 변수는 import 때 읽고 바로 지운다(에이전트 자식 프로세스가 물려받지 않게). 감시가 꺼져 있으면 아무 일도 하지 않는다.
 */
const rawToken = process.env.AETHER_ADMIN_TOKEN;
const watching = process.env.AETHER_PARENT_WATCH === "1";
delete process.env.AETHER_ADMIN_TOKEN;
delete process.env.AETHER_PARENT_WATCH;

/** 관리 API 토큰. 32자보다 짧으면 없는 것으로 본다. */
export const adminToken: string | undefined = rawToken && rawToken.length >= 32 ? rawToken : undefined;

/** 부모가 죽어 stdin이 닫히면 스스로 끝난다(SIGTERM). */
export function watchParent(): void {
  if (!watching) return;
  const stop = () => process.kill(process.pid, "SIGTERM");
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
  process.stdin.resume();
  process.stdout.on("error", () => {}); // 부모가 죽은 뒤 쓰기의 EPIPE가 치명 오류로 번지지 않게
}

/** 듣기 시작을 부모에게 알린다. 감시가 켜져 있을 때만 쓴다. */
export function announceListening(port: number, setup = false): void {
  if (watching) process.stdout.write(`aether-listening ${port}${setup ? " setup" : ""}\n`);
}
