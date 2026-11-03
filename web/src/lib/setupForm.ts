// 첫 설정 화면의 순수 로직: 입력 검사, 단계 판정, 서버 오류 코드 → 칸/문구, 저장 뒤 기다리는 상태 판정.
// 서버 쪽 기준은 server/setup/save.ts(SetupErrorCode)와 같다. React·HTTP 없음.
import { isBrowserBlockedPort } from '../../../shared/browserPorts'
import { checkNewPassword } from './passwordForm'

export type SetupField = 'password' | 'confirm' | 'projectRoot' | 'dataDir' | 'port' | 'terms'
/** key는 i18n 키 `setup.error.<key>`의 끝부분. field가 null이면 특정 칸에 묶이지 않는 오류다. */
export type SetupIssue = { field: SetupField | null; key: string }

export type SetupFormValues = {
  password: string
  confirm: string
  port: string
  dataDir: string
  projectRoot: string
  terms: boolean
}

/** 맥·리눅스 `/…`, 윈도우 `C:\…` `C:/…` `\\서버\…`. 서버는 path.isAbsolute로 다시 검사한다. */
export function looksAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

/** 화면 순서(비밀번호 → 작업 폴더 → 고급 → 사용 조건)대로 모은 오류. 비어 있으면 저장해도 된다. */
export function validateSetupForm(v: SetupFormValues): SetupIssue[] {
  const out: SetupIssue[] = []
  const pw = checkNewPassword(v.password)
  if (pw) out.push({ field: 'password', key: pw })
  else if (v.confirm !== v.password) out.push({ field: 'confirm', key: 'mismatch' })
  const root = v.projectRoot.trim()
  if (!root) out.push({ field: 'projectRoot', key: 'projectRootEmpty' })
  else if (!looksAbsolute(root)) out.push({ field: 'projectRoot', key: 'projectRoot_invalid' })
  const dir = v.dataDir.trim()
  if (!dir) out.push({ field: 'dataDir', key: 'dataDirEmpty' })
  else if (!looksAbsolute(dir)) out.push({ field: 'dataDir', key: 'data_dir_invalid' })
  const port = Number(v.port)
  if (!/^\d+$/.test(v.port.trim()) || port < 1024 || port > 65535 || isBrowserBlockedPort(port)) out.push({ field: 'port', key: 'port_invalid' })
  if (!v.terms) out.push({ field: 'terms', key: 'terms_required' })
  return out
}

export type SetupStep = 1 | 2 | 3
export const SETUP_STEP_COUNT = 3

/** 칸이 속한 단계. 특정 칸에 묶이지 않은 오류(field가 null)는 단계가 없다. */
export function stepOfField(f: SetupField | null): SetupStep | null {
  switch (f) {
    case 'password': case 'confirm': return 1
    case 'projectRoot': case 'port': case 'dataDir': return 2
    case 'terms': return 3
    default: return null
  }
}

/** 한 단계의 칸만 검사한다. 기준은 validateSetupForm 하나다. */
export const validateSetupStep = (v: SetupFormValues, step: SetupStep): SetupIssue[] =>
  validateSetupForm(v).filter((i) => stepOfField(i.field) === step)

/** 오류가 있는 첫 칸의 단계. 칸에 묶인 오류가 없으면 지금 단계에 머문다. */
export const stepForIssues = (issues: SetupIssue[], current: SetupStep): SetupStep =>
  issues.map((i) => stepOfField(i.field)).find((s) => s !== null) ?? current

/** 서버의 기계용 오류 코드(error)를 칸과 문구로 바꾼다. 모르는 코드는 일반 저장 실패다. */
export function issueFromServerCode(code: string): SetupIssue {
  switch (code) {
    case 'terms_required': return { field: 'terms', key: 'terms_required' }
    case 'password_invalid': return { field: 'password', key: 'tooShort' }
    case 'port_invalid': return { field: 'port', key: 'port_invalid' }
    case 'port_in_use': return { field: 'port', key: 'port_in_use' }
    case 'data_dir_invalid': return { field: 'dataDir', key: 'data_dir_invalid' }
    case 'data_dir_unwritable': return { field: 'dataDir', key: 'data_dir_unwritable' }
    case 'project_root_invalid': return { field: 'projectRoot', key: 'projectRoot_invalid' }
    case 'project_root_missing': return { field: 'projectRoot', key: 'project_root_missing' }
    case 'already_saving': return { field: null, key: 'already_saving' }
    default: return { field: null, key: 'save_failed' } // save_failed, invalid_body, 네트워크 실패 등
  }
}

/** 고급 설정 칸(포트, 데이터 폴더)에 오류가 있으면 접힌 곳을 열어 보여 줘야 한다. */
export const isAdvancedField = (f: SetupField | null): boolean => f === 'port' || f === 'dataDir'

/** 저장 뒤 /api/health 조회 결과. down은 연결 실패(설정 서버가 끝나는 중이거나 진짜 서버가 아직 안 뜸)로 정상 대기다. */
export type HealthProbe = 'down' | 'setup' | 'running'
export const SLOW_AFTER_MS = 60_000

export function classifyProbe(body: { ok?: boolean; setup?: boolean } | null): HealthProbe {
  if (!body || body.ok !== true) return 'down'
  return body.setup ? 'setup' : 'running'
}

/** reload: 진짜 서버가 떴다 · slow: 60초가 넘었다(계속 조회는 한다) · waiting: 더 기다린다 */
export function waitDecision(probe: HealthProbe, elapsedMs: number): 'reload' | 'slow' | 'waiting' {
  if (probe === 'running') return 'reload'
  return elapsedMs >= SLOW_AFTER_MS ? 'slow' : 'waiting'
}

/** 다른 포트로 옮길 새 주소. 지금 접속한 호스트 이름을 그대로 쓴다. */
export function newAddress(loc: { protocol: string; hostname: string }, port: number): string {
  return `${loc.protocol}//${loc.hostname}:${port}/`
}

/** 서버로 보낼 저장 본문. 포트는 숫자로 보낸다(서버는 문자열을 거절한다). */
export function toSetupBody(v: SetupFormValues) {
  return { terms: v.terms, password: v.password, port: Number(v.port), dataDir: v.dataDir.trim(), projectRoot: v.projectRoot.trim() }
}

/** 오류 목록에 고급 설정 칸이 있으면 접힌 곳을 열어야 한다. */
export const needsAdvancedOpen = (issues: SetupIssue[]): boolean => issues.some((i) => isAdvancedField(i.field))

/**
 * 저장 요청이 실패했을 때 다음 화면. 상태 코드가 없는 실패(응답 유실)와 409는 저장이 됐을 수 있어 health를 한 번 확인한다.
 * 여전히 설정 서버(setup)면 저장되지 않은 것이므로 오류, 연결 실패나 설정이 사라졌으면 기다림으로 넘긴다.
 */
export function saveFailureNext(status: number | undefined, probe: HealthProbe): 'error' | 'wait' {
  if (status !== undefined && status !== 409) return 'error'
  return probe === 'setup' ? 'error' : 'wait'
}

/** 한 AI의 준비 상태. 기록이 없거나 모르는 이유는 확인 실패로 보인다(준비됨이라고 하지 않는다). */
const KNOWN_REASONS = ['not_installed', 'logged_out', 'unreachable', 'no_models', 'check_failed', 'sdk_unavailable']
export type AiStatusView = { ready: true } | { ready: false; reason: string; requires?: string }
export function aiStatusOf(a: { available: boolean; reason?: string; requires?: string } | undefined): AiStatusView {
  if (!a) return { ready: false, reason: 'check_failed' }
  if (a.available) return { ready: true }
  return { ready: false, reason: a.reason && KNOWN_REASONS.includes(a.reason) ? a.reason : 'check_failed', requires: a.requires }
}
