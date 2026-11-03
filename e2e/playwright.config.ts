// 웹 화면을 실제 브라우저로 누르는 시험.
// 서버는 라이브(8787)와 다른 8790에서, 이 폴더의 진입점이 띄운다.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:8790',
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
    locale: 'ko-KR',
  },
  webServer: {
    command: 'bash start-server.sh',
    url: 'http://127.0.0.1:8790/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
})
