import type { CSSProperties } from 'react'
import { X, FileText } from 'lucide-react'
import { C, R, alpha } from '../../design/tokens'
import { useT } from '../../lib/i18n'
import { IconButton } from '../ui'
import type { Attachment } from '../../lib/attachments'

// 첨부 미리보기 제거(×) 버튼 스타일 — 이미지/파일 칩 두 분기 공용.
const REMOVE_BTN_STYLE: CSSProperties = { position: 'absolute', top: -6, right: -6, background: C.label, boxShadow: `0 1px 4px ${alpha.ink(0.4)}` }

// 첨부 미리보기 — 이미지는 썸네일, PDF·텍스트/코드는 파일 칩. 개별 제거(×). 전송/전환 시 비워짐.
export function AttachmentPreview({ items, note, onRemove }: {
  items: Attachment[]
  /** 형식·크기·개수 초과 안내(빈 문자열이면 표시 안 함). */
  note: string
  onRemove: (i: number) => void
}) {
  const t = useT()
  return (
    <div className="flex flex-col" style={{ gap: 6, marginBottom: 8 }}>
      {items.length > 0 && (
        <div className="flex flex-wrap" style={{ gap: 8 }}>
          {items.map((a, i) => {
            const remove = (
              <IconButton label={t('composer.attach.remove')} onClick={() => onRemove(i)} size={20} radius={10} color={C.onTint} style={REMOVE_BTN_STYLE}>
                <X size={12} />
              </IconButton>
            )
            return a.kind === 'image' && a.url ? (
              <div key={i} style={{ position: 'relative', width: 60, height: 60, flexShrink: 0 }}>
                <img src={a.url} alt={t('composer.attach.previewAlt')} style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: R.pill, border: `1px solid ${C.sep}` }} />
                {remove}
              </div>
            ) : (
              <div key={i} className="inline-flex items-center" style={{ position: 'relative', gap: 7, maxWidth: 200, padding: '7px 10px', borderRadius: R.pill, background: C.bg2, border: `1px solid ${C.sep}` }}>
                <FileText size={15} style={{ color: a.kind === 'pdf' ? C.del : C.label2, flexShrink: 0 }} />
                <span className="truncate" style={{ fontSize: 12, fontWeight: 600, color: C.label2 }} title={a.name}>{a.name}</span>
                <span style={{ fontSize: 10, color: C.label3, flexShrink: 0 }}>{a.kind === 'pdf' ? 'PDF' : t('composer.attach.text')}</span>
                {remove}
              </div>
            )
          })}
        </div>
      )}
      {note && <span style={{ fontSize: 11.5, color: C.del }}>{note}</span>}
    </div>
  )
}
