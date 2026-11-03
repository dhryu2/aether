/** 첫 설정 화면의 순수 로직 시험: 입력 검사, 서버 오류 코드 → 칸/문구, 저장 뒤 기다림 판정, i18n 짝. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  aiStatusOf, classifyProbe, isAdvancedField, needsAdvancedOpen, saveFailureNext, toSetupBody, issueFromServerCode, looksAbsolute, newAddress, validateSetupForm, waitDecision,
  SLOW_AFTER_MS, stepForIssues, stepOfField, validateSetupStep, type SetupFormValues,
} from '../src/lib/setupForm'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}
const ok: SetupFormValues = { password: 'abcdefgh', confirm: 'abcdefgh', port: '8787', dataDir: '/data', projectRoot: '/home/me', terms: true }
const keys = (v: Partial<SetupFormValues>) => validateSetupForm({ ...ok, ...v }).map((i) => `${i.field}:${i.key}`)

check(validateSetupForm(ok).length === 0, '정상 입력은 오류 없음')
check(keys({ password: '' }).join() === 'password:tooShort', '빈 비밀번호는 비밀번호 칸 오류만(확인 칸은 따로 안 냄)')
check(keys({ password: 'a'.repeat(73), confirm: 'a'.repeat(73) }).join() === 'password:tooLong', '73바이트는 너무 김')
check(keys({ confirm: 'abcdefgx' }).join() === 'confirm:mismatch', '확인 칸이 다르면 확인 칸')
check(keys({ projectRoot: ' ' }).join() === 'projectRoot:projectRootEmpty', '빈 작업 폴더')
check(keys({ projectRoot: 'relative/x' }).join() === 'projectRoot:projectRoot_invalid', '상대 경로 작업 폴더')
check(keys({ dataDir: '' }).join() === 'dataDir:dataDirEmpty', '빈 데이터 폴더')
check(keys({ port: '80' }).join() === 'port:port_invalid' && keys({ port: '65536' }).length === 1 && keys({ port: 'abc' }).length === 1 && keys({ port: '87.5' }).length === 1, '포트 범위·숫자')
check(keys({ port: '1024' }).length === 0 && keys({ port: '65535' }).length === 0, '포트 경계 통과')
check(keys({ terms: false }).join() === 'terms:terms_required', '약관 미동의')
check(keys({ password: '', projectRoot: '', terms: false }).join() === 'password:tooShort,projectRoot:projectRootEmpty,terms:terms_required', '오류는 화면 순서대로')
check(looksAbsolute('/a') && looksAbsolute('C:\\a') && looksAbsolute('c:/a') && looksAbsolute('\\\\srv\\x') && !looksAbsolute('a/b') && !looksAbsolute(''), '절대 경로 모양')

// 서버 코드(server/setup/save.ts SetupErrorCode) 전부가 칸과 문구로 바뀐다
const codes: Record<string, [string | null, string]> = {
  terms_required: ['terms', 'terms_required'], password_invalid: ['password', 'tooShort'], port_invalid: ['port', 'port_invalid'],
  port_in_use: ['port', 'port_in_use'], data_dir_invalid: ['dataDir', 'data_dir_invalid'], data_dir_unwritable: ['dataDir', 'data_dir_unwritable'],
  project_root_invalid: ['projectRoot', 'projectRoot_invalid'], project_root_missing: ['projectRoot', 'project_root_missing'],
  already_saving: [null, 'already_saving'], save_failed: [null, 'save_failed'], invalid_body: [null, 'save_failed'], 'Failed to fetch': [null, 'save_failed'], '': [null, 'save_failed'],
}
for (const [code, [field, key]] of Object.entries(codes)) {
  const i = issueFromServerCode(code)
  check(i.field === field && i.key === key, `서버 코드 ${code || '(빈 값)'} → ${field}/${key}`, i)
}
const saveSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../server/setup/save.ts'), 'utf8')
const serverCodes = [...saveSrc.matchAll(/"([a-z_]+)"(?=\s*\|\s*"|;)/g)].map((m) => m[1])
const declared = saveSrc.slice(saveSrc.indexOf('export type SetupErrorCode'), saveSrc.indexOf('export interface SetupInput'))
const all = [...declared.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
check(all.length >= 10 && all.every((c) => c in codes), '서버 SetupErrorCode가 모두 매핑됨', { all, serverCodes: serverCodes.length })
check(isAdvancedField('port') && isAdvancedField('dataDir') && !isAdvancedField('password') && !isAdvancedField(null), '고급 칸 판정')

// 저장 뒤 기다림
check(classifyProbe(null) === 'down' && classifyProbe({}) === 'down' && classifyProbe({ ok: false }) === 'down', '연결 실패·이상 응답은 정상 대기(down)')
check(classifyProbe({ ok: true, setup: true }) === 'setup' && classifyProbe({ ok: true }) === 'running', 'setup이 사라지면 running')
check(waitDecision('running', 1000) === 'reload' && waitDecision('running', SLOW_AFTER_MS + 1) === 'reload', '진짜 서버가 뜨면 언제든 reload')
check(waitDecision('down', 1000) === 'waiting' && waitDecision('setup', 59_999) === 'waiting', '60초 전에는 기다림')
check(waitDecision('down', SLOW_AFTER_MS) === 'slow' && waitDecision('setup', SLOW_AFTER_MS + 5) === 'slow', '60초부터 slow')
// 저장 요청 실패 뒤 판정(응답 유실·409는 health로 확인)
check(saveFailureNext(undefined, 'down') === 'wait' && saveFailureNext(undefined, 'running') === 'wait', '응답 유실: 설정 서버가 끝났으면 기다림')
check(saveFailureNext(undefined, 'setup') === 'error' && saveFailureNext(409, 'setup') === 'error', '응답 유실·409라도 아직 설정 서버면 오류')
check(saveFailureNext(409, 'down') === 'wait', '409인데 서버가 내려갔으면 기다림')
check(saveFailureNext(400, 'down') === 'error' && saveFailureNext(500, 'running') === 'error' && saveFailureNext(403, 'down') === 'error', '그 밖의 상태 코드는 항상 오류')
// 저장 본문: 포트는 숫자
const body = toSetupBody({ ...ok, port: ' 8787 ', dataDir: ' /data ', projectRoot: ' /home/me ' })
check(body.port === 8787 && typeof body.port === 'number' && body.dataDir === '/data' && body.projectRoot === '/home/me' && body.terms === true, '저장 본문: 포트 숫자, 경로 다듬음', body)
check(needsAdvancedOpen([{ field: 'port', key: 'x' }]) && needsAdvancedOpen([{ field: 'password', key: 'x' }, { field: 'dataDir', key: 'y' }]) && !needsAdvancedOpen([{ field: 'password', key: 'x' }, { field: null, key: 'y' }]), '고급 칸 자동 열기 조건')
check(keys({ port: '6000' }).join() === 'port:port_invalid' && keys({ port: '6667' }).length === 1 && keys({ port: '10080' }).length === 1 && keys({ port: '8787' }).length === 0, '브라우저 금지 포트 거절')
// AI 상태: 기록이 없거나 모르는 이유는 준비됨이 아니다
check(aiStatusOf({ available: true }).ready === true, 'AI 상태: 준비됨')
const missing = aiStatusOf(undefined)
check(!missing.ready && missing.reason === 'check_failed', 'AI 상태: 기록 없음은 확인 실패', missing)
const unk = aiStatusOf({ available: false, reason: 'brand_new' })
check(!unk.ready && unk.reason === 'check_failed', 'AI 상태: 모르는 이유는 확인 실패', unk)
const known = aiStatusOf({ available: false, reason: 'logged_out', requires: 'X' })
check(!known.ready && known.reason === 'logged_out' && known.requires === 'X', 'AI 상태: 아는 이유와 requires 유지', known)
check(newAddress({ protocol: 'http:', hostname: '127.0.0.1' }, 9000) === 'http://127.0.0.1:9000/', '새 주소')

// i18n: 코드가 쓰는 오류 키와 화면 키가 사전에 한국어·영어로 모두 있다
const dictSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/i18n/setup.ts'), 'utf8')
const used = new Set<string>()
for (const i of validateSetupForm({ password: '', confirm: '', port: '', dataDir: '', projectRoot: '', terms: false })) used.add(i.key)
for (const k of ['mismatch', 'tooLong', 'projectRoot_invalid', 'data_dir_invalid']) used.add(k)
for (const [, [, key]] of Object.entries(codes)) used.add(key)
for (const k of used) check(new RegExp(`'setup\\.error\\.${k}': \\{\\s*ko: '[^']+',\\s*en: '[^']+`).test(dictSrc), `i18n setup.error.${k} 한국어·영어`)
check(/작업 폴더 밖의 파일도 읽고 고칠 수 있고/.test(dictSrc) && /outside the work folder/.test(dictSrc), '안내 1: 작업 폴더 밖 접근과 명령 실행을 알림')
check([1, 2, 3, 4, 5].every((n) => dictSrc.includes(`'setup.consent.${n}'`)), '핵심 안내 5줄')
check(/책임은 모두 사용자에게 있습니다/.test(dictSrc) && /solely responsible/.test(dictSrc), '안내 5: 사용 책임은 사용자에게')
check(/개발자는 사용자 정보를 수집하지 않습니다/.test(dictSrc) && /AI 서비스의 약관을 따릅니다/.test(dictSrc) && /does not collect your information/.test(dictSrc), '안내 3: 수집하지 않음')
check(!/Claude|Codex|Grok|Ollama|OpenAI|Anthropic/i.test(dictSrc), '문구에 AI 회사 이름 없음')
const termsSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../shared/terms.ts'), 'utf8')
check(termsSrc.includes('"2026-11-02"'), '사용 조건 판 상수')

// 단계: 칸이 속한 단계와 단계별 검사
check(stepOfField('password') === 1 && stepOfField('confirm') === 1 && stepOfField('projectRoot') === 2 && stepOfField('port') === 2 && stepOfField('dataDir') === 2 && stepOfField('terms') === 3 && stepOfField(null) === null, '칸의 단계')
const bad = { ...ok, password: '', projectRoot: '', port: '1', terms: false }
check(validateSetupStep(bad, 1).map((i) => i.field).join() === 'password' && validateSetupStep(bad, 2).map((i) => i.field).join() === 'projectRoot,port' && validateSetupStep(bad, 3).map((i) => i.field).join() === 'terms', '단계별 검사는 그 단계 칸만')
check(validateSetupStep(ok, 1).length + validateSetupStep(ok, 2).length === 0 && validateSetupStep({ ...ok, terms: false }, 1).length === 0, '정상 입력·다른 단계 오류는 통과')
check(stepForIssues(validateSetupForm(bad), 3) === 1 && stepForIssues([{ field: 'port', key: 'x' }], 3) === 2 && stepForIssues([{ field: 'terms', key: 'x' }], 1) === 3, '첫 오류의 단계로 이동')
check(stepForIssues([{ field: null, key: 'save_failed' }], 3) === 3 && stepForIssues([{ field: null, key: 'x' }, { field: 'port', key: 'y' }], 1) === 2, '칸 없는 오류는 현재 단계, 칸 있는 첫 오류가 있으면 그 단계')
check(stepForIssues([issueFromServerCode('port_in_use')], 3) === 2 && stepForIssues([issueFromServerCode('project_root_missing')], 3) === 2 && stepForIssues([issueFromServerCode('password_invalid')], 3) === 1, '서버 오류도 해당 단계로')

console.log(`\n${fail ? '❌' : '✅'} setupForm: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
