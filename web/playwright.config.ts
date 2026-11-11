import { defineConfig } from '@playwright/test';

// 실제 브라우저로 화면 전체를 확인한다 (pnpm e2e).
// Windows 는 설치된 Edge 를 쓰고, 그 밖의 OS 는 `pnpm exec playwright install chromium` 으로 받은 Chromium 을 쓴다.
const PORT = Number(process.env.E2E_PORT ?? 5174);   // 여러 작업이 동시에 돌릴 때 서로 다른 포트를 쓰게 한다

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },   // 컴퓨터가 바쁠 때(여러 작업 · DB 컨테이너) 화면이 늦게 떠도 흔들리지 않게 기본 5초에서 늘렸다
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/items`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
