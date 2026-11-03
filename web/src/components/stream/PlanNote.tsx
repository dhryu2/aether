// 계획문 스트리밍 — 생각 과정과 같은 접힌 줄이되, 계획 검토 카드와 구분이 되게 연다.
import { useState } from 'react'
import { ListTodo, ChevronDown, ChevronRight } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { Markdown } from '../Markdown'
import { Collapse } from '../ui'
import { C, R } from '../../design/tokens'

export function PlanNote({ text }: { text: string }) {
  const t = useT()
  const [open, setOpen] = useState(true)
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
        <ListTodo size={14} />
        {t('stream.plan.label')}
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      <Collapse open={open}>
        <div
          style={{
            marginTop: 8,
            padding: '12px 14px',
            background: C.bg2,
            borderRadius: R.field,
            color: C.label,
            lineHeight: 1.6,
          }}
        >
          <Markdown>{text}</Markdown>
        </div>
      </Collapse>
    </div>
  )
}
