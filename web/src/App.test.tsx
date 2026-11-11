import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { SessionProvider } from './session';

// 가짜 데이터가 없다: SessionProvider 의 기본 API 는 비어 있는 구현이라, 데이터가 필요한 화면은 "OPMS 에 연결되면 표시돼요"라고 말한다.
function renderApp(path: string) {
  return render(
    <SessionProvider>
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

  it.each([
    ['/rules', '조립 규칙', '조립 규칙이 없어요'],
    ['/rules/SP-FAS-01', '조립 규칙', '조립 규칙이 없어요'],
    ['/mes', '작업 표준', '작업 표준을 만들 데이터가 없어요'],
    ['/products', '제품', '제품 데이터가 없어요'],
  ])('데이터를 읽어 올 곳이 없으면 %s 는 가짜 데이터 대신 연결 안내를 보인다 (오류가 아니다)', async (path, heading, title) => {
    renderApp(path);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    const note = await screen.findByRole('status', { name: 'OPMS 연결 안내' });
    expect(note).toHaveTextContent(title);
    expect(note).toHaveTextContent('연결되면');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(note.innerHTML).not.toMatch(/red|danger|#dc2626/i);                                  // 진짜 오류가 아니므로 빨강을 쓰지 않는다
  });

  it('제품 연결 그래프도 제품을 못 찾았다는 경고가 아니라 연결 안내를 보인다', async () => {
    renderApp('/products/HCR3A');
    expect(await screen.findByRole('status', { name: 'OPMS 연결 안내' })).toHaveTextContent('제품 연결 그래프를 그릴 데이터가 없어요');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('데모 데이터의 흔적이 화면에 없다 (온토전자 · HCR3A 제품 이름 · 가짜 품번)', async () => {
    renderApp('/products');
    await screen.findByRole('status', { name: 'OPMS 연결 안내' });
    expect(document.body.textContent).not.toMatch(/온토전자|협동로봇 3 kg|P-0000000010/);
  });
});
