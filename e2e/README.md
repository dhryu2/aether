# 웹 화면 시험

Aether 웹을 브라우저로 눌러 보는 시험이다. 서버는 라이브(8787)와 따로 8790 포트에 뜬다. 모델은 부르지 않는다. 시험 전용 가짜 응답만 쓴다. 데이터는 임시 폴더와 그 안의 SQLite 파일에 두고, 끝나면 지운다.

## 실행

저장소 루트에서 한 줄이면 된다.

```bash
cd e2e && npm install --include=dev && npm test
```

`--include=dev`는 설치 환경이 개발 도구를 빼더라도 Playwright가 들어가게 한다. `npm test`가 웹을 빌드한 뒤 Playwright를 돌린다. 데스크톱(1280x800)과 폰(390x844) 두 크기를 순서대로 본다. 실패한 시험은 `e2e/test-results/`에 스크린샷을 남긴다.

브라우저가 받아 둔 Chromium과 버전이 다르면 다음을 한 번 실행한다.

```bash
cd e2e && npx playwright install chromium
```
