import { currentRelease } from '../server/observability/release'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import { computeWebSourceHash, type WebBuildInfo } from '../server/observability/webBuildHash'
import { AGENT_EVENT_CONTRACT_VERSION } from '../shared/agentEvent'

const sourceHash = computeWebSourceHash(fileURLToPath(new URL('..', import.meta.url)))

// 빌드 결과 옆에 build-info.json을 남긴다. 서버는 켜질 때 화면이 서버와 맞는지 보고, 멈춘 화면은 최신 빌드인지 비교한다.
function buildInfoPlugin(): Plugin {
  let outDir = ''
  return {
    name: 'aether-build-info',
    apply: 'build',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir) },
    // closeBundle은 빌드가 실패해도 돌아 옛 화면 위에 새 build-info를 쓴다. 파일을 다 쓴 성공 때만 쓴다.
    writeBundle() {
      const info: WebBuildInfo = { contractVersion: AGENT_EVENT_CONTRACT_VERSION, sourceHash, builtAt: new Date().toISOString() }
      fs.writeFileSync(path.join(outDir, 'build-info.json'), JSON.stringify(info))
    },
  }
}

// dev: Vite(:5173)에서 백엔드로 /api 프록시(SSE 포함). 기본은 운영(:8787)이고, 시험은 AETHER_DEV_API로 시험 서버를 가리킨다(scripts/dev-sandbox.sh).
// 빌드 결과는 백엔드가 static으로 서빙.
export default defineConfig({
  define: { __AETHER_RELEASE__: JSON.stringify(currentRelease), __AETHER_SOURCE_HASH__: JSON.stringify(sourceHash) },
  plugins: [react(), tailwindcss(), buildInfoPlugin()],
  // Phase 8b 작업 항목: web→shared 경로 계약(`@shared`). 실제 렌더러 소비는 8c에서 시작한다.
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  // 작은 글꼴을 base64로 CSS에 박지 않고 파일로 둔다(CSS 크기 절반 감소).
  build: { assetsInlineLimit: 0 },
  server: {
    proxy: {
      '/api': { target: process.env.AETHER_DEV_API ?? 'http://localhost:8787', changeOrigin: true },
    },
  },
})
