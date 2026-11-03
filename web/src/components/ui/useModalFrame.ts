import { createContext, useContext, type RefObject } from 'react'

type ModalFrame = {
  titleId: string
  descId: string
  closeRef: RefObject<HTMLButtonElement | null>
  boxRef: RefObject<HTMLDivElement | null>
  narrow: boolean
}

export const ModalFrameCtx = createContext<ModalFrame | null>(null)

export function useModalFrame(): ModalFrame {
  const ctx = useContext(ModalFrameCtx)
  if (!ctx) throw new Error('창 부품은 ModalShell 안에서만 쓴다')
  return ctx
}
