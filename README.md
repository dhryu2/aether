# Aether

채팅으로 다루는 AI 에이전트.

Aether는 내 컴퓨터에 설치해 쓰는 앱입니다. 터미널 대신 채팅 화면에서 AI 에이전트에게 작업을 맡기고, AI가 읽은 파일과 실행한 명령을 카드로 확인하고, 질문과 승인 요청에 답합니다. 회원가입이 필요 없고 대화 기록은 내 컴퓨터에 저장됩니다.

## 지원하는 AI 도구

Aether에는 AI 도구가 포함되어 있지 않습니다. 아래 중 쓸 도구를 먼저 설치하고 로그인하세요. 각 서비스의 이용 약관은 사용자가 직접 확인해야 합니다.

- Claude Code
- Codex
- Grok
- Ollama

## 소스에서 실행하기

Node.js 24가 필요합니다.

```bash
npm --prefix web ci --include=dev
npm --prefix web run build
npm --prefix server ci --include=dev
npm --prefix server start
```

브라우저에서 <http://127.0.0.1:8787>을 엽니다. 설정은 [`server/.env.example`](./server/.env.example)을 `server/.env`로 복사해 고칩니다.

## 접속 범위와 보안

- **기본값:** 설치한 컴퓨터에서만 접속되고, 로그인 절차는 꺼져 있습니다.
- **다른 기기에서 쓸 때:** 인터넷에 직접 열지 말고 Tailscale 같은 VPN을 쓰고, `server/.env`의 `AETHER_AUTH_MODE`로 인증을 켜세요. 인증 설정은 [`server/.env.example`](./server/.env.example)을 보세요.
- **주의:** AI 에이전트는 이 컴퓨터에서 파일을 고치고 명령을 실행할 수 있습니다. 승인 설정을 확인하고 쓰세요.

## 시험

```bash
npm --prefix server test
```

## 라이선스

코드는 [Apache License 2.0](./LICENSE)으로 제공합니다. 함께 들어 있는 외부 저작물은 [`NOTICE`](./NOTICE)에 적었습니다.

마스코트 참딩과 Aether의 이름, 로고는 이 라이선스에 포함되지 않습니다. 수정한 버전을 배포하려면 해당 파일을 바꾸고 다른 이름을 써야 합니다. 자세한 내용은 [`BRAND.md`](./BRAND.md)를 보세요.

## English

Aether is a self-hosted chat interface for AI coding agents (Claude Code, Codex, Grok, Ollama). It runs on your own machine and stores conversations locally. Install and sign in to the agent tools you want to use, then follow the commands above.

Code is licensed under Apache 2.0; third-party notices are in [NOTICE](./NOTICE). The Chamding mascot and the Aether name and logos are not covered; see [BRAND.md](./BRAND.md).
