/**
 * 앱 비밀번호 → bcrypt 해시 1회용 생성기. 해시(60자)만 stdout으로 출력.
 * 사용: `npm run hash:pw` 후 프롬프트에 비번 입력 → 출력된 해시를 .env의 AETHER_PASSWORD_HASH=에 붙여넣기.
 *   (파이프도 가능: `echo 'mypw' | npm run hash:pw`)
 * ⚠️ 평문 비번은 argv·파일·로그 어디에도 남기지 않는다(stdin만). 화면 입력은 미표시.
 */
import readline from "node:readline";
import bcrypt from "bcryptjs";
import { config } from "../config";

function emit(pw: string) {
  if (Buffer.byteLength(pw, "utf8") > 72) {
    process.stderr.write("⚠️ 72바이트 초과분은 bcrypt에서 무시됩니다.\n");
  }
  if (!pw) {
    process.stderr.write("빈 비밀번호는 거부됩니다.\n");
    process.exit(1);
  }
  process.stdout.write(bcrypt.hashSync(pw, config.bcryptCost) + "\n");
}

if (process.stdin.isTTY) {
  // 대화형: 입력 미표시(muted). 안내 문구는 stderr — stdout엔 해시만 남겨 `$(npm run -s hash:pw)`로 받게.
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  let muted = false;
  const out = rl as unknown as { _writeToOutput?: (s: string) => void };
  out._writeToOutput = (s) => {
    if (!muted) process.stderr.write(s);
  };
  rl.question("비밀번호 입력(미표시): ", (pw) => {
    process.stderr.write("\n");
    rl.close();
    emit(pw.trim());
  });
  muted = true;
} else {
  // 파이프: 첫 줄을 비번으로
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => emit(buf.split("\n")[0].trim()));
}
