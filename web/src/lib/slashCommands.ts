// 슬래시 명령 목록 만들기 — 컴포저에서 떼어낸 순수 로직(React 비의존).
import type { SlashCommandInfo } from './types'
import { resolveLocalizedText } from './localizedText'

export type SlashCmd = {
  name: string
  cmd: string
  arg: string
  desc: string
  aliases: string[]
  startsTurn: boolean
  uiAction?: SlashCommandInfo['uiAction']
  /** 이번 글만 브리프로 보낸다. 슬래시 메뉴의 별칭이며 스킬이 아니다. */
  brief?: boolean
}

/** 화면에 보이는 별칭. 코드 식별자로 시작하지 않는다. */
export const BRIEF_SLASH = '/brief'

/** 서버 명령 목록 뒤에 브리프 별칭을 하나 붙인다. 앞쪽 순서는 그대로다. */
export function withBriefAlias(commands: SlashCmd[], desc: string): SlashCmd[] {
  if (commands.some((command) => command.brief || command.cmd === BRIEF_SLASH)) return commands
  return [
    ...commands,
    {
      name: 'brief',
      cmd: BRIEF_SLASH,
      arg: '',
      desc,
      aliases: [],
      startsTurn: false,
      brief: true,
    },
  ]
}

// 활성 세션의 동적 명령 목록 구성 — REST(provider interface)가 정본이고, 이벤트 이름은 설명 없는 보조분이다.
//   화면은 명령 이름의 의미를 모르며 provider/Aether가 보낸 번역표에서 현재 언어의 문구만 고른다.
//   `hints`는 활성 세션이 알려준 실제 값(모델 이름·강도 단계) — 있으면 인자 힌트를 그걸로 채운다.
export function buildSlashCmds(
  live: string[],
  rich: SlashCommandInfo[],
  locale: string,
  hints?: Record<string, string>,
): SlashCmd[] {
  const richMap = new Map(rich.map((r) => [r.name, r]))
  const names = [...rich.map((r) => r.name), ...live.filter((n) => !richMap.has(n))]
  return names.map((n) => {
    const r = richMap.get(n)
    const arg = hints?.[n] || resolveLocalizedText(r?.argumentHint, locale)
    const desc = resolveLocalizedText(r?.description, locale)
    return { name: n, cmd: '/' + n, arg, desc, aliases: r?.aliases ?? [], startsTurn: r?.startsTurn ?? true, uiAction: r?.uiAction }
  })
}

/** `/name args`를 provider 중립 실행 입력으로 나눈다. 목록에 없는 이름도 반환해 서버 adapter가 거부하게 한다. */
export function parseSlashCommand(
  text: string,
  commands: SlashCmd[],
): { name: string; arguments: string; startsTurn: boolean; uiAction?: SlashCommandInfo['uiAction']; brief?: boolean } | null {
  // provider 생태계의 네임스페이스 명령(`plugin:command`)도 받아야 하므로 이름 문자를 영숫자로 한정하지 않는다.
  const match = /^\/([^/\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  const name = match[1].toLowerCase()
  const known = commands.find((command) => command.name.toLowerCase() === name || command.aliases.some((alias) => alias.toLowerCase() === name))
  return {
    name,
    arguments: (match[2] ?? '').trim(),
    startsTurn: known?.startsTurn ?? false,
    uiAction: known?.uiAction,
    ...(known?.brief ? { brief: true } : {}),
  }
}
