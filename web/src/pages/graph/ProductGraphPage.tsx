// 제품 연결 그래프: 제품 → 조립품 → 부품이 BOM 관계로 이어진 3D 그래프와, 고른 노드에 묶인 문서 · 조립 규칙.
// 디자인은 CAD 스튜디오(studio.css)와 같다: 밝은 글래스 + 시안 홀로그램.
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  AssemblyGuide, AssemblyPartInput, BomNode, BomRule, DocType, DocumentLink, ItemDetail, ItemSummary, PdmApi, Product, Revision, TaxonomyClass,
} from '../../api/types';
import { Icon } from '../../components/AppShell';
import { RevisionBadge } from '../../components/StatusBadges';
import { Badge, Loaded } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { DOC_TYPE, ITEM_TYPE, formatNumber } from '../../labels';
import { useSession } from '../../session';
import '../studio/studio.css';
import { Graph3D } from './Graph3D';
import { GraphList } from './GraphList';
import { DEFAULT_FILTERS, GraphFilters, filtersActive, type GraphFilterState, type OperationOption } from './GraphFilters';
import { filterGraph, productGraph, usagePaths, type Graph, type GraphNode } from './graphData';
import './productGraph.css';

type Bundle =
  | { missing: true }
  | {
      missing: false;
      product: Product;
      root: ItemDetail;
      rootRevision?: Revision;
      /** 루트(최상위 조립품)를 뿌리로 한 BOM 트리 */
      tree: BomNode;
      /** 품목(품번)별 적용되는 조립 규칙. 규칙은 이름 · 분류 · 속성으로 걸리므로 품번마다 따로 물어본다 */
      guides: Map<string, AssemblyGuide>;
      docs: Map<string, DocumentLink[]>;
      classes: TaxonomyClass[];
    };

/** BOM 기준에 맞는 최상위 조립품 리비전: 승인본이면 최신 승인본(없으면 보이는 최신), 최신이면 폐기를 뺀 최신 */
function pickRevision(root: ItemDetail, rule: BomRule): Revision | undefined {
  const live = root.revisions.filter(r => r.status !== 'obsolete');           // revisions 는 최신이 앞이다
  if (rule === 'released') return root.releasedRevision ?? live[0] ?? root.latestRevision;
  return live[0] ?? root.latestRevision;
}

const nameOf = (n: { nameKo?: string; name: string }) => n.nameKo ?? n.name;

function flatten(node: BomNode, out: BomNode[] = []): BomNode[] {
  out.push(node);
  node.children.forEach(c => flatten(c, out));
  return out;
}

/** 조립 규칙을 묻는 입력: 이름과 분류 이름, 숫자 · 문자 속성. 같은 이름이어도 분류가 다르면 다른 질문이다 */
function guideInput(item: ItemSummary, classes: TaxonomyClass[]): AssemblyPartInput {
  const className = classes.find(c => c.iri === item.classIri)?.labelKo;
  const attributes = Object.fromEntries(Object.entries(item.attributes ?? {}).filter(([, v]) => typeof v === 'string' || typeof v === 'number'));
  return {
    name: nameOf(item),
    ...(className ? { className } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
  };
}

async function loadBundle(api: PdmApi, code: string, rule: BomRule): Promise<Bundle> {
  const product = (await api.listProducts()).find(p => p.code === code);
  if (!product) return { missing: true };
  const [root, classes] = await Promise.all([api.getItem(product.rootItemNo), api.listClasses()]);
  const rootRevision = pickRevision(root, rule);
  const children = rootRevision ? await api.getBom(rootRevision.id, rule) : [];
  const tree: BomNode = { lineId: 0, depth: 0, quantity: 1, totalQuantity: 1, item: root, ...(rootRevision ? { revision: rootRevision } : {}), children };

  const nodes = flatten(tree);
  // 같은 질문(이름 + 분류 + 속성)은 한 번만 묻고, 그 질문에 해당하는 품번 모두에게 답을 나눈다
  const asks = new Map<string, { input: AssemblyPartInput; itemNos: Set<string> }>();
  nodes.forEach(n => {
    const input = guideInput(n.item, classes);
    const key = JSON.stringify(input);
    const ask = asks.get(key) ?? { input, itemNos: new Set<string>() };
    ask.itemNos.add(n.item.itemNo);
    asks.set(key, ask);
  });
  const guides = new Map<string, AssemblyGuide>();
  await Promise.all([...asks.values()].map(async ask => {
    const [g] = await api.getAssemblyGuides([ask.input]);
    if (g) ask.itemNos.forEach(no => guides.set(no, g));
  }));

  // 품목마다 연결된 문서 (리비전은 BOM 규칙이 정한 것). 보이지 않는 리비전은 문서가 없는 것으로 본다
  const docs = new Map<string, DocumentLink[]>();
  await Promise.all(nodes.filter(n => n.revision).map(async n => {
    docs.set(n.item.itemNo, await api.getDocuments(n.revision!.id).catch(() => []));
  }));
  return { missing: false, product, root, ...(rootRevision ? { rootRevision } : {}), tree, guides, docs, classes };
}

function classPath(classes: TaxonomyClass[], iri?: string): string[] {
  const out: string[] = [];
  for (let c = classes.find(x => x.iri === iri); c; c = classes.find(x => x.iri === c!.parentIri)) out.unshift(c.labelKo);
  return out;
}

const DOC_ORDER: DocType[] = ['cad_3d', 'drawing', 'spec', 'manual', 'bom_sheet', 'other'];

function groupDocs(links: DocumentLink[]): [DocType, DocumentLink[]][] {
  const byType = new Map<DocType, DocumentLink[]>();
  links.filter(l => l.status !== 'rejected').forEach(l => byType.set(l.docType, [...(byType.get(l.docType) ?? []), l]));
  return DOC_ORDER.filter(t => byType.has(t)).map(t => [t, byType.get(t)!]);
}

function DocGroups({ links }: { links: DocumentLink[] }) {
  const groups = groupDocs(links);
  if (groups.length === 0) return <p className="faint pg-none">연결된 문서가 없습니다.</p>;
  return (
    <div className="pg-docs">
      {groups.map(([type, rows]) => (
        <section key={type} aria-label={`${DOC_TYPE[type]} ${rows.length}건`}>
          <h4>{DOC_TYPE[type]} <span className="faint">{rows.length}</span></h4>
          <ul>
            {rows.map(d => (
              <li key={d.documentId}>
                <span className="mono">{d.docNo}</span>
                <span className="pg-doc-title">{d.title}</span>
                <span className="faint mono">{d.rev}</span>
                {d.status === 'suggested' && <Badge tone="warning">제안</Badge>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const LEGEND = [
  { key: 'ok', label: '승인' }, { key: 'maybe', label: '작업중 · 검토중' }, { key: 'none', label: '폐기' },
] as const;

export function ProductGraphPage() {
  const { code = '' } = useParams();
  const { api } = useSession();
  const [rule, setRule] = useState<BomRule>('released');
  const bundle = useAsync(() => loadBundle(api, code, rule), [api, code, rule]);

  return (
    <div className="pg-page">
      <div className="holo-backdrop" aria-hidden />
      <Loaded state={bundle}>
        {b => b.missing
          ? <NotFound code={code} />
          : <ProductView key={b.product.id} bundle={b} rule={rule} onRule={setRule} />}
      </Loaded>
    </div>
  );
}

function NotFound({ code }: { code: string }) {
  return (
    <div className="banner banner-warning" role="alert">
      제품 <span className="mono">{code}</span>을(를) 찾을 수 없습니다. <Link to="/products">제품 목록으로</Link>
    </div>
  );
}

function ProductView({ bundle, rule, onRule }: { bundle: Extract<Bundle, { missing: false }>; rule: BomRule; onRule(r: BomRule): void }) {
  const { product, root, rootRevision, tree, guides, docs, classes } = bundle;
  const [view, setView] = useState<'3d' | 'list'>('3d');
  const [unsupported, setUnsupported] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [depth, setDepth] = useState<number | 'all'>('all');
  const [filters, setFilters] = useState<GraphFilterState>(DEFAULT_FILTERS);

  // 같은 품목이 여러 곳에 쓰이면 한 노드로 보고, 루트 1개당 총수량은 모두 더한다
  const info = useMemo(() => {
    const byNo = new Map<string, { node: BomNode; total: number; parents: Set<string> }>();
    const walk = (n: BomNode, parent?: BomNode) => {
      const rec = byNo.get(n.item.itemNo) ?? { node: n, total: 0, parents: new Set<string>() };
      rec.total += n.totalQuantity;
      if (parent) rec.parents.add(nameOf(parent.item));
      byNo.set(n.item.itemNo, rec);
      n.children.forEach(c => walk(c, n));
    };
    walk(tree);
    return byNo;
  }, [tree]);

  const fullGraph = useMemo(() => productGraph(product, [tree], itemNo => (guides.has(itemNo) ? 1 : 0)), [product, tree, guides]);

  const maxLevel = Math.max(1, ...fullGraph.nodes.map(n => n.level));
  const limit = depth === 'all' ? maxLevel : Math.min(depth, maxLevel);
  const depthGraph: Graph = useMemo(() => {
    const nodes = fullGraph.nodes.filter(n => n.level <= limit);
    const ids = new Set(nodes.map(n => n.id));
    return { nodes, edges: fullGraph.edges.filter(e => ids.has(e.from) && ids.has(e.to)) };
  }, [fullGraph, limit]);

  // 필터: 걸러 낸 노드는 빼되 조상(제품까지)은 남긴다. 걸러지는 것이 없으면 같은 객체를 써서 3D 를 다시 만들지 않는다
  const active = filtersActive(filters);
  const graph: Graph = useMemo(() => {
    if (!active) return depthGraph;
    return filterGraph(depthGraph, n => {
      if (!filters.tones.has(n.tone)) return false;
      const g = guides.get(n.id);
      if (filters.rules === 'with' && !g) return false;
      if (filters.rules === 'without' && g) return false;
      if (filters.operations.size > 0 && !(g && filters.operations.has(g.operation))) return false;
      return true;
    });
  }, [active, depthGraph, filters, guides]);

  const operations: OperationOption[] = useMemo(() => {
    const m = new Map<string, OperationOption>();
    fullGraph.nodes.forEach(n => {
      const g = n.kind === 'product' ? undefined : guides.get(n.id);
      if (g) m.set(g.operation, { key: g.operation, label: g.operationLabel, count: (m.get(g.operation)?.count ?? 0) + 1 });
    });
    return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [fullGraph, guides]);

  const selected = fullGraph.nodes.find(n => n.id === selectedId) ?? null;
  const showList = view === 'list' || unsupported;
  const selectedVisible = selectedId !== null && graph.nodes.some(n => n.id === selectedId);

  const items = fullGraph.nodes.filter(n => n.kind !== 'product');
  const count = {
    part: items.filter(n => n.kind === 'part').length,
    assembly: items.filter(n => n.kind === 'assembly').length,
    ok: items.filter(n => n.tone === 'ok').length,
    maybe: items.filter(n => n.tone === 'maybe').length,
    none: items.filter(n => n.tone === 'none').length,
    ruled: items.filter(n => (n.rules ?? 0) > 0).length,
  };
  const shownItems = graph.nodes.filter(n => n.kind !== 'product').length;

  return (
    <>
      <header className="holo-head pg-head">
        <div>
          <p className="holo-eyebrow">제품 연결 · BOM · 문서 · 규칙</p>
          <h1>{product.name}</h1>
          <p className="pg-sub">
            <span className="mono">{product.code}</span> · 최상위 조립품 <span className="mono">{root.itemNo}</span>
            {rootRevision && <> <RevisionBadge revision={rootRevision} /></>}
          </p>
        </div>
        <div className="row holo-actions">
          <div className="seg" role="group" aria-label="BOM 기준">
            {([['released', '승인본'], ['latest', '최신']] as const).map(([key, label]) => (
              <button key={key} type="button" aria-pressed={rule === key} onClick={() => onRule(key)}>{label}</button>
            ))}
          </div>
          <label className="pg-depth">
            <span className="faint">단계</span>
            <select className="select" aria-label="단계" value={depth === 'all' ? 'all' : String(depth)}
              onChange={e => setDepth(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
              <option value="all">전체</option>
              {Array.from({ length: maxLevel }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}단계까지</option>)}
            </select>
          </label>
          <div className="seg" role="group" aria-label="보기">
            <button type="button" aria-pressed={!showList} disabled={unsupported} onClick={() => setView('3d')}><Icon name="view_in_ar" size={14} />3D</button>
            <button type="button" aria-pressed={showList} onClick={() => setView('list')}><Icon name="account_tree" size={14} />목록</button>
          </div>
          <Link className="btn btn-sm btn-primary" to={`/mes?product=${encodeURIComponent(product.code)}&rule=${rule}`}>
            <Icon name="assignment" size={14} />작업 표준
          </Link>
        </div>
      </header>

      <div className="pg-chips" role="group" aria-label="요약">
        <span className="chip-holo chip-none">부품 {count.part}종</span>
        <span className="chip-holo chip-none">조립품 {count.assembly}개</span>
        <span className="chip-holo chip-ok">승인 {count.ok}</span>
        <span className="chip-holo chip-maybe">작업중 · 검토중 {count.maybe}</span>
        <span className="chip-holo chip-none">폐기 {count.none}</span>
        <span className="chip-holo chip-sent"><Icon name="rule" size={12} />조립 규칙 연결 {count.ruled}</span>
      </div>

      <GraphFilters
        filters={filters} onChange={setFilters} operations={operations} total={items.length} shown={shownItems}
        candidates={graph.nodes} onPick={setSelectedId} onClear={() => setFilters(DEFAULT_FILTERS)} />

      {unsupported && <div className="banner banner-info" role="status">이 환경에서는 3D를 쓸 수 없어 목록으로 보여 드립니다.</div>}

      <div className="pg-body">
        <div className="holo-frame pg-frame">
          <div className="holo-strip">
            <span className="led" aria-hidden />
            <span className="holo-model">{product.name}</span>
            <span className="spacer" />
            <span className="holo-meta">{graph.nodes.length - 1}개 품목 · {graph.edges.length}개 연결</span>
          </div>
          <div className="pg-stage">
            {showList
              ? <div className="pg-list"><GraphList graph={graph} selectedId={selectedVisible ? selectedId : null} onSelect={setSelectedId} label={`${product.name} 연결 목록`} /></div>
              : <Graph3D graph={graph} selectedId={selectedVisible ? selectedId : null} onSelect={setSelectedId} label={`${product.name} 연결 그래프`}
                  onUnsupported={() => setUnsupported(true)} />}
          </div>
          <ul className="pg-legend" aria-label="범례">
            {LEGEND.map(l => <li key={l.key}><i className={`dot dot-${l.key}`} aria-hidden />{l.label}</li>)}
            <li><i className="dot dot-rule" aria-hidden />조립 규칙 연결</li>
          </ul>
          <i className="corner corner-tl" aria-hidden /><i className="corner corner-tr" aria-hidden />
          <i className="corner corner-bl" aria-hidden /><i className="corner corner-br" aria-hidden />
        </div>

        <aside className="glass-panel pg-panel" aria-label="묶음">
          {selected && selected.kind !== 'product' && info.get(selected.id)
            ? <ItemBundle node={selected} rec={info.get(selected.id)!} guide={guides.get(selected.id)}
                docs={docs.get(selected.id) ?? []} classes={classes}
                paths={usagePaths(fullGraph, selected.id).map(p => p.map(id => fullGraph.nodes.find(n => n.id === id)!).filter(Boolean))}
                onSelect={id => setSelectedId(fullGraph.nodes.find(n => n.id === id)?.kind === 'product' ? null : id)}
                onClear={() => setSelectedId(null)} />
            : <ProductBundle product={product} root={root} fullGraph={fullGraph} docs={docs} guides={guides} />}
        </aside>
      </div>
    </>
  );
}

function ProductBundle({ product, root, fullGraph, docs, guides }: {
  product: Product; root: ItemDetail; fullGraph: Graph;
  docs: Map<string, DocumentLink[]>; guides: Map<string, AssemblyGuide>;
}) {
  // 제품에 묶인 문서(같은 문서가 여러 품목에 걸리면 한 번만) 와 규칙(품목 수)
  const allDocs = [...new Map([...docs.values()].flat().map(d => [d.documentId, d])).values()];
  const ruleUse = new Map<string, { guide: AssemblyGuide; n: number }>();
  fullGraph.nodes.forEach(n => {
    const g = n.kind === 'product' ? undefined : guides.get(n.id);
    if (g) ruleUse.set(g.ruleId, { guide: g, n: (ruleUse.get(g.ruleId)?.n ?? 0) + 1 });
  });
  return (
    <>
      <header className="panel-head">
        <div>
          <h2>제품 묶음</h2>
          <p className="panel-sub">노드를 누르면 그 품목에 묶인 문서 · 규칙을 봅니다</p>
        </div>
      </header>
      <div className="pg-panel-body">
        <dl className="props">
          <dt>제품</dt><dd>{product.name} <span className="mono faint">{product.code}</span></dd>
          <dt>최상위 품목</dt><dd><span className="mono">{root.itemNo}</span> <span className="muted">{nameOf(root)}</span></dd>
          <dt>문서</dt><dd>{allDocs.length}건</dd>
          <dt>조립 규칙</dt><dd>{ruleUse.size}개</dd>
        </dl>
        <h3 className="pg-h3">문서</h3>
        <DocGroups links={allDocs} />
        <h3 className="pg-h3">적용되는 조립 규칙</h3>
        {ruleUse.size === 0
          ? <p className="faint pg-none">연결된 규칙이 없습니다.</p>
          : <ul className="pg-rules">{[...ruleUse.values()].map(({ guide, n }) => (
              <li key={guide.ruleId}><Link to={`/rules/${guide.ruleId}`} className="chip-holo chip-sent mono">{guide.ruleId}</Link><span>{guide.ruleName}</span><span className="faint">{n}개 품목</span></li>
            ))}</ul>}
      </div>
    </>
  );
}

function ItemBundle({ node, rec, guide, docs, classes, paths, onSelect, onClear }: {
  node: GraphNode; rec: { node: BomNode; total: number; parents: Set<string> };
  guide?: AssemblyGuide; docs: DocumentLink[]; classes: TaxonomyClass[];
  /** 사용처 경로: 갈래마다 [자기, 상위 …, 제품] 노드 */
  paths: GraphNode[][];
  onSelect(id: string): void; onClear(): void;
}) {
  const it = rec.node.item;
  const path = classPath(classes, it.classIri);
  return (
    <>
      <header className="panel-head">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="mono muted">{it.itemNo}</span>
            <Badge>{ITEM_TYPE[it.itemType]}</Badge>
            <RevisionBadge {...(rec.node.revision ? { revision: rec.node.revision } : {})} />
          </div>
          <h2 className="pg-item-name">{nameOf(it)}</h2>
          {it.nameKo && <p className="panel-sub">{it.name}</p>}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" aria-label="선택 해제" onClick={onClear}><Icon name="close" size={16} /></button>
      </header>
      <div className="pg-panel-body">
        <dl className="props">
          <dt>분류</dt><dd>{path.length ? path.join(' › ') : <span className="faint">분류 없음</span>}</dd>
          <dt>수량</dt><dd>루트 1개당 <strong>{formatNumber(rec.total)}</strong> {it.unit}</dd>
          <dt>사용처</dt><dd>{rec.parents.size ? [...rec.parents].join(' · ') : <span className="faint">제품 최상위</span>}</dd>
          {node.level > 0 && <><dt>단계</dt><dd>{node.level}단계</dd></>}
        </dl>
        <h3 className="pg-h3">사용처 경로</h3>
        <ul className="pg-paths" aria-label="사용처 경로">
          {paths.map((p, i) => (
            <li key={i}>
              {p.map((n, j) => (
                <span key={n.id} className="pg-path-step">
                  {j > 0 && <Icon name="chevron_right" size={14} className="pg-path-sep" />}
                  <button type="button" className={`pg-path-chip pg-path-${n.kind}`} aria-current={j === 0 ? 'true' : undefined} disabled={j === 0}
                    title={n.kind === 'product' ? '제품 묶음으로' : `${n.label} 보기`} onClick={() => onSelect(n.id)}>{n.label}</button>
                </span>
              ))}
            </li>
          ))}
        </ul>
        <h3 className="pg-h3">문서</h3>
        <DocGroups links={docs} />
        <h3 className="pg-h3">적용되는 조립 규칙</h3>
        {guide
          ? <ul className="pg-rules"><li><Link to={`/rules/${guide.ruleId}`} className="chip-holo chip-sent mono">{guide.ruleId}</Link><span>{guide.ruleName}</span><span className="faint">{guide.operationLabel}</span></li></ul>
          : <p className="faint pg-none">연결된 규칙이 없습니다.</p>}
      </div>
    </>
  );
}
