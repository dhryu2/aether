/**
 * 설치본의 비밀번호 재설정. 설치한 컴퓨터의 파일을 쓸 수 있는 사람만 실행할 수 있어 원격에서는 쓸 수 없다.
 * 저장하면 해시로 만든 서명 키가 바뀌어 모든 기기의 로그인이 풀린다(auth/jwt.ts). 실행 중인 서버도 바로 새 값을 읽는다.
 */
import readline from "node:readline";
import bcrypt from "bcryptjs";
import { config } from "../config";
import { isValidNewPassword, savePasswordHash } from "../auth/passwordHash";

const TRIES = 3;
const ko = Intl.DateTimeFormat().resolvedOptions().locale.startsWith("ko");
const say = (korean: string, english: string) => process.stdout.write(`${ko ? korean : english}\n`);

export async function resetPassword(): Promise<number> {
  const tty = !!process.stdin.isTTY;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  // 입력한 글자를 화면에 그리지 않는다. Node의 readline에 공개된 끄기 옵션이 없어 scripts/hash-password.ts와 같은 방법을 쓴다.
  if (tty) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (korean: string, english: string) => {
    process.stdout.write(`${ko ? korean : english}: `);
    const { value, done } = await lines.next();
    if (tty) process.stdout.write("\n");
    return done ? null : String(value);
  };
  try {
    for (let i = 0; i < TRIES; i++) {
      const next = await ask("새 비밀번호(화면에 보이지 않습니다)", "New password (not shown on screen)");
      if (next === null) break;
      if (!isValidNewPassword(next)) {
        say("비밀번호는 8자 이상, 72바이트 이하여야 합니다.", "The password must be at least 8 characters and at most 72 bytes.");
        continue;
      }
      if ((await ask("한 번 더 입력", "Enter it again")) !== next) {
        say("두 번 입력한 값이 다릅니다.", "The two entries do not match.");
        continue;
      }
      savePasswordHash(await bcrypt.hash(next, config.bcryptCost));
      say("비밀번호를 바꿨습니다. 모든 기기에서 새 비밀번호로 다시 로그인하세요.", "Password changed. Sign in again on every device with the new password.");
      return 0;
    }
    say("비밀번호를 바꾸지 않았습니다.", "The password was not changed.");
    return 1;
  } finally {
    rl.close();
  }
}
