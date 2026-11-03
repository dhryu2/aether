/**
 * 마크다운 코드 블록 — 필요한 언어만 등록한 강조(PrismLight)와 렌더 안정성.
 *   실행: npx tsx web/test/markdownHighlight.test.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  cond ? pass++ : fail++
  console.log(`${cond ? '✅' : '❌'} ${name}${cond || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

// tsx가 web의 tsconfig(react-jsx)를 못 찾는 위치에서 돌 수 있어, 클래식 JSX 변환이 찾는 React를 전역에 둔다.
;(globalThis as { React?: unknown }).React = React

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/components/Markdown.tsx')
// tsx 버전마다 esm 파일의 default 처리가 달라 실제 번들러(Vite)로 불러온다. 
const vite = await createServer({
  configFile: false,
  root: path.resolve(path.dirname(SRC), '../..'),
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null },
  ssr: { noExternal: ['react-syntax-highlighter'] },
})
const { Markdown, CodeBlock } = await vite.ssrLoadModule('/src/components/Markdown.tsx')

const render = (md: string) => renderToStaticMarkup(createElement(Markdown, { children: md }))
const fence = (lang: string, code: string) => '```' + lang + '\n' + code + '\n```'
// 강조된 토큰은 색을 인라인 style로 가진 span이다. 언어 이름표 같은 바깥 요소가 섞이지 않게 <code> 안만 본다.
const codeInner = (html: string) => html.slice(html.indexOf('<code'), html.indexOf('</code>'))
const colored = (lang: string, code: string) => /<span class="token[^"]*" style="color:/.test(codeInner(render(fence(lang, code))))

// 대표 문법. 정식 이름과 자주 쓰는 별칭이 모두 색칠돼야 한다.
const samples: Record<string, string> = {
  typescript: 'const a: number = 1', tsx: 'const a = <div>{1}</div>', javascript: 'const a = 1', jsx: 'const a = <b />',
  json: '{"a": 1}', bash: 'echo "hi" && ls -la', python: 'def f():\n  return 1', rust: 'fn main() { let x = 1; }',
  go: 'func main() { var x int }', java: 'public class A { int x = 1; }', kotlin: 'fun main() { val x = 1 }',
  swift: 'let x: Int = 1', c: 'int main() { return 0; }', cpp: 'int main() { std::cout << 1; }', csharp: 'public class A { int x = 1; }',
  ruby: 'def f; 1; end', php: '<?php echo 1;', sql: 'SELECT * FROM t WHERE a = 1', yaml: 'a: 1\nb: [1, 2]', toml: '[a]\nb = 1',
  markup: '<div class="a">x</div>', css: 'a { color: red; }', scss: '$a: 1; a { b: $a; }', diff: '+ a\n- b',
  markdown: '# 제목\n**굵게**', docker: 'FROM node:20\nRUN npm ci', dart: 'void main() { var x = 1; }',
  powershell: 'Get-ChildItem -Path .', batch: '@echo off\nset A=1',
}
for (const [lang, code] of Object.entries(samples)) check(`강조: ${lang}`, colored(lang, code))

const aliases: Record<string, string> = {
  ts: samples.typescript, js: samples.javascript, py: samples.python, sh: samples.bash, shell: samples.bash, zsh: samples.bash,
  yml: samples.yaml, html: samples.markup, xml: samples.markup, rs: samples.rust, md: samples.markdown,
  dockerfile: samples.docker, ps1: samples.powershell, cs: samples.csharp, kt: samples.kotlin, rb: samples.ruby,
}
for (const [alias, code] of Object.entries(aliases)) check(`별칭: ${alias}`, colored(alias, code))

// 미등록 언어와 빈 언어는 오류 없이 색 없는 코드로 나온다.
for (const lang of ['haskell', 'nosuchlang', '']) {
  let html = ''
  let threw = false
  try {
    html = render(fence(lang, 'main = print 1'))
  } catch {
    threw = true
  }
  check(`미등록(${lang || '빈 값'}): 오류 없음, 색 없음, 본문 유지`, !threw && !/<span class="token[^"]*" style="color:/.test(codeInner(html)) && html.includes('main = print 1'))
}

// 스트리밍 중 상태 유지: 코드 블록이 렌더마다 다른 컴포넌트가 되면 줄바꿈·접기 상태가 초기화된다.
//   따라서 components는 함수 밖에 하나뿐이고, 코드 블록은 memo이며, 바뀌는 값은 context로 넘어가야 한다.
const src = fs.readFileSync(SRC, 'utf8')
const mdFn = src.slice(src.indexOf('export const Markdown = memo('))
check('components가 Markdown 함수 안에서 만들어지지 않는다', !/components=\{\{/.test(mdFn) && /components=\{markdownComponents\}/.test(mdFn))
check('CodeBlock은 memo다', (CodeBlock as unknown as { $$typeof: symbol }).$$typeof === Symbol.for('react.memo'))
check('dark는 context로 전달된다', /MarkdownCtx\.Provider/.test(mdFn) && /use\(MarkdownCtx\)/.test(src))

// 블록 순번(파일 이름에 쓰임)은 렌더마다 1부터 다시 센다 — 같은 글을 두 번 그려도 결과가 같아야 한다.
const twoBlocks = fence('ts', 'a') + '\n\n' + fence('ts', 'b')
check('두 번 렌더해도 같은 결과', render(twoBlocks) === render(twoBlocks))

console.log(`\n${pass} pass / ${fail} fail`)
process.exit(fail ? 1 : 0)
