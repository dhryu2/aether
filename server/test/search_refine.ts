/**
 * 검색용 표 정제기 단위 시험 — 호출·사용자·AI 글 보존, 예전 검색 결과 버림, 같은 출력 접기, 긴 셸 출력 압축.
 *
 * 계약(/tmp/ps3/contract.md 3절, server/search/refineLetter.ts): createLetterRefiner(rules?)가 세션 하나의 상태를 갖고
 * refine(seq, items)이 새 배열을 돌려준다. DB·모델은 쓰지 않는다.
 * 실행: node --env-file=.env --import tsx test/search_refine.ts
 */
import assert from "node:assert/strict";

const { createLetterRefiner, REFINE_RULES } = await import("../search/refineLetter");
const { letterDocId } = await import("../db/sessionLetter");
type IndexItem = import("../search/extract").IndexItem;

let pass = 0;
let fail = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${label} — ${(e as Error).message.split("\n").slice(0, 3).join(" | ")}`);
    fail++;
  }
}

type Kind = "bash" | "file_read";
const call = (id: string, kind: Kind, part = 0, text = "⚙ Bash(ls)"): IndexItem =>
  ({ role: "tool", content: text, part, tool: { id, kind } }) as IndexItem;
const result = (id: string | undefined, body: string, part = 1): IndexItem =>
  ({ role: "tool", content: `▸ ${body}`, part, ...(id ? { tool: { id } } : {}) }) as IndexItem;
const text = (role: "user" | "assistant" | "assistant_interim", content: string, part = 0): IndexItem =>
  ({ role, content, part }) as IndexItem;

/** 줄 번호가 든 고정 폭 줄 n개(줄마다 개행 포함 약 L자). 오류 낱말은 들어 있지 않다. */
const lines = (n: number, w = 30, tag = "row") =>
  Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(4, "0")}`.padEnd(w, ".")).join("\n");

/** 압축 결과에서 본문과 끝 표지 줄을 나눈다. */
function split(content: string) {
  const idx = content.lastIndexOf("\n");
  return { body: content.slice(2, idx), marker: content.slice(idx + 1) };
}

console.log("— 그대로 두는 항목");
check("호출 항목은 그대로", () => {
  const r = createLetterRefiner();
  const items = [call("t1", "bash")];
  assert.deepEqual(r.refine(1, items), items);
});
check("사용자·AI 글은 길어도 그대로", () => {
  const r = createLetterRefiner();
  const long = lines(300);
  const items = [text("user", long), text("assistant", long, 1), text("assistant_interim", "중간 말", 2)];
  assert.deepEqual(r.refine(1, items), items);
});
check("'▸ '로 시작하지 않는 tool 항목은 결과가 아니므로 그대로", () => {
  const r = createLetterRefiner();
  const items = [{ role: "tool", content: lines(300), part: 1 } as IndexItem];
  assert.deepEqual(r.refine(1, items), items);
});

console.log("— 예전 검색 결과 버림");
check('▸ "…" 검색 3건 줄은 버린다', () => {
  const r = createLetterRefiner();
  const out = r.refine(2, [call("s1", "bash"), result("s1", '"배포" 검색 3건 · 세션 2개'), text("assistant", "답")]);
  assert.equal(out.length, 2);
  assert.ok(out.every((x) => !x.content.includes("검색 3건")));
});
check("버려진 항목은 중복 기록에도 남지 않는다", () => {
  const r = createLetterRefiner();
  const body = `"x" 검색 3건 ` + "가".repeat(600);
  const a = r.refine(1, [result("a", body)]);
  const b = r.refine(2, [result("b", body)]);
  assert.equal(a.length, 0);
  assert.equal(b.length, 0); // 접힘 표시가 아니라 여전히 버려짐
});

console.log("— 같은 출력 접기");
check("500자 이상 같은 출력의 두 번째는 앞 번호를 가리킨다", () => {
  const r = createLetterRefiner();
  const body = "ab".repeat(300);
  const first = r.refine(3, [result("a", body, 2)]);
  assert.equal(first[0].content, `▸ ${body}`);
  const second = r.refine(7, [result("b", body, 1)]);
  assert.equal(second.length, 1);
  const m = second[0].content.match(/^▸ \(앞의 #(\d+)와 같은 출력 (\d+)자\)$/);
  assert.ok(m, second[0].content);
  assert.equal(Number(m![1]), letterDocId(3, 2));
  assert.equal(Number(m![1]), 3 * 100000 + 2);
  // 글자수는 본문(600) 또는 '▸ ' 포함(602) — 계약이 모호해 둘 다 허용
  assert.ok([600, 602].includes(Number(m![2])), `글자수 ${m![2]}`);
  assert.equal(second[0].role, "tool");
  assert.equal(second[0].part, 1);
});
check("정확히 500자도 접는다(경계 이상)", () => {
  const r = createLetterRefiner();
  const body = "c".repeat(500);
  r.refine(1, [result("a", body)]);
  const out = r.refine(2, [result("b", body)]);
  assert.match(out[0].content, /^▸ \(앞의 #100001와 같은 출력 /);
});
check("500자 미만 반복은 그대로", () => {
  const r = createLetterRefiner();
  const body = "d".repeat(499);
  r.refine(1, [result("a", body)]);
  const out = r.refine(2, [result("b", body)]);
  assert.equal(out[0].content, `▸ ${body}`);
});
check("같은 사건 안에서도 두 번째는 접는다", () => {
  const r = createLetterRefiner();
  const body = "e".repeat(700);
  const out = r.refine(4, [result("a", body, 1), result("b", body, 2)]);
  assert.equal(out[0].content, `▸ ${body}`);
  assert.match(out[1].content, /^▸ \(앞의 #400001와 같은 출력 /);
});
check("세 번째도 처음 본 번호를 가리킨다", () => {
  const r = createLetterRefiner();
  const body = "f".repeat(700);
  r.refine(5, [result("a", body, 3)]);
  r.refine(6, [result("b", body, 1)]);
  const out = r.refine(9, [result("c", body, 1)]);
  assert.match(out[0].content, /^▸ \(앞의 #500003와 같은 출력 /);
});
check("다른 내용은 접지 않는다", () => {
  const r = createLetterRefiner();
  r.refine(1, [result("a", "g".repeat(700))]);
  const out = r.refine(2, [result("b", "h".repeat(700))]);
  assert.equal(out[0].content, `▸ ${"h".repeat(700)}`);
});
check("번호는 seq*100000+part", () => {
  assert.equal(letterDocId(12, 34), 1200034);
  const r = createLetterRefiner();
  r.refine(12, [result("a", "i".repeat(600), 34)]);
  const out = r.refine(13, [result("b", "i".repeat(600))]);
  assert.match(out[0].content, /#1200034와/);
});

console.log("— 긴 셸 출력 압축");
const longBash = () => {
  const body = lines(300); // 약 9300자
  return body;
};
check("bash이고 4000자 초과면 압축한다 — 머리·꼬리·생략 표시·끝 표지", () => {
  const r = createLetterRefiner();
  const body = longBash();
  const out = r.refine(5, [call("b1", "bash", 0), result("b1", body, 1)]);
  assert.equal(out.length, 2);
  const c = out[1].content;
  assert.ok(c.startsWith("▸ "));
  assert.ok(c.length < body.length / 2, `길이 ${c.length}`);
  const { body: kept, marker } = split(c);
  assert.ok(kept.startsWith("row0000"), "머리");
  assert.ok(kept.endsWith("row0299".padEnd(30, ".")), "꼬리");
  assert.match(kept, /… \(\d+줄 생략\) …/);
  assert.match(marker, /^… \(원래 \d+자 중 \d+자만 색인 · 중간 출력은 검색표에 없음\)$/);
  const m = marker.match(/원래 (\d+)자 중 (\d+)자/)!;
  const keptText = kept.split("\n").filter((l) => !/^… \(\d+줄 생략\) …$/.test(l)).join("\n");
  assert.equal(Number(m[2]), keptText.length, "남긴 글자수 = 남긴 원문 줄의 길이(생략 표시 줄과 끝 표지 줄 제외)");
  assert.equal(Number(m[1]), body.length, "전체 글자수 = 정제 전 본문 길이");
  assert.equal(out[1].part, 1);
  assert.equal(out[1].role, "tool");
});
check("머리·꼬리는 각각 약 1200자 안쪽이다", () => {
  const r = createLetterRefiner();
  const out = r.refine(1, [call("b", "bash"), result("b", longBash())]);
  const { body: kept } = split(out[1].content);
  const parts = kept.split(/\n… \(\d+줄 생략\) …\n/);
  assert.equal(parts.length, 2, "생략 표시 하나로 머리와 꼬리만 있다");
  assert.ok(parts[0].length <= 1200 && parts[0].length > 1100, `머리 ${parts[0].length}`);
  assert.ok(parts[1].length <= 1200 && parts[1].length > 1100, `꼬리 ${parts[1].length}`);
});
check("생략 줄 수 N이 실제로 건너뛴 줄 수와 맞는다", () => {
  const r = createLetterRefiner();
  const out = r.refine(1, [call("b", "bash"), result("b", longBash())]);
  const { body: kept } = split(out[1].content);
  const n = Number(kept.match(/… \((\d+)줄 생략\) …/)![1]);
  const keptLines = kept.split("\n").filter((l) => /^row\d{4}/.test(l)).length;
  assert.equal(keptLines + n, 300);
});
check("가운데 오류 줄은 남기고 앞뒤에 생략 표시가 붙는다", () => {
  const r = createLetterRefiner();
  const arr = lines(300).split("\n");
  arr[150] = "ERRMID TypeError: boom at line 150";
  const out = r.refine(1, [call("b", "bash"), result("b", arr.join("\n"))]);
  const { body: kept } = split(out[1].content);
  assert.ok(kept.includes("ERRMID TypeError: boom at line 150"));
  assert.equal((kept.match(/줄 생략/g) ?? []).length, 2);
});
check("오류 줄 예산 1400자를 넘지 않는다", () => {
  const r = createLetterRefiner();
  const arr = lines(300).split("\n");
  for (let i = 100; i < 200; i++) arr[i] = `ERRMID${i} error `.padEnd(100, "x");
  const out = r.refine(1, [call("b", "bash"), result("b", arr.join("\n"))]);
  const { body: kept } = split(out[1].content);
  const errs = kept.split("\n").filter((l) => l.startsWith("ERRMID"));
  const sum = errs.reduce((s, l) => s + l.length, 0);
  assert.ok(errs.length >= 10, `오류 줄 ${errs.length}`);
  assert.ok(sum <= 1400, `합 ${sum}`);
  assert.ok(errs[0].startsWith("ERRMID100"), "앞에서부터 고른다");
});
check("오류 줄은 줄당 300자로 자른다", () => {
  const r = createLetterRefiner();
  const arr = lines(300).split("\n");
  for (let i = 100; i < 120; i++) arr[i] = `ERRMID${i} fatal ` + "z".repeat(1000);
  const out = r.refine(1, [call("b", "bash"), result("b", arr.join("\n"))]);
  const { body: kept } = split(out[1].content);
  const errs = kept.split("\n").filter((l) => l.startsWith("ERRMID"));
  assert.ok(errs.length >= 3 && errs.length <= 5, `오류 줄 ${errs.length}`);
  assert.ok(errs.every((l) => l.length <= 300), "줄당 300자 이하");
  assert.ok(errs.reduce((s, l) => s + l.length, 0) <= 1400);
});
check("한 줄뿐인 아주 긴 출력은 앞 1200자와 뒤 1200자를 둘 다 남긴다", () => {
  const r = createLetterRefiner();
  const one = Array.from({ length: 10000 }, (_, i) => String.fromCharCode(97 + (i % 26)) + (i % 7)).join("").slice(0, 10000);
  const out = r.refine(1, [call("b", "bash"), result("b", one)]);
  const { body: kept, marker } = split(out[1].content);
  assert.equal(kept, `${one.slice(0, 1200)}\n… (1줄 생략) …\n${one.slice(-1200)}`);
  assert.equal(marker, "… (원래 10000자 중 2401자만 색인 · 중간 출력은 검색표에 없음)");
});
check("4000자 이하 bash 출력은 그대로", () => {
  const r = createLetterRefiner();
  const body = "k".repeat(4000);
  const out = r.refine(1, [call("b", "bash"), result("b", body)]);
  assert.equal(out[0].content === "⚙ Bash(ls)", true);
  assert.equal(out[1].content, `▸ ${body}`);
});
check("file_read 종류는 길어도 그대로", () => {
  const r = createLetterRefiner();
  const body = longBash();
  const out = r.refine(1, [call("f", "file_read", 0, "⚙ Read(x)"), result("f", body)]);
  assert.equal(out[1].content, `▸ ${body}`);
});
check("kind를 모르는(호출 기록이 없는) 결과는 그대로", () => {
  const r = createLetterRefiner();
  const body = longBash();
  assert.equal(r.refine(1, [result("zzz", body)])[0].content, `▸ ${body}`);
  assert.equal(r.refine(2, [result(undefined, body + "!")])[0].content, `▸ ${body}!`);
});
check("호출이 앞 사건에 있어도 id로 kind를 찾는다", () => {
  const r = createLetterRefiner();
  r.refine(1, [call("late", "bash")]);
  const out = r.refine(2, [result("late", longBash())]);
  assert.ok(out[0].content.length < 4000);
});
check("긴 bash 출력을 두 번 보면 두 번째는 접힘 표시(원본 번호는 첫 항목)", () => {
  const r = createLetterRefiner();
  const body = longBash();
  const a = r.refine(5, [call("b1", "bash"), result("b1", body, 1)]);
  assert.match(a[1].content, /자만 색인 · 중간 출력은 검색표에 없음\)$/);
  const b = r.refine(8, [call("b2", "bash"), result("b2", body, 1)]);
  assert.match(b[1].content, /^▸ \(앞의 #500001와 같은 출력 \d+자\)$/);
});

console.log("— 오류 줄 보존(검토 지적 사항)");
const longOut = (n = 300) => lines(n).split("\n");
const compressed = (body: string, seq = 1) => {
  const r = createLetterRefiner();
  return r.refine(seq, [call("b", "bash"), result("b", body)])[1].content;
};
check("\\r만 쓰는 진행 표시 출력 끝의 오류 문구가 남는다", () => {
  const body = Array.from({ length: 400 }, (_, i) => `progress ${i}%`).join("\r") + "\rnpm ERR! code ELIFECYCLE";
  const c = compressed(body);
  assert.ok(c.includes("npm ERR! code ELIFECYCLE"));
  assert.ok(!c.includes("\r"));
});
check("\\r\\n 줄바꿈도 줄로 센다", () => {
  const arr = longOut();
  arr[150] = "ERRMID TypeError: boom";
  const c = compressed(arr.join("\r\n"));
  assert.ok(c.includes("ERRMID TypeError: boom"));
  assert.ok(!c.includes("\r"));
});
check("마지막 줄 하나가 1200자보다 길면 그 줄의 뒤 1200자가 남는다", () => {
  const arr = longOut();
  arr.push("W".repeat(3000) + "TAILEND");
  const c = compressed(arr.join("\n"));
  const { body: kept } = split(c);
  assert.ok(kept.endsWith("W".repeat(1193) + "TAILEND"));
  assert.ok(!kept.includes("W".repeat(1201)));
});
check("가운데 빈 줄이 있어도 줄 수와 오류 줄이 맞는다", () => {
  const arr = longOut();
  for (let i = 100; i < 110; i++) arr[i] = "";
  arr[120] = "ERRMID fatal: x";
  const c = compressed(arr.join("\n"));
  const { body: kept } = split(c);
  assert.ok(kept.includes("ERRMID fatal: x"));
  const n = [...kept.matchAll(/… \((\d+)줄 생략\) …/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  const keptLines = kept.split("\n").filter((l) => !/^… \(\d+줄 생략\) …$/.test(l)).length;
  assert.equal(keptLines + n, 300);
});
check("줄 400자 뒤에 오류 낱말이 있어도 남는다", () => {
  const arr = longOut();
  arr[150] = "y".repeat(400) + " fatal: bad object deadbeef";
  const { body: kept } = split(compressed(arr.join("\n")));
  assert.ok(kept.includes("fatal: bad object deadbeef"));
  const errLine = kept.split("\n").find((l) => l.includes("fatal: bad object"))!;
  assert.ok(errLine.length <= 300, `줄 ${errLine.length}`);
});
check("첫 줄이 1200자보다 길고 그 줄 뒤쪽에 오류가 있어도 남는다", () => {
  const arr = longOut();
  arr[0] = "h".repeat(2000) + " Error: first line boom";
  const { body: kept } = split(compressed(arr.join("\n")));
  assert.ok(kept.includes("Error: first line boom"));
  assert.ok(kept.startsWith("h".repeat(1200)));
});
check("'0 errors' 줄이 예산을 다 쓰지 않아 뒤의 진짜 오류 줄이 남는다", () => {
  const arr = longOut();
  for (let i = 60; i < 160; i++) arr[i] = `suite${i}: 0 errors, 0 failures`.padEnd(60, " ");
  arr[200] = "TypeError: cannot read properties of undefined";
  const { body: kept } = split(compressed(arr.join("\n")));
  assert.ok(kept.includes("TypeError: cannot read properties of undefined"));
  assert.ok(!kept.includes("0 errors, 0 failures"));
});
check("새 오류 낱말(No such file, Segmentation fault, npm ERR!, 에러)이 오류 줄로 남는다", () => {
  const arr = longOut();
  arr[110] = "ls: /x: No such file or directory";
  arr[120] = "Segmentation fault: 11";
  arr[130] = "npm ERR! code E401";
  arr[140] = "에러: 파일을 열 수 없다";
  const { body: kept } = split(compressed(arr.join("\n")));
  for (const w of ["No such file or directory", "Segmentation fault: 11", "npm ERR! code E401", "에러: 파일을 열 수 없다"]) {
    assert.ok(kept.includes(w), w);
  }
});
check("오류 줄 예산은 합이 1400자 이하이고 예산에 맞는 건 앞에서부터 담는다(정확한 개수)", () => {
  const arr = longOut();
  for (let i = 100; i < 200; i++) arr[i] = `ERRMID${i} error `.padEnd(100, "x");
  const { body: kept } = split(compressed(arr.join("\n")));
  const errs = kept.split("\n").filter((l) => l.startsWith("ERRMID"));
  assert.equal(errs.length, 14);
  assert.equal(errs[0].slice(0, 9), "ERRMID100");
  assert.equal(errs[13].slice(0, 9), "ERRMID113");
});
check("원문은 다르지만 압축본이 같아지는 두 출력은 접지 않는다(해시는 압축 전 내용)", () => {
  const r = createLetterRefiner();
  const a = longOut();
  const b = longOut();
  a[150] = "plain middle A";
  b[150] = "plain middle B"; // 가운데는 머리·꼬리·오류 줄 밖이라 압축본은 같다
  const first = r.refine(1, [call("t1", "bash"), result("t1", a.join("\n"), 1)])[1].content;
  const second = r.refine(2, [call("t2", "bash"), result("t2", b.join("\n"), 1)])[1].content;
  assert.equal(first, second);
  assert.ok(!second.startsWith("▸ (앞의 #"));
});
check("같은 seq를 두 번 넘겨도 자기 자신을 가리키지 않는다", () => {
  const r = createLetterRefiner();
  const body = "q".repeat(600);
  r.refine(5, [result("a", body, 1)]);
  assert.equal(r.refine(5, [result("a", body, 1)])[0].content, `▸ ${body}`);
});
check("예전 검색 결과의 여러 형식이 버려진다", () => {
  const r = createLetterRefiner();
  const bodies = [
    '"빌드" 검색 3건 — 요약', "3 result(s) for \"x\"", 'Past-search summary for "x"',
    "session=abcd context around 10", "No results for \"zz\"", "Raw session=abc rows", "No more raw messages",
  ];
  const out = r.refine(1, bodies.map((b, i) => result(`s${i}`, b, i + 1)));
  assert.deepEqual(out, []);
});
check("줄바꿈이 없는 단일 줄 끝의 오류 문구도 남는다", () => {
  const body = "x".repeat(6000) + " Error: boom at end";
  assert.ok(split(compressed(body)).body.endsWith("Error: boom at end"));
});

check("긴 한 줄 뒤에 줄바꿈이 붙어도 꼬리가 남는다", () => {
  const body = "z".repeat(10000) + "TAILMARK\n";
  const { body: kept } = split(compressed(body));
  assert.ok(kept.endsWith("TAILMARK\n") || kept.includes("TAILMARK"));
  assert.ok(kept.startsWith("z".repeat(1200)));
});
check("맨 앞이 줄바꿈이고 뒤에 긴 줄이 이어져도 머리가 남는다", () => {
  const { body: kept } = split(compressed("\nHEADMARK" + "q".repeat(10000)));
  assert.ok(kept.includes("HEADMARK"));
});
check("짧은 줄 다음에 긴 줄이 와도 머리·꼬리가 통째로 사라지지 않는다", () => {
  const body = "$ cmd\n" + "HEADMARK" + "p".repeat(10000) + "\nok";
  const { body: kept } = split(compressed(body));
  assert.ok(kept.includes("$ cmd") && kept.includes("HEADMARK") && kept.includes("ok"));
  assert.ok(kept.length > 1500, `남긴 길이 ${kept.length}`);
});
check("'0 errors' 뒤 멀리 있는 진짜 오류도 남는다", () => {
  const arr = longOut();
  arr[150] = "Found 0 errors" + " ".repeat(500) + "fatal: REALERR";
  const { body: kept } = split(compressed(arr.join("\n")));
  assert.ok(kept.includes("fatal: REALERR"));
});

console.log("— 입력 불변 · 규칙 · 상태 분리");
check("입력 배열과 항목을 바꾸지 않는다", () => {
  const r = createLetterRefiner();
  const items = [call("b", "bash"), result("b", longBash()), result("p", '"q" 검색 2건 ' + "x".repeat(10))];
  const snap = JSON.parse(JSON.stringify(items));
  const out = r.refine(1, items);
  assert.deepEqual(items, snap);
  assert.notEqual(out, items);
});
check("규칙 인자(Partial)가 기본값을 덮어쓴다", () => {
  const r = createLetterRefiner({ longMin: 100, head: 50, tail: 50, errBudget: 0 });
  const body = lines(20); // 약 620자, 기본 규칙이면 압축 안 됨
  const out = r.refine(1, [call("b", "bash"), result("b", body)]);
  assert.ok(out[1].content.length < body.length, `길이 ${out[1].content.length}`);
  assert.match(out[1].content, /줄 생략/);
  const base = createLetterRefiner();
  assert.equal(base.refine(1, [call("b", "bash"), result("b", body)])[1].content, `▸ ${body}`);
});
check("dedupeMin 덮어쓰기", () => {
  const r = createLetterRefiner({ dedupeMin: 10 });
  r.refine(1, [result("a", "m".repeat(50))]);
  assert.match(r.refine(2, [result("b", "m".repeat(50))])[0].content, /^▸ \(앞의 #100001와 같은 출력/);
});
check("기본 규칙값이 계약과 같다", () => {
  assert.deepEqual(REFINE_RULES, { dedupeMin: 500, longMin: 4000, head: 1200, tail: 1200, errBudget: 1400, errLine: 300 });
});
check("세션마다 상태가 분리된다(refiner 둘)", () => {
  const a = createLetterRefiner();
  const b = createLetterRefiner();
  const body = "n".repeat(800);
  a.refine(1, [result("x", body)]);
  assert.equal(b.refine(2, [result("y", body)])[0].content, `▸ ${body}`, "b는 a가 본 것을 모른다");
  const bb = longBash();
  a.refine(1, [call("t", "bash")]);
  assert.equal(b.refine(3, [result("t", bb)])[0].content, `▸ ${bb}`, "b는 a의 도구 종류 기록을 모른다");
});
check("압축이 원래보다 길면 원래대로 둔다", () => {
  const r = createLetterRefiner({ longMin: 100, head: 5000, tail: 5000 });
  const body = lines(10, 30);
  const out = r.refine(1, [call("b", "bash"), result("b", body)]);
  assert.equal(out[1].content, `▸ ${body}`);
});

console.log(`\n통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
