import { useMemo } from 'react';
import type { Graph, GraphNode, NodeKind, NodeTone } from './graphData';
import './graph.css';

export interface GraphListProps {
  graph: Graph;
  selectedId?: string | null;
  onSelect(id: string | null): void;
  /** 접근성 이름 */
  label: string;
}

const KIND_LABEL: Record<NodeKind, string> = {
  product: '제품', assembly: '조립품', part: '부품', rule: '규칙', operation: '공정', class: '분류', tool: '공구', caution: '주의',
  change: '변경', workorder: '작업지시', purchase: '발주', stock: '재고', joint: '체결부',
};
const TONE_TEXT: Record<NodeTone, string> = {
  ok: '정상', maybe: '확인', none: '비활성',
  impact_none: '영향 없음', impact_review: '확인 필요', impact_affected: '처분 필요', impact_blocked: '막힘',
};
const TONE_CLASS: Record<NodeTone, string> = {
  ok: 'tone-success', maybe: 'tone-warning', none: 'tone-neutral',
  impact_none: 'tone-neutral', impact_review: 'tone-info', impact_affected: 'tone-warning', impact_blocked: 'tone-danger',
};

interface Entry {
  node: GraphNode;
  /** 부모에서 이 노드로 오는 간선 이름 (수량 등) */
  edge?: string;
  /** 위에서 이미 펼친 노드를 다시 만난 것 */
  repeat: boolean;
  children: Entry[];
}

/** 간선 방향(from → to)을 따라 level 순으로 트리를 만든다. 두 번째로 만난 노드는 펼치지 않고 표시만 한다. 닿지 않는 노드는 따로 뿌리가 된다 */
export function buildTree(graph: Graph): Entry[] {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const out = new Map<string, { to: string; label?: string }[]>();
  graph.edges.forEach(e => {
    if (!byId.has(e.from) || !byId.has(e.to)) return;
    const list = out.get(e.from) ?? [];
    list.push({ to: e.to, ...(e.label ? { label: e.label } : {}) });
    out.set(e.from, list);
  });
  const hasParent = new Set(graph.edges.filter(e => byId.has(e.from) && byId.has(e.to)).map(e => e.to));
  const order = [...graph.nodes].sort((a, b) => a.level - b.level);
  const seen = new Set<string>();

  const expand = (node: GraphNode, edge?: string): Entry => {
    if (seen.has(node.id)) return { node, ...(edge ? { edge } : {}), repeat: true, children: [] };
    seen.add(node.id);
    const kids = (out.get(node.id) ?? [])
      .map(c => ({ node: byId.get(c.to)!, label: c.label }))
      .sort((a, b) => a.node.level - b.node.level);
    return { node, ...(edge ? { edge } : {}), repeat: false, children: kids.map(k => expand(k.node, k.label)) };
  };

  const roots: Entry[] = [];
  order.forEach(n => { if (!hasParent.has(n.id)) roots.push(expand(n)); });
  order.forEach(n => { if (!seen.has(n.id)) roots.push(expand(n)); });               // 순환이나 거꾸로 이어진 노드 (앞에서 펼친 것은 건너뛴다)
  return roots;
}

function Rows({ entries, selectedId, onSelect }: { entries: Entry[]; selectedId: string | null; onSelect(id: string): void }) {
  return (
    <ul>
      {entries.map(e => {
        const n = e.node;
        const on = n.id === selectedId;
        return (
          <li key={`${n.id}${e.repeat ? '*' : ''}${e.edge ?? ''}`}>
            <button type="button" className={`graph-row ${on ? 'graph-row-on' : ''} ${e.repeat ? 'graph-row-repeat' : ''}`}
              aria-current={on ? 'true' : undefined} onClick={() => onSelect(n.id)}>
              <span className="graph-row-kind">{KIND_LABEL[n.kind]}</span>
              <span className="graph-row-name">
                {n.label}
                {n.sub && <small className="mono">{n.sub}</small>}
              </span>
              {e.edge && <span className="graph-row-edge mono" title="수량">{e.edge}</span>}
              {e.repeat && <span className="graph-row-up">→ 위에 있음</span>}
              {(n.rules ?? 0) > 0 && <span className="graph-row-rule" title="연결된 조립 규칙">규칙 {n.rules}</span>}
              <span className={`badge ${TONE_CLASS[n.tone]}`}>{TONE_TEXT[n.tone]}</span>
            </button>
            {e.children.length > 0 && <Rows entries={e.children} selectedId={selectedId} onSelect={onSelect} />}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 3D 그래프와 같은 정보를 키보드로 읽는 목록(트리). 항목은 모두 버튼이고, 고른 항목에 aria-current 가 붙는다.
 * 같은 노드가 여러 곳에 쓰이면 첫 곳에서만 아래를 펼치고 나머지는 "→ 위에 있음"으로 표시한다.
 */
export function GraphList({ graph, selectedId = null, onSelect, label }: GraphListProps) {
  const tree = useMemo(() => buildTree(graph), [graph]);
  return (
    <div className="graph-list" role="group" aria-label={label}>
      <Rows entries={tree} selectedId={selectedId} onSelect={id => onSelect(id)} />
    </div>
  );
}
