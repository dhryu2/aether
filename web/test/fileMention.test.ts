/** 입력창 @ 파일 고르기의 순수 함수 시험. 실행: npx tsx web/test/fileMention.test.ts */
import { mentionAt, rankFiles } from '../src/lib/fileMention'

let fail = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`)
  if (!ok) fail++
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

check('맨 앞 @', same(mentionAt('@src', 4), { start: 0, query: 'src' }))
check('@만 있으면 빈 검색어', same(mentionAt('@', 1), { start: 0, query: '' }))
check('공백 뒤 @', same(mentionAt('보여줘 @ab', 7), { start: 4, query: 'ab' }))
check('줄 바꿈 뒤 @', same(mentionAt('a\n@b', 4), { start: 2, query: 'b' }))
check('메일 주소는 열지 않는다', mentionAt('a@b', 3) === null)
check('검색어에 공백이 들어가면 닫힌다', mentionAt('@ab cd', 6) === null)
check('@가 없으면 null', mentionAt('hello', 5) === null)
check('커서가 글 가운데', same(mentionAt('see @ab and more', 7), { start: 4, query: 'ab' }))
check('커서가 @ 앞이면 null', mentionAt('x @ab', 1) === null)
check('한글 검색어', same(mentionAt('@한글', 3), { start: 0, query: '한글' }))

const files = ['docs/readme.md', 'src/app.ts', 'src/deep/app-main.ts', 'README.txt', 'src/한글 문서.md', 'lib/x.ts']
check('이름 시작 > 이름 포함 > 경로 포함', same(rankFiles(files, 'app'), ['src/app.ts', 'src/deep/app-main.ts']))
check('경로에만 있으면 마지막', same(rankFiles(files, 'src/'), ['src/app.ts', 'src/한글 문서.md', 'src/deep/app-main.ts']))
check('이름 시작이 이름 포함보다 앞', same(rankFiles(['a/xreadme', 'z/readme.md'], 'readme'), ['z/readme.md', 'a/xreadme']))
check('대소문자 무시', same(rankFiles(files, 'README'), ['README.txt', 'docs/readme.md']))
check('같은 순위는 짧은 경로가 앞', same(rankFiles(['a/b/x.ts', 'x.ts', 'a/x.ts'], 'x'), ['x.ts', 'a/x.ts', 'a/b/x.ts']))
check('한글 검색어', same(rankFiles(files, '한글'), ['src/한글 문서.md']))
check('맞는 것이 없으면 빈 목록', rankFiles(files, 'zzz').length === 0)
check('limit 적용', rankFiles(files, '', 2).length === 2)

process.exit(fail ? 1 : 0)
