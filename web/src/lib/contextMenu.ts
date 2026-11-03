// 우클릭 메뉴의 순수 판정 — 어떤 우클릭에 앱 메뉴를 띄우고 어떤 우클릭은 브라우저 기본 메뉴에 맡길지,
//   그리고 메뉴가 화면 밖으로 나가지 않게 자리를 미는 계산. store를 모른다(시험하기 쉽게).

/** 브라우저 기본 메뉴가 더 쓸모 있는 대상 — 링크·입력칸·이미지. 이 안을 누르면 앱 메뉴를 열지 않는다. */
export const NATIVE_MENU_TARGETS = 'a,input,textarea,select,img,[contenteditable]'

/** 대상 요소를 추상화한 모양. 실제로는 Element를 넘기고, 시험에서는 흉내 객체를 넘긴다. */
export type MenuTarget = { closest(selector: string): unknown }

export function wantsAppMenu(o: {
  /** 터치가 주 입력인 기기. 길게 누르기와 겹치므로 앱 메뉴를 열지 않는다(폭이 아니라 입력수단 기준). */
  coarsePointer: boolean
  target: MenuTarget | null
  /** 지금 선택된 글. 비어 있으면 선택 없음. */
  selectedText: string
  /** 그 선택이 이 위젯 안에 걸쳐 있는가. */
  selectionInWidget: boolean
}): boolean {
  if (o.coarsePointer) return false
  if (o.target?.closest(NATIVE_MENU_TARGETS)) return false
  // 글을 골라 둔 채 우클릭하면 「복사」 같은 기본 메뉴가 필요하다.
  if (o.selectedText !== '' && o.selectionInWidget) return false
  return true
}

/** 판정에 쓰는 선택의 모양. 실제 Selection이거나, 우클릭 직전에 복제해 둔 선택(contextMenuFor.tsx). */
export type SelectionLike = {
  isCollapsed: boolean
  toString(): string
  containsNode(node: Node, allowPartialContainment?: boolean): boolean
}

/** 선택이 위젯과 겹치는가. 위젯 일부만 걸쳐도, 선택이 위젯을 양쪽에서 통째로 덮어도 참이다. */
export function selectionTouches(widget: Node, sel: SelectionLike | null = window.getSelection()): boolean {
  if (!sel || sel.isCollapsed) return false
  return sel.containsNode(widget, true)
}

/** 메뉴 왼쪽 위 좌표를 화면 안으로 민다. 화면보다 크면 왼쪽·위 여백에 붙인다. */
export function clampMenuPos(x: number, y: number, w: number, h: number, vw: number, vh: number, margin = 8): { x: number; y: number } {
  return {
    x: Math.max(margin, Math.min(x, vw - w - margin)),
    y: Math.max(margin, Math.min(y, vh - h - margin)),
  }
}
