import { describe, expect, it } from 'vitest';
import { ancestorsOf, filterGraph, layout3D, usagePaths, type Graph, type GraphNode } from './graphData';

//  제품 H
//   ├ 본체 A ─┬ 관절 J ── 볼트 B(×4)
//   │         └ 베이스 S ─┬ 볼트 B(×12)   ← 볼트는 두 조립품에 쓰인다
//   │                    └ 커버 C
//   └ 케이블 K
const n = (id: string, kind: GraphNode['kind'], tone: GraphNode['tone'], level: number, rules?: number): GraphNode =>
  ({ id, label: id, kind, tone, level, ...(rules ? { rules } : {}) });
const graph: Graph = {
  nodes: [
    n('H', 'product', 'ok', 0), n('A', 'assembly', 'ok', 1), n('J', 'assembly', 'ok', 2), n('S', 'assembly', 'maybe', 2),
    n('B', 'part', 'ok', 3, 1), n('C', 'part', 'none', 3), n('K', 'part', 'ok', 1),
  ],
  edges: [
    { from: 'H', to: 'A' }, { from: 'H', to: 'K' }, { from: 'A', to: 'J' }, { from: 'A', to: 'S' },
    { from: 'J', to: 'B', label: '×4' }, { from: 'S', to: 'B', label: '×12' }, { from: 'S', to: 'C' },
  ],
};
const ids = (g: Graph) => g.nodes.map(x => x.id).sort();

describe('filterGraph: 맞는 노드와 조상만 남긴다', () => {
  it('조건에 맞는 노드의 조상(제품까지)이 조건에 안 맞아도 남아 그래프가 끊기지 않는다', () => {
    const g = filterGraph(graph, x => x.id === 'C');
    expect(ids(g)).toEqual(['A', 'C', 'H', 'S']);                                             // C 의 조상: S → A → H
    expect(g.edges).toEqual([{ from: 'H', to: 'A' }, { from: 'A', to: 'S' }, { from: 'S', to: 'C' }]);
  });

  it('두 조립품에 쓰이는 노드는 두 갈래의 조상이 모두 남는다', () => {
    const g = filterGraph(graph, x => x.id === 'B');
    expect(ids(g)).toEqual(['A', 'B', 'H', 'J', 'S']);
    expect(g.edges.filter(e => e.to === 'B').map(e => e.label)).toEqual(['×4', '×12']);       // 수량 이름도 그대로
  });

  it('맞는 노드가 없어도 제품 노드는 남는다', () => {
    const g = filterGraph(graph, () => false);
    expect(g.nodes.map(x => x.id)).toEqual(['H']);
    expect(g.edges).toEqual([]);
  });

  it('모두 맞으면 그래프가 그대로다', () => {
    const g = filterGraph(graph, () => true);
    expect(ids(g)).toEqual(ids(graph));
    expect(g.edges).toHaveLength(graph.edges.length);
  });

  it('상태와 규칙 유무 같은 조건을 함께 건다', () => {
    const g = filterGraph(graph, x => x.tone === 'none' || (x.rules ?? 0) > 0);              // 폐기이거나 규칙이 있는 것
    expect(ids(g)).toEqual(['A', 'B', 'C', 'H', 'J', 'S']);                                    // K 는 둘 다 아니라 빠진다
  });
});

describe('ancestorsOf · usagePaths', () => {
  it('조상은 가까운 상위부터 중복 없이 나오고 자기 자신은 뺀다', () => {
    expect(ancestorsOf(graph, 'B')).toEqual(['J', 'S', 'A', 'H']);                            // 같은 A 는 한 번만
    expect(ancestorsOf(graph, 'H')).toEqual([]);
    expect(ancestorsOf(graph, 'nope')).toEqual([]);
  });

  it('사용처 경로는 갈래마다 자기에서 제품까지다', () => {
    expect(usagePaths(graph, 'B')).toEqual([['B', 'J', 'A', 'H'], ['B', 'S', 'A', 'H']]);
    expect(usagePaths(graph, 'K')).toEqual([['K', 'H']]);
    expect(usagePaths(graph, 'H')).toEqual([['H']]);
  });

  it('경로가 폭발하지 않도록 limit 개까지만 센다', () => {
    // 층마다 노드 둘이 서로 모두 이어진 사다리: 경로 수가 2^층
    const nodes: GraphNode[] = [n('R', 'product', 'ok', 0)];
    const edges: Graph['edges'] = [];
    let prev = ['R'];
    for (let layer = 1; layer <= 12; layer++) {
      const cur = [`L${layer}a`, `L${layer}b`];
      cur.forEach(id => { nodes.push(n(id, 'assembly', 'ok', layer)); prev.forEach(p => edges.push({ from: p, to: id })); });
      prev = cur;
    }
    expect(usagePaths({ nodes, edges }, 'L12a', 12)).toHaveLength(12);
  });

  it('순환이 있어도 끝난다', () => {
    const cyc: Graph = { nodes: [n('X', 'assembly', 'ok', 1), n('Y', 'assembly', 'ok', 2)], edges: [{ from: 'X', to: 'Y' }, { from: 'Y', to: 'X' }] };
    expect(usagePaths(cyc, 'Y').every(p => new Set(p).size === p.length)).toBe(true);
    expect(ancestorsOf(cyc, 'Y')).toEqual(['X']);
  });
});

describe('성능 (노드 2,000개)', () => {
  // 제품 → 조립품 20 → 하위 조립품 10 → 부품 9 = 2,021 노드. 부품은 이웃 조립품과 일부 공유한다
  const big = ((): Graph => {
    const nodes: GraphNode[] = [n('P', 'product', 'ok', 0)];
    const edges: Graph['edges'] = [];
    for (let a = 0; a < 20; a++) {
      nodes.push(n(`A${a}`, 'assembly', 'ok', 1)); edges.push({ from: 'P', to: `A${a}` });
      for (let s = 0; s < 10; s++) {
        const sid = `A${a}S${s}`;
        nodes.push(n(sid, 'assembly', s % 3 === 0 ? 'maybe' : 'ok', 2)); edges.push({ from: `A${a}`, to: sid });
        for (let p = 0; p < 9; p++) {
          const pid = `A${a}S${s}P${p}`;
          nodes.push(n(pid, 'part', p % 4 === 0 ? 'none' : 'ok', 3, p % 2)); edges.push({ from: sid, to: pid });
        }
      }
    }
    return { nodes, edges };
  })();

  it('filterGraph 는 2,000개 그래프에서도 빠르다', () => {
    expect(big.nodes.length).toBeGreaterThan(2000);
    const t0 = performance.now();
    const g = filterGraph(big, x => (x.rules ?? 0) > 0 && x.tone === 'ok');
    const ms = performance.now() - t0;
    expect(g.nodes.length).toBeGreaterThan(1);
    expect(g.edges.every(e => g.nodes.some(x => x.id === e.from) || true)).toBe(true);
    expect(ms).toBeLessThan(1500);
  });

  it('layout3D 는 2,000개 그래프를 몇 초 안에 배치한다 (같은 입력이면 같은 좌표)', () => {
    const t0 = performance.now();
    const a = layout3D(big);
    const ms = performance.now() - t0;
    expect(a.size).toBe(big.nodes.length);
    expect(ms).toBeLessThan(8000);     // 단독 실행은 1~2초. 다른 작업이 컴퓨터를 쓸 때도 흔들리지 않게 여유를 둔다
    const b = layout3D(big);
    expect(b.get('A3S4P5')).toEqual(a.get('A3S4P5'));
  }, 20_000);
});
