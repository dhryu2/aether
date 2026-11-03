import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSearchQuery, searchRequestUrl } from '../src/lib/searchFilters'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}

const url = searchRequestUrl({ q: 'x', fromTs: 10, toTs: 20 })
check(url.includes('q=x'), 'url q')
check(url.includes('fromTs=10'), 'url fromTs')
check(url.includes('toTs=20'), 'url toTs')

const empty = searchRequestUrl({ q: 'only' })
check(!empty.includes('fromTs=') && !empty.includes('toTs='), '빈 기간 키 없음')

const built = buildSearchQuery({ q: 'a', chatOnly: true })
check(built.q === 'a' && built.chatOnly === '1', 'build q·chatOnly')

const root = path.dirname(fileURLToPath(import.meta.url))
const store = fs.readFileSync(path.join(root, '../src/lib/store.ts'), 'utf8')
check(store.includes('searchRequestUrl('), 'store searchRequestUrl(')
check(!/_\s*=\s*searchRequestUrl\(/.test(store), 'searchRequestUrl 결과 버림 없음')
check(/fetch\(\s*url/.test(store) || /fetch\(\s*searchRequestUrl/.test(store), 'searchRequestUrl→fetch')

const searchView = fs.readFileSync(path.join(root, '../src/components/brain/SearchView.tsx'), 'utf8')
check(searchView.includes('data-search-period'), 'SearchView data-search-period')
check(searchView.includes('setSearchFilters'), 'SearchView setSearchFilters 연결')
check(
  !searchView.includes('data-search-thread') && !searchView.includes('data-search-channel') && !searchView.includes('data-search-bot'),
  '채널·스레드·봇 입력칸 없음',
)

console.log(`\n${fail === 0 ? '✅' : '❌'} searchFilters: ${pass} PASS / ${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
