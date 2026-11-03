// 시험 전용 프로세스 입구. 제품 서버 코드는 그대로 두고, 가짜 provider만 등록한 뒤 본체를 불러온다.
// 이 파일은 8790에서만 실행한다. 라이브 8787로 붙으면 바로 끝낸다.
import { __registerProviderForTest } from '../server/providers/registry'
import { e2eEntry } from './fakeProvider'

const port = process.env.PORT
const db = process.env.AETHER_DB_PATH ?? ''
if (port !== '8790') {
  console.error('e2e 서버는 PORT=8790에서만 띄운다')
  process.exit(1)
}
if ((process.env.AETHER_AUTH_MODE ?? 'off') !== 'off') {
  console.error('e2e 서버는 인증을 끈 상태로만 띄운다')
  process.exit(1)
}
if (!process.env.AETHER_DATA_DIR || !process.env.AETHER_PROJECT_ROOT) {
  console.error('e2e 서버에는 임시 데이터 폴더와 작업 폴더가 필요하다')
  process.exit(1)
}
if (!db.startsWith(`${process.env.AETHER_DATA_DIR}/`)) {
  console.error('e2e 서버는 임시 데이터 폴더 안의 SQLite 파일만 쓴다')
  process.exit(1)
}

__registerProviderForTest(e2eEntry)

await import('../server/index')
