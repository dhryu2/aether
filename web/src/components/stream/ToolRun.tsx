// W11/W11.5 도구 칩과 도구 런 — 연속 작업(Bash/Edit/Read…)을 주석 톤 한 줄로 접고(탭→전체 펼침),
//   진행 중엔 현재 작업으로 실시간 갱신한다.
//   답변(어시스턴트 버블)이 주인공 → 도구 노이즈는 작게. 펼치면 ToolChip 스택(결과 메타 포함) 그대로 노출.
import { useState, type CSSProperties } from 'react'
import { Check, ChevronDown, SquareTerminal, X } from 'lucide-react'
import { toolPath, toolResultMeta } from '../../lib/format'
import type { ToolResultView } from '../../lib/agentEvents'
import { useExitAnim } from '../../lib/hooks'
import { useT } from '../../lib/i18n'
import { C, MS, R } from '../../design/tokens'

/** 도구 런에 담기는 호출 하나. `key`는 리스트 렌더용 안정 식별자다. */
export type ToolEntry = { name: string; input: Record<string, unknown>; result?: ToolResultView; key: string }

/** 파일을 바꾸는 도구만 파랑으로 튀게 — 나머지는 회색. */
const TOOL_COLOR: Record<string, { c: string; bg: string }> = {
  Edit: { c: C.tint, bg: C.tintSoft },
  Write: { c: C.tint, bg: C.tintSoft },
  MultiEdit: { c: C.tint, bg: C.tintSoft },
  NotebookEdit: { c: C.tint, bg: C.tintSoft },
}
const TOOL_DEFAULT = { c: C.label2, bg: C.fill }

export function ToolChip({
  name,
  input,
  result,
  className,
  style,
}: {
  name: string
  input: Record<string, unknown>
  result?: ToolResultView
  /** 펼침 애니메이션(chip-in) 같은 바깥 사정. 칩 자신의 모양과는 무관하다. */
  className?: string
  style?: CSSProperties
}) {
  const col = TOOL_COLOR[name] ?? TOOL_DEFAULT
  const path = toolPath(input)
  const meta = result ? toolResultMeta(result.content, result.is_error) : null
  return (
    <div
      className={['self-start tool-chip flex items-center', className].filter(Boolean).join(' ')}
      style={{ width: '100%', maxWidth: '88%', padding: '10px 12px', gap: 8, ...style }}
    >
      <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, color: col.c, background: col.bg, borderRadius: 6, padding: '2px 7px', flexShrink: 0 }}>
        {name}
      </span>
      {path && (
        <span className="font-mono truncate" style={{ fontSize: 12, color: C.label2, flex: 1, minWidth: 0 }} title={path}>
          {path}
        </span>
      )}
      {meta && (
        <span className="font-mono inline-flex items-center" style={{ fontSize: 11, gap: 3, marginLeft: 'auto', color: meta.ok ? C.ok : C.del, flexShrink: 0 }}>
          {meta.ok ? <Check size={11} /> : <X size={11} />} {meta.label}
        </span>
      )}
    </div>
  )
}

// 실패 도구(is_error)는 접힌 상태에서도 ✗로 노출 — 펼치지 않아도 '실패' 인지(ToolChip ✗ parity 회복).
function ErrBadge({ count }: { count: number }) {
  const t = useT()
  if (count === 0) return null
  return (
    <span className="inline-flex items-center" style={{ color: C.del, gap: 1, flexShrink: 0 }} title={t('stream.toolRun.failedCount', { count })}>
      <X size={11} />
      {count > 1 ? count : ''}
    </span>
  )
}

/** 차례로 들어오고 나가는 시차 — 다섯 칸까지만 준다. 한 턴에 도구를 스무 번 부른 경우까지 차례를 지키면
 *  "펼쳐지는 중"이 아니라 "느린 화면"이 된다. 70ms였을 때 전체가 0.7초 걸려 느리다는 판단으로 줄였다(2026-10-02).
 *  28ms는 60Hz에서 두 프레임이 안 돼 한꺼번에 나오는 것처럼 보였으므로 그보다는 길게 둔다. */
const STAGGER_MS = 40
const STAGGER_MAX = 5

/** 펼친 런 — 접기 버튼 + 전체 ToolChip 스택. `leaving`이면 접히는 중이라 역순으로 빠져나간다. */
function ExpandedRun({ tools, leaving, onCollapse }: { tools: ToolEntry[]; leaving: boolean; onCollapse: () => void }) {
  const t = useT()
  return (
    <div className="self-stretch flex flex-col" style={{ gap: 8, pointerEvents: leaving ? 'none' : undefined }}>
      <button
        onClick={onCollapse}
        className="self-start inline-flex items-center press hit-44"
        style={{ fontSize: 13, color: C.label2, gap: 5, padding: '2px 2px', background: 'transparent', border: 'none', cursor: 'pointer' }}
      >
        <ChevronDown size={14} style={{ transform: 'rotate(180deg)' }} /> {t('stream.toolRun.collapse', { count: tools.length })}
      </button>
      {/* 펼칠 때는 위에서부터, 접을 때는 아래에서부터 — 순서가 뒤집혀야 접기가 펴기의 되감기로 읽힌다. */}
      {tools.map((tl, i) => {
        const order = leaving ? tools.length - 1 - i : i
        return (
          <ToolChip
            key={tl.key}
            name={tl.name}
            input={tl.input}
            result={tl.result}
            className={leaving ? 'chip-out' : 'chip-in'}
            style={{ animationDelay: `${Math.min(order, STAGGER_MAX) * STAGGER_MS}ms` }}
          />
        )
      })}
    </div>
  )
}

/** 진행 중: 현재(마지막) 작업만 → read a→read b로 갱신되는 라이브 티커(행이 쌓이지 않음).
 *  앞의 파랑 점은 "지금 도는 중"이라는 실제 상태라 둔다. 끝없이 빛나던 움직임은 지웠다. */
function LiveRun({ tools, errCount }: { tools: ToolEntry[]; errCount: number }) {
  const last = tools[tools.length - 1]
  const lastPath = toolPath(last.input)
  return (
    <div className="self-start font-mono inline-flex items-center" style={{ fontSize: 12, color: C.label3, gap: 7, padding: '2px 2px' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.tintFill, flexShrink: 0 }} />
      <span style={{ color: C.label2, fontWeight: 600, flexShrink: 0 }}>{last.name}</span>
      {lastPath && (
        <span className="truncate" style={{ maxWidth: 'min(320px, 52vw)' }} title={lastPath}>
          {lastPath}
        </span>
      )}
      {tools.length > 1 && <span style={{ color: C.label3, flexShrink: 0 }}>· {tools.length}</span>}
      <ErrBadge count={errCount} />
    </div>
  )
}

/** 완료된 런(스크롤백): 한 줄 요약. 단일이면 그 작업, 여러 개면 "작업 N개 · 도구들". 탭하면 전체 펼침. */
function SummaryRun({ tools, errCount, onExpand }: { tools: ToolEntry[]; errCount: number; onExpand: () => void }) {
  const t = useT()
  const last = tools[tools.length - 1]
  const lastPath = toolPath(last.input)
  const names = [...new Set(tools.map((tl) => tl.name))].join(', ')
  return (
    <button
      onClick={onExpand}
      className="self-start inline-flex items-center press hit-44"
      title={t('stream.toolRun.expandTitle')}
      // 회색 알약(시안 A) — 높이 32. 앞의 터미널 아이콘이 "명령 묶음"임을, 끝의 꺾쇠가 펼칠 수 있음을 알린다.
      //   개수는 사람 글(본문 글꼴), 도구 이름·경로는 기계 문자열(고정폭)이다.
      style={{ height: 32, fontSize: 13, color: C.label2, gap: 7, padding: '0 12px', maxWidth: '100%', background: C.fill, borderRadius: R.full, border: 'none', cursor: 'pointer' }}
    >
      <SquareTerminal size={14} style={{ flexShrink: 0 }} aria-hidden />
      {tools.length === 1 ? (
        <>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 600, flexShrink: 0 }}>{last.name}</span>
          {lastPath && (
            <span className="font-mono truncate" style={{ fontSize: 12, maxWidth: 'min(300px, 50vw)' }} title={lastPath}>
              {lastPath}
            </span>
          )}
        </>
      ) : (
        <>
          <span style={{ flexShrink: 0 }}>{t('stream.toolRun.count', { count: tools.length })}</span>
          <span className="font-mono truncate" style={{ fontSize: 12 }}>{names}</span>
        </>
      )}
      <ErrBadge count={errCount} />
      {/* 펼침 표시는 누를 수 있다는 유일한 단서라 흐리면 안 된다. */}
      <ChevronDown size={14} style={{ flexShrink: 0, color: C.label2 }} />
    </button>
  )
}

/** 접힘 애니메이션이 끝날 때까지 목록을 남겨 두는 시간 = 마지막 칸의 시차 + 애니메이션 길이(index.css chip-out = --dur-out). */
const COLLAPSE_MS = STAGGER_MAX * STAGGER_MS + MS.out

export function ToolRun({ tools, live }: { tools: ToolEntry[]; live?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  // 접기를 누르면 목록이 바로 사라지지 않고, 아래 칸부터 역순으로 빠져나간 뒤에 요약 줄로 돌아간다.
  //   '움직임 줄이기'를 켠 사람에게는 이 훅이 붙잡아 두지 않으므로 예전처럼 즉시 접힌다.
  const anim = useExitAnim(expanded, COLLAPSE_MS)
  if (!tools.length) return null
  const errCount = tools.filter((tl) => tl.result?.is_error).length
  if (anim.mounted) return <ExpandedRun tools={tools} leaving={anim.closing} onCollapse={() => setExpanded(false)} />
  if (live) return <LiveRun tools={tools} errCount={errCount} />
  return <SummaryRun tools={tools} errCount={errCount} onExpand={() => setExpanded(true)} />
}
