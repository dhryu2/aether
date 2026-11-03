// 시험이 끝나면 임시 폴더를 지운다. SQLite 파일은 데이터 폴더 안에 있어 같이 지워진다.
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const statePath = path.join(here, '.runtime', 'state.json')

export default function globalTeardown() {
  let dataDir = ''
  let workDir = ''
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { dataDir?: string; workDir?: string }
    dataDir = state.dataDir ?? ''
    workDir = state.workDir ?? ''
  } catch {
    // 준비 단계에서 끊기면 상태 파일이 없다. start-server.sh의 정리가 폴더를 지운다.
  }

  if (dataDir.startsWith('/')) rmSync(dataDir, { recursive: true, force: true })
  if (workDir.startsWith('/')) rmSync(workDir, { recursive: true, force: true })
  rmSync(path.join(here, '.runtime'), { recursive: true, force: true })
}
