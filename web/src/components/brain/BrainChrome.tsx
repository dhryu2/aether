// 스킬 상세의 "뒤로"를 창 껍데기에 알린다. 스킬 화면이 창 파일을 직접 가져오면 순환이 된다.
import { useMemo, useState, type ReactNode } from 'react'
import { BrainChromeCtx, type BrainBack } from './useBrainChrome'

export function BrainChrome({ children }: { children: ReactNode }) {
  const [back, setBack] = useState<BrainBack | null>(null)
  const api = useMemo(() => ({ back, setBack }), [back])
  return <BrainChromeCtx.Provider value={api}>{children}</BrainChromeCtx.Provider>
}
