import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom에는 matchMedia가 없어 데스크톱 폭(모바일 질의 false)으로 대신한다 (OPMS 테스트와 같은 방식)
vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));

// 시험을 병렬로 돌리면 화면이 뜨는 데 1초(기본값)를 넘기기도 한다. 기다리는 한도를 늘린다 (조건이 이루어지면 바로 끝난다)
configure({ asyncUtilTimeout: 4000 });

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.dataset.sidebar = 'expanded';
  document.documentElement.dataset.drawer = 'closed';
});
