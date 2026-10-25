import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BomNode } from '../api/types';
import { ITEM_TYPE, formatNumber } from '../labels';
import { RevisionBadge } from './StatusBadges';
import { ItemName } from './ui';

interface Row { node: BomNode; hasChildren: boolean }

function flatten(nodes: BomNode[], collapsed: Set<number>, out: Row[] = []): Row[] {
  for (const n of nodes) {
    out.push({ node: n, hasChildren: n.children.length > 0 });
    if (!collapsed.has(n.lineId)) flatten(n.children, collapsed, out);
  }
  return out;
}
function allParents(nodes: BomNode[], out: number[] = []): number[] {
  nodes.forEach(n => { if (n.children.length) { out.push(n.lineId); allParents(n.children, out); } });
  return out;
}

/** BOM 정전개 트리. 총수량 = 최상위 1개당 필요 수량 */
export function BomTree({ nodes }: { nodes: BomNode[] }) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const rows = useMemo(() => flatten(nodes, collapsed), [nodes, collapsed]);
  const parents = useMemo(() => allParents(nodes), [nodes]);
  const toggle = (id: number) => setCollapsed(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (!nodes.length) return <div className="empty">이 리비전에는 BOM이 없습니다.</div>;
  return (
    <>
      <div className="row" style={{ padding: '8px 12px' }}>
        <button type="button" className="btn btn-sm" onClick={() => setCollapsed(new Set())}>모두 펼치기</button>
        <button type="button" className="btn btn-sm" onClick={() => setCollapsed(new Set(parents))}>모두 접기</button>
      </div>
      <div className="table-wrap">
        <table className="table" aria-label="BOM">
          <thead>
            <tr>
              <th>도면 번호</th><th>품번</th><th>이름</th><th>구분</th>
              <th className="num">수량</th><th className="num">총수량</th><th>리비전</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, hasChildren }) => (
              <tr key={node.lineId}>
                <td>
                  <span className="tree-cell" title={`${node.depth}단계`}>
                    <span className="tree-pad" style={{ width: (node.depth - 1) * 20 }} />
                    {hasChildren ? (
                      <button
                        type="button" className="tree-toggle" onClick={() => toggle(node.lineId)}
                        aria-label={collapsed.has(node.lineId) ? '펼치기' : '접기'} aria-expanded={!collapsed.has(node.lineId)}
                      >
                        {collapsed.has(node.lineId) ? '▸' : '▾'}
                      </button>
                    ) : <span className="tree-pad" style={{ width: 24 }} />}
                    <span className="mono">{node.findNo ?? '—'}</span>
                  </span>
                </td>
                <td><Link className="mono" to={`/items/${node.item.itemNo}`}>{node.item.itemNo}</Link></td>
                <td><ItemName name={node.item.name} nameKo={node.item.nameKo} /></td>
                <td>{ITEM_TYPE[node.item.itemType]}</td>
                <td className="num">{formatNumber(node.quantity)}</td>
                <td className="num">{formatNumber(node.totalQuantity)}</td>
                <td><RevisionBadge revision={node.revision} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
