/**
 * Phase 5 영속 strip 순수 단위 (Claude 0). stripMutationForPersist가 diff 내용 제거·메타 보존·원본 불변 검증.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// codec은 설정을 읽으므로(자르기 상한) 데이터 폴더를 임시로 격리한 뒤 불러온다.
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-strip-"));

import { stripMutationForPersist, type AetherEvent } from "../types";
import { claudeCodec } from "../sessions/codec/claude";
import { codexCodec } from "../sessions/codec/codex";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  cond ? pass++ : fail++;
}

const ev = {
  seq: 5,
  ts: 1,
  kind: "permission_request",
  req: {
    id: "x",
    toolName: "Write",
    input: {},
    toolUseID: "t",
    createdAt: 1,
    mutation: {
      kind: "write",
      path: "a.txt",
      before: "secret-before-content",
      after: "secret-after-content",
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-secret-before-content", "+secret-after-content"] }],
      additions: 1,
      deletions: 1,
      isCreate: false,
    },
  },
} as unknown as AetherEvent;

const stripped = stripMutationForPersist(ev) as any;
check(stripped.req.mutation.before === undefined && stripped.req.mutation.after === undefined && stripped.req.mutation.hunks === undefined, "T12 strip: before/after/hunks 제거");
check(stripped.req.mutation.kind === "write" && stripped.req.mutation.path === "a.txt" && stripped.req.mutation.additions === 1 && stripped.req.mutation.isCreate === false, "T12 strip: 메타(kind/path/additions/플래그) 잔존");
check((ev as any).req.mutation.before === "secret-before-content", "T12 원본 ev 불변(얕은 복사)");
check(!JSON.stringify(stripped).includes("secret-before-content") && !JSON.stringify(stripped).includes("secret-after-content"), "T12 strip본 JSON에 시크릿 미포함");

const sdkEv = { seq: 1, ts: 1, kind: "sdk", msg: { type: "assistant" } } as unknown as AetherEvent;
check(stripMutationForPersist(sdkEv) === sdkEv, "T12 비대상(sdk) 이벤트는 원본 그대로");
const noMut = { seq: 2, ts: 1, kind: "permission_request", req: { id: "y", toolName: "Bash", input: { command: "ls" }, toolUseID: "t2", createdAt: 1 } } as unknown as AetherEvent;
check(stripMutationForPersist(noMut) === noMut, "T12 mutation 없는 비변이(Bash)는 원본 그대로");

// 리뷰 #1 회귀: 카드에 실린 도구 인자의 콘텐츠 필드도 영속에서 지운다(시크릿 평문 + 중복 차단).
//   8e 이동: 이 판정은 Claude 인자 이름을 알아야 해서 Claude 영속 축소기로 옮겼다. 그래서 검증도
//   실제 경로 그대로 codec을 통해 한다 — 공통 함수만 부르면 "옮긴 뒤에도 정말 지워지는가"를 못 본다.
const claudeFilter = claudeCodec.persistFilter();
const withInput = { seq: 3, ts: 1, kind: "permission_request", req: { id: "z", toolName: "Write", input: { file_path: ".env", content: "SECRET=plaintext" }, toolUseID: "t3", createdAt: 1, mutation: { kind: "write", path: ".env", redacted: true } } } as unknown as AetherEvent;
const s2 = claudeFilter.apply(stripMutationForPersist(withInput)) as any;
check(s2.req.input.content === undefined && s2.req.input.file_path === ".env", "T12b req.input.content strip(file_path는 메타로 잔존)");
check(!JSON.stringify(s2).includes("plaintext"), "T12b req.input 평문 시크릿 미영속");
check((withInput as any).req.input.content === "SECRET=plaintext", "T12b 원본 input 불변");
const editEv = { seq: 4, ts: 1, kind: "permission_request", req: { id: "w", toolName: "Edit", input: { file_path: "a.ts", old_string: "OLD", new_string: "NEW" }, toolUseID: "t4", createdAt: 1, mutation: { kind: "edit", path: "a.ts" } } } as unknown as AetherEvent;
const s3 = claudeFilter.apply(stripMutationForPersist(editEv)) as any;
check(s3.req.input.old_string === undefined && s3.req.input.new_string === undefined, "T12b Edit input old/new_string strip");

// 8e 회귀: 다른 provider의 도구 인자도 마스킹 없이 남지 않는다.
//   예전에는 지울 필드 목록이 Claude 인자 이름 고정이라, Codex 카드의 명령은 그대로 디스크에 적혔다.
const codexCard = {
  seq: 6,
  ts: 1,
  kind: "permission_request",
  req: { id: "c", toolName: "commandExecution", input: { command: 'curl -H "Authorization: Bearer sk-abcdefghij012345" https://x', cwd: "/tmp" }, toolUseID: "t6", createdAt: 1 },
} as unknown as AetherEvent;
const codexPersisted = codexCodec.persistFilter().apply(stripMutationForPersist(codexCard)) as any;
check(String(codexPersisted.req.input.command).includes("sk-abcdefghij012345"), "T12c 다른 provider의 카드 명령에 담긴 토큰도 영속본에 원문 그대로 남는다");
check(!String(codexPersisted.req.input.command).includes("[redacted]"), "T12c 가렸다는 표시가 없다");

console.log("─".repeat(50));
console.log(`Phase 5 persist strip: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
