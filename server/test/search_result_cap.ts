/**
 * 과거 검색 결과 한도 단위 시험 — 도구 결과 미리보기·행 길이 상한·옛 검색 결과 생략·같은 내용 접기·응답 상한.
 *
 * 계약(server/search/agentTool.ts): TOOL_RESULT_PREVIEW=600, ROW_MAX=4000, RESPONSE_CAP=20000,
 * fmtDiscovery/fmtScroll/fmtBrowse를 내보낸다. DB·모델은 쓰지 않고 서식 함수만 직접 부른다.
 * 실행: tsx test/search_result_cap.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TZ = "Asia/Seoul";
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aether-search-cap-"));
process.env.AETHER_DATA_DIR = DATA_DIR;

const { setLocale } = await import("../i18n");
setLocale("ko");
const at = await import("../search/agentTool");
const { TOOL_RESULT_PREVIEW, ROW_MAX, RESPONSE_CAP, fmtDiscovery, fmtScroll, fmtBrowse } = at;
type CtxRow = import("../search/queryTokens").CtxRow;
type SessionContextHit = import("../search/queryTokens").SessionContextHit;

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail?: unknown) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  ok ? pass++ : fail++;
}

// 2026-10-10 12:00 KST
const TS = Date.UTC(2026, 9, 10, 3, 0, 0);
const row = (seq: number, role: string, content: string, part = 0): CtxRow => ({
  id: seq * 100000 + part,
  seq,
  part,
  role,
  ts: TS,
  content,
});
/** 공백 없는 본문 — 접기·정리에 영향받지 않는다. */
const filler = (tag: string, n: number) => (tag + "가나다라마바사".repeat(Math.ceil(n / 7))).slice(0, n);
const rowLines = (s: string) => s.split("\n").filter((l) => /^ {4}\[\S+ #\d+/.test(l));
const idOf = (line: string) => Number(/#(\d+)/.exec(line)![1]);

console.log("\n[1] 상수");
check(TOOL_RESULT_PREVIEW === 600, "TOOL_RESULT_PREVIEW=600", TOOL_RESULT_PREVIEW);
check(ROW_MAX === 4000, "ROW_MAX=4000", ROW_MAX);
check(RESPONSE_CAP === 20000, "RESPONSE_CAP=20000", RESPONSE_CAP);

console.log("\n[2] 도구 결과 행 600자 미리보기");
{
  const body = "▸ " + "ab".repeat(500); // 1002자
  const r = row(1, "tool", body);
  const out = fmtBrowse("s1", [r]);
  const want = `${body.slice(0, 600)} … (나머지 402자 생략 · #${r.id})`;
  check(out.includes(want), "600자 + 생략 표시, M=402");
  check(!out.includes(body.slice(0, 601)), "601자째는 안 나온다");
  const exact = "▸ " + "cd".repeat(299); // 600자
  const short = "▸ " + "ef".repeat(100);
  const out2 = fmtBrowse("s1", [row(2, "tool", exact), row(3, "tool", short)]);
  check(out2.includes(exact) && !out2.includes("생략"), "600자 이하는 그대로");
  check(out2.includes(short), "짧은 도구 결과 그대로");
}

console.log("\n[3] 사람 글 4,000자 상한");
{
  const big = filler("A", 5000);
  const mid = filler("B", 3000);
  const r1 = row(1, "user", big);
  const out = fmtBrowse("s1", [r1, row(2, "assistant", mid)]);
  check(out.includes(`${big.slice(0, 4000)} … (나머지 1000자 생략 · #${r1.id})`), "5000자는 4000자에서 잘림, M=1000");
  check(!out.includes(big.slice(0, 4001)), "4001자째는 없다");
  check(out.includes(mid), "3000자는 그대로");
}

console.log("\n[4] 예전 검색 결과 행 생략");
{
  const a = '▸ "빌드 오류" 검색 3건 — ' + "x".repeat(900);
  const b = "▸ session=abc 맥락: " + "y".repeat(900);
  const out = fmtBrowse("s1", [row(1, "tool", a), row(2, "tool", b)]);
  check(out.includes(`▸ (예전 검색 결과 ${a.length}자 생략)`), "검색 결과 행", a.length);
  check(out.includes(`▸ (예전 검색 결과 ${b.length}자 생략)`), "session= 맥락 행", b.length);
  check(!out.includes("xxxxxxxxxx") && !out.includes("yyyyyyyyyy"), "원문은 안 나온다");
}

console.log("\n[5] 같은 내용 도구 결과 접기");
{
  const body = "▸ " + "zq".repeat(500);
  const r1 = row(1, "tool", body);
  const r2 = row(2, "tool", body);
  const out = fmtBrowse("s1", [r1, r2]);
  check(out.includes(`▸ (#${r1.id}와 같은 내용 ${body.length}자)`), "두 번째는 첫 행을 가리킨다");
  const lines = rowLines(out);
  check(lines[0].includes(" … (나머지 "), "첫 행은 미리보기 규칙");
  const same = row(3, "tool", "▸ same");
  const out2 = fmtBrowse("s1", [same, { ...same }]);
  check(!out2.includes("와 같은 내용"), "같은 id가 두 번 찍히면 접지 않는다");
}

console.log("\n[6] fmtDiscovery 상한");
{
  const mkHit = (n: number): SessionContextHit => {
    const w = [1, 2, 3].map((k) => row(n * 10 + k, "user", filler(`H${n}k${k}_`, 3900)));
    return {
      sessionId: `sess${n}`,
      session: { displayName: `세션${n}`, cwd: "/x", model: null, createdAt: TS, lineageId: null },
      anchor: { id: w[0].id, sessionId: `sess${n}`, seq: w[0].seq, part: 0, role: "user", ts: TS, snippet: "", session: { displayName: `세션${n}`, cwd: "/x", model: null, createdAt: TS, lineageId: null } },
      window: w,
      bookendStart: [],
      bookendEnd: [],
    };
  };
  const hits = [1, 2, 3, 4].map(mkHit);
  const out = fmtDiscovery("테스트", hits);
  check(out.length <= RESPONSE_CAP, "길이 ≤ RESPONSE_CAP", out.length);
  const omit = out.split("\n").find((l: string) => l.startsWith("(응답 상한"));
  check(!!omit, "생략 안내 줄이 있다");
  check(!!omit && omit.includes(`session=sess4 around_id=${hits[3].anchor.id}`), "다 못 보인 결과(#4)의 session=·around_id=가 안내에 있다", omit);
  check(out.includes("◀매칭"), "첫 블록 매칭 행 포함");
  const lines = out.split("\n");
  let orphan = false;
  lines.forEach((l: string, i: number) => {
    if (/^#\d+ \[/.test(l) && !(lines[i + 1] ?? "").startsWith("  ┄")) orphan = true;
  });
  check(!orphan, "머리 줄만 있고 아래가 없는 블록 없음");
  // 머리 줄이 아예 없는 결과는 안내에 모두 있어야 한다
  const missing = hits.filter((h) => !out.includes(`(session=${h.sessionId})`));
  check(missing.every((h) => !!omit && omit.includes(`session=${h.sessionId} `)), "아예 안 보인 결과는 전부 안내에 있다");
}

console.log("\n[7] fmtScroll 상한·기준 행·커서");
{
  const around = row(21, "tool", "▸ " + filler("AR", 11998)); // 12000자
  const win: CtxRow[] = [];
  for (let s = 1; s <= 41; s++) {
    if (s === 21) win.push(around);
    else win.push(row(s, s % 2 ? "user" : "assistant", filler(`R${s}_`, 3000)));
  }
  const out = fmtScroll("s1", win, false, around.id);
  check(out.length <= RESPONSE_CAP, "길이 ≤ RESPONSE_CAP", out.length);
  check(out.includes(around.content), "기준 행 12,000자는 자르지 않고 그대로");
  check(out.includes("응답 상한 20000자에 닿아"), "생략 안내가 있다");
  const ids = rowLines(out).map(idOf);
  check(ids.length >= 1 && ids.length < win.length, "일부 행만 보인다", ids.length);
  check(ids.includes(around.id), "기준 행 포함");
  const sorted = [...ids].sort((a, b) => a - b);
  check(JSON.stringify(ids) === JSON.stringify(sorted), "id 순서로 나온다");
  const prev = /이전으로: around_id=(\d+)/.exec(out);
  const next = /다음으로: around_id=(\d+)/.exec(out);
  check(!!prev && Number(prev[1]) === ids[0], "이전 커서 = 보인 첫 행 id", { prev: prev?.[1], first: ids[0] });
  check(!!next && Number(next[1]) === ids[ids.length - 1], "다음 커서 = 보인 끝 행 id", { next: next?.[1], last: ids[ids.length - 1] });

  const huge = row(5, "tool", "▸ " + filler("HG", 29998));
  const out2 = fmtScroll("s1", [huge], false, huge.id);
  check(out2.length <= RESPONSE_CAP, "기준 행 30,000자여도 길이 ≤ RESPONSE_CAP", out2.length);
}

console.log("\n[8] fmtBrowse 상한");
{
  const rows = Array.from({ length: 40 }, (_, i) => row(i + 1, i % 2 ? "assistant" : "user", filler(`B${i}_`, 3000)));
  const out = fmtBrowse("s1", rows);
  check(out.length <= RESPONSE_CAP, "길이 ≤ RESPONSE_CAP", out.length);
  const ids = rowLines(out).map(idOf);
  const last = ids[ids.length - 1];
  const m = /after_id=(\d+)/.exec(out);
  check(ids.length >= 1 && ids.length < rows.length, "일부 행만 보인다", ids.length);
  check(!!m && Number(m[1]) === last, "after_id = 보인 끝 행 id", { after: m?.[1], last });
  check(out.includes("응답 상한 20000자에 닿아") && out.includes("다음 페이지에서 이어진다"), "안내 문구");
  check(out.includes(`${rows.length - ids.length}행`), "뺀 행 수가 맞다", rows.length - ids.length);

  const few = rows.slice(0, 3);
  const out2 = fmtBrowse("s1", few);
  check(!out2.includes("응답 상한") && new RegExp(`after_id=${few[2].id}\\b`).test(out2), "상한 안이면 마지막 행 id, 안내 없음");
}

console.log("\n[9] scope=project (날짜 표시)");
{
  const tool = "▸ " + "pq".repeat(500);
  const r1 = row(1, "tool", tool);
  const r2 = row(2, "tool", tool);
  const big = row(3, "user", filler("P", 5000));
  const out = fmtBrowse("s1", [r1, r2, big], true);
  check(out.includes(`#${r1.id} 2026-10-10]`), "날짜가 붙는다");
  check(out.includes(`${tool.slice(0, 600)} … (나머지 ${tool.length - 600}자 생략 · #${r1.id})`), "도구 결과 600자 규칙");
  check(out.includes(`▸ (#${r1.id}와 같은 내용 ${tool.length}자)`), "같은 내용 접기");
  check(out.includes(`${big.content.slice(0, 4000)} … (나머지 1000자 생략 · #${big.id})`), "사람 글 4000자 규칙");
  check(out.includes('scope="project"'), "project 커서 안내 유지");
}

// ───────── 카드 1-4: 검색 매칭 행 발췌·결과별 고른 배분 (계약 B) ─────────
const SESS = { displayName: "s", cwd: "/x", model: null, createdAt: TS, lineageId: null };
/** 임의 window·가장자리 행으로 결과 하나를 만든다. anchorId를 안 주면 window[anchorIdx].id. */
const mkHit2 = (n: number, win: CtxRow[], anchorIdx: number, start: CtxRow[] = [], end: CtxRow[] = [], anchorId?: number): SessionContextHit => {
  const id = anchorId ?? win[anchorIdx].id;
  return {
    sessionId: `sess${n}`,
    session: SESS,
    anchor: { id, sessionId: `sess${n}`, seq: 0, part: 0, role: "user", ts: TS, snippet: "", session: SESS },
    window: win,
    bookendStart: start,
    bookendEnd: end,
  } as SessionContextHit;
};
const lineOf = (out: string, id: number) => out.split("\n").find((l) => l.includes(`#${id}`) && /^ {4}\[/.test(l)) ?? "";

console.log("\n[10] ANCHOR_PREVIEW");
check(at.ANCHOR_PREVIEW === 6000, "ANCHOR_PREVIEW=6000", at.ANCHOR_PREVIEW);

console.log("\n[11] 매칭 행 발췌 (낱말 위치 창)");
{
  // alpha가 50자째와 12000자째, beta가 12050자째 — 두 낱말이 함께 든 12000 근처 창이 골라져야 한다.
  const chars = Array.from({ length: 30000 }, () => "x");
  const put = (pos: number, w: string) => { for (let i = 0; i < w.length; i++) chars[pos + i] = w[i]; };
  put(52, "alpha");
  put(12002, "alpha");
  put(12052, "beta");
  const body = "▸ " + chars.join("").slice(2);
  const a = row(5, "tool", body);
  const win = [row(4, "user", "앞"), a, row(6, "assistant", "뒤")];
  const out = fmtDiscovery("alpha beta", [mkHit2(1, win, 1)]);
  const lineA = lineOf(out, a.id);
  const aPos = body.indexOf("alpha", 100);
  const s = aPos - 200;
  const m = body.length - (s + at.ANCHOR_PREVIEW);
  check(lineA.includes("alpha") && lineA.includes("beta"), "출력에 두 낱말이 있다");
  check(lineA.includes(`▸ (앞 ${s}자 생략) … `), "앞 생략 표시, N이 맞다", lineA.slice(0, 80));
  check(lineA.includes(` … (나머지 ${m}자 생략 · #${a.id})`), "뒤 생략 표시, M이 맞다", { m, tail: lineA.slice(-60) });
  check(lineA.endsWith("  ◀매칭"), "매칭 표시가 붙는다");
  check(lineA.includes(body.slice(s, s + at.ANCHOR_PREVIEW)), "발췌 범위가 body.slice(s, s+ANCHOR_PREVIEW)");
  // 이 창에는 앞쪽(52자째) alpha가 없다 → 뒤쪽 창이 골라졌다
  check(!lineA.includes("(앞 0자") && !lineA.includes(body.slice(0, 40)), "앞쪽(0~100자) 창이 아니라 뒤쪽 창");

  // 낱말이 행에 없으면 앞 ANCHOR_PREVIEW자
  const plain = row(7, "tool", "▸ " + "y".repeat(9000));
  const out3 = fmtDiscovery("zzzz", [mkHit2(1, [plain], 0)]);
  const l3 = lineOf(out3, plain.id);
  check(l3.includes(plain.content.slice(0, at.ANCHOR_PREVIEW)) && !l3.includes(plain.content.slice(0, at.ANCHOR_PREVIEW + 1)), "검색어가 없으면 앞 ANCHOR_PREVIEW자");
  check(!l3.includes("자 생략) …") && l3.includes(` … (나머지 ${plain.content.length - at.ANCHOR_PREVIEW}자 생략 · #${plain.id})`), "앞 생략 표시 없음, 뒤 생략만");
  check(l3.startsWith(`    [도구결과 #${plain.id}`) || l3.includes("▸ yyy"), "도구 결과는 ▸로 시작(중복 ▸ 없음)", l3.slice(0, 40));
  check(!l3.includes("▸ ▸"), "▸가 두 번 붙지 않는다");
}

console.log("\n[12] 소문자화로 길이가 바뀌는 글자(İ)");
{
  const body = "▸ " + "İ".repeat(8000) + " needle " + "x".repeat(9000);
  const r = row(5, "tool", body);
  const out = fmtDiscovery("needle", [mkHit2(1, [r], 0)]);
  const l = lineOf(out, r.id);
  const pos = body.indexOf("needle");
  const m = /\(앞 (\d+)자 생략\)/.exec(l);
  check(l.includes("needle"), "출력에 needle이 있다");
  check(!!m && Math.abs(Number(m[1]) - (pos - 200)) <= 2, "앞 생략 글자 수 ≈ needle 위치 − 200 (원문 기준)", { got: m?.[1], want: pos - 200 });
  check(!!m && Number(m[1]) < body.length, "앞 생략 수가 원문 길이보다 작다");
  // 검색어에 İ가 있어도 본문과 같은 규칙으로 바꿔 찾는다.
  const body2 = "▸ " + "x".repeat(9000) + " İstanbul " + "y".repeat(9000);
  const r2 = row(6, "tool", body2);
  const l2 = lineOf(fmtDiscovery("İstanbul", [mkHit2(1, [r2], 0)]), r2.id);
  check(l2.includes("İstanbul") && l2.includes("(앞 "), "검색어의 İ도 찾아 뒤쪽 창을 고른다");
}

console.log("\n[13] 결과별 고른 배분");
{
  const mk = (n: number) => {
    const win = Array.from({ length: 9 }, (_, k) => row(n * 20 + k + 1, k % 2 ? "assistant" : "user", filler(`W${n}k${k}_`, 3900)));
    return mkHit2(n, win, 4, [row(n * 20 + 50, "user", filler(`S${n}_`, 3900))], [row(n * 20 + 60, "user", filler(`E${n}_`, 3900))]);
  };
  const hits = [1, 2, 3, 4].map(mk);
  const out = fmtDiscovery("testword", hits);
  check(out.length <= RESPONSE_CAP, "상한 안", out.length);
  check(hits.every((h) => out.includes(`(session=${h.sessionId})`)), "네 결과의 머리 줄이 모두 있다");
  check(hits.every((h) => new RegExp(`#${h.anchor.id}\\b[^\\n]*  ◀매칭$`, "m").test(out)), "네 결과의 매칭 행이 모두 있고 두 칸 + ◀매칭으로 끝난다");
  check(out.split("◀매칭").length - 1 === 4, "매칭 표시 정확히 4번", out.split("◀매칭").length - 1);
  check(out.split("\n").filter((l) => l.includes("◀매칭")).every((l) => l.endsWith("  ◀매칭")), "◀매칭 줄은 모두 그 표시로 끝난다");
  // [14] 생략 안내의 N줄
  const total = hits.reduce((s, h) => s + h.window.length + h.bookendStart.length + h.bookendEnd.length, 0);
  const shown = rowLines(out).length;
  const m = /(\d+)줄을 뺐다/.exec(out);
  check(!!m && Number(m[1]) === total - shown, "생략 안내 N줄 = 실제로 빠진 행 수(라벨 제외)", { notice: m?.[1], total, shown });
}

console.log("\n[15] window에 anchor id가 없을 때");
{
  const win = [row(1, "user", "첫째"), row(2, "assistant", "둘째"), row(3, "user", "셋째")];
  const out = fmtDiscovery("q", [mkHit2(1, win, 0, [], [], 2 * 100000 + 50)]);
  const marked = out.split("\n").filter((l) => l.includes("◀매칭"));
  check(marked.length === 1 && marked[0].includes(`#${win[1].id}`), "id ≤ anchor인 마지막 행(둘째)에 매칭 표시", marked);
  const out2 = fmtDiscovery("q", [mkHit2(1, win, 0, [], [], 5)]);
  const marked2 = out2.split("\n").filter((l) => l.includes("◀매칭"));
  check(marked2.length === 1 && marked2[0].includes(`#${win[0].id}`), "그런 행도 없으면 첫 행", marked2);
}

console.log("\n[16] 30,000자 검색어");
{
  const q = "쿼" .repeat(30000);
  const win = [row(1, "user", "안녕"), row(2, "assistant", "응")];
  const withHit = fmtDiscovery(q, [mkHit2(1, win, 1)]);
  const noHit = fmtDiscovery(q, []);
  check(withHit.length <= RESPONSE_CAP, "결과 있음: 길이 ≤ RESPONSE_CAP", withHit.length);
  check(noHit.length <= RESPONSE_CAP, "결과 없음: 길이 ≤ RESPONSE_CAP", noHit.length);
}

console.log("\n[17] fmtScroll 생략 안내의 앞/뒤 행 수");
{
  const win = Array.from({ length: 41 }, (_, i) => row(i + 1, i % 2 ? "assistant" : "user", filler(`C${i}_`, 3000)));
  const center = win[20];
  const out = fmtScroll("s1", win, false, center.id);
  const ids = rowLines(out).map(idOf);
  const a = win.filter((r) => r.id < ids[0]).length;
  const b = win.filter((r) => r.id > ids[ids.length - 1]).length;
  const m = /앞 (\d+)행, 뒤 (\d+)행을 뺐다/.exec(out);
  check(!!m && Number(m[1]) === a && Number(m[2]) === b, "앞/뒤 행 수가 실제와 같다", { notice: m?.slice(1), a, b });
  check(a > 0 && b > 0, "양쪽 모두 빠졌다(시험 유효성)", { a, b });
}

console.log("\n[18] 영어 로캘");
{
  setLocale("en");
  try {
    const body = "▸ " + "ab".repeat(500);
    const r = row(1, "tool", body);
    const out = fmtBrowse("s1", [r]);
    check(out.includes(`${body.slice(0, 600)} … (402 more chars omitted · #${r.id})`), "en: 도구 결과 600자 규칙 문구");
    const hits = [1, 2, 3, 4].map((n) => mkHit2(n, Array.from({ length: 6 }, (_, k) => row(n * 20 + k + 1, "user", filler(`N${n}k${k}_`, 3900))), 2));
    const d = fmtDiscovery("qq", hits);
    check(d.length <= RESPONSE_CAP, "en: 검색 응답 ≤ RESPONSE_CAP", d.length);
    check(d.includes("Hit the 20000-char response cap; omitted"), "en: 생략 안내 문구");
  } finally {
    setLocale("ko");
  }
}

console.log("\n[19] 같은 내용 접기가 가리키는 행");
{
  const shared = "▸ " + "dup".repeat(400);
  const a1 = row(11, "tool", shared);
  const b1 = row(31, "tool", shared); // 두 번째 결과의 매칭 행 — 접힌다
  const c1 = row(32, "tool", shared); // 같은 결과의 다른 window 행 — 접힌다
  const h1 = mkHit2(1, [row(10, "user", "요청"), a1, row(12, "assistant", "답")], 1);
  const h2 = mkHit2(2, [row(30, "user", "요청2"), b1, c1], 1);
  const out = fmtDiscovery("dup", [h1, h2]);
  const refs = [...out.matchAll(/\(#(\d+)와 같은 내용 \d+자\)/g)].map((m) => Number(m[1]));
  check(refs.length >= 1, "접힌 행이 있다", refs);
  const present = new Set(rowLines(out).map(idOf));
  check(refs.every((id) => present.has(id)), "접힌 행이 가리키는 #id의 행이 출력에 실제로 있다", { refs, present: [...present] });
}

console.log(`\n${fail === 0 ? "전부 통과" : "실패 있음"}: ${pass} 통과 / ${fail} 실패`);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
if (fail > 0) process.exit(1);
