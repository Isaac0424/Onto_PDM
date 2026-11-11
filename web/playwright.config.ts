import { defineConfig } from '@playwright/test';

// 실제 브라우저로 화면 전체를 확인한다 (pnpm e2e).
// Windows 는 설치된 Edge 를 쓰고, 그 밖의 OS 는 `pnpm exec playwright install chromium` 으로 받은 Chromium 을 쓴다.
const PORT = Number(process.env.E2E_PORT ?? 5174);   // 여러 작업이 동시에 돌릴 때 서로 다른 포트를 쓰게 한다
// 개발 서버를 둘 띄운다: 기본은 읽어 올 곳이 없는 모드(empty), HTTP_PORT 는 PDM 백엔드(→ OPMS)를 읽는 모드(http).
// http 모드 시험(opms-connection.spec.ts)은 백엔드 호출을 가짜로 가로채서, 실제 백엔드 · OPMS DB 에 의존하지 않는다.
export const HTTP_PORT = PORT + 1;

const vite = (port: number, mode: 'empty' | 'http') => ({
  command: `node node_modules/vite/bin/vite.js --port ${port} --strictPort`,
  url: `http://localhost:${port}/`,
  reuseExistingServer: !process.env.CI,
  timeout: 60_000,
  env: { VITE_API_MODE: mode },
});

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
  webServer: [vite(PORT, 'empty'), vite(HTTP_PORT, 'http')],
});
