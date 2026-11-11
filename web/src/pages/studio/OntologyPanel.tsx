import { Link } from 'react-router-dom';
import type { PartInfo } from 'explode-studio';
import type { CadPartMatch } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { useAsync } from '../../hooks/useAsync';
import { ID_SCHEME } from '../../labels';
import { useSession } from '../../session';
import { overviewGraph, partGraph, textWidth, VIEW, type Graph, type GraphNode } from './ontologyGraph';

const STATUS_TEXT = { matched: '보유 품번', suggested: '후보 품번', none: '미보유' } as const;

/** 홀로그램 느낌의 온톨로지 그래프 (SVG). 노드 · 간선은 ontologyGraph.ts 가 배치한다 */
export function OntologyGraph({ graph, label }: { graph: Graph; label: string }) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const box = (n: GraphNode) => {
    const w = Math.max(54, Math.max(textWidth(n.label, 11), n.sub ? textWidth(n.sub, 9) : 0) + 20);
    return { w, h: n.sub ? 38 : 26 };
  };
  return (
    <svg className="onto-svg" viewBox={`0 0 ${VIEW.w} ${VIEW.h}`} role="img" aria-label={label}>
      <defs>
        <filter id="onto-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <marker id="onto-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L8 4 L0 8 z" fill="#0891b2" opacity=".85" />
        </marker>
      </defs>
      <g className="onto-edges">
        {graph.edges.map(e => {
          const a = byId.get(e.from), b = byId.get(e.to);
          if (!a || !b) return null;
          return (
            <g key={`${e.from}-${e.to}`}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={e.dashed ? 'edge edge-dash' : 'edge'} markerEnd="url(#onto-arrow)" />
              {e.label && <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 3} className="edge-label" textAnchor="middle">{e.label}</text>}
            </g>
          );
        })}
      </g>
      <g className="onto-nodes">
        {graph.nodes.map(n => {
          const { w, h } = box(n);
          return (
            <g key={n.id} className={`node node-${n.kind} ${n.tone ? `tone-${n.tone}` : ''}`} transform={`translate(${n.x - w / 2} ${n.y - h / 2})`} data-node={n.kind}>
              <rect width={w} height={h} rx={n.kind === 'center' ? 10 : 7} filter={n.kind === 'center' ? 'url(#onto-glow)' : undefined} />
              <text x={w / 2} y={n.sub ? 16 : 17} textAnchor="middle" className="node-label">{n.label}</text>
              {n.sub && <text x={w / 2} y={30} textAnchor="middle" className="node-sub">{n.sub}</text>}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/**
 * 온톨로지로 보기. 부품을 고르면 그 부품의 분류 사슬 · 재료 · 속성 · 별칭 · 사용처를,
 * 고르지 않으면 모델 전체의 분류 분포를 그래프로 보인다.
 */
export function OntologyPanel({
  model, parts, matches, selectedName, requested, onRequest, onConfirm,
}: {
  model: string;
  parts: PartInfo[];
  matches: Map<string, CadPartMatch>;
  selectedName?: string;
  requested: Map<string, number>;
  onRequest(name: string): void;
  onConfirm(name: string): void;
}) {
  const { api } = useSession();
  const match = selectedName ? matches.get(selectedName) : undefined;
  const itemNo = match && match.status !== 'none' ? match.itemNo : undefined;

  const item = useAsync(async () => {
    if (!itemNo) return undefined;
    const detail = await api.getItem(itemNo);
    const [materials, usedBy] = await Promise.all([api.listMaterials(), api.getWhereUsed(detail.id)]);
    return { detail, materials, usedBy };
  }, [itemNo]);

  let graph: Graph;
  let title: string;
  if (selectedName && match) {
    const detail = item.data?.detail;
    const material = detail?.materialIri ? item.data?.materials.find(m => m.iri === detail.materialIri)?.name : undefined;
    graph = partGraph({
      label: selectedName,
      sub: match.status === 'none' ? STATUS_TEXT.none : `${STATUS_TEXT[match.status]} ${match.itemNo}`,
      tone: match.status === 'matched' ? 'ok' : match.status === 'suggested' ? 'maybe' : 'none',
      classPath: match.classPath ?? [],
      ...(material ? { material } : {}),
      attrs: Object.entries(detail?.attributes ?? {}).map(([k, v]) => [k, String(v)] as [string, string]),
      usedIn: (item.data?.usedBy ?? []).map(w => w.parent.nameKo ?? w.parent.name),
      aliases: (detail?.identifiers ?? []).filter(i => i.scheme !== 'cad_name').map(i => i.value),
    });
    title = selectedName;
  } else {
    const classes = new Map<string, number>();
    [...new Set(parts.map(p => p.name))].forEach(n => {
      const key = matches.get(n)?.classLabel ?? '';
      classes.set(key, (classes.get(key) ?? 0) + 1);
    });
    graph = overviewGraph({ model, total: new Set(parts.map(p => p.name)).size, classes });
    title = model || '모델';
  }

  return (
    <section className="glass-panel onto-panel" aria-label="온톨로지">
      <header className="panel-head">
        <div>
          <h2>온톨로지</h2>
          <p className="panel-sub">{selectedName ? `${title} · 분류 · 재료 · 속성` : '부품을 고르면 그 부품의 온톨로지가 보입니다'}</p>
        </div>
      </header>

      <div className="onto-stage">
        <OntologyGraph graph={graph} label={`${title} 온톨로지 그래프`} />
      </div>

      {selectedName && match && (
        <div className="onto-detail">
          <dl className="props">
            <dt>상태</dt>
            <dd>
              {STATUS_TEXT[match.status]}
              {match.method && <span className="faint"> · {match.method === 'exact' ? '이름 일치' : match.method === 'alias' ? '별칭 일치' : match.method === 'cad_name' ? 'CAD 이름 별칭' : match.method === 'normalized' ? '정규화 일치' : '유사도'} {Math.round((match.score ?? 0) * 100)}%</span>}
            </dd>
            {itemNo && (<><dt>품번</dt><dd><Link to={`/items/${itemNo}`} className="mono">{itemNo}</Link> <span className="muted">{match.itemName}</span></dd></>)}
            <dt>분류</dt>
            <dd>{match.classPath?.length ? match.classPath.join(' › ') : <span className="faint">분류 없음 · OPMS 분류 제안 필요</span>}</dd>
            {item.data?.detail.identifiers.length ? (
              <><dt>별칭</dt><dd className="row">{item.data.detail.identifiers.map(i => <span key={`${i.scheme}${i.value}`} className="chip" title={ID_SCHEME[i.scheme]}>{i.value}</span>)}</dd></>
            ) : null}
          </dl>
          <div className="row onto-actions">
            {match.status === 'suggested' && (
              <button type="button" className="btn btn-sm" onClick={() => onConfirm(selectedName)}><Icon name="check" size={16} />이 품번으로 확정</button>
            )}
            {match.status === 'none' && (requested.has(selectedName)
              ? <span className="chip-holo chip-sent">OPMS 등록 요청 #{requested.get(selectedName)} 전송됨</span>
              : <button type="button" className="btn btn-primary btn-sm" onClick={() => onRequest(selectedName)}><Icon name="outbox" size={16} />OPMS에 등록 요청</button>)}
            {itemNo && <Link to={`/items/${itemNo}`} className="btn btn-sm">품목 상세</Link>}
          </div>
        </div>
      )}
    </section>
  );
}
