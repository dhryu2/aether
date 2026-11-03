/** 우클릭 메뉴 판정 시험: 터치·입력칸·링크·글자 선택은 기본 메뉴, 화면 밖 밀기. 실행: npx tsx web/test/contextMenu.test.ts */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { clampMenuPos, selectionTouches, wantsAppMenu, type MenuTarget, type SelectionLike } from '../src/lib/contextMenu'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/** 선택자 목록에 tag가 들어 있으면 closest가 참을 돌려주는 흉내 요소. */
const el = (tag: string): MenuTarget => ({ closest: (sel) => (sel.split(',').includes(tag) ? {} : null) })
const base = { coarsePointer: false, target: el('div'), selectedText: '', selectionInWidget: false }

check('보통 우클릭은 앱 메뉴', wantsAppMenu(base))
check('터치 기기는 열지 않는다', !wantsAppMenu({ ...base, coarsePointer: true }))
for (const tag of ['a', 'input', 'textarea', 'select', 'img', '[contenteditable]']) check(`${tag} 위는 기본 메뉴`, !wantsAppMenu({ ...base, target: el(tag) }))
check('글자를 골라 둔 채 위젯 안이면 기본 메뉴', !wantsAppMenu({ ...base, selectedText: 'abc', selectionInWidget: true }))
check('다른 곳의 선택은 무시한다', wantsAppMenu({ ...base, selectedText: 'abc', selectionInWidget: false }))
check('선택이 비어 있으면 무시한다', wantsAppMenu({ ...base, selectedText: '', selectionInWidget: true }))
check('대상이 없어도 판정은 선택만 본다', wantsAppMenu({ ...base, target: null }))

check('안에 있으면 그대로', JSON.stringify(clampMenuPos(100, 100, 200, 150, 1000, 800)) === '{"x":100,"y":100}')
check('오른쪽·아래로 넘치면 안쪽으로 민다', JSON.stringify(clampMenuPos(950, 780, 200, 150, 1000, 800)) === '{"x":792,"y":642}')
check('화면보다 크면 여백에 붙인다', JSON.stringify(clampMenuPos(50, 50, 2000, 2000, 1000, 800)) === '{"x":8,"y":8}')
check('음수 좌표도 여백까지', JSON.stringify(clampMenuPos(-5, -5, 100, 100, 1000, 800)) === '{"x":8,"y":8}')

// 선택 겹침: 걸치기만 해도, 위젯을 양쪽에서 통째로 덮어도 참. Selection.containsNode(widget, true)가 그 뜻이다.
const widget = {} as Node
const sel = (collapsed: boolean, touches: boolean): SelectionLike => ({
  isCollapsed: collapsed,
  toString: () => (collapsed ? '' : 'x'),
  containsNode: (n, partial) => n === widget && partial === true && touches,
})
check('선택이 위젯에 걸치면 참(양쪽을 덮는 경우 포함)', selectionTouches(widget, sel(false, true)))
check('선택이 위젯과 무관하면 거짓', !selectionTouches(widget, sel(false, false)))
check('접힌 선택(캐럿)은 거짓', !selectionTouches(widget, sel(true, true)))
check('선택이 없으면 거짓', !selectionTouches(widget, null))

// Esc 회귀(순수 함수로 시험할 수 없어 소스 구조를 지킨다): 메뉴는 window 캡처 단계에서 Esc를 삼켜야 전역 단축키·창의 Esc가 같이 돌지 않는다.
const dir = path.dirname(fileURLToPath(import.meta.url))
const menuSrc = fs.readFileSync(path.join(dir, '../src/components/shell/ContextMenu.tsx'), 'utf8')
const keysSrc = fs.readFileSync(path.join(dir, '../src/components/shell/useGlobalShortcuts.ts'), 'utf8')
check('메뉴가 window keydown을 캡처 단계로 듣는다', /window\.addEventListener\('keydown', onKey, true\)/.test(menuSrc))
check('Esc에서 stopPropagation으로 삼킨다', /e\.key !== 'Escape'\) return\s*e\.stopPropagation\(\)/.test(menuSrc))
check('메뉴가 document 단계의 useDismiss를 쓰지 않는다', !/useDismiss\(/.test(menuSrc))
check('전역 Esc 분기에 메뉴 전용 방어가 남아 있지 않다', !/Escape'\) \{\s*if \(s\.contextMenu\)/.test(keysSrc))

console.log(`\n${pass} 통과, ${fail} 실패`)
process.exit(fail ? 1 : 0)
