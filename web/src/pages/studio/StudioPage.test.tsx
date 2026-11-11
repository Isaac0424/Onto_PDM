import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../api/mock/mockApi';
import { SessionProvider } from '../../session';
import { StudioPage } from './StudioPage';

// jsdom 에는 WebGL 이 없어 뷰어는 같은 API 모양의 가짜로 바꾼다. 부품 · 단계는 실제 예시 모델과 같은 꼴이다.
const PARTS = [
  { id: 0, name: '하우징', path: '본체', layer: 0, ko: '', size: [120, 80, 20] },
  { id: 1, name: '제어 기판', path: '전장', layer: 1, ko: '', size: [96, 60, 1.6] },
  { id: 2, name: '기판 나사 M3', path: '체결', layer: 2, ko: '', size: [3, 3, 8] },
  { id: 3, name: '기판 나사 M3', path: '체결', layer: 2, ko: '', size: [3, 3, 8] },
  { id: 4, name: '전원 버튼', path: '외장', layer: 3, ko: '', size: [10, 10, 4] },
  { id: 5, name: '상부 커버', path: '외장', layer: 4, ko: '', size: [126, 80, 3] },
];
const LAYERS = [
  { index: 0, step: 2, title: '하우징', partIds: [0] },
  { index: 1, step: 3, title: '제어 기판', partIds: [1] },
  { index: 2, step: 4, title: '기판 나사 M3', partIds: [2, 3] },
  { index: 3, step: 5, title: '전원 버튼', partIds: [4] },
  { index: 4, step: 6, title: '상부 커버', partIds: [5] },
];

const studio = vi.hoisted(() => ({ goCalls: [] as number[], calls: [] as string[], last: undefined as undefined | { destroyed: boolean } }));

vi.mock('explode-studio', () => ({
  mountExplodeStudio: (container: HTMLElement) => {
    const handlers: Record<string, ((d: unknown) => void)[]> = {};
    const emit = (type: string, d: unknown) => (handlers[type] ?? []).forEach(fn => fn(d));
    const state = { destroyed: false };
    const root = Object.assign(document.createElement('div'), { innerHTML: '<div class="stage"></div>' });   // 실제 뷰어처럼 컨테이너 안에 붙인다
    container.appendChild(root);
    studio.last = state;
    return {
      on: (type: string, fn: (d: unknown) => void) => { (handlers[type] ??= []).push(fn); return () => { handlers[type] = (handlers[type] ?? []).filter(f => f !== fn); }; },
      loadExample: () => emit('model', { name: '제어 박스 · 예시 모델', parts: PARTS.length }),
      loadFile: async () => emit('model', { name: 'uploaded.step', parts: PARTS.length }),
      loadSpec: async () => {},
      replay: () => { studio.calls.push('replay'); },
      setSpin: (on: boolean) => { studio.calls.push(`spin:${on}`); },
      getState: () => ({ model: '제어 박스 · 예시 모델', step: 1 }),
      getParts: () => PARTS,
      getLayers: () => LAYERS,
      root,
      go: (n: number) => { studio.goCalls.push(n); emit('step', { step: n, layer: n - 2 }); },
      selectPart: (name: string) => { const p = PARTS.find(x => x.name === name)!; emit('select', { id: p.id, name: p.name, layer: p.layer }); },
      destroy: () => { state.destroyed = true; },
    };
  },
}));

function renderPage(prepare?: (api: ReturnType<typeof createMockApi>) => void) {
  window.localStorage.setItem('onto-pdm-session', JSON.stringify({ userId: 2, adminMode: false }));
  const api = createMockApi(() => JSON.parse(window.localStorage.getItem('onto-pdm-session')!));
  prepare?.(api);
  const view = render(
    <SessionProvider api={api}>
      <MemoryRouter><StudioPage /></MemoryRouter>
    </SessionProvider>,
  );
  return { api, ...view };
}

beforeEach(() => { studio.goCalls.length = 0; studio.calls.length = 0; });

describe('CAD 스튜디오 (메인 화면)', () => {
  it('제조 순서를 단계별로 나누고 부품마다 보유 품번 매칭을 보인다', async () => {
    renderPage();
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());

    expect(within(steps).getByText('CAD 구조에서 나눈 5단계 · 부품 5종')).toBeInTheDocument();
    expect(within(steps).getByRole('link', { name: 'P-00000000160' })).toBeInTheDocument();        // 전원 버튼: 이름이 정확히 같아 확정
    expect(within(steps).getByText('후보 P-00000000001')).toBeInTheDocument();                       // 기판 나사 M3: CAD 이름 별칭 → 후보
    expect(within(steps).getByText('×2')).toBeInTheDocument();                                       // 같은 이름의 두 개는 한 줄로
    expect(within(steps).getByText('분류 커버')).toBeInTheDocument();                                 // 미보유: 추정 분류
    expect(within(steps).getByText('미보유', { selector: '.chip-none' })).toBeInTheDocument();         // 미보유: 분류도 없음(제어 기판)
    expect(within(steps).getByRole('group', { name: '보유 품번 매칭 현황' })).toHaveTextContent('보유 1후보 2미보유 2');
  });

  it('단계를 누르면 뷰어가 그 단계로 간다', async () => {
    const user = userEvent.setup();
    renderPage();
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await user.click(within(steps).getByRole('button', { name: /^3\s*기판 나사 M3/ }));
    expect(studio.goCalls).toEqual([4]);
    expect(within(steps).getByRole('button', { name: /^3\s*기판 나사 M3/ })).toHaveAttribute('aria-current', 'step');
  });

  it('고르지 않으면 모델 전체의 분류 그래프, 보유 부품을 고르면 그 부품의 온톨로지가 보인다', async () => {
    const user = userEvent.setup();
    renderPage();
    const onto = await screen.findByRole('region', { name: '온톨로지' });
    expect(await within(onto).findByRole('img', { name: '제어 박스 · 예시 모델 온톨로지 그래프' })).toBeInTheDocument();

    const steps = screen.getByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());
    await user.click(within(steps).getByRole('button', { name: /^전원 버튼\s*P-00000000160/ }));

    expect(await within(onto).findByRole('img', { name: '전원 버튼 온톨로지 그래프' })).toBeInTheDocument();
    expect(await within(onto).findByText('전기 · 전자 › 스위치 · 버튼')).toBeInTheDocument();      // 분류 사슬
    expect(within(onto).getAllByText('정격 12V 50mA').length).toBeGreaterThan(0);                    // 속성이 그래프 노드로
    expect(within(onto).getByRole('link', { name: '품목 상세' })).toHaveAttribute('href', '/items/P-00000000160');
  });

  it('미보유 부품은 OPMS 등록 요청을 보낼 수 있고, 한 번 보내면 다시 보내지 않는다', async () => {
    const user = userEvent.setup();
    const { api } = renderPage();
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());

    await user.click(within(steps).getByRole('button', { name: /^제어 기판/ }));
    const onto = screen.getByRole('region', { name: '온톨로지' });
    expect(within(onto).getByText('분류 없음 · OPMS 분류 제안 필요')).toBeInTheDocument();
    await user.click(within(onto).getByRole('button', { name: 'OPMS에 등록 요청' }));

    expect(await within(onto).findByText(/OPMS 등록 요청 #\d+ 전송됨/)).toBeInTheDocument();
    const mine = await api.listPartRequests('mine');
    const sent = mine.find(r => r.payload.name === '제어 기판')!;
    expect(sent).toMatchObject({ status: 'submitted', sourceSystem: 'PDM' });
    expect(sent.payload.aliases).toEqual([{ scheme: 'cad_name', value: '제어 기판' }]);
    expect(sent.payload.note).toContain('제조 2단계');
    expect(within(onto).queryByRole('button', { name: 'OPMS에 등록 요청' })).not.toBeInTheDocument();
  });

  it('미보유를 한꺼번에 요청한다', async () => {
    const user = userEvent.setup();
    const { api } = renderPage();
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());

    await user.click(within(steps).getByRole('button', { name: /OPMS 등록 요청 2/ }));
    expect(await screen.findByText(/2종을 OPMS 등록 요청으로 보냈습니다/)).toBeInTheDocument();
    const names = (await api.listPartRequests('mine')).filter(r => r.status === 'submitted').map(r => r.payload.name);
    expect(names).toEqual(expect.arrayContaining(['제어 기판', '상부 커버']));
    expect(within(steps).getByRole('button', { name: /OPMS 등록 요청/ })).toBeDisabled();
  });

  it('후보 품번은 사람이 확정해야 보유로 바뀐다', async () => {
    const user = userEvent.setup();
    renderPage();
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());

    await user.click(within(steps).getByRole('button', { name: /^기판 나사 M3\s*×2/ }));
    await user.click(await screen.findByRole('button', { name: '이 품번으로 확정' }));
    expect(await within(steps).findByRole('link', { name: 'P-00000000001' })).toBeInTheDocument();
  });

  describe('파일 보관소', () => {
    const fetchMock = vi.fn();
    beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
    afterEach(() => { vi.unstubAllGlobals(); });

    const saved = (kind: string, duplicate = false) => new Response(
      JSON.stringify({ sha256: 'ab12cd34'.padEnd(64, '0'), size: 3, name: 'x', format: 'x', kind, duplicate }),
      { status: duplicate ? 200 : 201 });

    it('CAD · 사양서 · BOM 을 올리면 원본이 종류와 함께 보관소로 간다', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(saved('cad')));
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole('region', { name: '제조 순서' });

      await user.upload(screen.getByLabelText('CAD 파일'), new File(['solid'], '브래킷.step'));
      await user.upload(screen.getByLabelText('사양서 파일'), new File(['spec'], '사양.pdf'));
      await user.upload(screen.getByLabelText('BOM 파일'), new File(['a,b'], 'bom.csv'));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
        `/api/files?name=${encodeURIComponent('브래킷.step')}&kind=cad`,
        `/api/files?name=${encodeURIComponent('사양.pdf')}&kind=spec`,
        '/api/files?name=bom.csv&kind=bom',
      ]);
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
      expect(await screen.findByText(/bom\.csv을\(를\) 보관소에 저장했어요/)).toBeInTheDocument();
    });

    it('같은 내용이 이미 있으면 그렇게 알려준다', async () => {
      fetchMock.mockResolvedValue(saved('bom', true));
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole('region', { name: '제조 순서' });
      await user.upload(screen.getByLabelText('BOM 파일'), new File(['a,b'], 'bom.csv'));
      expect(await screen.findByText(/같은 파일이 이미 보관소에 있어요/)).toBeInTheDocument();
    });

    it('보관소 서버가 꺼져 있어도 화면에서는 열리고, 저장 실패를 알려준다', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      const user = userEvent.setup();
      renderPage();
      await screen.findByRole('region', { name: '제조 순서' });
      await user.upload(screen.getByLabelText('CAD 파일'), new File(['solid'], 'a.step'));
      expect(await screen.findByRole('alert')).toHaveTextContent('파일 보관소 서버에 연결하지 못했습니다');
      expect(screen.getByRole('region', { name: '제조 순서' })).toBeInTheDocument();
    });
  });

  it('부품을 고르면 3D 위에 그 부품의 조립 규칙 카드와 자막이 겹쳐 뜬다', async () => {
    const user = userEvent.setup();
    renderPage();
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());
    expect(await screen.findByRole('status', { name: /단계나 부품을 고르면/ })).toBeInTheDocument();     // 고르기 전: 안내 자막

    await user.click(within(steps).getByRole('button', { name: /^제어 기판/ }));
    const card = await screen.findByRole('complementary', { name: '조립 안내' });
    expect(within(card).getByText('STEP 2 / 5')).toBeInTheDocument();
    expect(within(card).getByText('장착')).toBeInTheDocument();
    expect(within(card).getByText('왼쪽 (−X)')).toBeInTheDocument();                                    // 입력 포트 위치
    expect(within(card).getByRole('list', { name: '주의사항' })).toHaveTextContent('정전기 방지 손목 스트랩');
    expect(within(card).getByText('SP-ELC-01 · 제어 기판 장착')).toBeInTheDocument();
    expect(await screen.findByRole('status', { name: '입력 포트가 왼쪽, 출력 포트가 오른쪽으로 오도록 놓습니다.' })).toBeInTheDocument();

    await user.click(within(steps).getByRole('button', { name: /^상부 커버/ }));                         // 두께 3 mm → 필요한 나사 길이
    expect(await within(await screen.findByRole('complementary', { name: '조립 안내' })).findByText('≥ 7.5 mm (두께 + 1.5 × 지름)')).toBeInTheDocument();
  });

  it('규칙이 없는 부품은 없다고 말하고, 카드는 접을 수 있다', async () => {
    const user = userEvent.setup();
    renderPage(api => {                                  // 하우징에서만 규칙을 걷어 낸다 (지금은 하우징 규칙 SP-HSG-01 이 있다)
      const real = api.getAssemblyGuides.bind(api);
      api.getAssemblyGuides = async parts => (await real(parts)).filter(g => g.partName !== '하우징');
    });
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());

    await user.click(within(steps).getByRole('button', { name: /^하우징후보/ }));
    const card = await screen.findByRole('complementary', { name: '조립 안내' });
    expect(within(card).getByText('연결된 규칙 없음')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: '안내 접기' }));
    expect(within(card).queryByText('연결된 규칙 없음')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '안내 펼치기' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('CAD 를 올리면 자동 회전을 켜고 처음부터 재생한다', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('region', { name: '제조 순서' });
    expect(studio.calls).toEqual([]);                                  // 예시 모델을 열 때는 시작하지 않는다
    await user.upload(screen.getByLabelText('CAD 파일'), new File(['solid'], 'a.step'));
    await waitFor(() => expect(studio.calls).toEqual(['spin:true', 'replay']));
  });

  it('화면을 떠나면 뷰어를 정리한다', async () => {
    const { unmount } = renderPage();
    await screen.findByRole('region', { name: '제조 순서' });
    unmount();
    expect(studio.last?.destroyed).toBe(true);
  });
});
