/**
 * 턴 읽기 장치 — 한 프로세스에서 턴을 여러 번 나눠 쓰는 기계장치. 모델을 안 띄우는 결정적 검사.
 *
 * 왜 따로 검사하나: 이 장치가 틀리면 배경 작업이 **조용히** 망가진다. 응답을 못 받아도 예외가 안 나고
 * 빈 문자열이 돌아오기 때문에, 호출자는 "이번엔 배울 게 없었다"로 착각하고 그 대화 구간을 영영 넘긴다.
 * 실모델 스파이크(내부 실측)는 실제 배선을 보지만 CI에서 못 돌린다.
 *
 * 검사하는 것:
 *   ① 턴을 두 번 나눠 받는다 (그리고 두 턴의 텍스트가 서로 안 섞인다)
 *   ② 기다리는 쪽이 없을 때 끝난 턴은 쌓였다가 나중에 그대로 나온다
 *   ③ 스트림이 중간에 끊겨도 기다리던 쪽이 반드시 깨어난다(영원히 매달리지 않는다)
 *   ④ 오류로 끝나면 기다리던 쪽이 그 오류를 받는다
 *   ⑤ 턴 종료가 두 번 온 찌꺼기를 drain()으로 버릴 수 있다
 *   ⑥ nextTurn()을 연달아 불러도 앞의 약속이 버려지지 않는다(순서대로 하나씩 받는다)
 */
import { readTurns, type TurnInspection } from "../providers/turnReader";

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const eq = <T,>(label: string, actual: T, expected: T) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), label, `실제=${JSON.stringify(actual)} 기대=${JSON.stringify(expected)}`);

/** 손으로 밀어 넣는 가짜 스트림 — 실제 SDK 대신 쓴다. */
function fakeStream() {
  const q: unknown[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let boom: unknown = null;
  return {
    push(msg: unknown) { q.push(msg); wake?.(); wake = null; },
    end() { done = true; wake?.(); wake = null; },
    fail(e: unknown) { boom = e; done = true; wake?.(); wake = null; },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (q.length) yield q.shift();
        if (done) { if (boom) throw boom; return; }
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

/** 테스트용 메시지 모양: 글자면 텍스트, "END"면 턴 종료. */
const inspect = (msg: unknown): TurnInspection =>
  msg === "END" ? { turnEnded: true } : { text: String(msg) };

/** 이벤트 루프를 한 바퀴 돌린다 — 소비 루프가 밀어 넣은 메시지를 처리할 틈을 준다. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function main() {
  console.log("──────── ① 턴 두 번 나눠 받기 ────────");
  {
    const s = fakeStream();
    const r = readTurns(s, inspect);
    const t1 = r.nextTurn();
    s.push("하나"); s.push("END");
    eq("첫 턴 텍스트", await t1, "하나");
    const t2 = r.nextTurn();
    s.push("둘"); s.push("END");
    eq("두 번째 턴 텍스트(앞 턴이 안 섞인다)", await t2, "둘");
    s.end();
    await r.done;
    check(true, "스트림이 끝나면 done이 풀린다");
  }

  console.log("\n──────── ② 기다리는 쪽이 없을 때 끝난 턴은 쌓인다 ────────");
  {
    const s = fakeStream();
    const r = readTurns(s, inspect);
    s.push("먼저"); s.push("END");
    await tick(); // 아무도 안 기다리는 사이에 턴이 끝난다
    eq("나중에 물어도 그대로 나온다", await r.nextTurn(), "먼저");
    s.end();
    await r.done;
  }

  console.log("\n──────── ③ 끝 신호 없이 끊기면 실패로 알린다 ────────");
  // ★ 여기서 "지금까지 모은 것"을 조용히 돌려주면, 호출자가 시간 제한에 걸린 것과 "배울 게 없었다"를
  //   구별하지 못한다. 그러면 그 대화 구간을 정상 처리로 넘겨 영영 다시 안 본다(기억 유실).
  {
    const s = fakeStream();
    const r = readTurns(s, inspect);
    const t = r.nextTurn();
    s.push("중간까지만");
    await tick();
    s.end(); // 턴 종료 신호 없이 끊김
    let name = "", partial = "";
    try { await t; check(false, "★ 잘린 응답을 성공으로 돌려주면 안 된다"); }
    catch (e) { name = (e as Error).name; partial = String((e as { partial?: string }).partial ?? ""); }
    eq("★ 매달리지 않고 실패로 깨운다", name, "TurnIncompleteError");
    eq("잘리기 전까지 모은 것은 진단용으로 딸려 온다", partial, "중간까지만");
    let name2 = "";
    try { await r.nextTurn(); } catch (e) { name2 = (e as Error).name; }
    eq("끝난 뒤에 물어도 실패다(빈 문자열이 아니다)", name2, "TurnIncompleteError");
    await r.done;
  }

  console.log("\n──────── ④ 오류로 끝나면 그 오류를 받는다 ────────");
  {
    const s = fakeStream();
    const r = readTurns(s, inspect);
    const t = r.nextTurn();
    s.fail(new Error("스트림 폭발"));
    let msg = "";
    try { await t; } catch (e) { msg = String((e as Error).message); }
    eq("기다리던 쪽이 오류를 받는다", msg, "스트림 폭발");
    let msg2 = "";
    try { await r.nextTurn(); } catch (e) { msg2 = String((e as Error).message); }
    eq("그 뒤에 물어도 같은 오류", msg2, "스트림 폭발");
    await r.done;
    check(true, "오류가 나도 done은 거절되지 않는다(처리 안 된 거절 없음)");
  }

  console.log("\n──────── ⑤ 찌꺼기 버리기(drain) ────────");
  {
    const s = fakeStream();
    const r = readTurns(s, inspect);
    const t1 = r.nextTurn();
    s.push("본문"); s.push("END");
    eq("첫 턴", await t1, "본문");
    s.push("중단찌꺼기"); s.push("END"); // 같은 프롬프트에 종료가 한 번 더 왔다
    await tick();
    eq("버린 개수", r.drain(), 1);
    const t2 = r.nextTurn();
    s.push("진짜다음턴"); s.push("END");
    eq("★ 찌꺼기가 아니라 진짜 다음 턴을 받는다", await t2, "진짜다음턴");
    eq("버릴 게 없으면 0", r.drain(), 0);
    s.end();
    await r.done;
  }

  console.log("\n──────── ⑥ 연달아 기다려도 앞의 약속이 안 버려진다 ────────");
  {
    const s = fakeStream();
    const r = readTurns(s, inspect);
    const t1 = r.nextTurn();
    const t2 = r.nextTurn(); // 앞의 것을 덮어쓰면 t1이 영원히 안 풀린다
    s.push("가"); s.push("END");
    s.push("나"); s.push("END");
    eq("첫 번째 기다림", await t1, "가");
    eq("두 번째 기다림", await t2, "나");
    s.end();
    await r.done;
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} turn_reader: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
