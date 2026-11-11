import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetMemoryCadStore } from '../pages/studio/cadLibrary';

// jsdom에는 matchMedia가 없어 데스크톱 폭(모바일 질의 false)으로 대신한다 (OPMS 테스트와 같은 방식)
vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));

// 시험을 병렬로 돌리면 화면이 뜨는 데 1초(기본값)를 넘기기도 한다. 기다리는 한도를 늘린다 (조건이 이루어지면 바로 끝난다). 화면 시험이 늘어 4초 → 8초
configure({ asyncUtilTimeout: 8000 });

// 등록한 CAD 목록은 기본이 접힘이다. 시험은 카드를 바로 누르므로 펼친 채 시작한다 (접는 동작은 CadLibraryStrip.test.tsx 가 따로 본다)
beforeEach(() => { window.localStorage.setItem('onto-pdm.cad.lib-open', '1'); });

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetMemoryCadStore();                       // IndexedDB 가 없는 시험 환경의 메모리 보관함을 시험마다 비운다
  document.documentElement.dataset.sidebar = 'expanded';
  document.documentElement.dataset.drawer = 'closed';
});
