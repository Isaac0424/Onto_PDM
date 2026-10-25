import { defineConfig } from '@playwright/test';

// 실제 브라우저로 화면 전체를 확인한다 (pnpm e2e).
// Windows 는 설치된 Edge 를 쓰고, 그 밖의 OS 는 `pnpm exec playwright install chromium` 으로 받은 Chromium 을 쓴다.
const PORT = 5174;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
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
