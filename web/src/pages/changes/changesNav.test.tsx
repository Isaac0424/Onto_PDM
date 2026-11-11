import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '../../App';
import { SessionProvider } from '../../session';
import { changeTestApi } from './testChange';

// 사이드바의 "변경" 메뉴와 /changes · /changes/:id 라우트(App.tsx · AppShell.tsx). 기본 API 는 비어 있어 연결 안내가 보인다.
function renderApp(path: string, api?: Parameters<typeof SessionProvider>[0]['api']) {
  return render(
    <SessionProvider {...(api ? { api } : {})}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('설계 변경 메뉴와 라우트', () => {
  it('사이드바에 "변경" 구역과 "설계 변경" 링크가 있다', async () => {
    renderApp('/changes');
    const nav = await screen.findByRole('navigation', { name: '변경' });
    expect(within(nav).getByRole('link', { name: '설계 변경' })).toHaveAttribute('href', '/changes');
  });

  it('/changes 는 머리 제목이 "설계 변경"이고, 읽어 올 곳이 없으면 가짜 변경 건 대신 연결 안내를 보인다', async () => {
    renderApp('/changes');
    expect(await screen.findByRole('heading', { level: 1, name: '설계 변경' })).toBeInTheDocument();
    expect(await screen.findByRole('status', { name: 'OPMS 연결 안내' })).toHaveTextContent('설계 변경 데이터를 읽어 올 곳이 없어요');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('/changes/:id 도 같은 메뉴 제목을 쓴다(상세 화면)', async () => {
    renderApp('/changes/CR-2026-0001', changeTestApi());
    expect(await screen.findByRole('heading', { level: 1, name: /CR-2026-0001/ })).toBeInTheDocument();
    const crumb = screen.getAllByText('설계 변경');
    expect(crumb.length).toBeGreaterThan(0);
  });
});
