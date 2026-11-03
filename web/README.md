# Aether 웹 (`web/`)

Aether의 프론트다. Vite + React + TypeScript + Tailwind v4로 만들었다. 서버(`server/`)가 `web/dist`를 같은 주소에서 정적으로 서빙하므로, 빌드만 하면 브라우저 새로고침으로 바로 반영된다. 백엔드 재시작은 필요 없다.

## 명령

```bash
cd web
npm run dev      # 개발 서버(vite)
npm run build    # 타입 검사(tsc -b) 후 vite 빌드 → web/dist
npm run lint     # eslint
```

시험은 `web/test/*.test.ts`이며 서버 쪽 `npm test`(`server/test/run-all.ts`)가 함께 돌린다. 브라우저 화면 시험은 [`e2e/README.md`](../e2e/README.md)를 본다.

## 구조와 설계

