/**
 * Phase 5 권한 diff preview 순수 단위 (Claude 0호출). buildMutationPreview를 임시파일로 직접 검증.
 * Edit/Write/NotebookEdit/MultiEdit · cwd경계 · 크기상한 · 바이너리 · 시크릿denylist · fail-closed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildMutationPreview } from "../providers/claude/mutationPreview";
import { previewFromDisk, readBefore } from "../sessions/mutationPreview";

// 자식 모드: FIFO를 읽다 멈추는지 보려고 따로 띄운 프로세스. 멈추면 부모가 timeout으로 실패 처리한다.
if (process.argv[2] === "fifo-child") {
  const target = process.argv[3];
  const b = readBefore(target);
  const p = previewFromDisk("write", target, "x", path.dirname(target));
  console.log("RESULT " + JSON.stringify({ binary: b.binary === true && b.before === null, previewBinary: p.binary === true }));
  process.exit(0);
}

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

// realpath — 프로덕션에서 LiveSession.cwd는 SessionManager.resolveWorkFolder가 realpath해 넘김(macOS /var 심볼릭 대응)
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-mp-")));
try {
  // T1 Edit diff(디스크 미접근)
  const e = buildMutationPreview("Edit", { file_path: "a.txt", old_string: "a\n", new_string: "b\n" }, cwd);
  check(e?.kind === "edit" && e.before === "a\n" && e.after === "b\n" && !e.replaceAll && Array.isArray(e.hunks), "T1 Edit diff(before/after/hunks)");
  // T2 replaceAll
  check(buildMutationPreview("Edit", { file_path: "a.txt", old_string: "a", new_string: "b", replace_all: true }, cwd)?.replaceAll === true, "T2 Edit replaceAll 플래그");
  // T3 Write 기존파일 before
  fs.writeFileSync(path.join(cwd, "exist.txt"), "old\n");
  const w = buildMutationPreview("Write", { file_path: "exist.txt", content: "new\n" }, cwd);
  check(w?.kind === "write" && w.before === "old\n" && w.after === "new\n" && w.isCreate === false && Array.isArray(w.hunks), "T3 Write 기존 before 읽기");
  // T4 Write 신규(before=null)
  const wn = buildMutationPreview("Write", { file_path: "newfile.txt", content: "hi" }, cwd);
  check(wn?.before === null && wn.isCreate === true, "T4 Write 신규 before=null,isCreate");
  // T5 cwd 경계 밖 → mutation 생략(내용 미노출)
  check(buildMutationPreview("Write", { file_path: "../../../etc/passwd", content: "x" }, cwd) === undefined, "T5 ../탈출 → mutation 생략");
  check(buildMutationPreview("Write", { file_path: "/etc/hosts", content: "x" }, cwd) === undefined, "T5 절대경로 밖 → mutation 생략");
  // T6 크기상한 truncate
  fs.writeFileSync(path.join(cwd, "big.txt"), "x".repeat(300 * 1024));
  const wbig = buildMutationPreview("Write", { file_path: "big.txt", content: "y" }, cwd);
  check(wbig?.truncated === true && (wbig.totalBytes ?? 0) > 256 * 1024 && (wbig.before?.length ?? 0) <= 256 * 1024, "T6 크기상한 truncate(hunks 생략)");
  check(wbig?.hunks === undefined, "T6 truncate 시 hunks 생략(부분 diff 오도 방지)");
  // T7 바이너리
  fs.writeFileSync(path.join(cwd, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
  const wbin = buildMutationPreview("Write", { file_path: "bin.dat", content: "y" }, cwd);
  check(wbin?.binary === true && wbin.before == null, "T7 바이너리 before 생략");
  // T8 시크릿 denylist(.env)
  fs.writeFileSync(path.join(cwd, ".env"), "SECRET=topsecret");
  check(buildMutationPreview("Write", { file_path: "auth.json", content: "x" }, cwd)?.redacted === true, "T8a auth.json redacted");
  const wenv = buildMutationPreview("Write", { file_path: ".env", content: "SECRET=newvalue" }, cwd);
  check(wenv?.redacted === true && wenv.before == null && wenv.after == null, "T8 .env redacted(before/after 생략)");
  check(!JSON.stringify(wenv ?? {}).includes("topsecret") && !JSON.stringify(wenv ?? {}).includes("newvalue"), "T8 시크릿 내용 payload 미포함(평문 차단)");
  // T9 fail-closed(깨진 input)
  check(buildMutationPreview("Write", {}, cwd) === undefined, "T9 file_path 누락 → undefined(fail-closed, throw 안 함)");
  // T10 NotebookEdit edit_mode 라벨
  fs.writeFileSync(path.join(cwd, "nb.ipynb"), JSON.stringify({ cells: [{ id: "c1", source: ["print(1)\n"] }] }));
  const nbR = buildMutationPreview("NotebookEdit", { notebook_path: "nb.ipynb", cell_id: "c1", new_source: "print(2)\n", edit_mode: "replace" }, cwd);
  check(nbR?.kind === "notebook" && nbR.before === "print(1)\n" && nbR.after === "print(2)\n", "T10 NotebookEdit replace 라벨");
  const nbI = buildMutationPreview("NotebookEdit", { notebook_path: "nb.ipynb", new_source: "new\n", edit_mode: "insert" }, cwd);
  check(nbI?.before === null && nbI.after === "new\n", "T10 NotebookEdit insert(before 없음)");
  const nbD = buildMutationPreview("NotebookEdit", { notebook_path: "nb.ipynb", cell_id: "c1", new_source: "", edit_mode: "delete" }, cwd);
  check(nbD?.before === "print(1)\n" && (nbD.after === undefined || nbD.after === ""), "T10 NotebookEdit delete(after 없음)");
  // T11 MultiEdit 순차누적
  fs.writeFileSync(path.join(cwd, "multi.txt"), "x");
  const me = buildMutationPreview("MultiEdit", { file_path: "multi.txt", edits: [{ old_string: "x", new_string: "y" }, { old_string: "y", new_string: "z" }] }, cwd);
  check(me?.kind === "multiedit" && me.after === "z", "T11 MultiEdit 순차누적(x→y→z)");

  // ── 리뷰 수정 회귀 가드 ──
  // R1 Edit 시크릿 redaction(이전엔 Edit만 denylist 누락 → 평문 노출)
  fs.writeFileSync(path.join(cwd, ".env"), "k=v");
  const editEnv = buildMutationPreview("Edit", { file_path: ".env", old_string: "SECRET_OLD", new_string: "SECRET_NEW" }, cwd);
  check(editEnv?.redacted === true && editEnv.before === undefined && editEnv.after === undefined, "R1 Edit .env redacted(before/after 생략)");
  check(!JSON.stringify(editEnv ?? {}).includes("SECRET_OLD") && !JSON.stringify(editEnv ?? {}).includes("SECRET_NEW"), "R1 Edit 시크릿 평문 미포함");
  // R2 Edit cwd 경계 밖 → mutation 생략
  check(buildMutationPreview("Edit", { file_path: "/etc/hosts", old_string: "a", new_string: "b" }, cwd) === undefined, "R2 Edit cwd 밖 → mutation 생략");
  // R3 대소문자 비구분 denylist(.ENV)
  const writeENV = buildMutationPreview("Write", { file_path: ".ENV", content: "x" }, cwd);
  check(writeENV?.redacted === true, "R3 .ENV(대문자) redacted(case-insensitive)");
  // R4 확장 denylist(.npmrc, id_rsa)
  fs.writeFileSync(path.join(cwd, ".npmrc"), "_authToken=tok");
  fs.writeFileSync(path.join(cwd, "id_rsa"), "PRIVATE");
  check(buildMutationPreview("Write", { file_path: ".npmrc", content: "x" }, cwd)?.redacted === true, "R4 .npmrc redacted");
  check(buildMutationPreview("Write", { file_path: "id_rsa", content: "x" }, cwd)?.redacted === true, "R4 id_rsa redacted");
  // R5 MultiEdit 미발견 → inexact
  fs.writeFileSync(path.join(cwd, "me2.txt"), "hello");
  const meInexact = buildMutationPreview("MultiEdit", { file_path: "me2.txt", edits: [{ old_string: "NOTFOUND", new_string: "z" }] }, cwd);
  check(meInexact?.inexact === true, "R5 MultiEdit 미발견 매치 → inexact 표기");

  // R6 FIFO·디렉터리 같은 일반 파일이 아닌 경로는 열지 않고 binary로 돌려준다(예전엔 FIFO open이 이벤트 루프를 영원히 막음)
  const mk = spawnSync("mkfifo", [path.join(cwd, "pipe")]);
  if (mk.status !== 0) {
    console.log("  ⏭️  R6 mkfifo 없음 — FIFO 시험 건너뜀");
  } else {
    const r = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, "fifo-child", path.join(cwd, "pipe")], { encoding: "utf8", timeout: 10_000 });
    const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    const res = line ? (JSON.parse(line.slice(7)) as { binary: boolean; previewBinary: boolean }) : null;
    check(res?.binary === true && res.previewBinary === true, "R6 FIFO는 멈추지 않고 binary로 즉시 돌려준다", `signal=${r.signal}`);
  }
  fs.mkdirSync(path.join(cwd, "adir"));
  check(readBefore(path.join(cwd, "adir")).binary === true, "R6 디렉터리도 binary(열지 않음)");
  check(readBefore(path.join(cwd, "exist.txt")).before === "old\n", "R6 일반 파일은 그대로 읽는다");
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}

console.log("─".repeat(50));
console.log(`Phase 5 mutation preview: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
