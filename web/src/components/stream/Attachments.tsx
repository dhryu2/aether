// 유저 메시지에 딸린 첨부 — 이미지 썸네일과 문서(PDF) 칩.
//   두 칩은 모양이 사실상 같았다(같은 여백·모서리·배경, 테두리 색과 글자 크기만 다름) → AttachChip 하나로 모았다.
import type { ImageAttachment, DocAttachment } from '../../lib/types'
import { useT } from '../../lib/i18n'
import { onCopyMenu } from '../contextMenuFor'
import { C, R } from '../../design/tokens'
import { ImageOff, FileText } from 'lucide-react'

// 디스크 stub 이미지 판정 — 영속본은 base64 대신 "[Aether: … 비영속]" 마커로 치환됨(라이브만 full).
const isStubImage = (data: string) => data.startsWith('[Aether')

/** 첨부 묶음의 줄 — 오른쪽 정렬로 감싸고 넘치면 다음 줄로. */
function AttachRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="self-end flex flex-wrap" style={{ maxWidth: '82%', gap: 6, justifyContent: 'flex-end' }}>
      {children}
    </div>
  )
}

/** 첨부 한 개를 나타내는 칩. 비영속(stub)이면 테두리가 점선이다. */
function AttachChip({ dashed, borderColor, fontSize, color, title, fill, onContextMenu, children }: {
  onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void
  dashed?: boolean
  borderColor: string
  fontSize: number
  color: string
  title?: string
  /** 남는 가로를 채우되 부모를 넘지 않게(파일명이 길 때). */
  fill?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className="inline-flex items-center"
      style={{
        gap: 6,
        ...(fill && { maxWidth: '100%' }),
        padding: '8px 11px',
        borderRadius: R.field,
        background: C.bg2,
        border: `1px ${dashed ? 'dashed' : 'solid'} ${borderColor}`,
        fontSize,
        color,
      }}
      title={title}
      onContextMenu={onContextMenu}
    >
      {children}
    </div>
  )
}

// 첨부 이미지 썸네일 묶음 — 라이브는 base64 렌더, 디스크 replay(stub)는 비영속 플레이스홀더.
export function Attachments({ images }: { images: ImageAttachment[] }) {
  const t = useT()
  return (
    <AttachRow>
      {images.map((im, i) =>
        isStubImage(im.data) ? (
          <AttachChip key={i} dashed borderColor={C.label4} fontSize={11.5} color={C.label3} title={t('stream.attachment.imageEphemeral')}>
            <ImageOff size={13} /> {t('stream.attachment.imageLabel')}
          </AttachChip>
        ) : (
          <img
            key={i}
            src={`data:${im.media_type};base64,${im.data}`}
            alt={t('stream.attachment.imageAlt')}
            style={{ maxHeight: 240, maxWidth: '100%', borderRadius: R.field, border: `1px solid ${C.sep}`, objectFit: 'contain', display: 'block' }}
          />
        ),
      )}
    </AttachRow>
  )
}

// 첨부 문서(PDF) 칩 — 라이브는 파일명, 디스크 replay(stub)는 비영속 표시.
export function DocChips({ documents }: { documents: DocAttachment[] }) {
  const t = useT()
  return (
    <AttachRow>
      {documents.map((d, i) => {
        const stub = isStubImage(d.data)
        return (
          <AttachChip
            key={i}
            dashed={stub}
            fill
            borderColor={C.sep}
            fontSize={12}
            color={C.label2}
            title={stub ? t('stream.attachment.docEphemeral') : d.name}
            onContextMenu={onCopyMenu(d.name, t('menu.copyFileName'))}
          >
            <FileText size={14} style={{ color: C.del, flexShrink: 0 }} />
            <span className="truncate" style={{ fontWeight: 600 }}>{d.name}</span>
            <span style={{ fontSize: 10, color: C.label3, flexShrink: 0 }}>{stub ? t('stream.attachment.docLabel') : t('stream.attachment.pdf')}</span>
          </AttachChip>
        )
      })}
    </AttachRow>
  )
}
