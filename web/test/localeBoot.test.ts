/**
 * 웹 부팅이 서버 언어를 덮지 않는지(D8).
 * 실행: npx tsx web/test/localeBoot.test.ts
 *
 * 설정에서 고른 언어만 POST /api/locale 한다. 부팅 init은 서버 언어를 읽어 화면에 맞춘다.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const storeSrc = fs.readFileSync(path.join(HERE, '../src/lib/store.ts'), 'utf8')

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) pass++; else fail++
  console.log(`${cond ? '✅' : '❌'} ${name}`)
}

const initStart = storeSrc.indexOf('async init()')
const nextAction = storeSrc.indexOf('\n  async ', initStart + 1)
check('init() 본문을 찾았다', initStart >= 0 && nextAction > initStart)
const initBody = storeSrc.slice(initStart, nextAction > initStart ? nextAction : undefined)
check('부팅 init이 서버 언어를 덮지 않는다', !initBody.includes('api.setLocale'))
check('부팅 init이 서버 언어를 따른다', initBody.includes('api.getLocale'))
check('설정 setLocale은 서버에 보낸다', /setLocale\(locale: Locale\)[\s\S]*api\.setLocale\(locale\)/.test(storeSrc))

console.log(`\n${fail === 0 ? '✅' : '❌'} localeBoot: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
