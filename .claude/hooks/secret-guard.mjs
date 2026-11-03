#!/usr/bin/env node
// Claude가 git 훅의 비밀값 검사를 건너뛰거나 끄는 명령을 막는다. 실제 내용 검사는 .githooks와 scripts/secret-scan.mjs가 한다.
// 이 시점에는 `git add x && git commit`에서 무엇이 커밋될지 아직 알 수 없어 내용 검사는 git 훅에 맡긴다.
import { spawnSync } from "node:child_process";

const input = JSON.parse(await new Response(process.stdin).text());
const cmd = input.tool_input?.command ?? "";
const deny = (why) => {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `비밀값 검사 보호: ${why}` } }));
  process.exit(0);
};
// 명령 조각 단위로 본다. 커밋 메시지 안의 글자에 걸리지 않도록 따옴표 안 내용은 지운다.
// core.hooksPath를 읽거나 .githooks로 켜는 명령은 검사를 끄지 않으므로 먼저 빼 둔다.
const ENABLE = /\bgit(?:\s+-C\s+\S+)?\s+config\s+(?:--local\s+)?core\.hooksPath(?:\s+["']?[^\s"';&|]*\/\.githooks\/?["']?)?\s*(?=$|[;&|\n])/gi;
const bare = cmd.replace(ENABLE, "").replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
for (const seg of bare.split(/&&|\|\||;|\||\n/)) {
  if (!/\bgit\b/.test(seg)) continue;
  // 하위 명령만 본다. git log --grep=commit 같은 인자에 걸리면 안 된다.
  const sub = /\bgit(?:\s+-[cC]\s+\S+|\s+--?\S+)*\s+([a-z-]+)/.exec(seg)?.[1];
  if (sub === "commit" && /\s(?:--no-v\w*|-[a-zA-Z]*n[a-zA-Z]*)(?=\s|$)/.test(seg)) deny("git commit의 --no-verify는 쓸 수 없습니다.");
  if (sub === "push" && /\s--no-v\w*(?=\s|$)/.test(seg)) deny("git push의 --no-verify는 쓸 수 없습니다.");
  if (/core\.hookspath/i.test(seg)) deny("core.hooksPath를 바꾸면 검사가 꺼집니다. 필요하면 사용자에게 요청하세요.");
  if ((sub === "commit" || sub === "push") && !spawnSync("git", ["-C", input.cwd ?? ".", "config", "core.hooksPath"], { encoding: "utf8" }).stdout.trim()) {
    deny("core.hooksPath가 설정되지 않아 검사가 돌지 않습니다. 저장소 폴더에서 git config core.hooksPath \"$PWD/.githooks\"를 사용자 확인 후 실행하세요.");
  }
}
// git을 거치지 않고 GitHub에 직접 파일을 올리면 훅이 돌지 않는다.
if (/\bgh\s+api\b/.test(cmd) && (/\/contents\//.test(cmd) || /\/git\/(?:blobs|trees|commits)\b/.test(cmd) || /createCommitOnBranch/.test(cmd)) && /(?:-X|--method)\s*(?:PUT|POST|PATCH)|createCommitOnBranch|\s-[fF]\s|--field|--raw-field|--input/.test(cmd)) {
  deny("gh api로 GitHub에 파일을 직접 올리면 비밀값 검사를 거치지 않습니다. git commit과 git push를 쓰세요.");
}
