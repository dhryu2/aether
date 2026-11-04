import { ClipboardCheck } from 'lucide-react'

/** 탭의 목록. 하나뿐이면 탭 막대를 그리지 않는다. 탭 막대와 창 껍데기가 같은 순서를 쓴다. */
export const BRAIN_TABS = [
  { id: 'review', labelKey: 'brain.tabs.review', Icon: ClipboardCheck },
] as const
