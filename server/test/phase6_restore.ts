/**
 * Phase 6 부팅 복원/머지/손상격리/원자영속 단위 (Claude 0). 디스크에 가짜 세션을 깔고 검증.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-p6-data-")));
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-p6-root-")));
process.env.AETHER_DATA_DIR = DATA;
process.env.AETHER_PROJECT_ROOT = ROOT;

let pass = 0;
let fail = 0;
const check = (c: boolean, n: string, e = "") => { console.log(`  ${c ? "✅" : "❌"} ${n}${e ? " — " + e : ""}`); c ? pass++ : fail++; };

/** 사건은 임시 데이터베이스 일기에 넣고, meta.json만 디스크에 쓴다. */
async function mkSession(id: string, meta: any, events: any[]) {
  fs.mkdirSync(path.join(DATA, id), { recursive: true });
  if (meta !== null) fs.writeFileSync(path.join(DATA, id, "meta.json"), typeof meta === "string" ? meta : JSON.stringify(meta));
  const store = await import("../sessions/persistence");
  for (const e of events) store.appendEvent(id, e);
  // 실제 DB 재적재를 거쳐 읽기 목록이 저장된 행에서 만들어지게 한다.
  await (await import("../db/sessionDiary")).loadSessionDiary(id, path.join(DATA, id, "events.jsonl"));
}

async function main() {
  const { useTempDatabase } = await import("./support/tempDb");
  const tempDb = useTempDatabase("p6-restore");
  await (await import("../db/sessionDiary")).openSessionDiary();
  // ★ 이 픽스처는 **8d-1 이전 형식**이다(이어가기 식별자가 옛 이름 sdkSessionId). 즉 아래 복원 검증 전체가
  //   구 meta 승격 규칙(D12: 읽기 시 resumeKey로 올려주기)의 회귀 테스트를 겸한다. 새 이름 경로는 T5b가 본다.
  const meta = (id: string, extra: any = {}) => ({ id, cwd: ROOT, model: "haiku", sdkSessionId: `sid-${id}`, createdAt: 1000, ...extra });
  await mkSession("s_ended", meta("s_ended"), [{ seq: 1, ts: 1, kind: "status", status: "completed" }]);
  await mkSession("s_crashed", meta("s_crashed"), [{ seq: 2, ts: 1, kind: "status", status: "crashed" }]);
  await mkSession("s_interrupted", meta("s_interrupted"), [{ seq: 3, ts: 1, kind: "sdk", msg: { type: "assistant" } }]); // status 없음 + sdkSessionId 有
  await mkSession("s_nocwd", { id: "s_nocwd", model: "haiku" }, []); // cwd 결손 → corrupted
  await mkSession("s_badmeta", "{not json", []); // meta 깨짐 → corrupted
  const fileCwd = path.join(ROOT, "not-a-folder.txt");
  fs.writeFileSync(fileCwd, "x");
  const outsideCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aether-p6-outside-"))); // 기본 폴더 밖의 실재 폴더 — 범위 제한이 없으니 정상 세션이다
  await mkSession("s_outside", meta("s_outside", { cwd: outsideCwd }), [{ seq: 1, ts: 1, kind: "status", status: "completed" }]);
  await mkSession("s_badcwd", meta("s_badcwd", { cwd: fileCwd }), [{ seq: 1, ts: 1, kind: "sdk", msg: { type: "x" } }]); // cwd가 폴더가 아님(파일)
  const delCwd = path.join(ROOT, "deleted-sub");
  fs.mkdirSync(delCwd, { recursive: true });
  await mkSession("s_delcwd", meta("s_delcwd", { cwd: delCwd }), [{ seq: 1, ts: 1, kind: "sdk", msg: { type: "x" } }]);
  fs.rmSync(delCwd, { recursive: true, force: true }); // 한때 존재한 cwd 삭제 → restore 시점 corrupted(부재)
  // 유령 세션: 생성만 하고 메시지 0회(events 없음 + sdkSessionId 없음) → 복원 스킵 대상(재시작 부활 방지).
  await mkSession("s_phantom", { id: "s_phantom", cwd: ROOT, model: "haiku", createdAt: 1000 }, []);

  const { sessionManager } = await import("../sessions/SessionManager");
  const store = await import("../sessions/persistence");
  // 꼬리 판정은 provider codec이 한다(D2.6) — 이 스위트의 fixture는 전부 Claude 세션.
  const { claudeCodec } = await import("../sessions/codec/claude");

  // 부팅 복원
  const n = sessionManager.restoreFromDisk();
  check(n === 4, "T1 정상 디스크 세션 4개 복원(손상 4개 제외: nocwd/badmeta/badcwd/delcwd · 유령 s_phantom 제외)", `n=${n}`);
  // 리뷰 #3: resume 경로도 cwd 재검증(폴더가 아니면 throw)
  let threwBadCwd = false;
  try { sessionManager.getOrResume("s_badcwd"); } catch (e) { threwBadCwd = /손상/.test(String((e as Error).message)); }
  check(threwBadCwd, "R-#3 getOrResume(cwd가 파일) → throw(재검증)");
  check(sessionManager.list().find((s: any) => s.id === "s_outside")?.status !== "corrupted", "T3e 기본 폴더 밖 실재 폴더 cwd 세션은 복원 뒤 corrupted가 아니다(범위 제한 없음)");
  let outsideThrew = false;
  try { sessionManager.getOrResume("s_outside"); } catch { outsideThrew = true; }
  check(!outsideThrew, "T3e 기본 폴더 밖 cwd 세션의 getOrResume이 던지지 않는다");
  const byId: Record<string, any> = Object.fromEntries(sessionManager.list().map((s: any) => [s.id, s]));
  check(byId["s_ended"]?.status === "ended", "T2 completed → ended");
  check(byId["s_crashed"]?.status === "crashed", "T2 crashed → crashed");
  check(byId["s_interrupted"]?.status === "interrupted", "T2 status없음+sid → interrupted(진행중 턴 유실)");
  check(byId["s_nocwd"]?.status === "corrupted" && byId["s_badmeta"]?.status === "corrupted", "T3 cwd결손·깨진meta → corrupted(목록엔 노출)");
  check(byId["s_badcwd"]?.status === "corrupted" && byId["s_delcwd"]?.status === "corrupted", "T3c cwd가 폴더 아님(파일)·삭제된 cwd → restore 시점 corrupted 격리(use 시점까지 미룸 제거)");
  check(byId["s_ended"]?.displayName === "" || typeof byId["s_ended"]?.displayName === "string", "T3b displayName 존재");
  check(byId["s_phantom"] === undefined, "T3d 유령 세션(events 0·sdkSessionId 없음) → 복원 스킵(목록 제외, 재시작 부활 방지)");

  // ── T2b: 미완 턴(turnOpen) → 합성 status:interrupted 영속 + 멱등 ──
  const evLines = (id: string) => store.readEventsSince(id, 0);
  const lastEv = (id: string) => evLines(id).at(-1) as any;
  check(evLines("s_interrupted").length === 2, "T2b 미완 턴에 합성 이벤트 1개 append", `count=${evLines("s_interrupted").length}`);
  const le = lastEv("s_interrupted");
  check(le.kind === "status" && le.status === "interrupted" && le.seq === 4, "T2b 합성 = status:interrupted, seq=lastSeq+1", `kind=${le.kind} status=${le.status} seq=${le.seq}`);
  check(evLines("s_ended").length === 1 && evLines("s_crashed").length === 1, "T2b 종료(status) 세션엔 append 안 함(turnOpen=false)");
  // 멱등: 재복원해도 합성 이벤트 중복 append 없음(꼬리가 status가 됨 → turnOpen=false)
  sessionManager.restoreFromDisk();
  check(evLines("s_interrupted").length === 2, "T2b 멱등 — 재복원 시 중복 append 없음", `count=${evLines("s_interrupted").length}`);

  await mkSession("s_orphanq", meta("s_orphanq"), [
    { seq: 1, ts: 1, kind: "question_request", req: { id: "q-orphan", toolUseID: "ask-1", questions: [{ question: "색?", options: [] }], createdAt: 1 } },
    { seq: 2, ts: 2, kind: "permission_request", req: { id: "p-orphan", toolName: "Write", input: {}, toolUseID: "perm-1", createdAt: 1 } },
    { seq: 3, ts: 3, kind: "plan_request", req: { id: "pl-orphan", planId: "plan-1", text: "계획", createdAt: 1 } },
    { seq: 4, ts: 4, kind: "status", status: "completed" },
  ]);
  sessionManager.restoreFromDisk();
  const orphanKinds = evLines("s_orphanq").map((e) => e.kind);
  check(orphanKinds.includes("question_resolved") && orphanKinds.includes("permission_resolved") && orphanKinds.includes("plan_resolved"), "T2d 끝난 턴의 미해결 카드도 디스크에서 닫힌다", orphanKinds.join(","));
  const orphanQ = (evLines("s_orphanq") as any[]).find((e) => e.kind === "question_resolved");
  check(orphanQ?.id === "q-orphan" && orphanQ?.answered === false, "T2d 미해결 질문은 answered:false", JSON.stringify(orphanQ));
  check(lastEv("s_orphanq").kind === "status", "T2d 카드 정리 뒤 꼬리는 닫힌 턴이다", JSON.stringify(lastEv("s_orphanq")));
  const orphanCount = evLines("s_orphanq").length;
  sessionManager.restoreFromDisk();
  check(evLines("s_orphanq").length === orphanCount, "T2d 멱등 — 재복원 시 카드 정리를 중복하지 않는다", `count=${evLines("s_orphanq").length}`);

  // ── T2c: turnOpen 판정 단위(restore 후 생성 → 카운트 영향 없음) ──
  await mkSession("s_resulttail", meta("s_resulttail"), [{ seq: 9, ts: 1, kind: "sdk", msg: { type: "result", subtype: "success" } }]);
  await mkSession("s_noticetail", meta("s_noticetail"), [{ seq: 9, ts: 1, kind: "notice", notice: "resumed" }]);
  await mkSession("s_opentail", meta("s_opentail"), [{ seq: 9, ts: 1, kind: "permission_resolved", id: "x", decision: "allow" }]);
  check(store.tailInfo("s_resulttail", claudeCodec).turnOpen === false, "T2c sdk result 꼬리 → turnOpen=false(정상 턴 종료)");
  check(store.tailInfo("s_noticetail", claudeCodec).turnOpen === false, "T2c notice 꼬리 → turnOpen=false");
  check(store.tailInfo("s_opentail", claudeCodec).turnOpen === true, "T2c permission_resolved 꼬리 → turnOpen=true(미완)");

  // ── T2c++: 깨운 직후 들어오는 명령 목록 갱신은 턴을 열지 않는다(가짜 interrupted 반복 회귀 가드) ──
  await mkSession("s_cmdtail", meta("s_cmdtail"), [
    { seq: 8, ts: 1, kind: "notice", notice: "resumed" },
    { seq: 9, ts: 2, kind: "sdk", msg: { type: "system", subtype: "commands_changed", commands: [] } },
  ]);
  const tiCmd = store.tailInfo("s_cmdtail", claudeCodec);
  check(tiCmd.turnOpen === false, "T2c++ notice 뒤 commands_changed 꼬리 → turnOpen=false");
  check(tiCmd.lastNotice === "resumed" && tiCmd.lastSeq === 9, "T2c++ 마지막 알림 종류 resumed, lastSeq는 명령 갱신까지", `notice=${tiCmd.lastNotice} seq=${tiCmd.lastSeq}`);
  await mkSession("s_realopen", meta("s_realopen"), [{ seq: 9, ts: 2, kind: "sdk", msg: { type: "system", subtype: "init" } }]);
  check(store.tailInfo("s_realopen", claudeCodec).turnOpen === true, "T2c++ 다른 system 사건은 여전히 미완 턴");

  // ── T2c+: ctx 꼬리 투명 처리(result/status 뒤 ctx여도 turnOpen·status 판정 불변 — 회귀 가드) ──
  await mkSession("s_resultctxtail", meta("s_resultctxtail"), [
    { seq: 8, ts: 1, kind: "sdk", msg: { type: "result", subtype: "success" } },
    { seq: 9, ts: 2, kind: "ctx", totalTokens: 10, maxTokens: 100 },
  ]);
  const tiR = store.tailInfo("s_resultctxtail", claudeCodec);
  check(tiR.turnOpen === false, "T2c+ result 뒤 ctx 꼬리 → turnOpen=false(ctx 투명, 가짜 interrupted 방지)");
  check(tiR.lastStatus === undefined && tiR.lastSeq === 9, "T2c+ ctx가 lastStatus 오염 안 함 + lastSeq=ctx(9)");
  await mkSession("s_statusctxtail", meta("s_statusctxtail"), [
    { seq: 8, ts: 1, kind: "status", status: "completed" },
    { seq: 9, ts: 2, kind: "ctx", totalTokens: 10, maxTokens: 100 },
  ]);
  const tiS = store.tailInfo("s_statusctxtail", claudeCodec);
  check(tiS.turnOpen === false && tiS.lastStatus === "completed", "T2c+ status:completed 뒤 ctx 꼬리 → turnOpen=false + lastStatus=completed(ctx가 안 덮음)");

  // getOrResume throw 경로(Claude spawn 없이)
  let threwNF = false;
  try { sessionManager.getOrResume("nonexistent"); } catch { threwNF = true; }
  check(threwNF, "T4 getOrResume(없음) → throw");
  let threwCorr = false;
  try { sessionManager.getOrResume("s_nocwd"); } catch (e) { threwCorr = /손상/.test(String((e as Error).message)); }
  check(threwCorr, "T4 getOrResume(corrupted) → throw(손상)");

  // 원자 saveMeta(temp 잔여 없음)
  store.saveMeta({ id: "s_atomic", cwd: ROOT, model: "haiku", resumeKey: "x", createdAt: 1 });
  check(fs.existsSync(path.join(DATA, "s_atomic", "meta.json")) && !fs.existsSync(path.join(DATA, "s_atomic", "meta.json.tmp")), "T5 saveMeta 원자(tmp 잔여 없음)");
  check(JSON.parse(fs.readFileSync(path.join(DATA, "s_atomic", "meta.json"), "utf8")).resumeKey === "x", "T5 saveMeta 내용 정확");

  // ── T5b: 이어가기 식별자 이름 통일(D12) — 승격은 읽기 한 곳에서만, 쓰기는 새 이름으로만 ──
  await mkSession("s_oldmeta", { id: "s_oldmeta", cwd: ROOT, model: "haiku", sdkSessionId: "old-key", createdAt: 1000 }, []);
  const promoted = store.loadMeta("s_oldmeta")!;
  check(promoted.resumeKey === "old-key", "T5b 구 meta(sdkSessionId만) → 읽을 때 resumeKey로 승격");
  check(promoted.sdkSessionId === undefined, "T5b 승격 후 옛 이름은 걷어냄(코어가 provider 용어를 보지 않음)");
  await mkSession("s_newmeta", { id: "s_newmeta", cwd: ROOT, model: "haiku", resumeKey: "new-key", sdkSessionId: "stale", createdAt: 1000 }, []);
  check(store.loadMeta("s_newmeta")!.resumeKey === "new-key", "T5b 새 이름이 있으면 옛 이름보다 우선");
  store.saveMeta(promoted);
  const rewritten = JSON.parse(fs.readFileSync(path.join(DATA, "s_oldmeta", "meta.json"), "utf8"));
  check(rewritten.resumeKey === "old-key" && !("sdkSessionId" in rewritten), "T5b 다시 저장하면 새 이름으로만 기록(무마이그레이션 자연 전환)");
  await mkSession("s_nokey", { id: "s_nokey", cwd: ROOT, model: "haiku", createdAt: 1000 }, []);
  check(store.loadMeta("s_nokey")!.resumeKey === undefined, "T5b 둘 다 없으면 resumeKey 미부여(유령 세션 판정 보존)");

  tempDb.dispose();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log("─".repeat(50));
  console.log(`Phase 6 restore: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("오류:", e); process.exit(1); });
