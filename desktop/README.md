# Aether 데스크톱 (맥·윈도)

Tauri 2 껍데기다. 기능 본체는 Node Express 서버다. 이 앱은 창·트레이·단축키·네이티브 알림만 맡는다. 서버·DB·로컬 모델을 앱 안에 두지 않는다.

## 전제

- 맥의 Aether Node 서버가 이미 떠 있어야 한다. 윈도 앱도 그 서버에 REST와 SSE로 붙는다.
- `cargo tauri dev` / 이 앱 실행은 라이브 Express PID를 재시작하지 않는다.
- 기본 시작 URL은 `http://127.0.0.1:8787`이다.
- 허용 시작 주소는 `http://127.0.0.1:*`와 `https://*.ts.net:*`뿐이다. `localhost` 호스트는 거절한다.
- 이 README의 소스 실행 안내는 MSI 설치 완료를 뜻하지 않는다.

## 실행 (맥·윈도 공통)

```bash
# 서버가 응답하는 상태에서 (기본은 127.0.0.1:8787)
cd desktop/src-tauri
cargo run
```

시작 URL을 바꾸려면 다음 중 하나를 쓴다.

1. 환경변수 `AETHER_DESKTOP_URL` (최우선)
2. 앱 설정 디렉터리의 `server_url` 파일

원격 Tailscale 주소 예: `AETHER_DESKTOP_URL=https://aether.example.ts.net:8787`

`localhost`를 넣으면 창을 만들지 않고 프로세스가 실패로 끝난다. `localhost`를 `127.0.0.1`로 바꿔 통과시키지 않는다.

## 윈도 MSI

윈도 PC에서만 네이티브로 만든다. 맥에서 교차 컴파일한 산출은 설치 증거가 아니다.

```bash
cargo install tauri-cli --locked --version "^2"
cd desktop/src-tauri
cargo tauri build --bundles msi
```

산출은 `desktop/src-tauri/target/release/bundle/msi/` 아래 `.msi`다. WiX Toolset v3가 없으면 실패다. NSIS나 exe 번들로 바꾸지 않는다.

설치 뒤 설정 파일:

1. `%APPDATA%\app.aether.desktop\server_url`에 `https://<맥-ts.net>:8787` 한 줄을 적는다.
2. 앱을 기동하면 같은 디렉터리의 `last_start_url`에 실제로 연 URL이 한 줄로 남는다.

이 앱 실행은 라이브 Express PID를 재시작하지 않는다. 맥 `tauri build --bundles dmg`를 이 절의 완료로 쓰지 않는다. 픽스처 창 스모크 여섯 줄은 맥 서버 실연결이 아니다.

## 스모크

격리 픽스처 origin만. 라이브 8787에 붙이지 않는다.

```bash
AETHER_DESKTOP_SMOKE=1 AETHER_DESKTOP_URL=http://127.0.0.1:<픽스처포트> cargo run
```

윈도 PC에서도 같은 명령을 그 PC의 루프백 픽스처에 대해 실행한다.

## 단축키

- 맥: `SUPER+SHIFT+A`
- 윈도: `CONTROL+SHIFT+A`

## 금지

- 앱 안에 DB 연결·로컬 모델·웹소켓·Rust HTTP 서버를 두지 않는다
- `web/dist`를 Tauri 번들에 복사해 넣기
- 라이브 Express를 이 앱 실행으로 재시작하기
