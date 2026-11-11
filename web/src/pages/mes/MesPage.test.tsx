import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyApi } from '../../api/emptyApi';
import { ApiError, type BomRule, type MesPackage, type PdmApi, type Product } from '../../api/types';
import { SessionProvider } from '../../session';
import { MesPage } from './MesPage';

// 시험 안에서만 쓰는 제품 · 작업 표준 묶음 (제품에는 가짜 데이터가 없다: 기본 API 는 비어 있다). API 가 돌려주는 모양(MesPackage)을 그대로 따른다.
const PRODUCTS: Product[] = [
  { id: 1, code: 'T-100', name: '시험 제품 A', rootItemNo: 'P-T0000000100' },
  { id: 2, code: 'T-200', name: '시험 제품 B', rootItemNo: 'P-T0000000200' },
];

const packageOf = (product: Product, rule: BomRule): MesPackage => ({
  productCode: product.code, productName: product.name, rootItemNo: product.rootItemNo, revision: 'R01', rule, generatedAt: '2026-11-01T09:00:00+09:00',
  bom: [
    { seq: 1, level: 0, itemNo: product.rootItemNo, name: `${product.name} 본체`, quantity: 1, totalQuantity: 1, step: 3, ruleIds: [] },
    { seq: 2, level: 1, itemNo: 'P-T0000000110', name: '관절 모듈', quantity: 1, totalQuantity: 1, step: 2, ruleIds: [] },
    { seq: 3, level: 2, itemNo: 'P-T0000000001', name: '테스트 볼트 M3', quantity: 12, totalQuantity: 12, ruleIds: ['SP-FAS-01'] },
    { seq: 4, level: 1, itemNo: 'P-T0000000140', name: '케이블', quantity: 1, totalQuantity: 1, ruleIds: [] },
    ...(rule === 'latest' ? [{ seq: 5, level: 1, itemNo: 'P-T0000000150', name: '브레이크', quantity: 1, totalQuantity: 1, ruleIds: [] }] : []),
  ],
  steps: [
    { step: 1, title: '관절 모듈 조립', operationLabel: '체결', parts: [{ itemNo: 'P-T0000000001', name: '테스트 볼트 M3', quantity: 12 }], ruleIds: ['SP-FAS-01'],
      params: [{ label: '체결 토크', value: '0.6 N·m ±10%' }], cautions: ['입력축 방향이 반대면 조립 후 분해해야 합니다.'], tools: ['토크 렌치', '그리스 도포기'] },
    { step: 2, title: `${product.name} 본체 조립`, parts: [{ itemNo: 'P-T0000000110', name: '관절 모듈', quantity: 1 }], ruleIds: [], params: [], cautions: [], tools: [] },
  ],
  documents: [{ docNo: 'D-SPEC-T1', title: '시험 사양서', docType: 'spec', rev: 'R02' }, { docNo: 'D-CAD-T1', title: '시험 3D', docType: 'cad_3d', rev: 'R01' }],
  warnings: rule === 'latest' ? ['BOM 기준이 \'최신\'이라 작업중 · 검토중 리비전이 들어 있습니다: 브레이크 (R00 작업중)'] : ['조립 규칙이 없는 작업 단계 1개: 시험 제품 본체 조립'],
});

const build = vi.fn(async (code: string, rule: BomRule) => {
  const p = PRODUCTS.find(x => x.code === code);
  if (!p) throw new ApiError(`제품 ${code}을(를) 찾을 수 없습니다`, 404);
  return packageOf(p, rule);
});

const withData = (): PdmApi => ({ ...createEmptyApi(), connected: true, listProducts: async () => PRODUCTS, buildMesPackage: build });

function renderPage(path = '/mes?product=T-100', api: PdmApi = withData()) {
  return render(
    <SessionProvider api={api}>
      <MemoryRouter initialEntries={[path]}><MesPage /></MemoryRouter>
    </SessionProvider>,
  );
}

describe('작업 표준 화면: 데이터를 읽어 올 곳이 없을 때', () => {
  it('가짜 제품 · BOM 대신 OPMS 연결 안내를 보이고, 제품 선택과 BOM 기준 스위치는 그리지 않는다', async () => {
    renderPage('/mes', createEmptyApi());
    expect(screen.getByRole('heading', { level: 1, name: '작업 표준' })).toBeInTheDocument();
    const note = await screen.findByRole('status', { name: 'OPMS 연결 안내' });
    expect(note).toHaveTextContent('작업 표준을 만들 데이터가 없어요');
    expect(note).toHaveTextContent('PDM 백엔드에 연결되면 작업표준서');
    expect(screen.queryByRole('combobox', { name: '제품' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'BOM 기준' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: '제조 BOM' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('연결돼 있는데 제품이 하나도 없으면 안내가 아니라 "제품이 없습니다"이다', async () => {
    renderPage('/mes', { ...withData(), listProducts: async () => [] });
    expect(await screen.findByText('제품이 없습니다.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'OPMS 연결 안내' })).not.toBeInTheDocument();
  });
});

describe('작업 표준 화면', () => {
  it('요약 칩 · 제조 BOM 표 · 문서가 나온다', async () => {
    renderPage();
    const summary = await screen.findByRole('region', { name: '묶음 요약' });
    expect(within(summary).getByRole('group', { name: '요약' })).toHaveTextContent('BOM 4줄작업 단계 2문서 2건경고 1');
    expect(within(summary).getByText(/조립 규칙이 없는 작업 단계 1개: 시험 제품 본체 조립/)).toBeInTheDocument();
    expect(within(summary).getByText('P-T0000000100')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /MES로 발행|내려받기/ })).not.toBeInTheDocument();      // 발행 · 내보내기는 삭제됨
    expect(screen.queryByRole('region', { name: '발행 이력' })).not.toBeInTheDocument();

    const bom = screen.getByRole('table', { name: '제조 BOM' });
    expect(within(bom).getAllByRole('row')).toHaveLength(5);                                // 머리 1 + 4줄
    const bolt = within(bom).getAllByRole('row').find(r => within(r).queryByText('테스트 볼트 M3'))!;
    expect(within(bolt).getByRole('link', { name: 'SP-FAS-01' })).toHaveAttribute('href', '/rules/SP-FAS-01');

    const docs = screen.getByRole('table', { name: '문서' });
    expect(within(docs).getByText('D-SPEC-T1')).toBeInTheDocument();
    expect(within(docs).getByText('3D CAD')).toBeInTheDocument();
  });

  it('작업 단계는 첫 단계가 펼쳐져 있고, 누르면 주의사항 · 공구가 펼쳐진다', async () => {
    const user = userEvent.setup();
    renderPage();
    const steps = await screen.findByRole('region', { name: '작업 단계' });
    const heads = within(steps).getAllByRole('button').map(b => b.textContent);
    expect(heads[0]).toContain('관절 모듈 조립');
    expect(heads[1]).toContain('시험 제품 A 본체 조립');
    // 첫 단계는 펼쳐져 있다
    expect(within(steps).getByRole('button', { name: /관절 모듈 조립/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(steps).getByRole('list', { name: '단계 1 주의사항' })).toHaveTextContent('입력축 방향이 반대면 조립 후 분해해야 합니다.');
    expect(within(steps).getByText(/^토크 렌치 · 그리스 도포기/)).toBeInTheDocument();                // 공구 줄
    expect(within(steps).getByText('0.6 N·m ±10%')).toBeInTheDocument();                              // 규칙에서 뽑은 값
    await user.click(within(steps).getByRole('button', { name: /관절 모듈 조립/ }));
    expect(within(steps).queryByRole('list', { name: '단계 1 주의사항' })).not.toBeInTheDocument();
  });

  it('최신 기준으로 바꾸면 그 기준으로 다시 읽고 경고가 달라진다', async () => {
    const user = userEvent.setup();
    build.mockClear();
    renderPage();
    await screen.findByRole('region', { name: '묶음 요약' });
    await user.click(screen.getByRole('button', { name: '최신' }));

    const warnings = await screen.findByRole('list', { name: '경고' });
    await waitFor(() => expect(warnings).toHaveTextContent('BOM 기준이 \'최신\'이라 작업중 · 검토중 리비전이 들어 있습니다'));
    expect(warnings).toHaveTextContent('브레이크 (R00 작업중)');
    expect(screen.getByRole('group', { name: '요약' })).toHaveTextContent('BOM 5줄');
    expect(build).toHaveBeenLastCalledWith('T-100', 'latest');
  });

  it('제품을 바꾸면 그 제품의 묶음이 나온다', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: '묶음 요약' });
    await user.selectOptions(screen.getByRole('combobox', { name: '제품' }), 'T-200');
    await waitFor(() => expect(within(screen.getByRole('table', { name: '제조 BOM' })).getByText('P-T0000000200')).toBeInTheDocument());
    expect(screen.getByRole('region', { name: '묶음 요약' })).toHaveTextContent('T-200');
  });

  it('?product= 가 없으면 첫 제품, 없는 제품이면 오류 안내', async () => {
    const first = renderPage('/mes');
    expect(within(await screen.findByRole('region', { name: '묶음 요약' })).getByText('P-T0000000100')).toBeInTheDocument();
    first.unmount();

    renderPage('/mes?product=NOPE');
    expect(await screen.findByRole('alert')).toHaveTextContent('제품 NOPE을(를) 찾을 수 없습니다');
  });
});
