# 시각 확인 하네스 (Phase 8d-3 완료 게이트 ③)

화면이 예전과 같은 모양으로 그려지는지 **눈으로** 대조하기 위한 도구다. 단위 테스트는 조각의 값이
맞는지 보지만, 8d-3처럼 원본 폴백을 지운 변경은 "값은 맞는데 화면이 비었다"가 가능하다.

8c 때는 이걸 그때그때 손으로 만들고 남기지 않아서 8d-3에서 처음부터 다시 만들어야 했다. 이번엔 남긴다.
8e(Codex 실구현)·8h(UI 표면)에서 그대로 재사용한다.

## 쓰는 법

```bash
# 1) 프론트 빌드(변경분 반영)
cd web && npm run build

# 2) 격리 fixture 서버 — 모델 호출 0, 디스크 무접촉
npx tsx server/test/visual/fixtureServer.ts 8899 &

# 3) 헤드리스 브라우저 띄우기(사용자 프로필과 분리 — 안 그러면 프로필 잠금으로 멈춘다)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --no-first-run --user-data-dir=/tmp/chrome-cdp --remote-debugging-port=9222 about:blank &

# 4) 찍기 — <url> <출력> [너비] [높이] [대기ms] [클릭할 선택자]
npx tsx server/test/visual/shoot.ts "http://127.0.0.1:8899/?s=fixture-claude" /tmp/desktop.png 1440 900
npx tsx server/test/visual/shoot.ts "http://127.0.0.1:8899/?s=fixture-claude" /tmp/mobile.png  390  844
npx tsx server/test/visual/shoot.ts "http://127.0.0.1:8899/?s=fixture-codex"  /tmp/second.png 1440 900
npx tsx server/test/visual/shoot.ts "http://127.0.0.1:8899/?s=fixture-claude" /tmp/settings.png 1440 900 3500 '[aria-label="설정"]'
npx tsx server/test/visual/shoot.ts "http://127.0.0.1:8899/?s=fixture-grok" /tmp/third.png 1440 900

# 세 번째 서비스 표면(새 세션 칩·목록 꼬리표·재로그인·한도 창 없음) — 데스크톱·모바일
CDP_PORT=9222 node --import tsx server/test/visual/checkProviderSurface.ts \
  http://127.0.0.1:8899 1440 900 /tmp/aether-10f
CDP_PORT=9222 node --import tsx server/test/visual/checkProviderSurface.ts \
  http://127.0.0.1:8899 390 844 /tmp/aether-10f

# 창 키보드·초점·ARIA·폰 44px 검사(CDP_PORT 생략 시 9222)
CDP_PORT=9222 node --import tsx server/test/visual/checkWindows.ts \
  "http://127.0.0.1:8899/?s=fixture-claude" 390 844

# Phase C feedback/status: Callout·PageBanner·Badge·Snackbar·focus·reduced-motion
CDP_PORT=9222 node --import tsx server/test/visual/checkFeedback.ts \
  "http://127.0.0.1:8899/?s=fixture-codex" 390 844
# 네 번째 인자를 주면 critical Snackbar 상태도 캡처한다.

# 작업 중 알림(모델이 일하는 도중에 하는 말) — 세션 세 개를 차례로 돌며 배치·글꼴·찾기까지 확인
#   ⚠️ 세션을 스스로 바꿔 다니므로 <url>이 아니라 <서버 주소>만 넘긴다.
CDP_PORT=9222 node --import tsx server/test/visual/checkLiveLine.ts http://127.0.0.1:8899 390 844

# 상태가 바뀌는 순간의 움직임 — 결정 카드 마무리·도구 펼침·중지 버튼·세션 선택·Agent Brain·오류 알림 +
#   '움직임 줄이기'에서 전부 꺼지는지. 네 번째 인자를 주면 그 폴더에 단계별 스크린샷을 남긴다.
#   ⚠️ 세션을 스스로 옮겨 다니고 카드에 답까지 하므로 <서버 주소>만 넘긴다.
#   ⚠️ 답한 결과를 fixture 서버가 기록으로 남기므로(과거 기록은 안 움직인다를 확인하려고 일부러 그렇게 한다)
#      두 번째 실행 전에는 서버를 새로 띄워라.
CDP_PORT=9222 node --import tsx server/test/visual/checkMotion.ts http://127.0.0.1:8899 1440 900 /tmp/aether-motion
CDP_PORT=9222 node --import tsx server/test/visual/checkMotion.ts http://127.0.0.1:8899 390  844 /tmp/aether-motion

# 세션 관제 점·손길 칩(13b) — 데스크톱·모바일. 대화 칸은 하나, 칩 점프는 대화만 갈아탄다.
#   CDP_PORT=9222 node --import tsx server/test/visual/checkPresence.ts http://127.0.0.1:8899 1440 900
#   CDP_PORT=9222 node --import tsx server/test/visual/checkPresence.ts http://127.0.0.1:8899 390 844

# 같은 일을 여러 장으로 시작(13c) — 새 작업 창. 대화 둘은 없다.
#   CDP_PORT=9222 node --import tsx server/test/visual/checkFanout.ts http://127.0.0.1:8899 1440 900
#   CDP_PORT=9222 node --import tsx server/test/visual/checkFanout.ts http://127.0.0.1:8899 390 844

# 아주 넓은 창에서만 대화 둘(13d) — 1440에서 둘, 1100 미만·폰에서 하나.
#   CDP_PORT=9222 node --import tsx server/test/visual/checkSplit.ts http://127.0.0.1:8899 1440 900
#   CDP_PORT=9222 node --import tsx server/test/visual/checkSplit.ts http://127.0.0.1:8899 1099 900
#   CDP_PORT=9222 node --import tsx server/test/visual/checkSplit.ts http://127.0.0.1:8899 390 844

# Agent Brain 검색 fixture
# slowSearch=1: 검색 응답을 900ms 늦춰 Recall Echo의 180ms 표시 지연·종료를 확인
open "http://127.0.0.1:8899/?s=fixture-claude&slowSearch=1"
```

> `node --import tsx …`는 **`server/` 디렉터리에서** 실행해야 한다(tsx가 거기 설치돼 있다).

## 함정 (실측)

- **Chrome 150부터 `--screenshot`·`--dump-dom` 명령줄 플래그가 동작하지 않는다**(빈 결과가 나온다).
  그래서 `shoot.ts`는 DevTools 프로토콜로 직접 찍는다. Node 24의 내장 WebSocket을 써서 의존성은 없다.
- **사용자 프로필을 그대로 쓰면 멈춘다** — 이미 떠 있는 Chrome이 프로필을 잠그고 있다. `--user-data-dir`로 가른다.
- **SSE에 주기 하트비트를 걸면 스크린샷이 영영 안 찍힌다** — 헤드리스의 가상 시간이 끝없이 흐른다.
  fixture 서버는 백로그를 보낸 뒤 타이머 없이 연결만 열어둔다(프론트는 그 상태로 재연결 마스크를 안 띄운다).

## fixture 세션

- `fixture-claude` — 실제 골든 코퍼스(`server/test/fixtures/claude_events.jsonl`)를 **실제 정규화 경로**에
  통과시킨다. 프로덕션이 내보내는 값과 같으므로 "화면 변화 0"을 여기서 대조한다.
- `fixture-codex` — 원본(`msg`)이 Claude와 아무 관계 없는 모양이고 계약(`events`)만 채운 봉투.
  화면이 원본을 몰래 읽고 있으면 여기서 빈다. 턴이 정상으로 끝난 모양이기도 하다.
- `fixture-actions` — 권한 카드·질문 카드가 답을 기다리는 상태. **카드에 답할 수 있다** — fixture 서버가
  결과 이벤트를 SSE로 되돌려 보내고 그 세션의 기록에도 남긴다(모델은 부르지 않는다). 그래서 "답하는 순간에만
  도는 움직임"과 "새로고침해서 과거 기록으로 볼 때는 안 도는 것"을 한 세션에서 둘 다 확인할 수 있다.
- `fixture-live` — **아직 돌고 있는 턴.** 턴 종료 이벤트가 없어서 프론트가 진행 중으로 본다.
  모델이 도중에 세 번 말했고, 화면엔 두 마디만 남아야 한다 — 뒤에 도구가 붙어 확정된 알림(두 번째 말)과
  아직 도구가 안 붙은 마지막 말. 첫 번째 말은 두 번째 말에 갈아끼워져 사라진다.
- `fixture-cut` — **답을 못 내고 끊긴 턴.** 최종 답변이 없으므로 마지막에 하던 말이 말풍선 없이 중단 배너 위에 남는다.
- `fixture-grok` — 세 번째 카탈로그 항목. 한도 창은 없고(`windowsAvailable: false`) 문맥 사용량만 온다. 새 세션 칩·목록 꼬리표·설정 재로그인 확인용(10f). 계획 승인 카드는 아직 그리지 않는다.
- `fixture-asleep` — **오래 안 써서 잠든 세션.** 모델 목록 조회(`/api/sessions/:id/models`)가 404를 준다.
  실패가 아니라 정상 상태이므로, 모델 칩을 눌러도 목록창을 열지 말고 "세션이 잠들어 있다"는 안내만
  띄워야 하고 다시 시도하지도 말아야 한다.
