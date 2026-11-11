import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { createMockApi } from '../../api/mock/mockApi';
import { SessionProvider } from '../../session';
import { MesPage } from './MesPage';

function renderPage(path = '/mes?product=HCR3A', session = { userId: 1, adminMode: true }) {
  window.localStorage.setItem('onto-pdm-session', JSON.stringify(session));
  const api = createMockApi(() => JSON.parse(window.localStorage.getItem('onto-pdm-session')!));
  return {
    api,
    ...render(
      <SessionProvider api={api}>
        <MemoryRouter initialEntries={[path]}><MesPage /></MemoryRouter>
      </SessionProvider>,
    ),
  };
}

describe('작업 표준 화면', () => {
  it('요약 칩 · 제조 BOM 표 · 문서가 나온다', async () => {
    renderPage();
    const summary = await screen.findByRole('region', { name: '묶음 요약' });
    expect(within(summary).getByRole('group', { name: '요약' })).toHaveTextContent('BOM 18줄작업 단계 4문서 5건경고 1');
    expect(within(summary).getByText(/조립 규칙이 없는 작업 단계 1개: HCR3A 본체 조립/)).toBeInTheDocument();
    expect(within(summary).getByText('P-00000000100')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /MES로 발행|내려받기/ })).not.toBeInTheDocument();      // 발행 · 내보내기는 삭제됨
    expect(screen.queryByRole('region', { name: '발행 이력' })).not.toBeInTheDocument();

    const bom = screen.getByRole('table', { name: '제조 BOM' });
    expect(within(bom).getAllByRole('row')).toHaveLength(19);                                // 머리 1 + 18줄
    const bolts = within(bom).getAllByRole('row').filter(r => within(r).queryByText('볼트 M3x8'));
    expect(bolts).toHaveLength(2);                                                            // J1 · J2 에 한 줄씩
    expect(within(bolts[0]!).getByRole('link', { name: 'SP-FAS-01' })).toHaveAttribute('href', '/rules/SP-FAS-01');

    const docs = screen.getByRole('table', { name: '문서' });
    expect(within(docs).getByText('D-SPEC-HCR')).toBeInTheDocument();
    expect(within(docs).getAllByText('3D CAD')).toHaveLength(2);                              // D-CAD-0100 · D-CAD-0120
  });

  it('작업 단계는 하위 조립품부터이고, 누르면 주의사항 · 공구가 펼쳐진다', async () => {
    const user = userEvent.setup();
    renderPage();
    const steps = await screen.findByRole('region', { name: '작업 단계' });
    const heads = within(steps).getAllByRole('button').map(b => b.textContent);
    expect(heads[0]).toContain('베이스 조립품 조립');
    expect(heads[1]).toContain('J1 관절 모듈 조립');
    expect(heads[3]).toContain('HCR3A 본체 조립');
    // 첫 단계는 펼쳐져 있다
    expect(within(steps).getByRole('button', { name: /베이스 조립품 조립/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(steps).queryByRole('list', { name: '단계 2 주의사항' })).not.toBeInTheDocument();

    await user.click(within(steps).getByRole('button', { name: /J1 관절 모듈 조립/ }));
    const cautions = within(steps).getByRole('list', { name: '단계 2 주의사항' });
    expect(cautions).toHaveTextContent('입력축 방향이 반대면 조립 후 분해해야 합니다.');
    const j1 = within(steps).getByRole('button', { name: /J1 관절 모듈 조립/ }).closest('li')!;
    expect(within(j1 as HTMLElement).getByText(/^토크 렌치 · 그리스 도포기/)).toBeInTheDocument();                // 공구 줄 (주의사항에도 '토크 드라이버'가 나와서 줄 앞부분으로 고른다)
    expect(within(steps).getByText('0.6 N·m ±10%')).toBeInTheDocument();                      // 규칙에서 뽑은 값
    await user.click(within(steps).getByRole('button', { name: /J1 관절 모듈 조립/ }));
    expect(within(steps).queryByRole('list', { name: '단계 2 주의사항' })).not.toBeInTheDocument();
  });

  it('최신 기준에서는 승인 전 리비전 경고가 뜬다', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: '묶음 요약' });
    await user.click(screen.getByRole('button', { name: '최신' }));

    const warnings = await screen.findByRole('list', { name: '경고' });
    await waitFor(() => expect(warnings).toHaveTextContent('BOM 기준이 \'최신\'이라 작업중 · 검토중 리비전이 들어 있습니다'));
    expect(warnings).toHaveTextContent('J1 브레이크 (R00 작업중)');
    expect(screen.getByRole('group', { name: '요약' })).toHaveTextContent('BOM 19줄');

  });

  it('제품을 바꾸면 그 제품의 묶음이 나온다', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: '묶음 요약' });
    await user.selectOptions(screen.getByRole('combobox', { name: '제품' }), 'HCR5A');
    await waitFor(() => expect(within(screen.getByRole('table', { name: '제조 BOM' })).getByText('P-00000000200')).toBeInTheDocument());
    expect(screen.getByRole('region', { name: '묶음 요약' })).toHaveTextContent('HCR5A');
  });

  it('?product= 가 없으면 첫 제품, 없는 제품이면 오류 안내', async () => {
    const first = renderPage('/mes');
    expect(within(await screen.findByRole('region', { name: '묶음 요약' })).getByText('P-00000000100')).toBeInTheDocument();
    first.unmount();

    renderPage('/mes?product=NOPE');
    expect(await screen.findByRole('alert')).toHaveTextContent('제품 NOPE을(를) 찾을 수 없습니다');
  });

});
