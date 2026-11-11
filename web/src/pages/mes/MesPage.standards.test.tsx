import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../../api/httpApi';
import { fakeBackend, type FakeBackend } from '../../api/testBackend';
import type { MesPackage, PdmApi, Product } from '../../api/types';
import { SessionProvider } from '../../session';
import { MesPage } from './MesPage';

// 작업표준서(규칙집): 백엔드가 rules/ 를 읽어 준다. 시험은 같은 응답 모양의 가짜 fetch(testBackend: 실제 rules/ 에서 옮긴 작업표준서 3개)를 쓴다.
// 제품 · BOM 묶음은 OPMS 연동 뒤의 데이터라 따로 시험한다(MesPage.test.tsx).
let backend: FakeBackend;
const withStandards = (init: Parameters<typeof fakeBackend>[0] = {}): PdmApi => {
  backend = fakeBackend(init);
  return createHttpApi({ fetchImpl: backend.fetch });
};

function renderPage(path = '/mes', api: PdmApi = withStandards()) {
  return render(
    <SessionProvider api={api}>
      <MemoryRouter initialEntries={[path]}><MesPage /></MemoryRouter>
    </SessionProvider>,
  );
}

const listOf = () => screen.getByRole('region', { name: '작업표준서 목록' });
const detailOf = () => screen.findByRole('region', { name: '작업표준서 상세' });
const loaded = () => waitFor(() => expect(within(listOf()).getAllByRole('button', { name: /WS-/ })).toHaveLength(3));

describe('작업 표준 화면: 규칙집을 읽지 못할 때', () => {
  it('PDM 백엔드가 꺼져 있으면 이유를 말하고(오류 배너가 아니다), 돌아오면 다시 시도로 열린다', async () => {
    const user = userEvent.setup();
    renderPage('/mes', withStandards({ backend: 'down' }));
    const note = await screen.findByRole('status', { name: '규칙집 연결 안내' });
    expect(note).toHaveTextContent('PDM 백엔드가 꺼져 있어요');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '작업표준서 목록' })).not.toBeInTheDocument();
    backend.state.backend = 'up';
    await user.click(within(note).getByRole('button', { name: '다시 시도' }));
    await loaded();
  });

  it('rules/ 에 검증 오류가 있으면 작업표준서 대신 오류 목록을 보인다', async () => {
    renderPage('/mes', withStandards({ rulebook: 'invalid' }));
    const note = await screen.findByRole('status', { name: '규칙집 연결 안내' });
    expect(note).toHaveTextContent('오류가 있어 보여 드릴 수 없어요');
    expect(within(note).getByRole('list', { name: '규칙집 오류 목록', hidden: true })).toHaveTextContent('없는 규칙 AR-X-999 을 참조합니다');
    expect(screen.queryByRole('region', { name: '작업표준서 목록' })).not.toBeInTheDocument();
  });
});

describe('작업 표준 화면: 작업표준서', () => {
  it('상태줄과 작업표준서 3개(종류 · 모델 · 단계 · 작성 필요 수)를 보이고 첫 작업표준서를 연다 — 모두 초안(검토 전)', async () => {
    renderPage();
    await loaded();
    expect(screen.getByRole('status', { name: '규칙집 상태' })).toHaveTextContent('규칙집 적재됨 · 작업표준 3 · 규칙 5 · 공백 4 · 모두 초안(검토 전)');
    const ins = within(listOf()).getByRole('button', { name: /WS-HCR-INS-02/ });
    expect(ins).toHaveTextContent('로봇 암 베이스 고정');
    expect(ins).toHaveTextContent('작업 절차');
    expect(ins).toHaveTextContent('단계 3');
    expect(ins).toHaveTextContent('HCR-3A · HCR-5A · HCR-12A');
    expect(ins).toHaveTextContent('작성 필요 1');
    expect(ins).toHaveAttribute('aria-current', 'true');                                             // 첫 작업표준서가 열려 있다
    const asm = within(listOf()).getByRole('button', { name: /WS-HCR12A-ASM-01/ });
    expect(asm).toHaveTextContent('CAD 구조만');
    expect(asm).toHaveTextContent('조립품 1');
    expect(within(listOf()).getAllByText('초안 · 검토 전')).toHaveLength(3);
    expect(backend.calls.every(c => c.method === 'GET')).toBe(true);                                  // 읽기만 한다
  });

  it('작업 절차: 목적 · 공구 이름 · 작업 순서(조건 · 대상 · 규칙 링크) · 주의사항(경고 문구 + 쪽 번호) · 품질 확인 · 표준 시간 없음 · 작성 필요', async () => {
    renderPage('/mes?standard=WS-HCR-INS-02');
    const detail = await detailOf();
    expect(await within(detail).findByRole('heading', { level: 2, name: '로봇 암 베이스 고정' })).toBeInTheDocument();
    expect(within(detail).getByText('초안 · 검토 전')).toBeInTheDocument();
    expect(within(detail).getByText('로봇 암을 볼트 4개로 설치면에 정해진 토크로 고정한다')).toBeInTheDocument();

    const time = within(detail).getByRole('region', { name: '표준 시간' });
    expect(time).toHaveTextContent('표준 시간 없음 — 근거 없음 (G-006)');                              // 근거가 없어 비어 있다 — 지어내지 않는다

    expect(await within(within(detail).getByRole('region', { name: '공구' })).findByText('토크 렌치(토크 관리 공구)')).toBeInTheDocument();

    const steps = within(within(detail).getByRole('region', { name: '작업 순서' })).getAllByRole('listitem');
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent('고정 베이스를 이용해 설치한다.');
    expect(steps[0]).toHaveTextContent('조건: 설치면의 평면도 · 강성이 로봇 암을 지지하기에 부족한 경우');
    expect(steps[2]).toHaveTextContent('볼트 체결');
    expect(steps[2]).toHaveTextContent('HCR-12A M12×25 mm 140 N·m');
    expect(steps[2]).toHaveTextContent('로봇 암 베이스 고정 볼트 × 4');                                 // 대상 역할 · 수량
    expect(steps[2]).toHaveTextContent('사용설명서(KR) 3.3절 p.49');                                   // 값의 출처
    expect(within(steps[2]!).getByRole('link', { name: 'AR-FAS-001' })).toHaveAttribute('href', '/rules/AR-FAS-001');

    // 주의사항은 규칙(AR-SAF-001)에 있는 사용설명서 경고 문구를 쪽 번호와 함께
    const cautions = await within(detail).findByRole('list', { name: '작업 주의사항' });
    expect(cautions).toHaveTextContent('경고');
    expect(cautions).toHaveTextContent('로봇에 조립되어 있는 볼트는 절대 임의로 분해하지 마세요.');
    expect(cautions).toHaveTextContent('사용설명서(KR) 3.3절 p.50');
    expect(within(cautions).getByRole('link', { name: 'AR-SAF-001' })).toBeInTheDocument();

    const checks = within(detail).getByRole('region', { name: '품질 확인' });
    expect(checks).toHaveTextContent('로봇 암의 설치면이 베이스면과 완전히 밀착되었는지 확인한다');
    expect(checks).toHaveTextContent('판정 기준: 완전 밀착');

    expect(within(detail).getByRole('region', { name: '관련 규칙' })).toHaveTextContent('AR-FAS-001');
    const gaps = within(detail).getByRole('region', { name: '작성이 필요한 곳' });
    expect(await within(gaps).findByText(/표준 시간/)).toBeInTheDocument();
    expect(detail).toHaveTextContent('값 출처 사용설명서 5 · 근거 없음 1');
  });

  it('점검 항목 표: 대상 · 점검 내용 · 주기(매일 · 3개월마다) · 사용설명서 쪽 번호', async () => {
    renderPage('/mes?standard=WS-HCR-MNT-01');
    const detail = await detailOf();
    const table = await within(detail).findByRole('table', { name: '점검 항목 표' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('로봇 암');
    expect(rows[0]).toHaveTextContent('프로그램에 따라 의도한 위치로 이동하는지 확인합니다.');
    expect(rows[0]).toHaveTextContent('매일');
    expect(rows[1]).toHaveTextContent('3개월마다');
    expect(rows[1]).toHaveTextContent('사용설명서(KR) 8장 p.229');
    expect(within(detail).queryByRole('region', { name: '작업 순서' })).not.toBeInTheDocument();       // 점검 작업표준서에는 작업 순서가 없다
  });

  it('CAD 구조만 있는 작업표준서: 절차가 없다는 안내(작성 필요 G-005)와 CAD 에서 센 체결 부품 표(CAD 추정 배지)', async () => {
    renderPage('/mes?standard=WS-HCR12A-ASM-01');
    const detail = await detailOf();
    expect(await within(detail).findByText(/작업 절차\(순서 · 토크 · 공구\)가 없어요/)).toBeInTheDocument();
    expect(detail).toHaveTextContent('작성 필요 G-005');
    expect(within(detail).queryByRole('region', { name: '작업 순서' })).not.toBeInTheDocument();
    const table = within(detail).getByRole('table', { name: '2번 암 조립품 체결 부품' });
    const row = within(table).getByText('BOLT-M4X15').closest('tr')!;
    expect(row).toHaveTextContent('18');
    expect(row).toHaveTextContent('SocketHeadBolt');
    expect(row).toHaveTextContent('M4 × 15 mm');
    expect(within(row).getByText('CAD 추정')).toBeInTheDocument();                                    // 수량 · 규격은 CAD 에서 도출한 추정
    expect(detail).toHaveTextContent('수량 · 규격은 CAD 구조와 형상 분석에서 도출한 값이라 추정이에요');
  });

  it('목록에서 고르면 그 작업표준서가 열린다. 종류 · 모델 필터와 검색으로 거른다', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    await user.click(within(listOf()).getByRole('button', { name: /WS-HCR-MNT-01/ }));
    expect(within(await detailOf()).getByRole('heading', { level: 2, name: '정기 점검 항목과 주기' })).toBeInTheDocument();
    expect(within(listOf()).getByRole('button', { name: /WS-HCR-MNT-01/ })).toHaveAttribute('aria-current', 'true');

    await user.selectOptions(within(listOf()).getByRole('combobox', { name: '종류 필터' }), 'structure_only');
    expect(within(listOf()).getAllByRole('button', { name: /WS-/ })).toHaveLength(1);
    await user.selectOptions(within(listOf()).getByRole('combobox', { name: '종류 필터' }), 'all');
    await user.selectOptions(within(listOf()).getByRole('combobox', { name: '모델 필터' }), 'HCR-5A');
    expect(within(listOf()).getAllByRole('button', { name: /WS-/ })).toHaveLength(2);                 // 12A 전용(구조) 작업표준서는 빠진다
    await user.selectOptions(within(listOf()).getByRole('combobox', { name: '모델 필터' }), 'all');
    await user.type(within(listOf()).getByRole('searchbox', { name: '작업표준서 검색' }), '점검');
    expect(within(listOf()).getAllByRole('button', { name: /WS-/ })).toHaveLength(1);
    await user.clear(within(listOf()).getByRole('searchbox', { name: '작업표준서 검색' }));
    await user.type(within(listOf()).getByRole('searchbox', { name: '작업표준서 검색' }), '없는 말');
    expect(within(listOf()).getByText('조건에 맞는 작업표준서가 없습니다.')).toBeInTheDocument();
  });

  it('작성 필요 목록: 근거가 없어 비워 둔 곳(G-xxx)이 필요한 것 · 이유 · 채울 곳과 함께 보이고, 막힌 규칙으로 이동할 수 있다', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    expect(screen.queryByRole('region', { name: '작성 필요 목록' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /작성 필요 목록 4/ }));
    const panel = screen.getByRole('region', { name: '작성 필요 목록' });
    expect(within(panel).getAllByRole('listitem').filter(li => li.id.startsWith('gap-'))).toHaveLength(4);
    expect(panel).toHaveTextContent('소켓 헤드 볼트(M3 · M4) 체결 토크');
    expect(panel).toHaveTextContent('채울 곳제조사 설계 · 사내 체결 기준표');
    expect(within(panel).getAllByRole('link', { name: 'AR-FAS-006' })[0]).toHaveAttribute('href', '/rules/AR-FAS-006');
    await user.click(screen.getByRole('button', { name: /작성 필요 목록 4/ }));
    expect(screen.queryByRole('region', { name: '작성 필요 목록' })).not.toBeInTheDocument();
  });

  it('인쇄 버튼은 브라우저 인쇄를 연다', async () => {
    const user = userEvent.setup();
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    renderPage('/mes?standard=WS-HCR-INS-02');
    await user.click(await screen.findByRole('button', { name: '인쇄' }));
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });

  it('제품 · BOM 이 있으면(OPMS 연동 뒤) 작업표준서와 제조 BOM 묶음이 함께 나온다', async () => {
    const products: Product[] = [{ id: 1, code: 'T-100', name: '시험 제품', rootItemNo: 'P-T0000000100' }];
    const pkg: MesPackage = {
      productCode: 'T-100', productName: '시험 제품', rootItemNo: 'P-T0000000100', revision: 'R01', rule: 'released', generatedAt: '2026-11-01T09:00:00+09:00',
      bom: [{ seq: 1, level: 0, itemNo: 'P-T0000000100', name: '본체', quantity: 1, totalQuantity: 1, ruleIds: [] }], steps: [], documents: [], warnings: [],
    };
    renderPage('/mes?product=T-100', { ...withStandards(), connected: true, listProducts: async () => products, buildMesPackage: async () => pkg });
    await loaded();
    expect(await screen.findByRole('region', { name: '묶음 요약' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: '제조 BOM' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '작업표준서 목록' })).toBeInTheDocument();
  });
});
