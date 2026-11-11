import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../api/mock/mockApi';
import { SessionProvider } from '../session';
import { AppShell } from './AppShell';

function renderShell(session = { userId: 1, adminMode: true }) {
  window.localStorage.setItem('onto-pdm-session', JSON.stringify(session));
  const api = createMockApi(() => JSON.parse(window.localStorage.getItem('onto-pdm-session')!));
  return render(
    <SessionProvider api={api}>
      <MemoryRouter initialEntries={['/items']}>
        <AppShell><p>본문</p></AppShell>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('앱 셸 (OPMS 디자인)', () => {
  it('접기 버튼과 Ctrl+B 가 <html data-sidebar> 를 바꾸고 상태를 기억한다', async () => {
    const user = userEvent.setup();
    renderShell();
    const root = document.documentElement;
    expect(root.dataset.sidebar).toBe('expanded');

    await user.click(screen.getByRole('button', { name: '사이드바 접기' }));
    expect(root.dataset.sidebar).toBe('collapsed');
    expect(window.localStorage.getItem('onto-pdm.sidebar')).toBe('collapsed');
    expect(screen.getByRole('button', { name: '사이드바 펼치기' })).toHaveAttribute('aria-expanded', 'false');

    await user.keyboard('{Control>}b{/Control}');
    expect(root.dataset.sidebar).toBe('expanded');
  });

  it('관리자 모드를 켜야 관리자 메뉴가 보인다', async () => {
    const user = userEvent.setup();
    renderShell();
    expect(await screen.findByRole('link', { name: '등록 요청 검토' })).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /관리자 모드/ }));
    expect(screen.queryByRole('link', { name: '등록 요청 검토' })).not.toBeInTheDocument();
  });

  it('머리에 현재 화면 이름과 검색 상자가 있다', async () => {
    renderShell();
    expect(await screen.findByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: '품목 검색' })).toBeInTheDocument();
    expect(screen.getByText('본문')).toBeInTheDocument();
  });
});
