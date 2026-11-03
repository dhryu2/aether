import type { CSSProperties } from 'react'
import { C } from '../../design/tokens'

export function fieldStyle(): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    border: 'none',
    borderRadius: 12,
    fontSize: 15,
    fontFamily: 'inherit',
    color: C.label,
    background: C.cell,
  }
}
