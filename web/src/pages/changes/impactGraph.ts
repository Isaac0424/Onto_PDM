// 서버의 영향 그래프(GET /changes/{id}/impact/graph)를 3D 그래프(Graph3D · GraphList)가 읽는 모양으로 바꾼다 (순수 함수).
// 변경 노드가 중심(0단계)이고, 거기서 몇 단계 떨어졌는지가 단계(level)다. 영향 노드는 심각도(severity)로 칠한다.
import type { ImpactGraphNode, ImpactGraphView, Severity } from '../../api/types';
import { SEVERITY } from '../../labels';
import type { Graph, GraphNode, NodeKind, NodeTone } from '../graph/graphData';

const KIND: Record<ImpactGraphNode['kind'], NodeKind> = {
  change: 'change', item: 'part', revision: 'assembly', product: 'product',
  work_order: 'workorder', purchase_order_line: 'purchase', stock_lot: 'stock', joint: 'joint',
};
const TONE: Record<Severity, NodeTone> = { none: 'impact_none', review: 'impact_review', affected: 'impact_affected', blocked: 'impact_blocked' };

const EDGE_LABEL: Record<ImpactGraphView['edges'][number]['kind'], string> = {
  changes: '변경', replaces: '교체', contains: '구성', uses_bom: '사용 BOM', orders: '발주', stock_of: '재고', affects: '영향',
};

export function impactGraph(view: ImpactGraphView): Graph {
  // 변경 노드에서 너비 우선으로 단계를 센다(방향 무시). 닿지 않는 노드는 가장 바깥 단계에 둔다
  const ids = new Set(view.nodes.map(n => n.id));
  const adj = new Map<string, string[]>();
  view.edges.filter(e => ids.has(e.source) && ids.has(e.target)).forEach(e => {
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
    adj.set(e.target, [...(adj.get(e.target) ?? []), e.source]);
  });
  const roots = view.nodes.filter(n => n.kind === 'change').map(n => n.id);
  if (roots.length === 0 && view.nodes[0]) roots.push(view.nodes[0].id);
  const level = new Map<string, number>(roots.map(r => [r, 0]));
  for (let frontier = [...roots]; frontier.length > 0;) {
    const next: string[] = [];
    frontier.forEach(cur => (adj.get(cur) ?? []).forEach(nb => { if (!level.has(nb)) { level.set(nb, level.get(cur)! + 1); next.push(nb); } }));
    frontier = next;
  }
  const outer = Math.max(0, ...level.values()) + 1;

  const nodes: GraphNode[] = view.nodes.map(n => ({
    id: n.id, label: n.label, kind: KIND[n.kind], level: level.get(n.id) ?? outer, ref: n.id,
    tone: n.severity ? TONE[n.severity] : 'impact_none',
    // 색에만 기대지 않도록 막힘 · 처분 필요는 글자(sub)로도 적는다
    ...(n.severity === 'blocked' || n.severity === 'affected' || n.severity === 'review' ? { sub: SEVERITY[n.severity] } : {}),
  }));
  return { nodes, edges: view.edges.filter(e => ids.has(e.source) && ids.has(e.target)).map(e => ({ from: e.source, to: e.target, label: EDGE_LABEL[e.kind] })) };
}
