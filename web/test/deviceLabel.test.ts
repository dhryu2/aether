/**
 * 기기 이름 뽑기 시험. 실행: npx tsx web/test/deviceLabel.test.ts
 */
import { deviceLabel } from '../src/lib/deviceLabel'

let fail = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) fail++
}

check('iPhone Safari', deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1') === 'iPhone · Safari')
check('Mac Chrome(Safari 글자가 섞여 있어도 Chrome)', deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36') === 'Mac · Chrome')
check('Android Chrome(Linux 글자가 섞여 있어도 Android)', deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36') === 'Android · Chrome')
check('Windows Edge', deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0') === 'Windows · Edge')
check('빈 값', deviceLabel(undefined) === undefined && deviceLabel('') === undefined)
check('알 수 없는 값', deviceLabel('curl/8.0') === undefined)

process.exit(fail ? 1 : 0)
