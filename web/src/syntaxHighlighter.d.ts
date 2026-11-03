// 코드 강조를 필요한 언어만 등록해 쓰기 위한 타입 선언(Markdown.tsx).
//   @types 패키지가 prism-light는 선언하지만 언어 파일은 선언하지 않는다. tsconfig의 types 제한 때문에 패키지도 직접 불러온다.
/// <reference types="react-syntax-highlighter" />

declare module 'react-syntax-highlighter/dist/esm/languages/prism/*' {
  const language: unknown
  export default language
}
