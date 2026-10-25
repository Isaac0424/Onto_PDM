import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  it('품목 목록과 별칭 검색', async () => {
    renderApp('/items?q=BLT-0038');
    const table = await screen.findByRole('table', { name: '품목 목록' });
    expect(within(table).getByText('P0000001')).toBeInTheDocument();
    expect(within(table).queryByText('P0000002')).not.toBeInTheDocument();
  });

  it('엔지니어에게는 관리자 메뉴가 없고, 관리자 화면은 막힌다', async () => {
    renderApp('/admin/requests', { userId: 2, adminMode: true });
    expect(await screen.findByText(/관리자 모드에서만 볼 수 있습니다/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '등록 요청 검토' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /관리자 모드/ })).toBeDisabled();
  });

  it('품목 상세의 BOM 트리와 총수량', async () => {
    const user = userEvent.setup();
    renderApp('/items/P0000100?tab=bom');
    const bom = await screen.findByRole('table', { name: 'BOM' });
    expect(within(bom).getAllByText('P0000001').length).toBe(2);       // J1 · J2 모듈 아래 볼트
    await user.click(screen.getByRole('button', { name: '모두 접기' }));
    expect(within(bom).queryByText('P0000001')).not.toBeInTheDocument();
  });

  it('새 등록 요청: 임시저장 → 제출', async () => {
    const user = userEvent.setup();
    const { unmount } = renderApp('/requests/new', { userId: 2, adminMode: false });
    await user.type(await screen.findByLabelText(/이름 \(원래 이름\)/), 'Spacer 3mm');
    await user.selectOptions(screen.getByLabelText(/^분류/), 'cls:C0100');
    await user.click(screen.getByRole('button', { name: '임시저장' }));
    expect(await screen.findByText(/임시저장했습니다/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '제출' }));
    expect(await screen.findByText(/관리자 모드에서 검토 중입니다/)).toBeInTheDocument();
    unmount();
  });
});
