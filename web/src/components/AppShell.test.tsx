import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SessionProvider } from '../session';
import { AppShell } from './AppShell';

function renderShell() {
  return render(
    <SessionProvider>
      <MemoryRouter initialEntries={['/']}>
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

  it('사이드바에는 관리 메뉴(품목 · 등록 · BOM 가져오기 · 관리자)가 없고 조립 규칙 · 작업 표준이 있다', async () => {
    renderShell();
    expect(await screen.findByRole('link', { name: '조립 규칙' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '작업 표준' })).toBeInTheDocument();
    for (const name of ['품목', '내 등록 요청', 'BOM 가져오기', 'BOM 올리기', '등록 요청 검토', '분류 제안 검토', '그래프 발행 상태', 'MES 발행']) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    }
  });

  it('머리에 현재 화면 이름이 있고 품목 검색 상자는 없다', async () => {
    renderShell();
    expect(await screen.findByText('본문')).toBeInTheDocument();
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: '품목 검색' })).not.toBeInTheDocument();
  });

  it('프로필(사진 · 이름 · 역할), 사용자 전환, 관리자 모드, 데모 초기화가 없다', async () => {
    const { container } = renderShell();
    expect(await screen.findByText('본문')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();                       // 사용자 선택
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();                       // 관리자 모드 스위치
    expect(screen.queryByText('관리자 모드')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '데모 초기화' })).not.toBeInTheDocument();
    expect(container.querySelector('.sb-user')).toBeNull();
    expect(container.querySelector('img:not([width="28"])')).toBeNull();                  // 로고(28px) 말고 사진이 없다
    expect(container.textContent).not.toMatch(/김관리|이설계|엔지니어|승인자/);
  });
});
