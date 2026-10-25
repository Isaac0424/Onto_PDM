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
  server: { fs: { allow: [repoRoot] } },
  // 3D 뷰어(three.js + explode-studio, 약 770 kB)는 3D 탭을 열 때만 따로 받는 청크라 경고 한도를 올린다
  build: { chunkSizeWarningLimit: 800 },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],   // e2e/ 는 Playwright 가 돌린다
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: false,
  },
});
