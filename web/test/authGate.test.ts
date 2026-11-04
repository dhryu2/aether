/**
 * authGate — nextAuthPhase 표 전행 + AuthGate 순서 계약(정적).
 *   실행: npx tsx web/test/authGate.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { nextAuthPhase } from '../src/lib/authGate'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++
  else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

// 표 전행
check(
  'off+example.ts.net+200 → ready',
  nextAuthPhase({ sessionsStatus: 200, healthAuth: 'off', originHost: 'example.ts.net' }) === 'ready',
)
check(
  '칸 없음+127.0.0.1+200 → ready',
  nextAuthPhase({ sessionsStatus: 200, healthAuth: undefined, originHost: '127.0.0.1' }) === 'ready',
)
check(
  'off+401 → blocked (login 0)',
  nextAuthPhase({ sessionsStatus: 401, healthAuth: 'off', originHost: 'example.ts.net' }) === 'blocked',
)
check(
  'password+example.ts.net+401 → login',
  nextAuthPhase({ sessionsStatus: 401, healthAuth: 'password', originHost: 'example.ts.net' }) === 'login',
)
check(
  'password+127.0.0.1+401 → login',
  nextAuthPhase({ sessionsStatus: 401, healthAuth: 'password', originHost: '127.0.0.1' }) === 'login',
)
check(
  'password+200 → ready',
  nextAuthPhase({ sessionsStatus: 200, healthAuth: 'password', originHost: 'x.com' }) === 'ready',
)
check(
  'tailscale+127.0.0.1 → need-tailnet',
  nextAuthPhase({ sessionsStatus: null, healthAuth: 'tailscale', originHost: '127.0.0.1' }) === 'need-tailnet',
)
check(
  'tailscale+localhost → need-tailnet',
  nextAuthPhase({ sessionsStatus: 401, healthAuth: 'tailscale', originHost: 'localhost' }) === 'need-tailnet',
)
check(
  'tailscale+example.ts.net+200 → ready',
  nextAuthPhase({ sessionsStatus: 200, healthAuth: 'tailscale', originHost: 'example.ts.net' }) === 'ready',
)
check(
  'tailscale+example.ts.net+401 → need-tailnet (login 0)',
  nextAuthPhase({ sessionsStatus: 401, healthAuth: 'tailscale', originHost: 'example.ts.net' }) === 'need-tailnet',
)
check(
  'password가 아닐 때 401→login 0 (off)',
  nextAuthPhase({ sessionsStatus: 401, healthAuth: 'off', originHost: 'h' }) !== 'login',
)

check(
  'setup=true → setup (어떤 auth·상태여도, sessions 호출 전)',
  nextAuthPhase({ sessionsStatus: null, healthAuth: 'off', healthSetup: true, originHost: '127.0.0.1' }) === 'setup' &&
    nextAuthPhase({ sessionsStatus: 401, healthAuth: 'password', healthSetup: true, originHost: 'x.ts.net' }) === 'setup' &&
    nextAuthPhase({ sessionsStatus: null, healthAuth: 'tailscale', healthSetup: true, originHost: 'localhost' }) === 'setup',
)
check(
  'setup=false/없음 → 기존 표 그대로',
  nextAuthPhase({ sessionsStatus: 401, healthAuth: 'password', healthSetup: false, originHost: 'h' }) === 'login' &&
    nextAuthPhase({ sessionsStatus: 200, healthAuth: 'off', originHost: 'h' }) === 'ready',
)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const gateSrc = fs.readFileSync(path.join(HERE, '../src/components/shell/AuthGate.tsx'), 'utf8')
check('AuthGate가 setClientToken을 부른다', /setClientToken\(/.test(gateSrc))
check('AuthGate가 ready 전에 init 0 — init는 ready effect', /phase !== 'ready'/.test(gateSrc) && /actions\.init\(/.test(gateSrc))
check('로그인 성공 후 보호 REST 재시도', /api\/sessions/.test(gateSrc) && /setClientToken/.test(gateSrc))

const firstSessions = gateSrc.indexOf("fetch('/api/sessions'")
const setupBranch = gateSrc.indexOf("=== 'setup'")
check('AuthGate: setup 판정이 첫 /api/sessions 호출보다 앞선다', setupBranch > 0 && setupBranch < firstSessions, { setupBranch, firstSessions })
check('AuthGate가 setup이면 SetupScreen을 그린다', /phase === 'setup'\) return <SetupScreen/.test(gateSrc))
check('AuthGate가 health.setup을 읽는다', /h\.setup === true/.test(gateSrc) && /healthSetup/.test(gateSrc))
const setupSrc = fs.readFileSync(path.join(HERE, '../src/components/setup/SetupScreen.tsx'), 'utf8')
const waitSrc = fs.readFileSync(path.join(HERE, '../src/components/setup/SetupWait.tsx'), 'utf8')
check('SetupScreen: 저장 본문은 toSetupBody, 실패 판정은 saveFailureNext, 고급 열기는 needsAdvancedOpen', /api\.setupComplete\(toSetupBody\(v\)\)/.test(setupSrc) && /saveFailureNext\(/.test(setupSrc) && /needsAdvancedOpen\(/.test(setupSrc))
check('SetupScreen: 저장 성공이면 대기 화면(setSavedPort)과 비밀번호 비우기', /setSavedPort\(r\.port\)/.test(setupSrc) && /password: '', confirm: ''/.test(setupSrc) && /<SetupWait/.test(setupSrc))
check('초점 표시를 지우는 all:unset 없음', !/all:\s*'unset'/.test(setupSrc + waitSrc))
check('SetupWait: 다른 포트로 자동 이동하지 않음', !/location\.assign|location\.href\s*=/.test(waitSrc))
check('SetupScreen이 store 초기화·보호 REST를 부르지 않는다', !/actions\.init|api\/sessions|\.listSessions/.test(setupSrc))

const appSrc = fs.readFileSync(path.join(HERE, '../src/App.tsx'), 'utf8')
check('App의 기존 init effect 제거', !/useEffect\(\(\)\s*=>\s*\{\s*actions\.init\(\)/.test(appSrc))
check('App이 AuthGate로 감싼다', /<AuthGate>/.test(appSrc))

const storeSrc = fs.readFileSync(path.join(HERE, '../src/lib/store.ts'), 'utf8')
const refreshBody = /async refreshPushState\(\) \{[\s\S]*?\n  \},/.exec(storeSrc)?.[0] ?? ''
check('refreshPushState가 브라우저 구독을 서버에 다시 등록한다', /api\.subscribePush\(/.test(refreshBody), refreshBody.length)
const pwSrc = fs.readFileSync(path.join(HERE, '../src/components/settings/PasswordSection.tsx'), 'utf8')
check('비밀번호를 바꾸면 알림 구독을 다시 등록한다', /changePassword\([\s\S]*?actions\.refreshPushState\(\)/.test(pwSrc))

console.log(`\n${fail === 0 ? '✅' : '❌'} authGate: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
