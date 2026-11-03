import { memo } from 'react'
import { Check, ChevronsDownUp, ChevronsUpDown, Copy } from 'lucide-react'
import { C, R } from '../../design/tokens'
import { useCopy } from '../../lib/hooks'
import { codeLabel, type CodeBlock } from '../../lib/composerBlocks'
import { ComposerTextarea, MAX_CODE_HEIGHT } from './ComposerTextarea'
import { MenuItem } from '../WorkMenu'
import { copyItem, menuOf, onContextMenuFor } from '../contextMenuFor'

// 입력창 안의 코드 상자. ``` 또는 ~~~ 줄에서 Shift+Enter로 생긴다.
//   왼쪽은 언어 이름(없으면 plain). 오른쪽은 접기와 복사. 본문은 그 아래에서 고친다.
export const ComposerCodeBox = memo(function ComposerCodeBox({
  block,
  disabled,
  register,
  collapseLabel,
  expandLabel,
  copyLabel,
  copiedLabel,
  onChange,
  onKeyDown,
  onPaste,
  onToggle,
}: {
  block: CodeBlock
  disabled: boolean
  register: (id: string, el: HTMLTextAreaElement | null) => void
  collapseLabel: string
  expandLabel: string
  copyLabel: string
  copiedLabel: string
  onChange: (id: string, value: string) => void
  onKeyDown: (id: string, e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (id: string, e: React.ClipboardEvent<HTMLTextAreaElement>) => void
  onToggle: (id: string) => void
}) {
  const { copied, copy } = useCopy()
  const label = codeLabel(block.lang)
  const fold = block.collapsed ? expandLabel : collapseLabel
  return (
    <div
      className="composer-code"
      // 안의 글칸은 입력칸이라 기본 메뉴가 뜬다. 이 메뉴는 머리와 테두리 쪽에서 쓰인다.
      onContextMenu={onContextMenuFor(() => menuOf(
        copyItem(block.value, copyLabel),
        <MenuItem onClick={() => onToggle(block.id)}>{fold}</MenuItem>,
      ))}
      style={{
        border: `1px solid ${C.sep}`,
        background: C.cell,
        borderRadius: R.card,
        padding: '8px 8px 8px',
        margin: '2px 0',
        minWidth: 0,
      }}
    >
      <div className="flex items-center" style={{ gap: 8, minWidth: 0, padding: '0 2px 2px' }}>
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 14,
            color: C.label,
            paddingLeft: 6,
          }}
        >
          {label}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="composer-code-btn"
          aria-expanded={!block.collapsed}
          aria-label={fold}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onToggle(block.id)}
        >
          {block.collapsed ? <ChevronsUpDown size={15} /> : <ChevronsDownUp size={15} />}
          {fold}
        </button>
        <button
          type="button"
          className="composer-code-btn"
          aria-label={copied ? copiedLabel : copyLabel}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => copy(block.value)}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? copiedLabel : copyLabel}
        </button>
      </div>
      {block.collapsed && block.value.trim() !== '' && (
        <div
          className="font-mono"
          style={{
            fontSize: 12.5,
            color: C.label3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            padding: '2px 8px 4px',
          }}
        >
          {block.value.trim().split('\n')[0]}
        </div>
      )}
      {!block.collapsed && (
        <ComposerTextarea
          blockId={block.id}
          register={register}
          value={block.value}
          disabled={disabled}
          placeholder=""
          maxHeight={MAX_CODE_HEIGHT}
          minHeight={24}
          code
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      )}
    </div>
  )
})
