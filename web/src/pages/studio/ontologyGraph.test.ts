import { describe, expect, it } from 'vitest';
import { overviewGraph, partGraph, textWidth } from './ontologyGraph';

describe('온톨로지 그래프 배치', () => {
  const base = { label: '전원 버튼', sub: '보유 품번 P-00000000160', tone: 'ok' as const, classPath: ['전기 · 전자', '스위치 · 버튼'], attrs: [] as [string, string][], usedIn: [] as string[], aliases: [] as string[] };

  it('부품은 가운데, 분류 사슬은 왼쪽에서 위(상위)에서 아래로 이어진다', () => {
    const g = partGraph(base);
    const center = g.nodes.find(n => n.kind === 'center')!;
    const classes = g.nodes.filter(n => n.kind === 'class');
    expect(classes.map(n => n.label)).toEqual(['전기 · 전자', '스위치 · 버튼']);
    expect(classes[0]!.y).toBeLessThan(classes[1]!.y);
    expect(classes.every(n => n.x < center.x)).toBe(true);
    expect(g.edges).toContainEqual({ from: 'part', to: 'c1', label: 'instanceOf' });       // 부품은 가장 구체적인 분류의 개체
  });

  it('재료와 속성은 오른쪽, 별칭은 위, 사용처는 아래에 놓이고 개수를 넘기지 않는다', () => {
    const g = partGraph({
      ...base, material: 'SUS304', attrs: [['a', '1'], ['b', '2'], ['c', '3'], ['d', '4']],
      aliases: ['x', 'y', 'z'], usedIn: ['p', 'q', 'r', 's'],
    });
    const of = (kind: string) => g.nodes.filter(n => n.kind === kind);
    expect(of('material')).toHaveLength(1);
    expect(of('attr')).toHaveLength(3);
    expect(of('alias')).toHaveLength(2);
    expect(of('used')).toHaveLength(3);
    expect(of('material')[0]!.x).toBeGreaterThan(220);
    expect(of('alias')[0]!.y).toBeLessThan(of('used')[0]!.y);
    // 간선이 가리키는 노드는 모두 있다
    const ids = new Set(g.nodes.map(n => n.id));
    expect(g.edges.every(e => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });

  it('분류가 없으면 점선 자리 노드를 둔다', () => {
    const g = partGraph({ ...base, tone: 'none', classPath: [] });
    expect(g.nodes.find(n => n.id === 'c0')).toMatchObject({ label: '분류 미정', tone: 'none' });
    expect(g.edges).toContainEqual({ from: 'part', to: 'c0', label: 'instanceOf?', dashed: true });
  });

  it('모델 전체는 분류별 부품 수를 많은 순으로 둘레에 두고, 분류 미정은 점선으로 잇는다', () => {
    const g = overviewGraph({ model: '제어 박스', total: 5, classes: new Map([['커버', 3], ['', 1], ['볼트', 1]]) });
    expect(g.nodes[0]).toMatchObject({ kind: 'center', label: '제어 박스', sub: '부품 5종' });
    expect(g.nodes.slice(1).map(n => n.label)).toEqual(['커버', '볼트', '분류 미정']);
    expect(g.edges.filter(e => e.dashed)).toHaveLength(1);
  });

  it('글자 폭은 한글이 영문보다 넓다', () => {
    expect(textWidth('커버')).toBeGreaterThan(textWidth('ab'));
  });
});
