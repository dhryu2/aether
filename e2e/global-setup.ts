// Playwright는 서버(webServer)를 이 파일보다 먼저 띄운다.
// 임시 폴더와 그 안의 SQLite 파일 경로는 start-server.sh가 정한다.
// 이 단계는 그 준비가 끝났는지만 확인한다. 지우기는 global-teardown.ts가 한다.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const statePath = path.join(here, '.runtime', 'state.json')

export default function globalSetup() {
  let state: { dataDir?: string; workDir?: string; db?: string }
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8')) as { dataDir?: string; workDir?: string; db?: string }
  } catch {
    throw new Error('시험 서버가 임시 폴더를 준비하지 못했다. start-server.sh가 먼저 떠 있어야 한다.')
  }
  if (!state.dataDir?.startsWith('/') || !state.workDir?.startsWith('/') || !state.db?.startsWith(`${state.dataDir}/`)) {
    throw new Error('시험 서버의 준비 상태가 임시 폴더와 그 안의 DB 파일이 아니다.')
  }
}
