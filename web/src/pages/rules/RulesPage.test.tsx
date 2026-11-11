import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyApi } from '../../api/emptyApi';
import { createHttpApi } from '../../api/httpApi';
import { fakeBackend, type FakeBackend } from '../../api/testBackend';
import type { PdmApi } from '../../api/types';
import { SessionProvider } from '../../session';
import type { Graph3DProps } from '../graph/Graph3D';
import type { GraphListProps } from '../graph/GraphList';
import { RulesPage } from './RulesPage';

// jsdom 에는 WebGL 이 없다. 3D 그래프는 두 가지 모양의 가짜로 바꿔 규칙 화면이 하는 일(탭 전환 · 목록 폴백 · 노드 선택)만 시험한다.
//   'unsupported': 마운트하자마자 onUnsupported 를 부른다 (실제 Graph3D 가 WebGL 을 못 만들 때)
//   'fake': 노드마다 버튼을 그린다
const mock = vi.hoisted(() => ({ mode: 'unsupported' as 'unsupported' | 'fake' }));

vi.mock('../graph/Graph3D', () => ({
  Graph3D: (props: Graph3DProps) => {
    const { onUnsupported } = props;
    useEffect(() => { if (mock.mode === 'unsupported') onUnsupported?.(); }, [onUnsupported]);
    if (mock.mode === 'unsupported') return null;
    return (
      <div role="img" aria-label={props.label}>
        {props.graph.nodes.map(n => <button key={n.id} type="button" onClick={() => props.onSelect(n.id)}>3D 노드 {n.label}</button>)}
      </div>
    );
  },
}));

vi.mock('../graph/GraphList', () => ({
  GraphList: (props: GraphListProps) => (
    <ul aria-label={props.label}>
      {props.graph.nodes.map(n => <li key={n.id}><button type="button" onClick={() => props.onSelect(n.id)}>{n.kind}:{n.label}</button></li>)}
    </ul>
  ),
}));

// 규칙집은 PDM 백엔드가 rules/ 를 읽어 준다: 시험은 같은 응답 모양의 가짜 fetch(testBackend: 실제 rules/ 에서 옮긴 규칙 5개 · 작업표준서 3개 · 공백 4건)를 쓴다.
let backend: FakeBackend;
const withRules = (init: Parameters<typeof fakeBackend>[0] = {}): PdmApi => {
  backend = fakeBackend(init);
  return createHttpApi({ fetchImpl: backend.fetch });
};

function renderPage(path = '/rules', api: PdmApi = withRules()) {
  return render(
    <SessionProvider api={api}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/rules/:ruleId" element={<RulesPage />} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
}

const listOf = () => screen.getByRole('region', { name: '규칙 목록' });
const detailOf = () => screen.findByRole('region', { name: '규칙 상세' });
const loaded = () => waitFor(() => expect(within(listOf()).getAllByRole('link')).toHaveLength(5));

describe('조립 규칙 화면: 규칙집을 읽어 올 곳이 없을 때', () => {
  it('가짜 규칙 대신 연결 안내를 보이고, 목록 · 검색 · 상세는 그리지 않는다 (오류가 아니다)', async () => {
    renderPage('/rules', createEmptyApi());
    expect(screen.getByRole('heading', { level: 1, name: '조립 규칙' })).toBeInTheDocument();
    const note = await screen.findByRole('status', { name: 'OPMS 연결 안내' });
    expect(note).toHaveTextContent('조립 규칙이 없어요');
    expect(note).toHaveTextContent('PDM 백엔드에 연결되면');
    expect(screen.queryByRole('region', { name: '규칙 목록' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '규칙 상세' })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('PDM 백엔드가 꺼져 있으면 이유를 말하고 다시 시도할 수 있다 (돌아오면 규칙이 보인다)', async () => {
    const user = userEvent.setup();
    renderPage('/rules', withRules({ backend: 'down' }));
    const note = await screen.findByRole('status', { name: '규칙집 연결 안내' });
    expect(note).toHaveTextContent('PDM 백엔드가 꺼져 있어요');
    expect(note.className).not.toMatch(/danger/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '규칙 목록' })).not.toBeInTheDocument();

    backend.state.backend = 'up';
    await user.click(within(note).getByRole('button', { name: '다시 시도' }));
    await loaded();
    expect(screen.queryByRole('status', { name: '규칙집 연결 안내' })).not.toBeInTheDocument();
  });

  it('rules/ 에 검증 오류가 있으면 규칙 대신 오류 목록을 펼쳐 보인다 (호박색, 규칙은 보여 주지 않는다)', async () => {
    renderPage('/rules', withRules({ rulebook: 'invalid' }));
    const note = await screen.findByRole('status', { name: '규칙집 연결 안내' });
    expect(note).toHaveTextContent('rules/)에 오류가 있어 보여 드릴 수 없어요');
    expect(note).toHaveTextContent('오류 2건 보기');
    const errors = within(note).getByRole('list', { name: '규칙집 오류 목록', hidden: true });
    expect(errors).toHaveTextContent('rules.yaml AR-FAS-001');
    expect(errors).toHaveTextContent('없는 규칙 AR-X-999 을 참조합니다');
    expect(screen.queryByRole('region', { name: '규칙 목록' })).not.toBeInTheDocument();
  });

  it('rules/ 폴더를 읽을 수 없으면 그 사실을 말한다', async () => {
    renderPage('/rules', withRules({ rulebook: 'unavailable' }));
    expect(await screen.findByRole('status', { name: '규칙집 연결 안내' })).toHaveTextContent('rules/ 폴더를 찾을 수 없습니다');
  });
});

describe('조립 규칙 화면', () => {
  it('규칙집 상태줄과 규칙 5개를 보이고, 모두 초안(검토 전)이며, 첫 규칙의 상세를 기본으로 연다', async () => {
    renderPage();
    await loaded();
    const status = screen.getByRole('status', { name: '규칙집 상태' });
    expect(status).toHaveTextContent('규칙집 적재됨 · 규칙 5 · 작업표준 3 · 공백 4 · 모두 초안(검토 전)');
    expect(status).toHaveTextContent('값 출처: 사용설명서');
    expect(within(listOf()).getAllByText('초안 · 검토 전')).toHaveLength(5);
    expect(await within(await detailOf()).findByRole('heading', { level: 2, name: '로봇 암 베이스 고정 볼트 체결' })).toBeInTheDocument();
    expect(within(listOf()).getByRole('link', { name: /AR-FAS-001/ })).toHaveAttribute('aria-current', 'true');
    expect(backend.calls.every(c => c.method === 'GET')).toBe(true);                                   // 읽기만 한다(규칙 화면은 POST 를 보내지 않는다)
  });

  it('목록에는 이름 · 공정 · 대상 · 값 출처 · 미확정 값 수가 보이고, 제안(미등록) 분류와 CAD 추정은 구분된다', async () => {
    renderPage();
    await loaded();
    const fas6 = within(listOf()).getByRole('link', { name: /AR-FAS-006/ });
    expect(fas6).toHaveTextContent('로봇 암 본체 소켓 헤드 볼트(M3 · M4) 체결');
    expect(fas6).toHaveTextContent('볼트 체결');
    expect(fas6).toHaveTextContent('육각구멍붙이볼트');                                // 분류 이름(OPMS 분류의 한글 이름)
    expect(fas6).toHaveTextContent('CAD 추정 1');
    expect(fas6).toHaveTextContent('근거 없음 2');
    expect(fas6).toHaveTextContent('미확정 값 2');
    const fas1 = within(listOf()).getByRole('link', { name: /AR-FAS-001/ });
    expect(fas1).toHaveTextContent('사용설명서 11');
    expect(fas1).not.toHaveTextContent('미확정 값');
  });

  it('공정 칩 · 분류 · 역할 · 출처 · 모델 필터와 검색으로 거른다', async () => {
    const user = userEvent.setup();
    renderPage();
    await loaded();
    const list = listOf();

    await user.click(within(list).getByRole('button', { name: '커넥터 체결 1' }));
    expect(within(list).getAllByRole('link')).toHaveLength(1);
    expect(within(list).getByRole('link', { name: /AR-CON-002/ })).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: /^전체/ }));
    expect(within(list).getAllByRole('link')).toHaveLength(5);

    await user.selectOptions(within(list).getByRole('combobox', { name: '분류 필터' }), 'SocketHeadBolt');
    expect(within(list).getAllByRole('link').map(a => a.textContent)).toEqual([expect.stringContaining('AR-FAS-006')]);
    await user.selectOptions(within(list).getByRole('combobox', { name: '분류 필터' }), 'all');

    await user.selectOptions(within(list).getByRole('combobox', { name: '역할 필터' }), 'tool_mount');
    expect(within(list).getAllByRole('link')).toHaveLength(1);
    expect(within(list).getByRole('link', { name: /AR-FAS-004/ })).toBeInTheDocument();
    await user.selectOptions(within(list).getByRole('combobox', { name: '역할 필터' }), 'all');

    await user.selectOptions(within(list).getByRole('combobox', { name: '출처 필터' }), 'cad');        // CAD 추정 값을 가진 규칙
    expect(within(list).getAllByRole('link')).toHaveLength(1);
    await user.selectOptions(within(list).getByRole('combobox', { name: '출처 필터' }), 'unknown');    // 근거 없는 값을 가진 규칙 둘
    expect(within(list).getAllByRole('link')).toHaveLength(2);
    await user.selectOptions(within(list).getByRole('combobox', { name: '출처 필터' }), 'all');

    await user.selectOptions(within(list).getByRole('combobox', { name: '모델 필터' }), 'HCR-5A');
    expect(within(list).getAllByRole('link')).toHaveLength(5);                                         // 모델 제한 없는 규칙도 포함, 5A 는 어느 규칙에서도 빠지지 않는다
    await user.selectOptions(within(list).getByRole('combobox', { name: '모델 필터' }), 'all');

    await user.type(within(list).getByRole('searchbox', { name: '규칙 검색' }), 'ar-saf');             // 번호는 대소문자 무시
    expect(within(list).getAllByRole('link')).toHaveLength(1);
    await user.clear(within(list).getByRole('searchbox', { name: '규칙 검색' }));
    await user.type(within(list).getByRole('searchbox', { name: '규칙 검색' }), '없는 말');
    expect(within(list).getByText('조건에 맞는 규칙이 없습니다.')).toBeInTheDocument();
  });

  it('사용설명서 근거 규칙: 값마다 출처 배지(쪽 번호), 모델별 표, 경고 문구, 공구 이름, 관련 작업표준 링크가 나온다', async () => {
    renderPage('/rules/AR-FAS-001');
    const detail = await detailOf();
    expect(await within(detail).findByRole('heading', { level: 2, name: '로봇 암 베이스 고정 볼트 체결' })).toBeInTheDocument();
    expect(within(detail).getByText('초안 · 검토 전')).toBeInTheDocument();
    expect(within(detail).getByText('부품 규칙')).toBeInTheDocument();

    const values = within(detail).getByRole('table', { name: '규칙 값' });
    const qty = within(values).getByText('수량').closest('tr')!;
    expect(qty).toHaveTextContent('4 개');
    expect(within(qty).getByText('사용설명서(KR) 3.3절 p.49')).toBeInTheDocument();                  // 확정값: 초록 배지에 쪽 번호까지

    const table = within(detail).getByRole('table', { name: '조건표' });
    expect(within(table).getAllByRole('columnheader').map(c => c.textContent)).toEqual(['모델', '나사 규격', '길이', '체결 토크', '위치 결정 핀 지름', '출처']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('HCR-3A');
    expect(rows[0]).toHaveTextContent('M6');
    expect(rows[0]).toHaveTextContent('15 mm');
    expect(rows[0]).toHaveTextContent('30 N·m');
    expect(rows[2]).toHaveTextContent('140 N·m');

    const cautions = within(detail).getByRole('list', { name: '주의사항' });
    expect(cautions).toHaveTextContent('경고');
    expect(cautions).toHaveTextContent('로봇을 고정할 때에는 볼트가 풀리지 않도록 단단히 고정하세요.');
    expect(cautions).toHaveTextContent('사용설명서(KR) 3.3절 p.49');
    expect(await within(detail).findByText('토크 렌치(토크 관리 공구)')).toBeInTheDocument();         // 공구 번호가 아니라 이름
    const link = await within(detail).findByRole('link', { name: 'WS-HCR-INS-02' });
    expect(link).toHaveAttribute('href', '/mes?standard=WS-HCR-INS-02');
    await waitFor(() => expect(within(listOf()).getByRole('link', { name: /AR-FAS-001/ })).toHaveAttribute('aria-current', 'true'));
  });

  it('CAD 추정 · 근거 없는 규칙: 확정값처럼 보이지 않는다 — "CAD 추정" 배지, 빈 값은 "작성 필요 G-0xx", 공백 목록', async () => {
    renderPage('/rules/AR-FAS-006');
    const detail = await detailOf();
    expect(await within(detail).findByRole('heading', { level: 2, name: /로봇 암 본체 소켓 헤드 볼트/ })).toBeInTheDocument();
    const target = within(detail).getByRole('region', { name: '적용 대상' });
    expect(within(target).getByText('CAD 추정')).toBeInTheDocument();                                  // 대상 자체가 CAD 에서 도출한 것
    expect(target).toHaveTextContent('M3 또는 M4');
    expect(target).toHaveTextContent('로봇 암 본체 조립에 쓰인 M3 · M4 소켓 헤드 볼트');             // 근거를 설명하는 괄호는 뗀다

    const values = within(detail).getByRole('table', { name: '규칙 값' });
    const torque = within(values).getByText('체결 토크').closest('tr')!;
    expect(torque).toHaveTextContent('작성 필요 G-001');                                               // 값은 비어 있다 — 지어내지 않는다
    expect(torque).toHaveTextContent('근거 없음 · 작성 필요 G-001');
    expect(within(values).getByText('체결 순서').closest('tr')).toHaveTextContent('작성 필요 G-005');

    const gaps = within(detail).getByRole('region', { name: '작성이 필요한 곳' });
    expect(gaps).toHaveTextContent('G-001');
    expect(await within(gaps).findByText(/소켓 헤드 볼트\(M3 · M4\) 체결 토크/)).toBeInTheDocument();
    expect(gaps).toHaveTextContent('필요한 곳: 제조사 설계 · 사내 체결 기준표');
    expect(within(detail).getByText(/사용설명서는 로봇 암 본체 조립/)).toBeInTheDocument();           // 규칙의 설명
  });

  it('값 일부만 비어 있는 규칙(툴 고정 볼트): 확정값(M6 · 4개)과 빈 값(길이 · 토크)이 한 표에서 구분된다', async () => {
    renderPage('/rules/AR-FAS-004');
    const values = within(await within(await detailOf()).findByRole('table', { name: '규칙 값' })).getAllByRole('row');
    expect(values).toHaveLength(4);
    const byName = (n: string) => values.find(r => within(r).queryByText(n))!;
    expect(byName('나사 규격')).toHaveTextContent('M6');
    expect(byName('나사 규격')).toHaveTextContent('사용설명서(KR) 3.4절 p.50');
    expect(byName('길이')).toHaveTextContent('작성 필요 G-002');
    expect(byName('체결 토크')).toHaveTextContent('작성 필요 G-002');
  });

  it('없는 규칙은 오류로 알린다', async () => {
    renderPage('/rules/AR-NOPE-99');
    expect(await within(await detailOf()).findByRole('alert')).toHaveTextContent('조립 규칙 AR-NOPE-99을(를) 찾을 수 없습니다');
  });

  it('온톨로지 탭: 3D 를 쓸 수 없으면 목록으로 떨어지고, 규칙 · 공정 · 분류 이름 · 공구 이름 · 주의사항이 노드로 보인다', async () => {
    mock.mode = 'unsupported';
    const user = userEvent.setup();
    renderPage('/rules/AR-FAS-006');
    const detail = await detailOf();
    await within(detail).findByRole('heading', { level: 2, name: /로봇 암 본체 소켓 헤드 볼트/ });
    await user.click(within(detail).getByRole('tab', { name: '온톨로지(3D)' }));

    expect(await within(detail).findByText('이 환경에서는 3D를 쓸 수 없어 목록으로 보여 드립니다.')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'rule:AR-FAS-006' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'operation:볼트 체결' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'class:육각구멍붙이볼트' })).toBeInTheDocument();
    await waitFor(() => expect(within(detail).getByRole('button', { name: 'tool:토크 렌치(토크 관리 공구)' })).toBeInTheDocument());
    expect(within(detail).getByRole('list', { name: '범례' })).toBeInTheDocument();
  });

  it('온톨로지 탭: 3D 가 되면 그래프를 그리고, 노드를 누르면 아래에 이름과 종류를 보인다', async () => {
    mock.mode = 'fake';
    const user = userEvent.setup();
    renderPage('/rules/AR-FAS-001');
    const detail = await detailOf();
    await within(detail).findByRole('heading', { level: 2, name: '로봇 암 베이스 고정 볼트 체결' });
    await user.click(within(detail).getByRole('tab', { name: '온톨로지(3D)' }));

    expect(await within(detail).findByRole('img', { name: 'AR-FAS-001 온톨로지 그래프' })).toBeInTheDocument();
    expect(within(detail).getByTestId('rule-picked')).toHaveTextContent('노드를 누르면 여기에 표시됩니다.');
    await user.click(within(detail).getByRole('button', { name: '3D 노드 볼트 체결' }));              // 공정 노드
    expect(within(detail).getByTestId('rule-picked')).toHaveTextContent('선택: 볼트 체결 (공정)');
    await user.click(within(detail).getByRole('button', { name: /3D 노드 로봇을 고정할 때에는/ }));    // 주의사항 노드는 전체 문장을 보인다
    expect(within(detail).getByTestId('rule-picked')).toHaveTextContent('로봇을 고정할 때에는 볼트가 풀리지 않도록 단단히 고정하세요.');
  });

  it('목록 탭은 같은 그래프를 키보드로 읽는 목록으로 보인다', async () => {
    mock.mode = 'unsupported';
    const user = userEvent.setup();
    renderPage('/rules/AR-CON-002');
    const detail = await detailOf();
    await within(detail).findByRole('heading', { level: 2, name: '컨트롤러 전원 연결' });
    expect(within(detail).getAllByText('제품 전반').length).toBeGreaterThan(0);                          // 분류도 역할도 없는 규칙
    await user.click(within(detail).getByRole('tab', { name: '목록' }));
    expect(within(detail).getByRole('list', { name: 'AR-CON-002 온톨로지 목록' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'class:제품 전반' })).toBeInTheDocument();
    expect(within(detail).getByRole('tab', { name: '목록' })).toHaveAttribute('aria-selected', 'true');
  });
});
