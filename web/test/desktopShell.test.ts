/**
 * desktopShell — __TAURI__ 없을 때 false. 있을 때 invoke 인자 {title,body}만.
 *   실행: npx tsx web/test/desktopShell.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(HERE, '../src/lib/desktopShell.ts'), 'utf8')
check('@tauri-apps 패키지 import 0', !/from\s+['"]@tauri-apps/.test(src))
check('__TAURI__ 문자열만 본다', src.includes('__TAURI__'))

// jsdom 없이 최소 window 흉내
const g = globalThis as unknown as {
  window?: {
    __TAURI__?: { core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }
  }
}

delete g.window
const { isDesktopShell, showDesktopNotification } = await import('../src/lib/desktopShell')

// window 없음
check('window 없으면 isDesktopShell false', isDesktopShell() === false)

g.window = {}
check('__TAURI__ 없으면 false', isDesktopShell() === false)
showDesktopNotification({ title: 't', body: 'b' }) // no-op, throw 없어야 함
check('invoke 없으면 showDesktopNotification no-op', true)

let invoked: { cmd: string; args?: Record<string, unknown> } | null = null
g.window = {
  __TAURI__: {
    core: {
      invoke: async (cmd, args) => {
        invoked = { cmd, args }
      },
    },
  },
}
// 모듈이 이미 로드됐으므로 window만 채운 뒤 재검사 — isDesktopShell은 매 호출 window를 본다
check('__TAURI__ 있으면 true', isDesktopShell() === true)
showDesktopNotification({ title: '알림', body: '본문' })
await new Promise((r) => setTimeout(r, 10))
check('invoke 명령 show_desktop_notification', invoked?.cmd === 'show_desktop_notification')
check('인자는 title·body만', !!invoked?.args && Object.keys(invoked.args).sort().join(',') === 'body,title')
check('title/body 값', invoked?.args?.title === '알림' && invoked?.args?.body === '본문')
check('sessionId/url 칸 없음', !invoked?.args || (!('sessionId' in invoked.args) && !('url' in invoked.args)))

console.log(`\n${fail === 0 ? '✅' : '❌'} desktopShell: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
