import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../api/mock/mockApi';
import { SessionProvider } from '../../session';
import { csvCell, mesFileName, packageToCsv } from './exportMes';
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

const readBytes = (blob: Blob) => new Promise<Uint8Array>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
  r.onerror = () => reject(r.error);
  r.readAsArrayBuffer(blob);
});

// jsdom 에는 오브젝트 URL 이 없다. 내려받기가 만든 Blob 과 파일 이름을 붙잡는다.
const blobs: Blob[] = [];
const downloads: string[] = [];
let clickSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  blobs.length = 0; downloads.length = 0;
  Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return `blob:mes-${blobs.length}`; }, revokeObjectURL: () => {} });
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
});
afterEach(() => { clickSpy.mockRestore(); });

describe('MES 발행 화면', () => {
  it('요약 칩 · 제조 BOM 표 · 문서가 나온다', async () => {
    renderPage();
    const summary = await screen.findByRole('region', { name: '묶음 요약' });
    expect(within(summary).getByRole('group', { name: '요약' })).toHaveTextContent('BOM 18줄작업 단계 4문서 5건경고 1');
    expect(within(summary).getByText(/조립 규칙이 없는 작업 단계 1개: HCR3A 본체 조립/)).toBeInTheDocument();
    expect(within(summary).getByRole('link', { name: 'P-00000000100' })).toHaveAttribute('href', '/items/P-00000000100');

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

  it('발행하면 이력에 한 줄이 생기고, 같은 리비전을 다시 발행하면 안내한다', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: '묶음 요약' });
    expect(await screen.findByText('발행 이력이 없습니다.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'MES로 발행' }));
    expect(await screen.findByText(/HCR3A R01\(승인본\)을\(를\) MES로 발행했습니다 \(#1\)/)).toBeInTheDocument();
    const history = await screen.findByRole('table', { name: '발행 이력' });
    const row = within(history).getAllByRole('row')[1]!;
    expect(row).toHaveTextContent('#1');
    expect(row).toHaveTextContent('HCR3A');
    expect(row).toHaveTextContent('R01');
    expect(row).toHaveTextContent('승인본');
    expect(row).toHaveTextContent('발행됨');
    expect(row).toHaveTextContent('18');
    expect(row).toHaveTextContent('4');

    await user.click(screen.getByRole('button', { name: 'MES로 발행' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('이미 발행한 리비전입니다');
    expect(within(await screen.findByRole('table', { name: '발행 이력' })).getAllByRole('row')).toHaveLength(2);   // 이력은 그대로 한 줄
  });

  it('최신 기준에서는 승인 전 리비전 경고가 뜨고, 발행은 거절된다', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: '묶음 요약' });
    await user.click(screen.getByRole('button', { name: '최신' }));

    const warnings = await screen.findByRole('list', { name: '경고' });
    await waitFor(() => expect(warnings).toHaveTextContent('BOM 기준이 \'최신\'이라 작업중 · 검토중 리비전이 들어 있습니다'));
    expect(warnings).toHaveTextContent('J1 브레이크 (R00 작업중)');
    expect(screen.getByRole('group', { name: '요약' })).toHaveTextContent('BOM 19줄');

    await user.click(screen.getByRole('button', { name: 'MES로 발행' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('승인된 리비전만 MES로 발행할 수 있습니다');
    expect(screen.getByText('발행 이력이 없습니다.')).toBeInTheDocument();
  });

  it('제품을 바꾸면 그 제품의 묶음이 나온다', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: '묶음 요약' });
    await user.selectOptions(screen.getByRole('combobox', { name: '제품' }), 'HCR5A');
    await waitFor(() => expect(within(screen.getByRole('table', { name: '제조 BOM' })).getByRole('link', { name: 'P-00000000200' })).toBeInTheDocument());
    expect(screen.getByRole('region', { name: '묶음 요약' })).toHaveTextContent('HCR5A');
  });

  it('?product= 가 없으면 첫 제품, 없는 제품이면 오류 안내', async () => {
    const first = renderPage('/mes');
    expect(within(await screen.findByRole('region', { name: '묶음 요약' })).getByRole('link', { name: 'P-00000000100' })).toBeInTheDocument();
    first.unmount();

    renderPage('/mes?product=NOPE');
    expect(await screen.findByRole('alert')).toHaveTextContent('제품 NOPE을(를) 찾을 수 없습니다');
  });

  it('JSON 내려받기: 묶음 전체가 파일 이름 규칙대로 내려온다', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: '묶음 요약' });
    await user.click(screen.getByRole('button', { name: 'JSON 내려받기' }));

    expect(downloads).toEqual(['HCR3A_R01_mes.json']);
    const json = JSON.parse(await blobs[0]!.text());
    expect(json).toMatchObject({ productCode: 'HCR3A', revision: 'R01', rule: 'released', rootItemNo: 'P-00000000100' });
    expect(json.bom).toHaveLength(18);
    expect(json.steps).toHaveLength(4);
    expect(json.documents).toHaveLength(5);
  });

  it('CSV 내려받기: 엑셀에서 한글이 깨지지 않게 UTF-8 BOM 으로 시작하고, BOM 표 한 줄이 한 행이다', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: '묶음 요약' });
    await user.click(screen.getByRole('button', { name: 'CSV 내려받기' }));

    expect(downloads).toEqual(['HCR3A_R01_mes.csv']);
    const bytes = await readBytes(blobs[0]!);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);                              // UTF-8 BOM
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('﻿seq,level,item_no,name,quantity,total_quantity,step,rule_ids');
    expect(lines[1]).toBe('1,0,P-00000000100,HCR3A 본체,1,1,4,');
    expect(lines).toContain('7,2,P-00000000121,J1 감속기,1,1,2,SP-RED-01');
    expect(lines.filter(l => l.length > 0)).toHaveLength(19);                                // 머리 1 + 18줄
  });
});

describe('내려받기 도우미', () => {
  it('csvCell: 쉼표 · 따옴표 · 줄바꿈이 있으면 따옴표로 감싸고 안의 따옴표는 두 번 쓴다', () => {
    expect(csvCell('볼트')).toBe('볼트');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('두 줄\n입니다')).toBe('"두 줄\n입니다"');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(12)).toBe('12');
  });

  it('packageToCsv: 이름에 쉼표가 있어도 열이 밀리지 않고, 규칙은 세미콜론으로 잇는다', () => {
    const csv = packageToCsv({
      productCode: 'X', productName: 'X', rootItemNo: 'P-1', revision: 'R00', rule: 'released', generatedAt: '', steps: [], documents: [], warnings: [],
      bom: [{ seq: 1, level: 0, itemNo: 'P-1', name: '볼트, M3 "특수"', quantity: 2, totalQuantity: 2, ruleIds: ['A', 'B'] }],
    });
    expect(csv.split('\r\n')[1]).toBe('1,0,P-1,"볼트, M3 ""특수""",2,2,,A;B');
    expect(mesFileName({ productCode: 'X', revision: 'R00' }, 'csv')).toBe('X_R00_mes.csv');
  });
});
