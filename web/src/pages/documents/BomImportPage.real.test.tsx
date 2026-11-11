import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../api/mock/mockApi';
import { SessionProvider } from '../../session';
import { BomImportPage } from './BomImportPage';

// 가짜 없이: 실제 시트 읽기(extract)와 실제 목 매칭을 지나 화면까지 이어지는지 본다.
function renderPage() {
  window.localStorage.setItem('onto-pdm-session', JSON.stringify({ userId: 2, adminMode: false }));
  const api = createMockApi(() => JSON.parse(window.localStorage.getItem('onto-pdm-session')!));
  render(
    <SessionProvider api={api}>
      <MemoryRouter><BomImportPage /></MemoryRouter>
    </SessionProvider>,
  );
  return api;
}

describe('BOM 가져오기 (실제 읽기 · 매칭)', () => {
  it('예시 시트: 품번이 맞으면 보유, 이름만 맞으면 후보, 없으면 미보유로 나오고 등록 요청까지 간다', async () => {
    const user = userEvent.setup();
    const api = renderPage();
    await user.click(screen.getByRole('button', { name: '예시 불러오기' }));

    const result = await screen.findByRole('region', { name: '가져오기 결과' });
    await waitFor(() => expect(within(result).queryByText('매칭 중…')).not.toBeInTheDocument());
    expect(within(result).getByRole('group', { name: '감지한 열' })).toHaveTextContent('품번 · 1열');
    expect(within(result).getByRole('group', { name: '매칭 요약' })).toHaveTextContent('보유 2후보 1미보유 1');

    const table = within(result).getByRole('table', { name: 'BOM 시트 미리보기' });
    const bolt = within(table).getByText('볼트 M3x8', { selector: 'td' }).closest('tr')!;
    expect(within(bolt).getByRole('link', { name: 'P-00000000001' })).toBeInTheDocument();
    const button = within(table).getByText('전원 버튼', { selector: 'td' }).closest('tr')!;
    expect(within(button).getByText('후보')).toBeInTheDocument();                                   // 이름만 맞아 사람이 확정한다

    await user.click(within(result).getByRole('button', { name: /OPMS 등록 요청 1/ }));
    await screen.findByText(/1줄을 OPMS 등록 요청으로 보냈습니다/);
    const sent = (await api.listPartRequests('mine')).find(r => r.payload.name === '방열판 20x20')!;
    expect(sent.payload.aliases).toEqual([{ scheme: 'legacy', value: 'SUP-X-100' }]);
  });

  it('머리줄이 없는 글은 열을 못 찾았다고 알려 준다', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByLabelText('BOM 본문 붙여넣기'));
    await user.paste('그냥 글입니다');
    await user.click(screen.getByRole('button', { name: '읽기' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '가져오기 결과' })).not.toBeInTheDocument();
  });
});
