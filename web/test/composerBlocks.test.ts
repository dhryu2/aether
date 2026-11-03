/** 입력창 코드 상자 — 열기·닫기·보내기. 화면 없이 글자만 검사한다. */
import {
  blocksFromMessage,
  closeCodeAt,
  codeLabel,
  decodeDraft,
  encodeDraft,
  bubbleBlocks,
  openCodeAt,
  openingFence,
  removeEmptyCode,
  serializeBlocks,
  textBlock,
  type ComposerBlock,
} from '../src/lib/composerBlocks'

let pass = 0
let fail = 0
function check(cond: boolean, name: string, detail?: unknown) {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (cond) pass++; else fail++
}

function shape(blocks: ComposerBlock[]): string {
  return blocks
    .map((block) => (block.kind === 'text' ? `t:${JSON.stringify(block.value)}` : `c:${block.lang}:${JSON.stringify(block.value)}`))
    .join('|')
}

check(openingFence('```')?.lang === '', '빈 ``` 는 언어가 없다')
check(openingFence('~~~')?.lang === '', '빈 ~~~ 도 연다')
check(openingFence('```python')?.lang === 'python', '``` 뒤의 언어 이름을 읽는다')
check(openingFence('~~~c++')?.lang === 'c++', '~~~ 뒤의 c++ 도 언어다')
check(openingFence('``` ts')?.lang === 'ts', '표시와 언어 사이의 빈칸은 허용한다')
check(openingFence('```hello world') === null, '언어가 두 단어면 상자를 열지 않는다')
check(openingFence('say ```') === null, '줄 중간의 표시는 상자를 열지 않는다')
check(codeLabel('') === 'plain' && codeLabel('python') === 'python', '언어가 없으면 화면에는 plain')

const only = [textBlock('~~~')]
const opened = openCodeAt(only, only[0].id, 3)
check(opened !== null && shape(opened.blocks) === 'c::""|t:""', '표시만 있는 줄은 빈 상자와 아래 글 칸이 된다', opened && shape(opened.blocks))
check(opened?.focusId === opened?.blocks[0].id && opened?.focusAt === 0, '커서는 상자 안으로 간다')

const mid = [textBlock('설명\n```python\n뒤')]
const midOpen = openCodeAt(mid, mid[0].id, '설명\n```python'.length)
check(midOpen !== null && shape(midOpen.blocks) === 't:"설명"|c:python:""|t:"뒤"', '앞뒤 글은 남고 그 사이에 상자가 생긴다', midOpen && shape(midOpen.blocks))

const plain = [textBlock('그냥 줄')]
check(openCodeAt(plain, plain[0].id, 2) === null, '보통 줄의 Shift+Enter 는 상자가 아니다')

const box = opened!.blocks.map((block, index) => (index === 0 && block.kind === 'code' ? { ...block, value: '```' } : block))
const closed = closeCodeAt(box, box[0].id, 3)
check(closed !== null && shape(closed.blocks) === 't:""', '빈 상자에서 닫는 표시만 있으면 상자가 사라진다', closed && shape(closed.blocks))

const filled = opened!.blocks.map((block, index) => (index === 0 && block.kind === 'code' ? { ...block, value: 'const a = 1\n```' } : block))
const closedFilled = closeCodeAt(filled, filled[0].id, 'const a = 1\n```'.length)
check(
  closedFilled !== null && shape(closedFilled.blocks) === 'c::"const a = 1"|t:""',
  '코드 아래의 닫는 줄은 상자를 끝내고 아래 글 칸으로 간다',
  closedFilled && shape(closedFilled.blocks),
)
check(closedFilled?.focusId === closedFilled?.blocks[1].id, '닫으면 아래 글 칸에 커서가 있다')

const notClose = closeCodeAt(
  filled.map((block, index) => (index === 0 && block.kind === 'code' ? { ...block, value: '```python' } : block)),
  filled[0].id,
  0,
)
check(notClose === null, '상자 안의 ```python 은 닫지 않는다')

const removed = removeEmptyCode(opened!.blocks, opened!.blocks[0].id)
check(removed !== null && shape(removed.blocks) === 't:""', '빈 상자의 백스페이스는 상자를 지운다', removed && shape(removed.blocks))
const kept = removeEmptyCode(filled, filled[0].id)
check(kept === null, '글이 있는 상자는 백스페이스로 지우지 않는다')

const hello = [textBlock('안녕\n```')]
const helloOpen = openCodeAt(hello, hello[0].id, '안녕\n```'.length)
const helloRemoved = helloOpen && removeEmptyCode(helloOpen.blocks, helloOpen.blocks[1].id)
check(helloRemoved !== null && shape(helloRemoved.blocks) === 't:"안녕"' && helloRemoved.focusAt === 2, '상자 앞 글의 끝으로 돌아간다', helloRemoved && shape(helloRemoved.blocks))

check(serializeBlocks(opened!.blocks) === '', '빈 상자는 보내지 않는다')
check(
  serializeBlocks(closedFilled!.blocks) === '```\nconst a = 1\n```',
  '언어가 없으면 plain 없이 코드 블록으로 보낸다',
  serializeBlocks(closedFilled!.blocks),
)
const pyLine = [textBlock('봐\n```python')]
const pyOpen = openCodeAt(pyLine, pyLine[0].id, '봐\n```python'.length)!
const pyFilled = pyOpen.blocks.map((block) => (block.kind === 'code' ? { ...block, value: 'x = 1' } : block))
check(serializeBlocks(pyFilled) === '봐\n```python\nx = 1\n```', '언어 이름을 붙여 보낸다', serializeBlocks(pyFilled))

const draft = encodeDraft(pyFilled.map((block) => (block.kind === 'code' ? { ...block, collapsed: true } : block)))
const restored = decodeDraft(draft)
check(restored.some((block) => block.kind === 'code' && block.lang === 'python' && block.value === 'x = 1' && block.collapsed), '접힌 상자는 임시저장 뒤에 그대로다')
check(decodeDraft('```아직 아님').length === 1 && decodeDraft('```아직 아님')[0].kind === 'text', '상자로 만들기 전의 ``` 는 새로고침해도 글이다')

const parsed = blocksFromMessage('앞\n```ts\nlet x = 1\n```\n뒤')
check(shape(parsed) === 't:"앞"|c:ts:"let x = 1"|t:"뒤"', '보낸 글을 다시 열면 상자로 돌아온다', shape(parsed))
const unclosed = blocksFromMessage('앞\n```ts\nlet x = 1')
check(unclosed.length === 1 && unclosed[0].kind === 'text', '닫히지 않은 표시는 상자로 만들지 않는다', shape(unclosed))

const bubble = bubbleBlocks('앞\n\n```ts\nlet x = 1\n```\n\n뒤')
check(shape(bubble) === 't:"앞"|c:ts:"let x = 1"|t:"뒤"', '말풍선 조각에는 코드 앞뒤 빈 줄이 남지 않는다', shape(bubble))
const bubbleOnlyCode = bubbleBlocks('```\nx\n```')
check(shape(bubbleOnlyCode) === 'c::"x"', '코드만 보낸 글에는 빈 글 칸이 생기지 않는다', shape(bubbleOnlyCode))
const bubbleUnclosed = bubbleBlocks('앞\n```ts\nlet x = 1')
check(bubbleUnclosed.every((block) => block.kind === 'text'), '닫히지 않은 표시는 말풍선에서도 글이다', shape(bubbleUnclosed))

console.log(`\n${fail ? '❌' : '✅'} composer blocks: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
