import { Home, Search } from 'lucide-react'

/** 두 탭의 목록. 탭 막대와 창 껍데기가 같은 순서를 쓴다. */
export const BRAIN_TABS = [
  { id: 'hub', labelKey: 'brain.tabs.hub', Icon: Home },
  { id: 'search', labelKey: 'brain.tabs.search', Icon: Search },
] as const
