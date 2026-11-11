// 온톨로지 그래프의 노드 · 간선 배치 (순수 함수). 화면은 OntologyPanel 이 SVG 로 그린다.
// 부품을 고르면 그 부품 중심으로, 고르지 않으면 모델 전체의 분류 분포를 보인다.

export type NodeKind = 'center' | 'class' | 'material' | 'attr' | 'used' | 'alias' | 'group';
export type Tone = 'ok' | 'maybe' | 'none';

export interface GraphNode {
  id: string;
  label: string;
  sub?: string;
  kind: NodeKind;
  tone?: Tone;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const VIEW = { w: 460, h: 300 };
const CX = VIEW.w / 2;
const CY = VIEW.h / 2;

/** 글자 폭 근사 (한글은 넓고 영문 · 숫자는 좁다). 노드 상자 크기에 쓴다 */
export function textWidth(s: string, size = 11): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? size * 1.02 : size * 0.58;
  return w;
}

function spread(count: number, from: number, to: number): number[] {
  if (count <= 1) return [(from + to) / 2];
  return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
}

export interface PartGraphInput {
  label: string;
  sub?: string;
  tone: Tone;
  classPath: string[];
  material?: string;
  attrs: [string, string][];
  usedIn: string[];
  aliases: string[];
}

/** 부품 하나: 왼쪽에 분류 사슬(위가 상위), 오른쪽에 재료 · 속성, 위에 별칭, 아래에 사용처 */
export function partGraph(input: PartGraphInput): Graph {
  const nodes: GraphNode[] = [{ id: 'part', label: input.label, ...(input.sub ? { sub: input.sub } : {}), kind: 'center', tone: input.tone, x: CX, y: CY }];
  const edges: GraphEdge[] = [];

  const classYs = spread(input.classPath.length, 52, 248);
  input.classPath.forEach((name, i) => {
    nodes.push({ id: `c${i}`, label: name, kind: 'class', x: 70, y: classYs[i]! });
    if (i > 0) edges.push({ from: `c${i - 1}`, to: `c${i}`, ...(i === 1 ? { label: 'subClassOf' } : {}) });
  });
  if (input.classPath.length) {
    edges.push({ from: 'part', to: `c${input.classPath.length - 1}`, label: 'instanceOf', ...(input.tone === 'none' ? { dashed: true } : {}) });
  } else {
    // 분류가 없으면 빈 자리를 점선 노드로 보여 준다 (OPMS 분류 제안으로 채운다)
    nodes.push({ id: 'c0', label: '분류 미정', sub: 'OPMS 분류 제안', kind: 'class', tone: 'none', x: 70, y: CY });
    edges.push({ from: 'part', to: 'c0', label: 'instanceOf?', dashed: true });
  }

  const right: GraphNode[] = [];
  if (input.material) right.push({ id: 'm', label: input.material, kind: 'material', x: 388, y: 0 });
  input.attrs.slice(0, 3).forEach(([k, v], i) => right.push({ id: `a${i}`, label: `${k} ${v}`, kind: 'attr', x: 388, y: 0 }));
  const rightYs = spread(right.length, 70, 230);
  right.forEach((n, i) => {
    n.y = rightYs[i]!;
    nodes.push(n);
    edges.push({ from: 'part', to: n.id, ...(n.kind === 'material' ? { label: 'material' } : {}) });
  });

  const aliasXs = spread(Math.min(input.aliases.length, 2), 170, 290);
  input.aliases.slice(0, 2).forEach((a, i) => {
    nodes.push({ id: `l${i}`, label: a, kind: 'alias', x: aliasXs[i]!, y: 26 });
    edges.push({ from: 'part', to: `l${i}`, dashed: true });
  });

  const usedXs = spread(Math.min(input.usedIn.length, 3), 150, 310);
  input.usedIn.slice(0, 3).forEach((u, i) => {
    nodes.push({ id: `u${i}`, label: u, kind: 'used', x: usedXs[i]!, y: 276 });
    edges.push({ from: `u${i}`, to: 'part', ...(i === 0 ? { label: 'contains' } : {}) });
  });

  return { nodes, edges };
}

export interface OverviewInput {
  model: string;
  total: number;
  /** 분류 이름 → 부품 종류 수. 분류가 없으면 key '' */
  classes: Map<string, number>;
}

/** 모델 전체: 가운데 모델, 둘레에 부품 분류 (분류 미정은 점선) */
export function overviewGraph(input: OverviewInput): Graph {
  const entries = [...input.classes.entries()].sort((a, b) => b[1] - a[1] || Number(a[0] === '') - Number(b[0] === '') || a[0].localeCompare(b[0])).slice(0, 8);
  const nodes: GraphNode[] = [{ id: 'model', label: input.model || '모델', sub: `부품 ${input.total}종`, kind: 'center', tone: 'ok', x: CX, y: CY }];
  const edges: GraphEdge[] = [];
  entries.forEach(([name, n], i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / entries.length;
    const id = `g${i}`;
    nodes.push({ id, label: name || '분류 미정', sub: `${n}종`, kind: name ? 'group' : 'class', x: CX + Math.cos(angle) * 178, y: CY + Math.sin(angle) * 108 });
    edges.push({ from: 'model', to: id, ...(name ? {} : { dashed: true }) });
  });
  return { nodes, edges };
}
