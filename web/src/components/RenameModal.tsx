// 세션 이름 바꾸기 창. 세션 카드는 통째로 <button>이라 그 안에 입력칸을 못 넣어서 작은 창으로 띄운다.
//   Enter = 저장, Esc·막 클릭 = 취소, 빈 이름이면 저장 단추가 꺼진다. 열리면 지금 이름이 선택되어 있다.
import { useEffect, useRef, useState, type RefObject } from 'react'
import { actions, useStore } from '../lib/store'
import { useT } from '../lib/i18n'
import { swallowEnter } from '../lib/questionnaire'
import { C, Z } from '../design/tokens'
import { Button, ModalCard, ModalShell } from './ui'
import { useModalFrame } from './ui/useModalFrame'
import { fieldStyle } from './newSession/fieldStyle'

/** 서버가 받는 이름 길이(store의 renameSession과 같다). */
const NAME_MAX = 80

export function RenameModal() {
  const target = useStore().renameTarget
  return target ? <RenameWindow key={target.id} id={target.id} initial={target.name} /> : null
}

function RenameWindow({ id, initial }: { id: string; initial: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <ModalShell onClose={actions.closeRename} zIndex={Z.root.deleteConfirm} initialFocusRef={inputRef}>
      <ModalCard variant="alert" data-window="rename">
        <RenameBody id={id} initial={initial} inputRef={inputRef} />
      </ModalCard>
    </ModalShell>
  )
}

function RenameBody({ id, initial, inputRef }: { id: string; initial: string; inputRef: RefObject<HTMLInputElement | null> }) {
  const t = useT()
  const { titleId } = useModalFrame()
  const [name, setName] = useState(initial)
  const ok = name.trim() !== ''
  // 초점은 창 틀이 다음 프레임에 준다. 그 뒤에 이름 전체를 선택해 바로 덮어쓰게 한다.
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.select())
    return () => cancelAnimationFrame(frame)
  }, [inputRef])
  const save = () => {
    if (!ok) return
    void actions.renameSession(id, name)
    actions.closeRename()
  }
  return (
    <div>
      <h2 id={titleId} style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.35, color: C.label }}>
        {t('menu.rename.title')}
      </h2>
      <input
        ref={inputRef}
        className="sheet-field"
        aria-label={t('menu.rename.label')}
        value={name}
        maxLength={NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        // 한글 조합 중의 Enter(keyCode 229 포함)는 글자를 확정하는 키다. 저장으로 읽지 않는다.
        onKeyDown={(e) => { if (swallowEnter({ key: e.key, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) save() }}
        style={{ ...fieldStyle(), height: 44, padding: '0 16px', marginTop: 14 }}
      />
      <div className="flex" style={{ gap: 10, marginTop: 18 }}>
        <Button tone="gray" grow height={44} fontSize={15} onClick={actions.closeRename}>{t('common.cancel')}</Button>
        <Button tone="primary" grow height={44} fontSize={15} disabled={!ok} onClick={save}>{t('common.save')}</Button>
      </div>
    </div>
  )
}
