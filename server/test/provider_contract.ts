/**
 * provider 계약 테스트 (Phase 8d-2 완료 게이트 ③) — 모델 호출 0.
 *
 * Claude가 아닌 가짜 세 번째 provider를 등록표에 끼운 뒤, 코어를 한 줄도 안 고치고
 *   세션 생성 → 입력 → 정규화 → 영속(축소 포함) → SSE replay → 검색 색인 → 턴 종료 판정
 *   → 재시작 복원(꼬리 판정·축소기 재수화) → 권한 왕복 → 정리
 * 가 전부 성립하는지 본다. 실 Codex 슬롯은 덮지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 세션·검색이 건드릴 디스크를 임시 디렉터리로 격리 — config import보다 먼저 세팅해야 한다.
process.env.AETHER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "aether-contract-"));

const { config } = await import("../config");
const { __registerProviderForTest, providerEntry, codecFor } = await import("../providers/registry");
const { sessionManager } = await import("../sessions/SessionManager");
await (await import("./support/tempDb")).useTempDiary("provider_contract"); // 임시 SQLite 일기
const store = await import("../sessions/persistence");
const { toWireEvent } = await import("../sessions/wireEvent");
const { extractIndexable } = await import("../search/extract");
const mock = await import("./support/mockProvider");
const { isControlEvent } = await import("../types");
type MockRaw = import("./support/mockProvider").MockRaw;

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${cond || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/**
 * 비동기 이벤트를 기다리되, 마감 실패 때 원인을 남긴다.
 * 관측 함수를 필수로 둬서 새 대기 검사가 실패 이유 없이 끝나는 것을 타입 단계에서 막는다.
 */
async function checkUntil(name: string, cond: () => boolean, observe: () => Record<string, unknown>, ms = 2000): Promise<void> {
  const t0 = Date.now();
  let passed = false;
  while (Date.now() - t0 < ms) {
    if (cond()) {
      passed = true;
      break;
    }
    await sleep(10);
  }
  if (!passed) passed = cond();

  const elapsedMs = Date.now() - t0;
  if (passed) {
    // 마감의 절반을 넘긴 통과는 다음 실패의 전조일 수 있어, 성공으로 숨기지 않는다.
    if (elapsedMs > ms / 2) console.warn(`  ⚠️ [대기-여유부족] ${name} — ${elapsedMs}ms 경과 / ${ms}ms 마감`);
    check(true, name);
    return;
  }

  let observed: Record<string, unknown>;
  try {
    observed = observe();
  } catch (error) {
    // 아직 만들어지지 않은 파일을 읽는 관측이 실패해도, 원래 검사 실패 기록은 남긴다.
    observed = { 관측오류: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  check(false, name, { 조건이름: name, 경과시간ms: elapsedMs, 마감시간ms: ms, 관측상태: observed });
}

const unregister = __registerProviderForTest(mock.mockEntry);
const cwd = config.projectRootReal ?? config.projectRoot;

try {
  // ── 1. 등록표가 실 Claude·실 Codex와 가짜 세 번째를 동시에 든다 ──
  check(providerEntry(mock.MOCK_PROVIDER).id === mock.MOCK_PROVIDER, "가짜 세 번째 provider가 등록표에서 조회된다");
  check(providerEntry("claude").id === "claude", "Claude 항목은 그대로다(등록이 기존 provider를 밀어내지 않음)");
  check(providerEntry("codex").id === "codex", "실 Codex 슬롯은 가짜와 동시에 남아 있다");
  check(providerEntry("codex").codec !== mock.mockCodec, "실 Codex를 가짜로 덮지 않았다");
  check(codecFor(mock.MOCK_PROVIDER) === providerEntry(mock.MOCK_PROVIDER).codec && codecFor(mock.MOCK_PROVIDER).provider === mock.MOCK_PROVIDER, "세션 없는 경로도 meta의 provider로 codec을 고른다");

  // ── 2. 이어가기 식별자 형식 판정이 provider 몫인가 ──
  check(providerEntry(mock.MOCK_PROVIDER).isValidResumeKey("mock-thread-9") === true, "가짜 provider 형식의 이어가기 키는 통과");
  check(
    providerEntry(mock.MOCK_PROVIDER).isValidResumeKey("11111111-2222-3333-4444-555555555555") === false,
    "Claude(UUID) 형식 키는 이 provider에서 거부 — 코어의 UUID 정규식이 새지 않았다",
  );
  let rejected = false;
  try {
    sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER, resume: "not-a-mock-key" });
  } catch {
    rejected = true;
  }
  check(rejected, "형식이 어긋난 이어가기 키로는 세션이 안 만들어진다");

  // ── 3. 세션 생성 — 코어가 가짜 runtime을 스폰한다 ──
  const s = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  check(s.provider === mock.MOCK_PROVIDER, "세션의 provider가 고정됐다");
  check(s.codec === providerEntry(mock.MOCK_PROVIDER).codec, "세션이 그 provider의 codec을 든다");
  const meta0 = store.loadMeta(s.id);
  check(meta0?.provider === mock.MOCK_PROVIDER, "meta.json에 provider가 적힌다", meta0?.provider);
  await checkUntil(
    "runtime이 알린 이어가기 키가 영속된다",
    () => store.loadMeta(s.id)?.resumeKey === mock.MOCK_RESUME_KEY,
    () => ({ 세션ID: s.id, 메타: store.loadMeta(s.id) ?? null }),
  );

  // ── 3b. 명령 목록·실행도 같은 provider 인터페이스를 타는가 ──
  const commands = await s.listCommands();
  check(commands.some((c) => c.name === "model") && commands.some((c) => c.name === "mock-ping"), "공통 명령과 가짜 provider 명령이 한 카탈로그로 합쳐진다", commands);
  check(commands.some((c) => c.name === "clear" && !c.uiAction), "/clear는 공통 화면 초기화가 아니라 provider 명령이다", commands);
  const unknownCommand = await s.executeCommand({ name: "unknown-command", arguments: "" });
  check(!unknownCommand.accepted, "모르는 명령은 일반 메시지로 폴백하지 않는다", unknownCommand);
  const mockCommand = await s.executeCommand({ name: "mock-ping", arguments: "payload" });
  check(mockCommand.accepted && mock.mockState.commandCalls.at(-1)?.arguments === "payload", "가짜 provider 명령 실행이 adapter에 도달한다", mock.mockState.commandCalls.at(-1));
  const clearCommand = await s.executeCommand({ name: "clear", arguments: "" });
  check(clearCommand.accepted && mock.mockState.commandCalls.at(-1)?.name === "clear", "/clear가 adapter에 도달한다", mock.mockState.commandCalls.at(-1));
  const turnCommand = await s.executeCommand({ name: "mock-turn", arguments: "payload" });
  const commandInput = s.replaySince(0).find((ev) => isControlEvent(ev, "user_msg") && ev.text === "/mock-turn payload");
  check(turnCommand.accepted && turnCommand.startsTurn && !!commandInput, "턴 시작 명령도 일반 입력과 같은 영속·SSE 사용자 기록을 남긴다", commandInput);
  const operationCommand = await s.executeCommand({ name: "mock-operation", arguments: "" });
  check(operationCommand.accepted, "비턴 operation 명령도 provider adapter에 도달한다", operationCommand);
  check(
    s.replaySince(0).some((ev) => isControlEvent(ev, "command_operation") && ev.state === "started" && ev.blocksInput),
    "runtime operation 시작이 공통 영속·SSE 사건으로 바뀐다",
  );
  await checkUntil(
    "runtime operation 완료도 같은 공통 사건으로 영속된다",
    () => s.replaySince(0).some((ev) => isControlEvent(ev, "command_operation") && ev.state === "completed"),
    () => ({ operations: s.replaySince(0).filter((ev) => ev.kind === "command_operation") }),
  );

  // ── 4. 입력 → 원본 이벤트 → 정규화 ──
  const seen: { seq: number; kind: string }[] = [];
  const unsub = s.subscribe((ev) => seen.push({ seq: ev.seq, kind: ev.kind }));
  s.push("hello world");
  await checkUntil(
    "턴 종료가 감지돼 컨텍스트 갱신까지 이어진다(codec.endsTurn)",
    () => seen.some((e) => e.kind === "ctx"),
    () => ({ 이벤트수: seen.length, 이벤트: seen }),
  );
  await s.waitHandshake(2000);
  check(
    !fs.existsSync(path.join(config.dataDir, `background-model-${mock.MOCK_PROVIDER}.json`)),
    "준비 신호의 모델 목록으로 배경 작업 모델 파일을 더는 만들지 않는다",
  );
  {
    // 이미 열린 세션도 목록을 다시 요청하면 그 시점의 기억으로 합친다(계획 7.2절).
    const catalog = await import("../providers/modelCatalogMemory");
    const first = await s.listModels(2000);
    catalog.rememberModelList(mock.MOCK_PROVIDER, [...first, { value: "mock-extra", displayName: "Mock Extra" }]);
    const again = await s.listModels(2000);
    check(again.some((r) => r.value === "mock-extra" && r.remembered === true), "열린 세션의 목록 재요청에 기억한 줄이 합쳐진다", again.map((r) => r.value));

    // 준비 신호 결과를 재사용하는 runtime: 같은 결과를 다시 받아도 다른 세션의 새 관측을 덮지 않는다.
    mock.mockState.reuseHandshake = true;
    await s.listModels(2000); // 재사용할 결과를 처음 받는다(새 결과라 기억한다)
    const v0 = first[0].value;
    catalog.rememberModelList(mock.MOCK_PROVIDER, [{ ...first[0], displayName: "새 관측 이름" }], Date.now() + 1000);
    await s.listModels(2000); // 같은 결과 — 기억하지 않는다
    catalog.resetModelCatalogMemory();
    const saved = JSON.parse(fs.readFileSync(path.join(config.dataDir, `model-catalog-${mock.MOCK_PROVIDER}.json`), "utf8"));
    check(saved.rows[v0]?.row?.displayName === "새 관측 이름", "같은 준비 신호를 다시 받아도 기억을 옛 값으로 되돌리지 않는다", saved.rows[v0]);
    mock.mockState.reuseHandshake = false;
  }

  const all = store.readEventsSince(s.id, 0);
  const rawKinds = all.map((e) => e.kind);
  check(rawKinds.includes(mock.MOCK_PROVIDER), "Claude가 아닌 원본 이벤트가 그대로 영속된다", rawKinds);
  check(!all.some((e) => (e as { msg?: MockRaw }).msg?.t === "peek"), "라이브 전용 이벤트는 디스크에 없다(codec.isLiveOnly)");
  check(
    seen.filter((e) => e.kind === mock.MOCK_PROVIDER).length > all.filter((e) => e.kind === mock.MOCK_PROVIDER).length,
    "라이브 SSE엔 미리보기가 나가고 디스크엔 안 남는다(두 경로 비대칭이 provider별로 성립)",
  );

  // ── 4b. 인증 만료 배너는 턴 종료가 아닌 이벤트에서도 떠야 한다(8e 외부 검토 지적) ──
  //   만료를 별도 오류 알림으로 먼저 알리는 provider가 있다. 세션이 턴 종료에서만 확인하면 그런 provider는
  //   재인증 안내가 영영 안 뜨고, 사용자는 이유 없이 계속 실패하는 세션을 보게 된다.
  s.push(mock.MOCK_AUTH_EXPIRED);
  await checkUntil(
    "턴을 끝내지 않는 이벤트로 온 인증 만료도 재인증 안내로 이어진다",
    () => store.readEventsSince(s.id, 0).some((e) => e.kind === "notice" && (e as { notice?: string }).notice === "auth_expired"),
    () => {
      const events = store.readEventsSince(s.id, 0);
      return { 이벤트수: events.length, 이벤트종류: events.map((e) => e.kind), 알림: events.filter((e) => e.kind === "notice") };
    },
  );

  const sayEv = all.find((e) => (e as { msg?: MockRaw }).msg?.t === "say")!;
  const wire = toWireEvent(sayEv, s.codec) as { kind?: string; msg?: unknown; events?: { type: string; text?: string; provider: string }[] };
  check(wire.events?.[0]?.type === "text" && wire.events[0].text === "hello world", "SSE 봉투가 가짜 codec의 정규화 결과를 싣는다", wire.events?.[0]);
  check(wire.events?.[0]?.provider === mock.MOCK_PROVIDER, "정규화 이벤트에 provider가 찍힌다");
  check(!("msg" in wire) && wire.msg === undefined, "클라이언트 봉투에 원본 msg가 없다", wire);
  check(wire.kind === "agent", "모델 사건의 클라이언트 kind는 agent다", wire.kind);

  const indexed = extractIndexable(sayEv, s.codec).items;
  check(indexed.length === 1 && indexed[0].content === "hello world", "검색 색인도 같은 codec을 지난다", indexed);

  // ── 4c. 할 일 도구 — 코어를 안 고치고 가짜 provider에서도 목록 사건이 정규화·재생·복원된다 ──
  s.push("TODO:completed:읽기|in_progress:고치기");
  const todoItems = (evs: AetherEventLike[]) =>
    evs.filter((e) => e.kind === "todo_list").map((e) => toWireEvent(e as never, s.codec) as { kind?: string; events?: { type: string; items?: unknown }[] });
  type AetherEventLike = { kind: string };
  await checkUntil(
    "할 일 도구 호출이 todo_list 사건으로 남아 plan_update로 나간다",
    () => todoItems(s.replaySince(0)).length === 1,
    () => ({ 종류: s.replaySince(0).map((e) => e.kind) }),
  );
  const todoWire = todoItems(s.replaySince(0))[0];
  check(todoWire.kind === "agent" && todoWire.events?.[0]?.type === "plan_update", "목록은 kind:agent 봉투의 plan_update로 나간다", todoWire);
  check(
    JSON.stringify(todoWire.events?.[0]?.items) === JSON.stringify([{ text: "읽기", status: "completed" }, { text: "고치기", status: "in_progress" }]),
    "항목과 상태가 그대로 실린다",
    todoWire.events?.[0],
  );
  s.push("TODO:done:틀린 상태");
  await checkUntil(
    "잘못된 입력은 목록 사건을 만들지 않는다",
    () => s.replaySince(0).some((e) => e.kind === mock.MOCK_PROVIDER && (e as { msg?: MockRaw }).msg?.text?.includes("갱신하지 못했다")),
    () => ({ 종류: s.replaySince(0).map((e) => e.kind) }),
  );
  check(todoItems(s.replaySince(0)).length === 1, "목록 사건은 여전히 1건이다");

  // ── 5. replay가 라이브 전용을 빼는가(메모리 분기) ──
  const replayed = s.replaySince(0);
  check(!replayed.some((e) => (e as { msg?: MockRaw }).msg?.t === "peek"), "replay에서도 라이브 전용은 빠진다");

  // ── 6. 영속 축소기의 이벤트 간 상태 ──
  s.push("SECRET open the vault");
  await checkUntil(
    "두 번째 턴이 영속됐다",
    () => store.readEventsSince(s.id, 0).filter((e) => (e as { msg?: MockRaw }).msg?.t === "say").length >= 2,
    () => {
      const events = store.readEventsSince(s.id, 0);
      return { 이벤트수: events.length, 이벤트종류: events.map((e) => e.kind), 말이벤트수: events.filter((e) => (e as { msg?: MockRaw }).msg?.t === "say").length };
    },
  );
  s.push("follow up after secret");
  await checkUntil(
    "시크릿 다음 이벤트가 디스크에서 가려진다(축소기가 상태를 든다)",
    () => store.readEventsSince(s.id, 0).some((e) => (e as { msg?: MockRaw }).msg?.text === mock.MOCK_REDACTED),
    () => {
      const events = store.readEventsSince(s.id, 0);
      return {
        이벤트수: events.length,
        이벤트종류: events.map((e) => e.kind),
        본문: events.map((e) => ({ 종류: e.kind, 본문: (e as { msg?: MockRaw }).msg?.text ?? null })),
      };
    },
  );
  check(
    seen.length > 0 && !store.readEventsSince(s.id, 0).some((e) => (e as { msg?: MockRaw }).msg?.text === "follow up after secret"),
    "가려진 본문이 평문으로 남지 않았다",
  );
  unsub();

  // ── 7. 턴 종료 꼬리 판정 — 세션 인스턴스 없이 meta의 provider로 ──
  const tail = store.tailInfo(s.id, codecFor(mock.MOCK_PROVIDER));
  check(tail.turnOpen === false, "정상 종료한 꼬리를 '미완 턴'으로 오판하지 않는다", tail);

  // ── 8. 재시작 복원 ──
  const sessionId = s.id;
  // 디스크는 남긴 채 라이브 핸들만 놓는다(복원 경로를 봐야 하므로 세션을 지우지 않는다).
  s.dispose();
  check(mock.mockState.disposeCalls === 1, "세션 정리가 runtime.dispose를 부른다");
  await s.dispose(); // 멱등이어야 한다 — 두 번 불러도 카운터가 안 오른다
  check(mock.mockState.disposeCalls === 1, "runtime.dispose는 멱등이다");

  const restoredCount = sessionManager.restoreFromDisk();
  check(restoredCount >= 0, "복원 스캔이 가짜 provider 세션에서 예외 없이 끝난다");
  const listed = sessionManager.list().find((x) => x.id === sessionId);
  check(!!listed, "가짜 provider 세션이 목록에 뜬다");
  check(listed?.status !== "corrupted", "미등록 provider로 오독돼 corrupted로 격리되지 않는다", listed?.status);

  check(
    store.readEventsSince(sessionId, 0).some((e) => e.kind === "todo_list"),
    "목록 사건은 디스크에 남아 재시작 뒤에도 읽힌다",
  );

  // ── 9. 축소기 재수화: 시크릿 뒤 재시작에서도 다음 이벤트가 가려지는가 ──
  const filter = mock.mockCodec.persistFilter();
  for (const ev of store.readRecentEvents(sessionId)) filter.restore(ev);
  const afterRestart = filter.apply({ seq: 999, ts: Date.now(), kind: mock.MOCK_PROVIDER, msg: { t: "say", text: "post restart" } } as never) as { msg: MockRaw } | null;
  // 마지막 say가 시크릿을 건드리지 않았으므로 가려지면 안 된다 — 상태가 '항상 가림'으로 굳지 않았는지 확인.
  check(afterRestart?.msg.text === "post restart", "재수화된 축소기가 무조건 가리지 않는다", afterRestart?.msg);
  const armed = mock.mockCodec.persistFilter();
  armed.restore({ seq: 1, ts: 1, kind: mock.MOCK_PROVIDER, msg: { t: "say", text: "SECRET x", touchedSecret: true } } as never);
  const hidden = armed.apply({ seq: 2, ts: 2, kind: mock.MOCK_PROVIDER, msg: { t: "say", text: "leak" } } as never) as { msg: MockRaw } | null;
  check(hidden?.msg.text === mock.MOCK_REDACTED, "시크릿 꼬리를 관측하면 재시작 뒤에도 다음 이벤트를 가린다", hidden?.msg);

  // ── 10. 권한 왕복(promise-hold) ──
  const s2 = sessionManager.create({ cwd, provider: mock.MOCK_PROVIDER });
  s2.push("ASK:/tmp/mock.txt");
  await checkUntil(
    "가짜 runtime의 승인 요청이 카드로 뜬다",
    () => s2.pendingPermissions().length === 1,
    () => ({ 세션ID: s2.id, 대기승인수: s2.pendingPermissions().length, 대기승인: s2.pendingPermissions() }),
  );
  const card = s2.pendingPermissions()[0];
  check(card.toolName === "mock_write", "카드가 provider의 도구 이름을 그대로 싣는다", card.toolName);
  check(s2.resolvePermission(card.id, "deny"), "카드에 거부로 답할 수 있다");
  await checkUntil(
    "거부 결과가 runtime으로 돌아간다",
    () => store.readEventsSince(s2.id, 0).some((e) => (e as { msg?: MockRaw }).msg?.text === "denied"),
    () => {
      const events = store.readEventsSince(s2.id, 0);
      return {
        이벤트수: events.length,
        이벤트종류: events.map((e) => e.kind),
        본문: events.map((e) => ({ 종류: e.kind, 본문: (e as { msg?: MockRaw }).msg?.text ?? null })),
      };
    },
  );
  check(s2.resolvePermission(card.id, "allow") === false, "이미 처리된 카드는 다시 응답되지 않는다(멱등)");

  // ── 11. 준비 신호(handshake) 계약 — 모델 목록의 정본이 여기다 ──
  //   ⓐ 턴을 소비하지 않고 ⓑ 이벤트 스트림을 건드리지 않으며 ⓒ 여러 번 불러도 같은 값을 준다.
  const beforeHandshake = store.readEventsSince(s2.id, 0).length;
  const shake = await s2.waitHandshake(5000);
  check(mock.mockState.handshakeCalls >= 1, "준비 신호가 runtime의 제어 채널을 지난다");
  check(store.readEventsSince(s2.id, 0).length === beforeHandshake, "준비 대기가 대화 이벤트를 소비하지 않는다(이벤트 이중 소비 금지)");
  check(shake.models.length === mock.MOCK_MODELS.length, "모델 목록이 provider가 준 그대로다", shake.models.length);
  check(shake.models.every((m) => !!m.value && !!m.displayName), "모든 모델이 값과 표시 이름을 갖는다");
  check(
    shake.models.some((m) => m.resolvedModel === "mock-small-2026"),
    "별칭이 가리키는 정식 id(resolvedModel)가 실려 온다 — 화면이 현재 모델을 맞춰볼 때 필요하다",
  );
  check(
    shake.models.some((m) => JSON.stringify(m.supportedEffortLevels) === JSON.stringify(mock.MOCK_EFFORTS)),
    "추론 강도 목록이 모델별로 실려 온다(서버가 들고 있는 목록이 아니다)",
  );
  check(
    !shake.models.some((m) => (m.supportedEffortLevels ?? []).includes("xhigh")),
    "Claude effort 어휘가 새어들지 않았다",
  );
  // 모델을 고르지 않은 세션도 목록 카드에 모델 이름이 보이도록, 기본 표시 줄의 정식 id를 표시용으로 적어 둔다.
  check(store.loadMeta(s2.id)?.accountDefaultModel === "mock-small-2026", "준비 신호가 계정 기본 모델의 정식 id를 meta에 적는다", store.loadMeta(s2.id));
  check(!store.loadMeta(s2.id)?.model, "계정 기본 모델은 고른 모델 칸에 들어가지 않는다(다음 이어가기에 고정되지 않음)", store.loadMeta(s2.id));
  check(sessionManager.list().find((x) => x.id === s2.id)?.accountDefaultModel === "mock-small-2026", "세션 목록이 계정 기본 모델을 싣는다");
  const shakeAgain = await s2.waitHandshake(5000);
  check(JSON.stringify(shakeAgain.models) === JSON.stringify(shake.models), "여러 번 불러도 같은 결과를 준다(멱등)");

  // 준비 신호가 대기 상한을 실제로 지키는가 — 상한이 없으면 응답을 기다리는 요청이 영원히 매달린다.
  mock.mockState.handshakeDelayMs = 200;
  let timedOut = false;
  try {
    await s2.waitHandshake(20);
  } catch (e) {
    timedOut = (e as Error).name === "SessionReadyTimeoutError";
  }
  mock.mockState.handshakeDelayMs = 0;
  check(timedOut, "대기 상한을 넘기면 구분 가능한 오류로 실패한다(라우트가 상태 코드를 가른다)");

  // ── 11b. 모델·effort 값의 유효성은 provider가 판정한다 ──
  let modelRejected = false;
  try {
    await s2.setModel("totally-made-up");
  } catch {
    modelRejected = true;
  }
  check(modelRejected, "없는 모델 이름은 provider가 거부한다(서버 목록 대조 없이도 걸린다)");
  await s2.setModel(mock.MOCK_ALT_MODEL);
  check(s2.model === mock.MOCK_ALT_MODEL, "아는 모델 이름은 통과하고 세션에 반영된다", s2.model);
  await s2.setEffort("deep");
  check(s2.effort === "deep", "provider 고유 effort 값이 그대로 적용된다");
  let effortRejected = false;
  try {
    await s2.setEffort("xhigh");
  } catch {
    effortRejected = true;
  }
  check(effortRejected, "지원하지 않는 effort는 조용히 무시되지 않고 거부된다(D12)");

  // ── 12. 보조 모델(distill)이 세션 provider의 것인가 ──
  const { backgroundDistill } = await import("../providers/backgroundDistill");
  mock.mockState.distillCalls.length = 0;
  await backgroundDistill(providerEntry(mock.MOCK_PROVIDER).services, "candidate", "배경 작업 시험 입력", cwd);
  check(mock.mockState.distillCalls.length >= 1, "배경 작업이 이 provider의 보조 모델을 부른다(Claude로 새지 않음)", mock.mockState.distillCalls.length);

  // 옛 측정 파일이 남아 있어도 배경 작업은 그 칸을 쓰지 않는다(어댑터에 옵션 없이 맡긴다).
  fs.writeFileSync(path.join(config.dataDir, `background-model-${mock.MOCK_PROVIDER}.json`), JSON.stringify({ candidate: { model: "stale-cell" } }));
  const seenOpts: unknown[] = [];
  const fakeServices = { ...providerEntry(mock.MOCK_PROVIDER).services, distill: async (_p: string, _c: string, o?: unknown) => { seenOpts.push(o); return "ok"; } };
  await backgroundDistill(fakeServices, "candidate", "x", cwd);
  check(seenOpts.length === 1 && seenOpts[0] === undefined, "남아 있는 옛 측정값은 무시하고 옵션 없이 부른다", seenOpts);

  // 배경 모델을 새로 고르면 그 세션은 턴이 끝날 때 "배경 모델을 정했다"는 안내를 한 번 남긴다.
  const { resolveAndApply } = await import("../providers/distillModel");
  await resolveAndApply(mock.MOCK_PROVIDER, [{ value: "cheap", displayName: "Cheap" }], async () => {}, async () => "cheap");
  const pickNotices = () => store.readEventsSince(s2.id, 0).filter((e) => e.kind === "notice" && (e as { notice?: string }).notice === "distill_model").length;
  const noticesBefore = pickNotices();
  s2.push("안내 확인");
  await checkUntil(
    "턴이 끝나면 새로 고른 배경 모델을 한 번 알린다",
    () => pickNotices() === noticesBefore + 1,
    () => ({ 이벤트종류: store.readEventsSince(s2.id, 0).map((e) => e.kind) }),
  );
  s2.push("안내 확인 2");
  await checkUntil(
    "두 번째 턴이 끝난다",
    () => !s2.isTurnOpen && store.readEventsSince(s2.id, 0).some((e) => (e as { msg?: MockRaw }).msg?.text?.includes?.("안내 확인 2")),
    () => ({ 열림: s2.isTurnOpen }),
  );
  await sleep(150);
  check(pickNotices() === noticesBefore + 1, "두 번째 턴 뒤에도 배경 모델 안내는 한 번뿐이다", pickNotices());

  // ── 13. provider 일반화된 인증 경로가 두 번째 provider에서도 도는가(D9) ──
  //   `/api/provider-auth/:provider/*`는 8d-1이 만들었지만 프론트가 아직 구 경로를 쓴다(전환은 8h).
  //   그래서 정식 경로에 실트래픽이 0이다 — 8f가 여기에 Codex 인증을 얹기 전에 경로 자체를 확인해둔다.
  const express = (await import("express")).default;
  const { providerAuthRouter } = await import("../routes/providerAuth");
  const app = express();
  app.use(express.json());
  app.use("/api/provider-auth", providerAuthRouter);
  const srv = app.listen(0);
  await new Promise<void>((r) => srv.once("listening", () => r()));
  const port = (srv.address() as { port: number }).port;
  const bogus = await fetch(`http://127.0.0.1:${port}/api/provider-auth/nope/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check(bogus.status === 404, "미등록 provider는 404로 명시 거부(조용한 fallback 금지)", bogus.status);
  srv.close();

  // ── 14. 종료 시 인증 정리가 *등록된 provider 전부*를 도는가 ──
  //   `index.ts`의 종료 훅이 한 provider를 이름으로 집어 쓰면 새 provider의 로그인 프로세스가 좀비로 남는다.
  //   그 훅과 같은 순회를 여기서 재현해 가짜 provider까지 정리되는지 본다.
  const { listProviders } = await import("../providers/registry");
  const before = mock.mockState.authDisposed;
  for (const prov of listProviders()) prov.services.auth?.disposeAll();
  check(listProviders().some((prov) => prov.id === mock.MOCK_PROVIDER), "등록된 provider 목록에 가짜 세 번째가 들어 있다");
  check(listProviders().some((prov) => prov.id === "codex"), "같은 목록에 실 Codex도 들어 있다");
  check(mock.mockState.authDisposed === before + 1, "종료 정리가 세 번째 provider의 인증도 정리한다", mock.mockState.authDisposed);

  // ── 15. 정리 ──
  s2.dispose();
  check(mock.mockState.disposeCalls === 2, "가짜 세 번째 세션도 runtime을 정리한다");
  sessionManager.delete(sessionId);
  sessionManager.delete(s2.id);
} finally {
  unregister();
}

// 원복 확인 — 테스트 통로가 프로덕션 등록표를 오염시키지 않는다.
let mockGone = false;
try {
  providerEntry(mock.MOCK_PROVIDER);
} catch {
  mockGone = true;
}
check(mockGone, "가짜 세 번째는 원복 후 등록표에 없다");
check(providerEntry("codex").id === "codex", "원복 후에도 실 Codex는 그대로다");
check(providerEntry("claude").id === "claude", "원복 후에도 Claude는 그대로다");

console.log(`\n${fail === 0 ? "✅" : "❌"} provider_contract: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
