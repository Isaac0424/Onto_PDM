import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { createMockApi } from './api/mock/mockApi';
import { App } from './App';
import { SessionProvider } from './session';

function renderApp(path: string, session = { userId: 1, adminMode: true }) {
  window.localStorage.setItem('onto-pdm-session', JSON.stringify(session));
  const api = createMockApi(() => JSON.parse(window.localStorage.getItem('onto-pdm-session')!));
  return render(
    <SessionProvider api={api}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('화면', () => {
  // 관리 기능(품목 관리 · BOM 가져오기 · 등록 요청 · 관리자 화면)은 사용자 지시로 삭제했다
  it.each(['/items', '/items/P-00000000001', '/requests', '/requests/new', '/bom-import', '/admin/requests', '/admin/proposals', '/admin/publish'])(
    '삭제된 관리 화면 %s 는 열리지 않는다',
    async path => {
      renderApp(path);
      expect(await screen.findByText(/없는 화면입니다/)).toBeInTheDocument();
    },
  );

  it('남은 화면: 조립 규칙과 작업 표준이 열린다', async () => {
    const { unmount } = renderApp('/rules');
    expect(await screen.findByRole('heading', { name: '조립 규칙' })).toBeInTheDocument();
    unmount();
    renderApp('/mes');
    expect(await screen.findByRole('heading', { name: '작업 표준' })).toBeInTheDocument();
  });
});
