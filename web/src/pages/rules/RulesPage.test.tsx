import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../api/mock/mockApi';
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

function renderPage(path = '/rules', prepare?: (api: ReturnType<typeof createMockApi>) => void) {
  window.localStorage.setItem('onto-pdm-session', JSON.stringify({ userId: 2, adminMode: false }));
  const api = createMockApi(() => JSON.parse(window.localStorage.getItem('onto-pdm-session')!));
  prepare?.(api);
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
const detailOf = () => screen.getByRole('region', { name: '규칙 상세' });

describe('조립 규칙 화면', () => {
  it('규칙 11개와 요약을 보이고, 첫 규칙의 상세를 기본으로 연다', async () => {
    renderPage();
    const list = listOf();
    await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(11));
    expect(within(list).getByText('규칙 11개 · 승인 9 · 검토 전 2')).toBeInTheDocument();
    expect(within(list).getAllByText('검토 전').length).toBeGreaterThanOrEqual(2);                  // 용접 · 압입은 가상 값이라 검토 전
    expect(await within(detailOf()).findByRole('heading', { level: 2, name: '소형 나사(M3) 체결' })).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: /SP-FAS-01/ })).toHaveAttribute('aria-current', 'true');
  });

  it('공정 칩으로 거르고, 검색은 번호 · 이름 · 적용 대상에서 찾는다', async () => {
    const user = userEvent.setup();
    renderPage();
    const list = listOf();
    await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(11));

    await user.click(within(list).getByRole('button', { name: '장착 4' }));
    expect(within(list).getAllByRole('link')).toHaveLength(4);
    expect(within(list).getByRole('button', { name: '장착 4' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(list).getByRole('button', { name: /^전체/ }));
    expect(within(list).getAllByRole('link')).toHaveLength(11);

    await user.type(within(list).getByRole('searchbox', { name: '규칙 검색' }), '러그');             // 적용 대상 '접합 부품 (러그)'
    expect(within(list).getAllByRole('link')).toHaveLength(1);
    expect(within(list).getByRole('link', { name: /SP-WLD-01/ })).toBeInTheDocument();
    await user.clear(within(list).getByRole('searchbox', { name: '규칙 검색' }));
    await user.type(within(list).getByRole('searchbox', { name: '규칙 검색' }), 'sp-bat');          // 번호는 대소문자 무시
    expect(within(list).getAllByRole('link')).toHaveLength(1);
    await user.clear(within(list).getByRole('searchbox', { name: '규칙 검색' }));
    await user.type(within(list).getByRole('searchbox', { name: '규칙 검색' }), '없는 말');
    expect(within(list).getByText('조건에 맞는 규칙이 없습니다.')).toBeInTheDocument();
  });

  it('규칙을 고르면 값 · 주의사항 · 공구 · 적용 품목이 상세에 나온다', async () => {
    const user = userEvent.setup();
    renderPage();
    const list = listOf();
    await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(11));

    await user.click(within(list).getByRole('link', { name: /SP-RED-01/ }));
    const detail = detailOf();
    expect(await within(detail).findByRole('heading', { level: 2, name: '감속기 장착' })).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: /SP-RED-01/ })).toHaveAttribute('aria-current', 'true');

    const values = within(detail).getByRole('table', { name: '규칙 값' });
    expect(within(values).getByText('입력축 방향')).toBeInTheDocument();
    expect(within(values).getByText('모터 쪽')).toBeInTheDocument();
    expect(within(detail).getByRole('list', { name: '주의사항' })).toHaveTextContent('입력축 방향이 반대면 조립 후 분해해야 합니다.');
    expect(within(detail).getByText('토크 렌치')).toBeInTheDocument();
    expect(within(detail).getByText('P-00000000121')).toBeInTheDocument();   // 보유 감속기 (품목 화면은 삭제돼 링크 없이 품번만)
    expect(within(detail).getByText(/온토전자 \(가상 회사\) 조립 표준 SP-RED-01/)).toBeInTheDocument();
  });

  it('/rules/SP-WLD-01 로 바로 열면 검토 전 배지와 용접 조건표(4행)가 보이고, 적용 품목이 없다고 말한다', async () => {
    renderPage('/rules/SP-WLD-01');
    const detail = detailOf();
    expect(await within(detail).findByRole('heading', { level: 2, name: '박판 용접 (가상 조건표)' })).toBeInTheDocument();
    expect(within(detail).getByText('검토 전')).toBeInTheDocument();
    const table = within(detail).getByRole('table', { name: '조건표' });
    expect(within(table).getAllByRole('columnheader').map(c => c.textContent)).toEqual(['모재 두께', '개선 형상', '필러 지름', '루트 갭']);
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(4);
    expect(within(table).getByText('V형 60° · 다층 용접')).toBeInTheDocument();
    expect(within(detail).getByText('적용되는 보유 품목이 없습니다.')).toBeInTheDocument();
    await waitFor(() => expect(within(listOf()).getByRole('link', { name: /SP-WLD-01/ })).toHaveAttribute('aria-current', 'true'));
  });

  it('없는 규칙은 오류로 알린다', async () => {
    renderPage('/rules/SP-NOPE-99');
    expect(await within(detailOf()).findByRole('alert')).toHaveTextContent('규칙을 찾을 수 없습니다');
  });

  it('온톨로지 탭: 3D 를 쓸 수 없으면 목록으로 떨어지고 안내한다. 그래프의 노드가 보이고 눌러서 고를 수 있다', async () => {
    mock.mode = 'unsupported';
    const user = userEvent.setup();
    renderPage('/rules/SP-RED-01');
    const detail = detailOf();
    await within(detail).findByRole('heading', { level: 2, name: '감속기 장착' });
    await user.click(within(detail).getByRole('tab', { name: '온톨로지(3D)' }));

    expect(await within(detail).findByText('이 환경에서는 3D를 쓸 수 없어 목록으로 보여 드립니다.')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'rule:SP-RED-01' })).toBeInTheDocument();       // 가운데 규칙 노드
    expect(within(detail).getByRole('button', { name: 'operation:장착' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'class:감속기' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'tool:토크 렌치' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'part:J1 감속기' })).toBeInTheDocument();         // 이 규칙이 쓰이는 보유 품목

    await user.click(within(detail).getByRole('button', { name: 'part:J1 감속기' }));
    expect(within(detail).getByText('P-00000000121')).toBeInTheDocument();
    expect(within(detail).getByTestId('rule-picked')).toHaveTextContent('선택: J1 감속기 (품목)');
    expect(within(detail).getByRole('list', { name: '범례' })).toBeInTheDocument();
  });

  it('온톨로지 탭: 3D 가 되면 그래프를 그리고, 노드를 누르면 아래에 이름과 종류를 보인다', async () => {
    mock.mode = 'fake';
    const user = userEvent.setup();
    renderPage('/rules/SP-FAS-01');
    const detail = detailOf();
    await within(detail).findByRole('heading', { level: 2, name: '소형 나사(M3) 체결' });
    await user.click(within(detail).getByRole('tab', { name: '온톨로지(3D)' }));

    expect(await within(detail).findByRole('img', { name: 'SP-FAS-01 온톨로지 그래프' })).toBeInTheDocument();
    expect(within(detail).queryByText(/3D를 쓸 수 없어/)).not.toBeInTheDocument();
    expect(within(detail).getByTestId('rule-picked')).toHaveTextContent('노드를 누르면 여기에 표시됩니다.');
    await user.click(within(detail).getByRole('button', { name: '3D 노드 볼트 체결' }));                // 공정 노드
    expect(within(detail).getByTestId('rule-picked')).toHaveTextContent('선택: 볼트 체결 (공정)');
    await user.click(within(detail).getByRole('button', { name: /3D 노드 나사산이 상하면/ }));          // 주의사항 노드는 전체 문장을 보인다
    expect(within(detail).getByTestId('rule-picked')).toHaveTextContent('나사산이 상하면 폐기하고, 같은 나사를 3번 넘게 다시 쓰지 않습니다.');
  });

  it('목록 탭은 같은 그래프를 키보드로 읽는 목록으로 보인다', async () => {
    mock.mode = 'unsupported';
    const user = userEvent.setup();
    renderPage('/rules/SP-BAT-01');
    const detail = detailOf();
    await within(detail).findByRole('heading', { level: 2, name: '배터리 장착' });
    await user.click(within(detail).getByRole('tab', { name: '목록' }));
    expect(within(detail).getByRole('list', { name: 'SP-BAT-01 온톨로지 목록' })).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'class:배터리' })).toBeInTheDocument();
    expect(within(detail).getByRole('tab', { name: '목록' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('규칙 검증은 삭제됨 (사용자 지시)', () => {
  it('검증 영역과 검증 표식이 없다', async () => {
    renderPage();
    await waitFor(() => expect(within(listOf()).getAllByRole('link')).toHaveLength(11));
    expect(screen.queryByRole('region', { name: '규칙 검증' })).not.toBeInTheDocument();
    expect(screen.queryByText(/검증 문제/)).not.toBeInTheDocument();
  });
});
