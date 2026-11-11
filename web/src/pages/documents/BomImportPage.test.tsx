import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../api/mock/mockApi';
import type { BomSheetMatch, BomSheetRowInput } from '../../api/types';
import { SessionProvider } from '../../session';
import { BomImportPage } from './BomImportPage';

// 시트 읽기(A 작업)와 매칭은 따로 시험한다. 여기서는 화면이 결과를 어떻게 보이고 · 확정하고 · 등록 요청으로 보내는지를 본다.
const sheetMock = vi.hoisted(() => ({
  parse: vi.fn(),
}));

vi.mock('../../extract', () => ({
  parseBomSheet: (text: string) => sheetMock.parse(text),
  extractCadAttributes: () => [],
  extractSpecAttributes: () => [],
}));

const SHEET = {
  rows: [
    { line: 1, itemNo: 'P-00000000001', name: '볼트 M3x8', quantity: 12, findNo: 1 },
    { line: 2, itemNo: 'LEG-0099', name: '볼트 M4x10', quantity: 2, findNo: 2 },
    { line: 3, name: '방열판 20x20', quantity: 2, findNo: 3 },
    { line: 4, itemNo: 'SUP-77', name: '스티커', quantity: 0 },
  ],
  columns: { itemNo: 0, name: 1, quantity: 2, findNo: 3 },
  warnings: ['4번째 줄: 수량이 0 이하입니다'],
};

function fakeMatches(rows: BomSheetRowInput[]): BomSheetMatch[] {
  return rows.map(r => {
    if (r.line === 1) return { line: 1, status: 'matched', itemNo: 'P-00000000001', itemName: '볼트 M3x8', reason: '품번이 정확히 같습니다' };
    if (r.line === 2) return { line: 2, status: 'suggested', itemNo: 'P-00000000002', itemName: '볼트 M4×10', reason: '이름이 비슷합니다 (품번 LEG-0099 는 없음)' };
    return { line: r.line, status: 'none', reason: '보유 품번이 없습니다' };
  });
}

function renderPage() {
  window.localStorage.setItem('onto-pdm-session', JSON.stringify({ userId: 2, adminMode: false }));
  const api = createMockApi(() => JSON.parse(window.localStorage.getItem('onto-pdm-session')!));
  api.matchBomSheet = async rows => fakeMatches(rows);
  render(
    <SessionProvider api={api}>
      <MemoryRouter><BomImportPage /></MemoryRouter>
    </SessionProvider>,
  );
  return api;
}

async function paste(user: ReturnType<typeof userEvent.setup>, body = '품번,품명,수량,도면번호\n...') {
  await user.click(screen.getByLabelText('BOM 본문 붙여넣기'));
  await user.paste(body);
  await user.click(screen.getByRole('button', { name: '읽기' }));
}

beforeEach(() => { sheetMock.parse.mockReset(); sheetMock.parse.mockImplementation(() => SHEET); });

describe('BOM 가져오기', () => {
  it('붙여넣은 시트를 읽어 감지한 열 · 줄별 상태 · 매칭 품번 · 사유를 미리보기로 보인다', async () => {
    const user = userEvent.setup();
    renderPage();
    await paste(user);

    const result = await screen.findByRole('region', { name: '가져오기 결과' });
    await waitFor(() => expect(within(result).queryByText('매칭 중…')).not.toBeInTheDocument());
    const cols = within(result).getByRole('group', { name: '감지한 열' });
    expect(cols).toHaveTextContent('품번 · 1열');
    expect(cols).toHaveTextContent('도면 번호 · 4열');
    expect(within(result).getByRole('group', { name: '매칭 요약' })).toHaveTextContent('보유 1후보 1미보유 2');

    const table = within(result).getByRole('table', { name: 'BOM 시트 미리보기' });
    const row1 = within(table).getByText('볼트 M3x8', { selector: 'td' }).closest('tr')!;
    expect(within(row1).getByText('보유')).toBeInTheDocument();
    expect(within(row1).getByRole('link', { name: 'P-00000000001' })).toHaveAttribute('href', '/items/P-00000000001');
    expect(within(row1).getByText('품번이 정확히 같습니다')).toBeInTheDocument();
    const row2 = within(table).getByText('볼트 M4x10', { selector: 'td' }).closest('tr')!;
    expect(within(row2).getByText('후보')).toBeInTheDocument();
    expect(within(row2).getByText('이름이 비슷합니다 (품번 LEG-0099 는 없음)')).toBeInTheDocument();
    expect(within(result).getByRole('list', { name: '읽으며 확인할 것' })).toHaveTextContent('4번째 줄: 수량이 0 이하입니다');
    expect(within(table).getByText('수량 확인')).toBeInTheDocument();                              // 수량 0 은 표시한다
  });

  it('파일을 올리면 이름을 보이고 같은 방식으로 읽는다 (서버로 보내지 않는다)', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderPage();
    await user.upload(screen.getByLabelText('BOM 시트 파일'), new File(['품번,품명,수량\nP-1,볼트,1'], '제어박스_BOM.csv', { type: 'text/csv' }));

    const result = await screen.findByRole('region', { name: '가져오기 결과' });
    expect(result).toHaveTextContent('4줄 · 제어박스_BOM.csv');
    expect(sheetMock.parse).toHaveBeenCalledWith('품번,품명,수량\nP-1,볼트,1');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('후보는 사람이 "이 품번으로 확정"해야 보유로 바뀐다', async () => {
    const user = userEvent.setup();
    renderPage();
    await paste(user);
    const result = await screen.findByRole('region', { name: '가져오기 결과' });
    await user.click(await within(result).findByRole('button', { name: '줄 2 이 품번으로 확정' }));

    expect(within(result).getByRole('group', { name: '매칭 요약' })).toHaveTextContent('보유 2후보 0미보유 2');
    expect(within(result).queryByRole('button', { name: '줄 2 이 품번으로 확정' })).not.toBeInTheDocument();
    expect(within(result).getByRole('link', { name: 'P-00000000002' })).toBeInTheDocument();
  });

  it('미보유 줄을 OPMS 등록 요청으로 보낸다: 한 줄씩, 그리고 남은 것을 한꺼번에', async () => {
    const user = userEvent.setup();
    const api = renderPage();
    await paste(user);
    const result = await screen.findByRole('region', { name: '가져오기 결과' });

    await user.click(await within(result).findByRole('button', { name: '줄 3 OPMS에 등록 요청' }));
    expect(await within(result).findByText(/요청됨 #\d+/)).toBeInTheDocument();
    const first = (await api.listPartRequests('mine')).find(r => r.payload.name === '방열판 20x20')!;
    expect(first).toMatchObject({ status: 'submitted', sourceSystem: 'PDM' });
    expect(first.payload.note).toBe('BOM 시트 · 줄 3');
    expect(within(result).queryByRole('button', { name: '줄 3 OPMS에 등록 요청' })).not.toBeInTheDocument();    // 다시 보내지 않는다

    await user.click(within(result).getByRole('button', { name: /OPMS 등록 요청 1/ }));
    expect(await screen.findByText(/1줄을 OPMS 등록 요청으로 보냈습니다/)).toBeInTheDocument();
    const second = (await api.listPartRequests('mine')).find(r => r.payload.name === '스티커')!;
    expect(second.payload.aliases).toEqual([{ scheme: 'legacy', value: 'SUP-77' }]);                         // 시트의 품번은 레거시 별칭으로 남긴다
    expect(within(result).getByRole('button', { name: /OPMS 등록 요청/ })).toBeDisabled();
  });

  it('내용이 비었거나 열을 못 찾으면 이유를 알려 준다', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: '읽기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('내용이 비어 있어요');
    expect(sheetMock.parse).not.toHaveBeenCalled();

    sheetMock.parse.mockImplementation(() => ({ rows: [], columns: {}, warnings: [] }));
    await paste(user, '아무 글');
    expect(await screen.findByRole('alert')).toHaveTextContent('머리줄에서 품번 · 이름 · 수량 열을 찾지 못했어요');
    expect(screen.queryByRole('region', { name: '가져오기 결과' })).not.toBeInTheDocument();
  });

  it('열은 감지했는데 읽을 수 있는 줄이 없으면 머리줄과 수량을 확인하라고 알려 준다', async () => {
    const user = userEvent.setup();
    sheetMock.parse.mockImplementation(() => ({ rows: [], columns: { name: 0 }, warnings: [] }));
    renderPage();
    await paste(user, '품명\n볼트');
    expect(await screen.findByRole('alert')).toHaveTextContent('수량 칸이 숫자인지 확인해 주세요');
  });

  it('찾지 못한 열을 알린다', async () => {
    const user = userEvent.setup();
    sheetMock.parse.mockImplementation(() => ({ rows: [{ line: 1, name: '볼트', quantity: 1 }], columns: { name: 0, quantity: 1 }, warnings: [] }));
    renderPage();
    await paste(user);
    expect(await screen.findByText('찾지 못한 열: 품번')).toBeInTheDocument();
  });

  it('예시를 불러오면 바로 읽는다', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: '예시 불러오기' }));
    expect(await screen.findByRole('region', { name: '가져오기 결과' })).toHaveTextContent('예시.csv');
    expect(sheetMock.parse.mock.calls[0]![0]).toContain('P-00000000001');
  });
});
