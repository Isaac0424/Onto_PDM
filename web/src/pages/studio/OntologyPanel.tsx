import type { PartInfo } from 'explode-studio';
import type { CadPartMatch, OpmsPartInfo } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { NotConnected } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { ID_SCHEME } from '../../labels';
import { useSession } from '../../session';
import { overviewGraph, partGraph, textWidth, VIEW, type Graph, type GraphNode } from './ontologyGraph';

const STATUS_TEXT = { matched: '보유 품번', suggested: '후보 품번', none: '미보유' } as const;

/** 매칭 상태 문구. 보유 품번은 확정한 규격으로 찾으므로 규격이 없거나 OPMS 를 못 읽은 것은 '미보유'가 아니다 */
function statusOf(m: CadPartMatch): string {
  if (m.status === 'none' && m.reason === 'needs_values') return '규격 확정 필요';
  if (m.status === 'none' && m.reason === 'unreachable') return 'OPMS 연결 안 됨';
  if (m.estimated) return m.status === 'none' ? '미보유 · 추정 규격' : `${STATUS_TEXT[m.status]} · 추정`;
  return STATUS_TEXT[m.status];
}

/** 확정 전에 CAD 형상 추정 규격으로 찾았다는 한 줄 안내 */
function estimateNote(m: CadPartMatch): string | undefined {
  const e = m.estimated;
  if (!e) return undefined;
  const spec = [e.threadSize, e.length !== undefined ? `${e.length} mm` : undefined].filter(Boolean).join(' · ');
  return `CAD 형상에서 ${spec} 로 추정해 찾았어요. 규격을 확정하면 더 정확해져요${e.unitAssumed ? ' (파일에 단위 정보가 없어 mm 로 가정한 값이에요)' : ''}`;
}

type Why = NonNullable<NonNullable<CadPartMatch['candidates']>[number]['matched']>[number];

/** 보유 품번 후보 하나의 일치 근거 한 조각 (hit=null 은 값이 없어 비교하지 않았다) */
function whyOf(m: Why): { key: string; className: string; text: string } | undefined {
  if (m.hit === null) return undefined;
  return m.hit
    ? { key: m.label, className: 'why-hit', text: `${m.label} ${m.part ?? m.doc ?? ''} 일치` }
    : { key: m.label, className: 'why-miss', text: `${m.label} ${m.doc ?? ''} ≠ ${m.part ?? ''}` };
}

/** 값이 한쪽에 없어 비교하지 못한 속성 이름. 점수는 비교한 속성만으로 계산되므로(길이 없이 규격만 같아도 100%) 이것을 같이 보여 줘야 한다 */
const unverifiedOf = (matched: Why[] | undefined): string[] => (matched ?? []).filter(m => m.hit === null).map(m => m.label);

/**
 * 후보 한 줄의 주 표시. 퍼센트가 아니라 "확인한 K개 속성이 모두 일치 · 미확인 M개(길이, 재질)"로 말한다:
 * 점수는 양쪽에 값이 있는 속성만 비교해서 길이가 없어도 100% 가 되므로, 미확인이 하나라도 있으면 '100% 일치'라고 하지 않는다.
 * 가중 점수 퍼센트는 툴팁에만 둔다. 비교한 속성 정보가 없는 응답(matched 없음)만 퍼센트로 말한다.
 */
export function compareLine(c: NonNullable<CadPartMatch['candidates']>[number]): { text: string; title: string } {
  const pct = Math.round(c.score * 100);
  const compared = (c.matched ?? []).filter(m => m.hit !== null);
  const unverified = unverifiedOf(c.matched);
  const tail = c.classCapped ? ' · 다른 분류' : '';
  if (compared.length === 0) {
    return c.matched === undefined
      ? { text: `${pct}% 일치${tail}`, title: '비교한 속성 정보가 없는 응답이라 점수로만 말해요' }
      : { text: `비교한 속성 없음${unverified.length ? ` · 미확인 ${unverified.length}개(${unverified.join(', ')})` : ''}${tail}`, title: '양쪽에 값이 있는 속성이 없어요' };
  }
  const hits = compared.filter(m => m.hit).length;
  const agree = hits === compared.length ? `확인한 ${compared.length}개 속성이 모두 일치` : `확인한 ${compared.length}개 중 ${hits}개 일치`;
  const rest = unverified.length ? ` · 미확인 ${unverified.length}개(${unverified.join(', ')})` : '';
  return { text: `${agree}${rest}${tail}`, title: `가중 점수 ${pct}% — 양쪽에 값이 있는 속성만 비교한 점수예요${unverified.length ? '. 미확인 속성은 비교하지 않았어요' : ''}` };
}

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
  model, parts, matches, selectedName, onConfirm,
}: {
  model: string;
  parts: PartInfo[];
  matches: Map<string, CadPartMatch>;
  selectedName?: string;
  /** 후보 중 하나를 고르면 itemNo 가 함께 온다 */
  onConfirm(name: string, itemNo?: string): void;
}) {
  const { api } = useSession();
  const match = selectedName ? matches.get(selectedName) : undefined;
  const itemNo = match && match.status !== 'none' ? match.itemNo : undefined;

  // OPMS 를 읽는 길이 있으면 OPMS 부품(분류 · 속성)을, 아니면 품목 API 를 읽는다. 둘 다 없으면 읽을 곳이 없다
  const readable = api.connected || !!api.opms;
  const opmsPart = useAsync<OpmsPartInfo | undefined>(
    async () => (api.opms && itemNo ? api.opms.getPart(itemNo).catch(() => undefined) : undefined), [itemNo]);
  const item = useAsync(async () => {
    if (api.opms || !api.connected || !itemNo) return undefined;
    const detail = await api.getItem(itemNo);
    const [materials, usedBy] = await Promise.all([api.listMaterials(), api.getWhereUsed(detail.id)]);
    return { detail, materials, usedBy };
  }, [itemNo]);

  let graph: Graph;
  let title: string;
  if (selectedName && match) {
    const detail = item.data?.detail;
    const part = opmsPart.data;
    const material = part ? part.valueLabels.material : detail?.materialIri ? item.data?.materials.find(m => m.iri === detail.materialIri)?.name : undefined;
    graph = partGraph({
      label: selectedName,
      sub: match.status === 'none' ? statusOf(match) : `${STATUS_TEXT[match.status]} ${match.itemNo}${match.estimated ? ' · 추정' : ''}`,
      tone: match.status === 'matched' ? 'ok' : match.status === 'suggested' ? 'maybe' : 'none',
      classPath: match.classPath ?? [],
      ...(material ? { material } : {}),
      attrs: part
        ? part.properties.filter(x => x.key !== 'material').map(x => [x.label, x.text] as [string, string])
        : Object.entries(detail?.attributes ?? {}).map(([k, v]) => [k, String(v)] as [string, string]),
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

  if (!readable) {
    return (
      <section className="glass-panel onto-panel" aria-label="온톨로지">
        <header className="panel-head">
          <div>
            <h2>온톨로지</h2>
            <p className="panel-sub">부품의 분류 · 재료 · 속성을 온톨로지로 봅니다</p>
          </div>
        </header>
        <NotConnected compact title="온톨로지를 읽을 곳이 없어요" hint="OPMS에 연결되면 부품의 분류 · 재료 · 속성이 그래프로 표시돼요. 형상으로 본 볼트 종류는 속성 탭에서 볼 수 있어요." />
      </section>
    );
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
              {statusOf(match)}
              {match.method && (
                // 규격으로 찾은 후보의 점수는 양쪽에 값이 있는 속성만 비교한 것이라 길이가 없어도 100% 가 된다: 퍼센트는 툴팁에만 두고 본문에는 쓰지 않는다
                match.method === 'attributes'
                  ? <span className="faint" title={`가중 점수 ${Math.round((match.score ?? 0) * 100)}% — 양쪽에 값이 있는 속성만 비교한 점수예요`}> · 규격 일치(나사 규격 · 길이 · 머리 모양)</span>
                  : <span className="faint"> · {match.method === 'exact' ? '이름 일치' : match.method === 'alias' ? '별칭 일치' : match.method === 'cad_name' ? 'CAD 이름 별칭' : match.method === 'normalized' ? '정규화 일치' : '유사도'} {Math.round((match.score ?? 0) * 100)}%</span>
              )}
            </dd>
            {itemNo && (<><dt>품번</dt><dd><span className="mono">{itemNo}</span> <span className="muted">{match.itemName}</span></dd></>)}
            <dt>분류</dt>
            <dd>{match.classPath?.length ? match.classPath.join(' › ') : <span className="faint">{match.reason === 'needs_values' ? 'CAD로 규격을 추정하지 못했어요 — 속성 탭에서 확정하면 찾아요' : match.reason === 'unreachable' ? 'OPMS를 읽지 못했어요' : '분류 없음 · OPMS 분류 제안 필요'}</span>}</dd>
            {item.data?.detail.identifiers.length ? (
              <><dt>별칭</dt><dd className="row">{item.data.detail.identifiers.map(i => <span key={`${i.scheme}${i.value}`} className="chip" title={ID_SCHEME[i.scheme]}>{i.value}</span>)}</dd></>
            ) : null}
          </dl>
          {estimateNote(match) && <p className="cand-estimate" role="note">{estimateNote(match)}</p>}
          {match.status === 'suggested' && match.candidates && match.candidates.length > 0 ? (
            <>
              <ul className="cand-list" aria-label="보유 품번 후보">
                {match.candidates.map(c => (
                  <li key={c.itemNo} className="cand">
                    <span className="cand-name"><span className="mono">{c.itemNo}</span> {c.itemName}</span>
                    <button type="button" className="btn btn-sm" aria-label={`${c.itemNo} 이 품번으로 확정`} onClick={() => onConfirm(selectedName, c.itemNo)}>
                      <Icon name="check" size={16} />확정
                    </button>
                    <span className="cand-score" title={compareLine(c).title}>{compareLine(c).text}</span>
                    <ul className="cand-why" aria-label={`${c.itemNo} 일치 근거`}>
                      {(c.matched ?? []).map(whyOf).flatMap(w => (w ? [<li key={w.key} className={w.className}>{w.text}</li>] : []))}
                    </ul>
                  </li>
                ))}
              </ul>
              <p className="cand-note">CAD에서 읽은 값은 근사라 후보까지만 돼요. 하나를 고르면 이 부품을 그 품번으로 봐요.</p>
            </>
          ) : (
            <div className="row onto-actions">
              {match.status === 'suggested' && (
                <button type="button" className="btn btn-sm" onClick={() => onConfirm(selectedName)}><Icon name="check" size={16} />이 품번으로 확정</button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
