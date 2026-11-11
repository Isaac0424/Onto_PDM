// 3D 그래프의 노드 · 간선 만들기와 배치 (순수 함수). 그리는 일은 Graph3D.tsx 가 한다.
// 제품 연결 그래프(제품 → 조립품 → 부품)와 규칙 온톨로지 그래프가 같은 모양의 데이터를 쓴다.
import { forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, type SimNode } from 'd3-force-3d';
import type { AssemblyRuleDetail, BomNode, Product, RevisionStatus } from '../../api/types';

export type NodeKind = 'product' | 'assembly' | 'part' | 'rule' | 'operation' | 'class' | 'tool' | 'caution'
  | 'change' | 'workorder' | 'purchase' | 'stock' | 'joint';                  // 뒤의 다섯은 설계 변경 영향 그래프(pages/changes)
export type NodeTone = 'ok' | 'maybe' | 'none'
  | 'impact_none' | 'impact_review' | 'impact_affected' | 'impact_blocked';   // 뒤의 넷은 영향 심각도(none · review · affected · blocked)

export interface GraphNode {
  id: string;
  label: string;
  sub?: string;
  kind: NodeKind;
  /** ok: 승인 · 보유, maybe: 작업중 · 검토중 · 후보, none: 폐기 · 미보유 */
  tone: NodeTone;
  /** 제품(규칙)에서 몇 단계 떨어졌나. 배치에서 중심으로부터의 거리가 된다 */
  level: number;
  /** 연결된 조립 규칙 수 (0 이면 표식 없음) */
  rules?: number;
  /** 화면에서 돌려받을 값 (품번 등) */
  ref?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }

export interface Placed { x: number; y: number; z: number }

const TONE_OF: Partial<Record<RevisionStatus, NodeTone>> = { released: 'ok', wip: 'maybe', in_review: 'maybe', obsolete: 'none' };

/**
 * 제품의 BOM 트리를 그래프로 만든다. 같은 품목이 여러 곳에 쓰이면 노드는 하나이고 상위마다 간선을 잇는다.
 * 노드 색은 리비전 상태(승인 · 작업중/검토중 · 폐기)이고, rulesOf 가 알려 주는 조립 규칙 수를 표식으로 단다.
 */
export function productGraph(product: Product, tree: BomNode[], rulesOf: (itemNo: string) => number = () => 0): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge & { qty: number }>();
  const productId = `product:${product.code}`;
  nodes.set(productId, { id: productId, label: product.name, sub: product.code, kind: 'product', tone: 'ok', level: 0 });

  const add = (n: BomNode, parentId: string, depth: number) => {
    const id = n.item.itemNo;
    const hasChildren = n.children.length > 0 || n.item.itemType === 'assembly';
    const known = nodes.get(id);
    if (!known) {
      const rules = rulesOf(id);
      nodes.set(id, {
        id, label: n.item.nameKo ?? n.item.name, sub: id, kind: hasChildren ? 'assembly' : 'part',
        tone: TONE_OF[n.revision?.status ?? 'obsolete'] ?? 'none', level: depth, ref: id, ...(rules > 0 ? { rules } : {}),
      });
    } else if (depth < known.level) known.level = depth;

    const key = `${parentId}>${id}`;
    const e = edges.get(key);
    if (e) e.qty += n.quantity;
    else edges.set(key, { from: parentId, to: id, qty: n.quantity });
    if (!known) n.children.forEach(c => add(c, id, depth + 1));
  };
  tree.forEach(n => add(n, productId, 1));

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].map(({ qty, ...e }) => ({ ...e, ...(qty !== 1 ? { label: `×${qty}` } : {}) })),
  };
}

/** 규칙 하나를 가운데 두고 공정 · 적용 대상 · 공구 · 주의사항 · 쓰이는 품목을 잇는다 */
/** 규칙 그래프가 읽는 것만: 예전 규칙 상세(AssemblyRuleDetail)와 규칙집의 규칙(화면이 모양을 맞춘 것)이 모두 이 모양을 만족한다 */
export type RuleGraphInput = Pick<AssemblyRuleDetail, 'id' | 'name' | 'operationLabel' | 'appliesTo' | 'tools' | 'cautions' | 'usedBy'> & { operation: string };

export function ruleGraph(rule: RuleGraphInput): Graph {
  const id = `rule:${rule.id}`;
  const nodes: GraphNode[] = [{ id, label: rule.id, sub: rule.name, kind: 'rule', tone: 'ok', level: 0 }];
  const edges: GraphEdge[] = [];
  const link = (n: GraphNode, label: string) => { nodes.push(n); edges.push({ from: id, to: n.id, label }); };

  link({ id: `op:${rule.operation}`, label: rule.operationLabel, kind: 'operation', tone: 'ok', level: 1 }, '공정');
  rule.appliesTo.forEach(t => link({ id: `cls:${t}`, label: t, kind: 'class', tone: 'ok', level: 1 }, '적용 대상'));
  rule.tools.forEach(t => link({ id: `tool:${t}`, label: t, kind: 'tool', tone: 'ok', level: 2 }, '공구'));
  rule.cautions.slice(0, 6).forEach((c, i) => link({ id: `cau:${i}`, label: c.length > 16 ? `${c.slice(0, 16)}…` : c, sub: c, kind: 'caution', tone: 'maybe', level: 2 }, '주의'));
  rule.usedBy.slice(0, 10).forEach(u => link({ id: u.itemNo, label: u.name, sub: u.itemNo, kind: 'part', tone: 'ok', level: 3, ref: u.itemNo }, '사용'));
  return { nodes, edges };
}

/**
 * 3D 힘 기반 배치. 연결된 노드는 가깝게, 단계(level)는 중심에서 일정한 거리에 놓는다.
 * 같은 입력이면 항상 같은 모양이 나온다(d3 의 난수는 고정 시드). 미리 계산하고 멈춘다.
 */
export function layout3D(graph: Graph, ringGap = 40): Map<string, Placed> {
  interface N extends SimNode { id: string; level: number }
  const nodes: N[] = graph.nodes.map(n => ({ id: n.id, level: n.level }));
  const links = graph.edges.map(e => ({ source: e.from, target: e.to }));
  // 노드가 많으면 계산을 줄인다: 틱 수를 줄이고(대신 같은 시간에 식도록 냉각을 빠르게), 먼 노드 사이의 반발력과 충돌 계산을 뺀다.
  // 2,000개에서도 몇 초 안에 끝나야 화면이 멈추지 않는다.
  const big = nodes.length > 600;
  const ticks = big ? Math.max(40, Math.round(60000 / nodes.length)) : 320;
  const sim = forceSimulation<N>(nodes, 3).stop();
  (sim as unknown as { alphaDecay(v: number): void }).alphaDecay(1 - Math.pow(0.001, 1 / ticks));
  sim.force('link', forceLink<N>(links).id(n => n.id).distance(ringGap * 0.9).strength(0.35));
  const charge = forceManyBody<N>().strength(-90);
  if (big) charge.distanceMax(ringGap * 5);
  sim.force('charge', charge);
  sim.force('radial', forceRadial<N>(n => n.level * ringGap, 0, 0, 0).strength(0.55));
  if (!big) sim.force('collide', forceCollide<N>(8));
  for (let i = 0; i < ticks; i++) sim.tick();
  return new Map(nodes.map(n => [n.id, { x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0 }]));
}

/** 노드 하나와 직접 이어진 이웃 id (선택 강조용) */
export function neighbors(graph: Graph, id: string): Set<string> {
  const out = new Set<string>();
  graph.edges.forEach(e => { if (e.from === id) out.add(e.to); else if (e.to === id) out.add(e.from); });
  return out;
}

// ---------- 필터 · 사용처 (제품 연결 그래프) ----------
// 간선 방향은 상위 → 하위(from → to)다. 제품이 맨 위(뿌리), 부품이 잎이다.

const parentsMap = (graph: Graph): Map<string, string[]> => {
  const m = new Map<string, string[]>();
  graph.edges.forEach(e => { const list = m.get(e.to); if (list) list.push(e.from); else m.set(e.to, [e.from]); });
  return m;
};

/**
 * 조건에 맞는 노드와 그 **조상(제품까지)** 만 남긴다. 맞는 노드가 하나도 없어도 제품 노드는 남아 그래프가 비지 않는다.
 * 조상은 조건에 안 맞아도 남는다: 그래야 걸러 낸 뒤에도 끊어진 조각이 생기지 않는다.
 */
export function filterGraph(graph: Graph, keep: (node: GraphNode) => boolean): Graph {
  const parents = parentsMap(graph);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const kept = new Set<string>();
  const climb = (id: string) => {
    if (kept.has(id)) return;
    kept.add(id);
    (parents.get(id) ?? []).forEach(climb);
  };
  graph.nodes.forEach(n => { if (n.kind === 'product' || keep(n)) climb(n.id); });
  return {
    nodes: graph.nodes.filter(n => kept.has(n.id) && byId.has(n.id)),
    edges: graph.edges.filter(e => kept.has(e.from) && kept.has(e.to)),
  };
}

/** 이 노드의 모든 조상 id (가까운 상위부터, 중복 없음). 자기 자신은 뺀다 */
export function ancestorsOf(graph: Graph, id: string): string[] {
  const parents = parentsMap(graph);
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    frontier.forEach(cur => (parents.get(cur) ?? []).forEach(p => { if (!seen.has(p)) { seen.add(p); out.push(p); next.push(p); } }));
    frontier = next;
  }
  return out;
}

/**
 * 이 노드에서 제품까지 올라가는 **모든 경로**(사용처 경로). 경로마다 [자기, 상위, …, 뿌리] 순서다.
 * 같은 품목이 여러 조립품에 쓰이면 갈래가 여럿이고, 폭발을 막으려고 limit 개까지만 센다.
 */
export function usagePaths(graph: Graph, id: string, limit = 12): string[][] {
  const parents = parentsMap(graph);
  const out: string[][] = [];
  const walk = (cur: string, path: string[]) => {
    if (out.length >= limit) return;
    const ups = (parents.get(cur) ?? []).filter(p => !path.includes(p));          // 순환 방지
    if (ups.length === 0) { out.push(path); return; }
    ups.forEach(p => walk(p, [...path, p]));
  };
  walk(id, [id]);
  return out;
}
