// 모델이 답하기 전에 스스로 정리한 생각 (Phase 8h).
//
// 기본은 접어 둔다. 이건 답이 아니라 과정이고, 길이가 답변보다 긴 경우도 흔해서 펼친 채로 두면 대화가
// 생각으로 뒤덮인다. 그렇다고 아예 안 보여주면 모델이 왜 그렇게 답했는지 확인할 방법이 사라진다 —
// 특히 Codex 세션은 답하기 전에 오래 생각하는 일이 많아서, 그동안 화면에 아무 근거도 남지 않는다.
//
// 한 턴에 하나만 만든다(조각별로 줄을 만들지 않는다 — `streamSegments.ts`가 이어 붙여서 넘긴다).
// 접힌 줄은 말풍선이 아니라 한 줄짜리 버튼이라, 안 펼치면 대화 흐름에서 거의 눈에 띄지 않는다.
import { useState } from 'react'
import { ChevronDown, ChevronRight, Lightbulb } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { Markdown } from '../Markdown'
import { Collapse } from '../ui'
import { C, R } from '../../design/tokens'

export function ReasoningNote({ text }: { text: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="self-start" style={{ maxWidth: '88%' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        // 도구 요약 줄과 같은 회색 알약(재설계 4단계, 시안 A). 장식에는 색을 쓰지 않는다.
        className="press hit-44 inline-flex items-center"
        style={{
          gap: 6,
          height: 32,
          padding: '0 12px',
          borderRadius: R.full,
          background: C.fill,
          color: C.label2,
          fontSize: 13,
          fontWeight: 500,
        }}
      >
        <Lightbulb size={14} />
        {t('stream.reasoning.label')}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      <Collapse open={open}>
        {/* 말풍선과 같은 여백·모서리를 쓰되 글자를 한 단계 작고 옅게 — 읽을 수는 있지만 답보다 뒤에 놓인다. */}
        <div
          style={{
            marginTop: 8,
            padding: '12px 14px',
            background: C.bg2,
            borderRadius: R.field,
            color: C.label2,
            lineHeight: 1.6,
          }}
        >
          <Markdown>{text}</Markdown>
        </div>
      </Collapse>
    </div>
  )
}
