// 3D 그래프가 three 없이도 쓸 수 있는 부분: 속성 계약, 색, 같은 그래프인지 판별.
// three 를 가져오는 장면 구현(Graph3DScene.tsx)과 분리해 두어, 그래프 화면을 열 때만 three 를 내려받게 한다.
import type { Graph, NodeKind, NodeTone } from './graphData';

export interface Graph3DProps {
  graph: Graph;
  /** 선택된 노드 id. 없으면 null */
  selectedId?: string | null;
  /** 노드를 누르면 그 id, 빈 곳을 누르면 null */
  onSelect(id: string | null): void;
  /** 접근성 이름 (role=img 의 aria-label) */
  label: string;
  /** WebGL 을 쓸 수 없을 때(테스트 · 구형 기기) 한 번 부른다. 부모는 목록 보기로 바꾼다 */
  onUnsupported?(): void;
}

/** 노드 종류 · 상태 색. 범례(.graph-legend)의 점 색(graph.css)과 같다. 빨강 계열은 쓰지 않는다(영향 그래프의 impact_blocked 만 예외: 오류 · 위험 전용) */
export const KIND_COLOR: Record<NodeKind, string> = {
  product: '#0891b2', assembly: '#2563eb', part: '#059669', rule: '#7c3aed', operation: '#0ea5e9', class: '#a78bfa', tool: '#0d9488', caution: '#f59e0b',
  change: '#4f46e5', workorder: '#0284c7', purchase: '#8b5cf6', stock: '#14b8a6', joint: '#64748b',
};
export const TONE_COLOR: Record<NodeTone, string> = {
  ok: '#059669', maybe: '#d97706', none: '#94a3b8',
  impact_none: '#94a3b8', impact_review: '#d97706', impact_affected: '#ea580c', impact_blocked: '#dc2626',
};

/** 같은 그래프인지 (부모가 매 렌더마다 새 객체를 만들어도 장면을 다시 만들지 않기 위해) */
export function graphKey(g: Graph): string {
  return g.nodes.map(n => `${n.id}|${n.kind}|${n.tone}|${n.level}|${n.rules ?? 0}|${n.label}`).join('\n') + '\n#\n' + g.edges.map(e => `${e.from}>${e.to}|${e.label ?? ''}`).join('\n');
}
