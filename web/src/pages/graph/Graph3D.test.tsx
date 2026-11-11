import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Graph3D, graphKey } from './Graph3D';
import { GraphList, buildTree } from './GraphList';
import type { Graph } from './graphData';

// 본체 ─ 관절 ─ 볼트 ×4
//     └ 베이스 ─ 볼트(위와 같은 노드) ×12
const graph: Graph = {
  nodes: [
    { id: 'product:H', label: 'HCR3A', sub: 'H', kind: 'product', tone: 'ok', level: 0 },
    { id: 'P-1', label: '본체', sub: 'P-1', kind: 'assembly', tone: 'ok', level: 1 },
    { id: 'P-2', label: '관절', sub: 'P-2', kind: 'assembly', tone: 'maybe', level: 2 },
    { id: 'P-3', label: '베이스', sub: 'P-3', kind: 'assembly', tone: 'ok', level: 2 },
    { id: 'P-9', label: '볼트', sub: 'P-9', kind: 'part', tone: 'ok', level: 3, rules: 1 },
    { id: 'P-8', label: '폐기 부품', sub: 'P-8', kind: 'part', tone: 'none', level: 3 },
  ],
  edges: [
    { from: 'product:H', to: 'P-1' }, { from: 'P-1', to: 'P-2' }, { from: 'P-1', to: 'P-3' },
    { from: 'P-2', to: 'P-9', label: '×4' }, { from: 'P-3', to: 'P-9', label: '×12' }, { from: 'P-3', to: 'P-8' },
  ],
};

describe('Graph3D', () => {
  it('WebGL 을 쓸 수 없으면(jsdom) onUnsupported 를 한 번만 부르고 안내를 보인다', async () => {
    const onUnsupported = vi.fn();
    const { rerender } = render(<Graph3D graph={graph} onSelect={() => {}} label="HCR3A 연결 그래프" onUnsupported={onUnsupported} />);
    expect(screen.getByRole('img', { name: 'HCR3A 연결 그래프' })).toHaveTextContent('3D를 불러오는 중…');          // three 는 지연 로딩이라 먼저 안내가 뜬다
    await waitFor(() => expect(screen.getByRole('img', { name: 'HCR3A 연결 그래프' })).toHaveTextContent('3D를 사용할 수 없어 목록으로 보여 드립니다.'));
    expect(onUnsupported).toHaveBeenCalledTimes(1);

    // 그래프가 바뀌어도, 부모가 다시 그려도 다시 알리지 않는다
    rerender(<Graph3D graph={{ ...graph, nodes: graph.nodes.slice(0, 3) }} onSelect={() => {}} label="HCR3A 연결 그래프" onUnsupported={onUnsupported} />);
    expect(onUnsupported).toHaveBeenCalledTimes(1);
  });

  it('onUnsupported 가 없어도 깨지지 않는다', () => {
    render(<Graph3D graph={graph} onSelect={() => {}} label="그래프" />);
    expect(screen.getByRole('img', { name: '그래프' })).toBeInTheDocument();
  });

  it('graphKey: 같은 내용이면 같고, 노드 · 간선 · 상태가 바뀌면 달라진다 (부모가 새 객체를 만들어도 장면을 다시 만들지 않는다)', () => {
    const copy: Graph = JSON.parse(JSON.stringify(graph));
    expect(graphKey(copy)).toBe(graphKey(graph));
    expect(graphKey({ ...graph, edges: graph.edges.slice(1) })).not.toBe(graphKey(graph));
    expect(graphKey({ ...graph, nodes: graph.nodes.map(n => (n.id === 'P-2' ? { ...n, tone: 'ok' as const } : n)) })).not.toBe(graphKey(graph));
  });
});

describe('GraphList', () => {
  it('간선을 따라 들여쓴 트리로 보이고, 이미 펼친 노드는 "→ 위에 있음"으로만 표시한다', () => {
    render(<GraphList graph={graph} onSelect={() => {}} label="목록" />);
    const group = screen.getByRole('group', { name: '목록' });
    expect(within(group).getAllByRole('button')).toHaveLength(7);                         // 노드 6개 + 볼트가 두 번 나온다
    expect(within(group).getAllByText('→ 위에 있음')).toHaveLength(1);
    // 볼트는 첫 상위(관절) 아래에서만 펼치고 수량을 보인다
    const nested = group.querySelectorAll('ul ul ul ul');
    expect(nested.length).toBeGreaterThan(0);
    expect(within(group).getByText('×4')).toBeInTheDocument();
    expect(within(group).getByText('×12')).toBeInTheDocument();
  });

  it('종류 · 상태 · 규칙 표식을 보인다', () => {
    render(<GraphList graph={graph} onSelect={() => {}} label="목록" />);
    expect(screen.getAllByText('조립품').length).toBe(3);
    expect(screen.getByText('제품')).toBeInTheDocument();
    expect(screen.getAllByText('규칙 1')).toHaveLength(2);                                // 두 번 나오는 볼트에 모두
    expect(screen.getByText('비활성')).toBeInTheDocument();                              // 폐기 부품
    expect(screen.getByText('확인')).toBeInTheDocument();                                // 작업중 관절
  });

  it('누르면 onSelect(id), 고른 항목에만 aria-current 가 붙는다', async () => {
    const user = userEvent.setup();
    function Host() {
      const [id, setId] = useState<string | null>(null);
      return <GraphList graph={graph} selectedId={id} onSelect={setId} label="목록" />;
    }
    render(<Host />);
    const rows = () => screen.getAllByRole('button');
    expect(rows().filter(r => r.getAttribute('aria-current'))).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /^조립품\s*베이스/ }));
    const current = rows().filter(r => r.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('베이스');
  });

  it('키보드로 읽을 수 있다: 모든 항목이 button 이라 Tab 으로 닿고 Enter 로 고른다', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<GraphList graph={graph} onSelect={onSelect} label="목록" />);
    await user.tab();
    expect(screen.getAllByRole('button')[0]).toHaveFocus();                              // 제품이 맨 위
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('product:H');
  });

  it('buildTree: 뿌리는 들어오는 간선이 없는 노드, 순환이나 거꾸로 이어진 노드도 빠지지 않는다', () => {
    const tree = buildTree(graph);
    expect(tree.map(t => t.node.id)).toEqual(['product:H']);
    const cyc: Graph = {
      nodes: [{ id: 'a', label: 'a', kind: 'part', tone: 'ok', level: 1 }, { id: 'b', label: 'b', kind: 'part', tone: 'ok', level: 2 }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    };
    const t2 = buildTree(cyc);
    expect(t2.map(t => t.node.id)).toEqual(['a']);                                       // 순환은 한 번만 펼치고 멈춘다
    expect(t2[0]!.children[0]!.children[0]).toMatchObject({ repeat: true });
  });
});
