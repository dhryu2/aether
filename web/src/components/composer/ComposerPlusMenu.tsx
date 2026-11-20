import { useRef, useState, type ReactNode } from 'react'
import { FolderOpen, Paperclip, Plus } from 'lucide-react'
import { C, R } from '../../design/tokens'
import { useDismiss } from '../../lib/hooks'
import { useT } from '../../lib/i18n'
import { ACCEPT_ALL } from '../../lib/attachments'
import { PopoverSurface } from '../ui'

// 입력창 아랫줄 왼쪽의 ＋ 버튼. 누르면 위로 작은 메뉴가 열린다 — 파일 첨부.
//   한때 첨부·코드 상자·마이크·즐겨찾기가 글 칸과 한 줄에 나란히 있어서, 폰에서는 글 칸이 손가락 두 개 폭으로 줄었다.
//   자주 누르지 않는 동작을 이 버튼 뒤로 모았다. 붙여넣기·끌어 놓기 첨부와 ``` 뒤 Shift+Enter 코드 상자는 메뉴 없이 된다.
//   숨은 <input type=file>은 메뉴 밖에 둔다. 메뉴가 닫힌 뒤에도 파일 고르기 창의 결과를 받아야 해서다.
export function ComposerPlusMenu({ attachDisabled, size, onFiles, onBrowse }: {
  attachDisabled: boolean
  /** 버튼 한 변(px). */
  size: number
  onFiles: (files: File[]) => void
  /** 작업 폴더 파일 열어 보기(읽기 전용). */
  onBrowse: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  useDismiss(boxRef, () => setOpen(false), open)
  // 메뉴가 열린 채로 막히면(대화 로딩 등) 닫는다. 렌더 중에 맞춰 한 번 그려졌다 닫히는 깜빡임을 없앤다.
  if (open && attachDisabled) setOpen(false)

  return (
    <div ref={boxRef} style={{ position: 'relative', flexShrink: 0 }}>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT_ALL}
        multiple
        hidden
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []))
          e.target.value = '' // 같은 파일 재선택 허용
        }}
      />
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={attachDisabled}
        aria-label={t('composer.plus.aria')}
        title={t('composer.plus.title')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-composer-plus
        className="attach-btn plus-btn hit-44 inline-flex items-center justify-center"
        style={{ width: size, height: size, borderRadius: R.full, flexShrink: 0 }}
      >
        <Plus size={20} />
      </button>
      {open && (
        <PopoverSurface role="menu" direction="up" align="left" minWidth={208}>
          <div className="flex flex-col" style={{ padding: 6 }}>
            <PlusItem
              icon={<Paperclip size={17} />}
              label={t('composer.attachButton.aria')}
              hint={t('composer.plus.attachHint')}
              disabled={attachDisabled}
              onClick={() => {
                setOpen(false)
                fileRef.current?.click()
              }}
            />
            <PlusItem
              icon={<FolderOpen size={17} />}
              label={t('composer.plus.browseLabel')}
              hint={t('composer.plus.browseHint')}
              disabled={false}
              onClick={() => {
                setOpen(false)
                onBrowse()
              }}
            />
          </div>
        </PopoverSurface>
      )}
    </div>
  )
}

function PlusItem({ icon, label, hint, disabled, onClick }: {
  icon: ReactNode
  label: string
  /** 둘째 줄 — 무엇을 넣는지, 또는 버튼 말고 같은 일을 하는 방법. */
  hint: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="menu-row flex w-full items-center text-left"
      style={{ gap: 10, minHeight: 44, padding: '6px 10px', borderRadius: R.sm, color: disabled ? C.label4 : C.label }}
    >
      <span style={{ display: 'inline-flex', color: disabled ? C.label4 : C.label2, flexShrink: 0 }}>{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.3 }}>{label}</span>
        <span style={{ fontSize: 12, color: C.label3, lineHeight: 1.3, whiteSpace: 'nowrap' }}>{hint}</span>
      </span>
    </button>
  )
}
