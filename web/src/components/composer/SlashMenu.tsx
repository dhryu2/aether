import { C, FONT, Z } from '../../design/tokens'
import { PopoverSurface } from '../ui'
import type { SlashCmd } from '../../lib/slashCommands'

// 슬래시 명령 메뉴 — 입력 위로 떠서 표시(높이 변동 없음). onMouseDown으로 포커스 유지하며 선택.
export function SlashMenu({ cmds, sel, onHover, onPick }: {
  cmds: SlashCmd[]
  /** 키보드·마우스로 고른 항목의 인덱스. */
  sel: number
  onHover: (i: number) => void
  onPick: (c: SlashCmd) => void
}) {
  return (
    <PopoverSurface
      direction="up"
      align="left"
      zIndex={Z.inApp.slashMenu}
      style={{
        // 기존 위치·스크롤 규칙 유지: 좌우로 꽉 채우고, 명령이 많으면 화면 위로 넘치지 않게 세로 스크롤.
        bottom: 'calc(100% + 8px)',
        right: 0,
        overflowX: 'hidden',
        overflowY: 'auto',
        maxHeight: 'min(46vh, 360px, calc(var(--pane-h, 100vh) - var(--composer-h, 0px) - var(--bar-h, 0px) - 16px))',
      }}
    >
      {cmds.map((c, i) => (
        <button
          key={c.cmd}
          type="button"
          data-slash-name={c.name}
          ref={i === sel ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
          onMouseDown={(e) => {
            e.preventDefault() // textarea blur 방지(포커스 유지)
            onPick(c)
          }}
          onMouseEnter={() => onHover(i)}
          className="flex w-full items-baseline text-left"
          style={{ gap: 8, padding: '9px 12px', background: i === sel ? C.tintSoft : 'transparent', cursor: 'pointer' }}
        >
          <code style={{ fontFamily: FONT.mono, fontSize: 12.5, fontWeight: 600, color: C.tint, flexShrink: 0 }}>{c.cmd}</code>
          <span className="truncate" style={{ fontFamily: FONT.mono, fontSize: 10.5, color: C.label3 }}>{c.arg}</span>
          <span style={{ fontSize: 11.5, color: C.label2, marginLeft: 'auto', flexShrink: 0 }}>{c.desc}</span>
        </button>
      ))}
    </PopoverSurface>
  )
}
