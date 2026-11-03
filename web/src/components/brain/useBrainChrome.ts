import { createContext, useContext } from 'react'

export type BrainBack = { label: string; onBack: () => void }

type Api = {
  back: BrainBack | null
  setBack: (next: BrainBack | null) => void
}

export const BrainChromeCtx = createContext<Api | null>(null)

export function useBrainChrome(): Api {
  const api = useContext(BrainChromeCtx)
  if (!api) throw new Error('BrainChrome missing')
  return api
}
