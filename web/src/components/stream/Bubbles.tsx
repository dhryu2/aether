// 대화 말풍선 — 유저(보낸 것·대기 중)와 어시스턴트.
import { memo, useMemo, type CSSProperties } from 'react'
import { Copy, Pencil, RotateCw, Send, Undo2, X } from 'lucide-react'
import type { ImageAttachment, DocAttachment } from '../../lib/types'
import { actions, sessionTurn, useSessionArchived, useStore } from '../../lib/store'
import { bubbleBlocks } from '../../lib/composerBlocks'
import { useCopy } from '../../lib/hooks'
import { useT } from '../../lib/i18n'
import { C, R } from '../../design/tokens'
import { CodeBlock } from '../Markdown'
import { Attachments, DocChips } from './Attachments'
import { HandoffCard } from './HandoffCard'
import { MenuItem } from '../WorkMenu'
import { copyItem, menuOf, onContextMenuFor } from '../contextMenuFor'

// 내 말 풍선의 글 — 시안 A: 15.5px, 여백 10/16, 모서리 20(index.css .bubble-user). 폭은 index.css .bubble-max가 정한다.
const USER_TEXT = { maxWidth: '100%', padding: '10px 16px', fontSize: 15.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } as const

// 내 말풍선의 본문. 닫힌 ``` 조각은 답변과 같은 코드 블록으로 그리고, 나머지 글은 친 모양 그대로 둔다.
//   minWidth·maxWidth: 긴 코드 줄이 말풍선을 밀어내지 않고 블록 안에서 가로로 스크롤되게 한다.
function UserText({ text }: { text: string }) {
  const blocks = useMemo(() => bubbleBlocks(text), [text])
  if (!blocks.some((block) => block.kind === 'code')) return <>{text}</>
  return (
    <div className="flex flex-col" style={{ gap: 8, minWidth: 0, maxWidth: '100%' }}>
      {blocks.map((block, index) =>
        block.kind === 'code' ? <CodeBlock key={block.id} language={block.lang} code={block.value} index={index + 1} /> : <div key={block.id}>{block.value}</div>,
      )}
    </div>
  )
}

// W9 유저 버블 (memo: text·images·documents 참조 안정 → 라이브 스트리밍 중 재렌더 스킵)
export const UserBubble = memo(function UserBubble({
  sessionId,
  seq,
  text,
  images,
  documents,
  autoSent,
  handoffFrom,
}: {
  sessionId: string
  seq?: number
  text: string
  images?: ImageAttachment[]
  documents?: DocAttachment[]
  /** Aether가 자동 재개로 대신 보낸 글. */
  autoSent?: boolean
  /** 넘기기로 이어 받은 첫 말이면 이전 세션 id. 접힌 카드로 그린다. */
  handoffFrom?: string
}) {
  const t = useT()
  const { copied, copy } = useCopy()
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard && text.trim().length > 0
  const archived = useSessionArchived(sessionId)
  const canRewind = seq != null && seq > 0 && !archived // 보관된 세션은 읽기 전용 — 서버도 409
  return (
    <div className="bubble-max self-end flex flex-col" style={{ gap: 6, alignItems: 'flex-end' }}>
      {images && images.length > 0 && <Attachments images={images} />}
      {documents && documents.length > 0 && <DocChips documents={documents} />}
      {autoSent && <AutoSentNote sessionId={sessionId} seq={seq} />}
      {text && (
        // 버튼은 말풍선 아래에 가로로 오른쪽 끝을 맞춰 둔다. 답변 아래 복사 줄과 같은 자리다.
        //   한때 말풍선 왼쪽에 세로로 띄웠는데, 폰에서는 말풍선 옆에 아이콘 기둥이 서서 어색했다(2026-10-06 사용자 판단).
        //   --hit-w·--hit-h: 폰에서 넓힌 누름 범위가 옆 버튼과 위 말풍선을 덮지 않게 줄인다(index.css .hit-44).
        <div className="bubble-row flex flex-col" style={{ maxWidth: '100%', alignItems: 'flex-end', gap: 4, ...(handoffFrom ? { width: '100%' } : {}) }}>
          {handoffFrom ? (
            <HandoffCard text={text} fromId={handoffFrom} />
          ) : (
            <div
              className="bubble-user"
              style={USER_TEXT}
              onContextMenu={onContextMenuFor(() => menuOf(
                copyItem(text, t('stream.userBubble.copy')),
                <MenuItem onClick={() => actions.editMessage(text, sessionId)}>{t('stream.userBubble.resend')}</MenuItem>,
                canRewind && <MenuItem onClick={() => actions.requestRewind(sessionId, seq)}>{t('stream.userBubble.rewind')}</MenuItem>,
              ))}
            >
              <UserText text={text} />
            </div>
          )}
          <div className="flex items-center" style={{ gap: 4, '--hit-w': '32px', '--hit-h': '40px' } as CSSProperties}>
            {canCopy && (
              <button
                type="button"
                onClick={() => copy(text)}
                aria-label={copied ? t('stream.copied') : t('stream.userBubble.copy')}
                title={t('stream.userBubble.copy')}
                className="msg-action lift hit-44 inline-flex items-center justify-center"
                style={{ width: 28, height: 28, borderRadius: R.sm, color: copied ? C.ok : C.label3 }}
              >
                <Copy size={15} />
              </button>
            )}
            <button
              type="button"
              onClick={() => actions.editMessage(text, sessionId)}
              aria-label={t('stream.userBubble.resend')}
              title={t('stream.userBubble.resendTitle')}
              className="msg-action lift hit-44 inline-flex items-center justify-center"
              style={{ width: 28, height: 28, borderRadius: R.sm, color: C.label3 }}
            >
              <RotateCw size={15} />
            </button>
            {canRewind && (
              <button
                type="button"
                onClick={() => actions.requestRewind(sessionId, seq)}
                aria-label={t('stream.userBubble.rewind')}
                title={t('stream.userBubble.rewindTitle')}
                className="msg-action lift hit-44 inline-flex items-center justify-center"
                style={{ width: 28, height: 28, borderRadius: R.sm, color: C.label3 }}
              >
                <Undo2 size={15} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

/**
 * 자동 재개로 보낸 글 위의 안내. 이 글이 마지막 사용자 글이고 턴이 진행 중일 때만 [중단]을 보인다(기존 중단 동작과 같다).
 * 이 안내가 있는 글에서만 렌더돼, 일반 말풍선은 저장소 변화로 다시 그려지지 않는다.
 */
function AutoSentNote({ sessionId, seq }: { sessionId: string; seq?: number }) {
  const t = useT()
  const s = useStore()
  const items = s.convos[sessionId]
  let lastUser: number | undefined
  for (let i = (items?.length ?? 0) - 1; i >= 0; i--) {
    const it = items![i]
    if (it.kind === 'user_msg' || it.kind === 'local_user') {
      lastUser = it.seq
      break
    }
  }
  const canStop = seq != null && lastUser === seq && sessionTurn(s, sessionId) !== 'idle'
  return (
    <div className="flex items-center" style={{ gap: 8, fontSize: 12.5, color: C.label2 }}>
      <span>{t('stream.userBubble.autoSent')}</span>
      {canStop && (
        <button
          type="button"
          onClick={() => actions.interrupt(sessionId)}
          className="press hit-44"
          style={{ height: 24, padding: '0 10px', border: 'none', borderRadius: R.full, background: C.fill, color: C.label, fontSize: 12.5, fontWeight: 500, cursor: 'pointer' }}
        >
          {t('stream.userBubble.autoStop')}
        </button>
      )}
    </div>
  )
}

// 대기 큐 버블 — 턴 진행 중 입력한 후속 메시지(아직 미전송). 흐릿하게 + 취소(×). 턴 끝나면 자동 전송됨.
export function QueuedBubble({
  text,
  imageCount = 0,
  onCancel,
  onEdit,
  onSendNow,
  canSendNow = false,
}: {
  text: string
  imageCount?: number
  onCancel: () => void
  onEdit: () => void
  onSendNow: () => void
  canSendNow?: boolean
}) {
  const t = useT()
  return (
    // msg-in = 다른 말풍선과 같은 방식으로 떠오른다. 이 버블은 대화 목록(SegmentList) 바깥에서 그려져서
    //   그 애니메이션을 물려받지 못한다 — 넣지 않으면 큐에 들어간 내 메시지만 툭 나타난다.
    <div className="bubble-max msg-in self-end inline-flex items-start" style={{ gap: 4 }}>
      {canSendNow && (
        <button
          type="button"
          onClick={onSendNow}
          aria-label={t('stream.queued.sendNow')}
          title={t('stream.queued.sendNow')}
          className="flex items-center justify-center lift hit-44"
          style={{ width: 26, height: 26, marginTop: 8, color: C.label3, flexShrink: 0, borderRadius: R.full }}
        >
          <Send size={14} />
        </button>
      )}
      <button
        type="button"
        onClick={onEdit}
        aria-label={t('stream.queued.edit')}
        title={t('stream.queued.edit')}
        className="flex items-center justify-center lift hit-44"
        style={{ width: 26, height: 26, marginTop: 8, color: C.label3, flexShrink: 0, borderRadius: R.full }}
      >
        <Pencil size={14} />
      </button>
      <button
        type="button"
        onClick={onCancel}
        aria-label={t('stream.queued.cancel')}
        title={t('stream.queued.cancel')}
        className="flex items-center justify-center lift hit-44"
        style={{ width: 26, height: 26, marginTop: 8, color: C.label3, flexShrink: 0, borderRadius: R.full }}
      >
        <X size={14} />
      </button>
      <div
        className="bubble-user"
        style={{ ...USER_TEXT, minWidth: 0, opacity: 0.55, border: `1px dashed ${C.sep}` }}
        title={t('stream.queued.title')}
        onContextMenu={onContextMenuFor(() => (
          <>
            {canSendNow && <MenuItem onClick={onSendNow}>{t('stream.queued.sendNow')}</MenuItem>}
            <MenuItem onClick={onEdit}>{t('stream.queued.edit')}</MenuItem>
            <MenuItem onClick={onCancel}>{t('stream.queued.cancel')}</MenuItem>
          </>
        ))}
      >
        {imageCount > 0 && <span style={{ opacity: 0.8 }}>🖼×{imageCount}{text ? ' ' : ''}</span>}
        <UserText text={text} />
      </div>
    </div>
  )
}

/** 질문에 고른 답. 사용자 말풍선과 같은 톤이지만 재전송은 없다 — 이 줄은 사람이 친 입력이 아니다. */
export const ChoiceBubble = memo(function ChoiceBubble({ labels }: { labels: string[] }) {
  const t = useT()
  const text = labels.filter(Boolean).join(' · ')
  if (!text) return null
  return (
    <div
      className="bubble-max self-end flex flex-col"
      style={{ alignItems: 'flex-end' }}
      aria-label={t('session.question.choiceEcho', { answer: text })}
    >
      <div className="bubble-user" style={USER_TEXT}>
        {text}
      </div>
    </div>
  )
})

// W10 어시스턴트 답 (Markdown 본문은 부모가 children으로 주입). 재설계 4단계: 상자 없이 바탕 위의 글이다(시안 A).
//   글 폭은 대화 열(760) 전체를 쓴다. 글자 15.5px, 줄 간격 1.65.
export function AssistantBubble({ children, onContextMenu }: { children: React.ReactNode; onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void }) {
  return (
    <div className="self-stretch bubble-assistant" style={{ lineHeight: 1.65, color: C.label }} onContextMenu={onContextMenu}>
      {children}
    </div>
  )
}
