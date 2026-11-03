/**
 * 지식툴 서술자 + Claude adapter 검증 (Phase 8d-1 · D8.1). 모델 호출 0 — 순수 정의·변환만 본다.
 *
 * 지키려는 것:
 *   ① 모델이 보는 툴 이름이 8d-1 이전과 동일(mcp__aether__*) — 바뀌면 프롬프트 안내문·자동승인·기존 세션이 어긋난다.
 *   ② 중립 서술자 → zod 변환이 8d-1 이전 스키마와 같은 계약(필수/선택·enum 값·정수 범위).
 *   ③ 세션 바인딩 경계 — 어떤 툴 스키마에도 cwd가 없다(모델이 다른 프로젝트를 지정할 통로 차단 — D8).
 *   ④ 3툴 전부 autoApprove(권한 카드 없이 자동 허용).
 */
import { z } from "zod";
import { buildKnowledgeTools } from "../knowledge/tools";
import { claudeToolName, toZodShape } from "../providers/claude/knowledgeMcp";
import type { KnowledgeToolDefinition } from "../knowledge/types";
import type { TodoItem } from "../../shared/agentEvent";

let pass = 0;
let fail = 0;
function check(cond: boolean, name: string, extra = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
  cond ? pass++ : fail++;
}

const tools = buildKnowledgeTools();
const byName = new Map(tools.map((t) => [t.name, t]));
const need = (n: string): KnowledgeToolDefinition => {
  const t = byName.get(n as KnowledgeToolDefinition["name"]);
  if (!t) throw new Error(`${n} 서술자 없음(플래그가 꺼져 있으면 이 스위트는 기본 config로 돌려야 한다)`);
  return t;
};

// ── ① 모델이 보는 이름 (8d-1 이전 상수와 동일해야 함) ──
check(tools.length === 2, `기본 config에서 지식툴 2종(검색 + 할 일)`, `n=${tools.length}`);
check(claudeToolName(need("session_search")) === "mcp__aether__session_search", "session_search 이름 불변");
check(claudeToolName(need("todo_update")) === "mcp__aether__todo_update", "todo_update는 mcp__aether__todo_update로 보인다");

// ── ③④ 세션 바인딩 경계 + 자동 허용 ──
check(tools.every((t) => t.binding === "session"), "지식툴 전부 세션 바인딩");
check(tools.every((t) => t.autoApprove), "지식툴 전부 카드 없이 자동 허용");
check(
  tools.every((t) => !Object.keys(t.parameters).some((k) => /^cwd$/i.test(k))),
  "어떤 툴도 cwd를 모델 인자로 받지 않는다(D8 보안 경계)",
);
check(tools.every((t) => t.description.trim().length > 0), "지식툴 전부 설명이 비어있지 않다(라우팅 근거)");

// ── ② zod 변환 계약 ──
const schema = (n: string) => z.object(toZodShape(z, need(n)));

const search = schema("session_search");
check(search.safeParse({}).success, "session_search: 인자 전부 선택(빈 호출 허용 — 8d-1 이전과 동일)");
check(search.safeParse({ query: "빌드 실패", limit: 4 }).success, "session_search: query+limit 정상");
check(!search.safeParse({ limit: 0 }).success, "session_search: limit 하한(1) 강제");
check(!search.safeParse({ limit: 11 }).success, "session_search: limit 상한(10) 강제");
check(!search.safeParse({ limit: 2.5 }).success, "session_search: limit 정수 강제");
check(!search.safeParse({ around_id: "3" }).success, "session_search: around_id 문자열 거부(정수)");
check(search.safeParse({ session_id: "s", after_id: 10, role: "tool" }).success, "session_search: BROWSE cursor+role 정상");
check(!search.safeParse({ role: "system" }).success, "session_search: 미지원 role 거부");
check(search.safeParse({ scope: "project" }).success, "session_search: scope=project 허용");
check(search.safeParse({ scope: "all" }).success, "session_search: scope=all 허용");
check(!search.safeParse({ scope: "folder" }).success, "session_search: scope는 project와 all만 허용");

// ── 할 일 도구: zod 스키마 + 처리 함수 ──
const todo = schema("todo_update");
const item = (status: string, text = "일") => ({ text, status });
check(todo.safeParse({ items: [item("pending"), item("in_progress"), item("completed")] }).success, "todo_update: 정상 입력 통과");
check(todo.safeParse({ items: [] }).success, "todo_update: 빈 목록 허용(지우기)");
check(!todo.safeParse({ items: [item("done")] }).success, "todo_update: 잘못된 status 거부");
check(!todo.safeParse({ items: [{ status: "pending" }] }).success, "todo_update: text 누락 거부");
check(!todo.safeParse({ items: Array.from({ length: 51 }, () => item("pending")) }).success, "todo_update: 51개 거부");
check(todo.safeParse({ items: Array.from({ length: 50 }, () => item("pending")) }).success, "todo_update: 50개 허용");
{
  const got: unknown[] = [];
  const ctx = (onTodoList?: (i: TodoItem[]) => void) => ({ cwd: "/", services: {} as never, onTodoList });
  const def = need("todo_update");
  const text = async (args: Record<string, unknown>, c: ReturnType<typeof ctx>) => (await def.handler(args, c)).content[0].text;
  await text({ items: [{ text: "  가나다  ", status: "pending" }, { text: "x".repeat(400), status: "completed" }] }, ctx((i) => got.push(i)));
  const first = got[0] as { text: string; status: string }[];
  check(first[0].text === "가나다" && first[1].text.length === 300, "todo_update: 앞뒤 공백을 자르고 300자에서 자른다");
  const before = got.length;
  const bad = [{ items: [{ text: "   ", status: "pending" }] }, { items: [{ text: "a", status: "no" }] }, { items: "x" }, { items: Array.from({ length: 51 }, () => item("pending")) }];
  for (const a of bad) await text(a, ctx((i) => got.push(i)));
  check(got.length === before, "todo_update: 잘못된 입력이면 콜백을 부르지 않고 글 결과만 돌려준다");
  const none = await text({ items: [] }, ctx());
  check(none.length > 0 && !none.includes("갱신했다"), "todo_update: 콜백이 없으면 안내 글을 돌려준다");
  await text({ items: [] }, ctx((i) => got.push(i)));
  check(JSON.stringify(got.at(-1)) === "[]", "todo_update: 빈 목록도 콜백으로 전달된다");
}

console.log(`\n${fail === 0 ? "✅" : "❌"} knowledge_tools: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
