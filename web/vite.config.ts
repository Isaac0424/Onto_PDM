import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  // ../assets/occt 를 /occt/ 로 서비스한다 (explode-studio 의 STEP·IGES 해석기)
  publicDir: fileURLToPath(new URL('../assets', import.meta.url)),
  resolve: {
    // 뷰어는 저장소 루트의 explode-studio 소스를 그대로 쓴다
    alias: { 'explode-studio': fileURLToPath(new URL('../src/index.js', import.meta.url)) },
    // ../src 가 import 하는 three 를 web/node_modules 에서 찾게 한다
    dedupe: ['three'],
  },
  server: {
    fs: { allow: [repoRoot] },
    // 올린 CAD 는 파일 서버(server/files-server.mjs)의 /api/cads(CAD 파일 DB)가 받고, /api/files 는 OPMS 와 공유하는 파일 보관소다.
    // /api/v1/pdm 은 PDM 백엔드(backend/, onto-pdm serve): OPMS 의 분류 · 부품을 읽기만 해서 준다
    proxy: {
      '/api/files': `http://127.0.0.1:${process.env.FILES_PORT ?? 8788}`,
      '/api/cads': `http://127.0.0.1:${process.env.FILES_PORT ?? 8788}`,
      '/api/v1/pdm': `http://127.0.0.1:${process.env.PDM_API_PORT ?? 8100}`,
    },
  },
  // 3D 뷰어(three.js + explode-studio, 약 770 kB)는 3D 탭을 열 때만 따로 받는 청크라 경고 한도를 올린다
  build: { chunkSizeWarningLimit: 800 },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],   // e2e/ 는 Playwright 가 돌린다
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: false,
    // 스튜디오 화면 시험은 형상 분석 + 렌더가 겹쳐 컴퓨터가 바쁠 때(여러 시험 파일 병렬) 5초(기본)를 넘길 수 있다
    testTimeout: 20_000,
  },
});
