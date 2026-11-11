import { describe, expect, it } from 'vitest';
import type { AssemblyRuleDetail, BomNode, ItemSummary, Product, RevisionStatus } from '../../api/types';
import { layout3D, neighbors, productGraph, ruleGraph, type Graph } from './graphData';

const product: Product = { id: 1, code: 'HCR3A', name: 'HCR3A', rootItemNo: 'P-1' };

const bom = (itemNo: string, name: string, status: RevisionStatus | undefined, quantity: number, children: BomNode[] = [], itemType: ItemSummary['itemType'] = 'part'): BomNode => ({
  lineId: 0, depth: 0, quantity, totalQuantity: quantity,
  item: { id: 1, itemNo, name, nameKo: name, itemType, unit: 'EA', attributes: {}, createdBy: 1 } as ItemSummary,
  ...(status ? { revision: { id: 1, itemId: 1, rev: 'R00', revSeq: 0, status, createdBy: 1, createdAt: '' } } : {}),
  children,
});

describe('productGraph', () => {
  // 본체(P-1) ─ 관절(P-2) ─ 볼트(P-9) ×4
  //          └ 베이스(P-3) ─ 볼트(P-9) ×12   ← 같은 볼트가 두 곳에 쓰인다
  const bolt = (q: number) => bom('P-9', '볼트', 'released', q);
  const tree = [bom('P-1', '본체', 'released', 1, [
    bom('P-2', '관절', 'wip', 1, [bolt(4)], 'assembly'),
    bom('P-3', '베이스', 'in_review', 1, [bolt(12)], 'assembly'),
  ], 'assembly')];

  it('제품이 level 0, 최상위 조립품이 level 1 이다', () => {
    const g = productGraph(product, tree);
    expect(g.nodes.find(n => n.kind === 'product')).toMatchObject({ id: 'product:HCR3A', level: 0, label: 'HCR3A' });
    expect(g.nodes.find(n => n.id === 'P-1')).toMatchObject({ level: 1, kind: 'assembly' });
    expect(g.edges).toContainEqual({ from: 'product:HCR3A', to: 'P-1' });
  });

  it('같은 품목이 두 곳에 쓰이면 노드는 하나이고 상위마다 간선이 있다', () => {
    const g = productGraph(product, tree);
    expect(g.nodes.filter(n => n.id === 'P-9')).toHaveLength(1);
    const toBolt = g.edges.filter(e => e.to === 'P-9');
    expect(toBolt).toEqual([{ from: 'P-2', to: 'P-9', label: '×4' }, { from: 'P-3', to: 'P-9', label: '×12' }]);
    expect(g.nodes.find(n => n.id === 'P-9')).toMatchObject({ kind: 'part', level: 3 });
  });

  it('같은 상위에 같은 품목이 여러 줄이면 수량을 합친다', () => {
    const g = productGraph(product, [bom('P-1', '본체', 'released', 1, [bom('P-9', '볼트', 'released', 4), bom('P-9', '볼트', 'released', 2)], 'assembly')]);
    expect(g.edges.find(e => e.to === 'P-9')).toEqual({ from: 'P-1', to: 'P-9', label: '×6' });
  });

  it('수량이 1 이면 간선 이름이 없다', () => {
    const g = productGraph(product, [bom('P-1', '본체', 'released', 1, [bom('P-9', '볼트', 'released', 1)], 'assembly')]);
    expect(g.edges.find(e => e.to === 'P-9')).toEqual({ from: 'P-1', to: 'P-9' });
  });

  it('리비전 상태가 색(tone)이 된다: 승인 ok · 작업중/검토중 maybe · 폐기와 리비전 없음 none', () => {
    const g = productGraph(product, [bom('P-1', '본체', 'released', 1, [
      bom('P-2', '작업중', 'wip', 1), bom('P-3', '검토중', 'in_review', 1), bom('P-4', '폐기', 'obsolete', 1), bom('P-5', '없음', undefined, 1),
    ], 'assembly')]);
    const tone = (id: string) => g.nodes.find(n => n.id === id)?.tone;
    expect([tone('P-1'), tone('P-2'), tone('P-3'), tone('P-4'), tone('P-5')]).toEqual(['ok', 'maybe', 'maybe', 'none', 'none']);
  });

  it('규칙이 연결된 품목에만 rules 표식이 붙는다', () => {
    const g = productGraph(product, tree, itemNo => (itemNo === 'P-9' ? 1 : 0));
    expect(g.nodes.find(n => n.id === 'P-9')?.rules).toBe(1);
    expect(g.nodes.find(n => n.id === 'P-2')?.rules).toBeUndefined();
  });
});

describe('ruleGraph', () => {
  const rule = (over: Partial<AssemblyRuleDetail> = {}): AssemblyRuleDetail => ({
    id: 'SP-X-01', name: '규칙', operation: 'fasten', operationLabel: '볼트 체결', appliesTo: ['볼트', '너트'], keyValues: [], cautionCount: 2, toolCount: 1,
    status: 'approved', source: '', description: '', conditions: [], parameters: [], cautions: ['첫째 주의', '둘째 주의'], tools: ['토크 드라이버'],
    usedBy: [{ itemNo: 'P-1', name: '볼트 M3' }], ...over,
  });

  it('규칙을 가운데 두고 공정 · 적용 대상 · 공구 · 주의 · 품목을 종류별로 잇는다', () => {
    const g = ruleGraph(rule());
    const kinds = g.nodes.map(n => n.kind).sort();
    expect(kinds).toEqual(['caution', 'caution', 'class', 'class', 'operation', 'part', 'rule', 'tool']);
    expect(g.nodes.find(n => n.kind === 'rule')).toMatchObject({ id: 'rule:SP-X-01', level: 0, label: 'SP-X-01', sub: '규칙' });
    expect(g.edges).toHaveLength(g.nodes.length - 1);                                  // 가운데에서 하나씩 뻗는 별 모양
    expect(g.edges.every(e => e.from === 'rule:SP-X-01')).toBe(true);
  });

  it('주의사항은 6개, 사용 품목은 10개까지만 그리고 긴 주의는 줄인다', () => {
    const g = ruleGraph(rule({
      cautions: Array.from({ length: 9 }, (_, i) => `아주 길게 적은 주의사항 문장입니다 ${i}`),
      usedBy: Array.from({ length: 14 }, (_, i) => ({ itemNo: `P-${i}`, name: `품목 ${i}` })),
    }));
    const cautions = g.nodes.filter(n => n.kind === 'caution');
    expect(cautions).toHaveLength(6);
    expect(cautions[0]!.label.endsWith('…')).toBe(true);
    expect(cautions[0]!.sub).toContain('아주 길게');                                    // 전체 문장은 sub 에 남는다
    expect(g.nodes.filter(n => n.kind === 'part')).toHaveLength(10);
  });
});

describe('neighbors', () => {
  const g: Graph = {
    nodes: ['a', 'b', 'c', 'd'].map(id => ({ id, label: id, kind: 'part' as const, tone: 'ok' as const, level: 0 })),
    edges: [{ from: 'a', to: 'b' }, { from: 'c', to: 'a' }, { from: 'c', to: 'd' }],
  };
  it('들어오는 간선과 나가는 간선의 상대를 모두 돌려준다', () => {
    expect([...neighbors(g, 'a')].sort()).toEqual(['b', 'c']);
    expect([...neighbors(g, 'd')]).toEqual(['c']);
    expect(neighbors(g, 'zzz').size).toBe(0);
  });
});

describe('layout3D', () => {
  // 가운데 1개 → 1단계 4개 → 2단계 각 2개
  const star = (): Graph => {
    const nodes: Graph['nodes'] = [{ id: 'c', label: 'c', kind: 'product', tone: 'ok', level: 0 }];
    const edges: Graph['edges'] = [];
    for (let i = 0; i < 4; i++) {
      nodes.push({ id: `m${i}`, label: `m${i}`, kind: 'assembly', tone: 'ok', level: 1 });
      edges.push({ from: 'c', to: `m${i}` });
      for (let j = 0; j < 2; j++) {
        nodes.push({ id: `l${i}${j}`, label: `l${i}${j}`, kind: 'part', tone: 'ok', level: 2 });
        edges.push({ from: `m${i}`, to: `l${i}${j}` });
      }
    }
    return { nodes, edges };
  };

  it('같은 입력이면 같은 좌표가 나온다 (난수 고정)', () => {
    const a = layout3D(star()), b = layout3D(star());
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect(a.size).toBe(13);
    [...a.values()].forEach(p => { expect(Number.isFinite(p.x + p.y + p.z)).toBe(true); });
  });

  it('단계가 클수록 중심에서 평균적으로 더 멀다', () => {
    const g = star();
    const pos = layout3D(g);
    const mean = (level: number) => {
      const ds = g.nodes.filter(n => n.level === level).map(n => { const p = pos.get(n.id)!; return Math.hypot(p.x, p.y, p.z); });
      return ds.reduce((s, d) => s + d, 0) / ds.length;
    };
    expect(mean(0)).toBeLessThan(mean(1));
    expect(mean(1)).toBeLessThan(mean(2));
  });

  it('겹치지 않는다: 어떤 두 노드도 거의 같은 자리에 놓이지 않는다', () => {
    const pos = [...layout3D(star()).values()];
    let min = Infinity;
    for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) {
      min = Math.min(min, Math.hypot(pos[i]!.x - pos[j]!.x, pos[i]!.y - pos[j]!.y, pos[i]!.z - pos[j]!.z));
    }
    expect(min).toBeGreaterThan(3);
  });

  it('빈 그래프와 노드 하나도 다룬다', () => {
    expect(layout3D({ nodes: [], edges: [] }).size).toBe(0);
    expect(layout3D({ nodes: [{ id: 'x', label: 'x', kind: 'rule', tone: 'ok', level: 0 }], edges: [] }).size).toBe(1);
  });
});
