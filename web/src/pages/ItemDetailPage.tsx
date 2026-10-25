import { Fragment, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { BomRule, ItemDetail, Material, Passage, TaxonomyClass } from '../api/types';
import { BomTree } from '../components/BomTree';
import { LinkBadge, RevisionBadge } from '../components/StatusBadges';
import { ViewerPanel } from '../components/ViewerPanel';
import { Badge, ItemName, Loaded, Tabs } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import {
  DOC_TYPE, ID_SCHEME, ITEM_TYPE, MATCH_METHOD, PASSAGE_PURPOSE, formatDateTime, formatNumber,
} from '../labels';
import { useSession } from '../session';

const TABS = ['overview', 'bom', 'used', 'docs', 'viewer', 'history'] as const;
type Tab = (typeof TABS)[number];

export function ItemDetailPage() {
  const { itemNo = '' } = useParams();
  const { api } = useSession();
  const item = useAsync(() => api.getItem(itemNo), [itemNo]);
  const classes = useAsync(() => api.listClasses(), []);
  const materials = useAsync(() => api.listMaterials(), []);

  return (
    <div className="page">
      <Loaded state={item}>
        {it => <ItemView key={it.id} item={it} classes={classes.data ?? []} materials={materials.data ?? []} />}
      </Loaded>
    </div>
  );
}

function classPath(classes: TaxonomyClass[], iri?: string): TaxonomyClass[] {
  const out: TaxonomyClass[] = [];
  let c = classes.find(x => x.iri === iri);
  while (c) { out.unshift(c); c = classes.find(x => x.iri === c!.parentIri); }
  return out;
}

function ItemView({ item, classes, materials }: { item: ItemDetail; classes: TaxonomyClass[]; materials: Material[] }) {
  const [params, setParams] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview';
  const [revId, setRevId] = useState<number | undefined>(item.releasedRevision?.id ?? item.latestRevision?.id);
  const revision = item.revisions.find(r => r.id === revId) ?? item.revisions[0];
  const setTab = (t: string) => { const n = new URLSearchParams(params); n.set('tab', t); setParams(n, { replace: true }); };

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="mono muted">{item.itemNo}</span>
            <Badge>{ITEM_TYPE[item.itemType]}</Badge>
            {item.products.map(p => <span key={p.id} className="chip">{p.code}</span>)}
          </div>
          <h1 style={{ marginTop: 4 }}>{item.nameKo ?? item.name}</h1>
          {item.nameKo && <div className="muted">{item.name}</div>}
        </div>
        <div className="spacer" />
        {item.revisions.length > 0 && (
          <label className="field revision-field">
            <span>리비전</span>
            <select className="select" value={revision?.id} onChange={e => setRevId(Number(e.target.value))}>
              {item.revisions.map(r => (
                <option key={r.id} value={r.id}>{r.rev} · {{ wip: '작업중', in_review: '검토중', released: '승인', obsolete: '폐기' }[r.status]}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {revision && revision.status !== 'released' && (
        <div className="banner banner-warning">
          <RevisionBadge revision={revision} />
          {revision.status === 'obsolete'
            ? '폐기된 리비전입니다.'
            : '승인 전 리비전입니다. 작성자와 관리자 모드에서만 보이고, ERP · MES와 그래프에는 공개되지 않습니다.'}
        </div>
      )}

      <Tabs
        value={tab} onChange={setTab}
        tabs={[
          { id: 'overview', label: '개요' }, { id: 'bom', label: 'BOM' }, { id: 'used', label: '사용처' },
          { id: 'docs', label: '문서 · 근거' }, { id: 'viewer', label: '3D' }, { id: 'history', label: '이력', count: item.revisions.length },
        ]}
      />

      {tab === 'overview' && <Overview item={item} classes={classes} materials={materials} />}
      {tab === 'bom' && (revision ? <BomTab revisionId={revision.id} /> : <NoRevision />)}
      {tab === 'used' && <WhereUsedTab itemId={item.id} />}
      {tab === 'docs' && (revision ? <DocsTab revisionId={revision.id} /> : <NoRevision />)}
      {tab === 'viewer' && (revision ? <ViewerTab revisionId={revision.id} title={item.nameKo ?? item.name} /> : <NoRevision />)}
      {tab === 'history' && <History item={item} />}
    </>
  );
}

const NoRevision = () => <div className="empty">볼 수 있는 리비전이 없습니다.</div>;

function Overview({ item, classes, materials }: { item: ItemDetail; classes: TaxonomyClass[]; materials: Material[] }) {
  const path = classPath(classes, item.classIri);
  const material = materials.find(m => m.iri === item.materialIri);
  const materialClass = classes.find(c => c.iri === material?.classIri);
  const attrs = Object.entries(item.attributes);
  return (
    <div className="grid-2">
      <section className="card">
        <div className="card-head"><h2>기본 정보</h2></div>
        <div className="card-body">
          <dl className="props">
            <dt>분류</dt>
            <dd>
              {path.length ? path.map((c, i) => (
                <span key={c.iri}>{i > 0 && <span className="faint"> › </span>}{c.labelKo}</span>
              )) : <span className="faint">미지정</span>}
              {path.length > 0 && <span className="mono faint"> {path[path.length - 1]!.code}</span>}
            </dd>
            <dt>구분</dt><dd>{ITEM_TYPE[item.itemType]}</dd>
            <dt>관리 단위</dt><dd>{item.unit}</dd>
            <dt>재료</dt>
            <dd>
              {material ? (
                <>
                  {material.name} <span className="faint">· {materialClass?.labelKo}</span>
                  {material.density !== undefined && <span className="faint"> · 밀도 {material.density} g/cm³</span>}
                </>
              ) : <span className="faint">—</span>}
            </dd>
            <dt>질량</dt>
            <dd>
              {item.massKg !== undefined
                ? <>{formatNumber(item.massKg)} kg {item.massSource === 'cad_estimate' && <Badge tone="warning">CAD 추정</Badge>}</>
                : <span className="faint">—</span>}
            </dd>
            {attrs.map(([k, v]) => (<Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>))}
          </dl>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>별칭</h2><span className="faint" style={{ fontSize: 12 }}>다른 시스템 · 옛 번호로도 이 품목을 찾습니다</span></div>
        {item.identifiers.length ? (
          <table className="table">
            <thead><tr><th>종류</th><th>값</th></tr></thead>
            <tbody>
              {item.identifiers.map(x => (
                <tr key={`${x.scheme}:${x.value}`}><td>{ID_SCHEME[x.scheme]}</td><td className="mono">{x.value}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <div className="empty">별칭이 없습니다.</div>}
      </section>

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="card-head"><h2>재고 현황</h2><span className="faint" style={{ fontSize: 12 }}>ERP · MES가 보낸 최신 값</span></div>
        {item.inventory.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>출처</th><th>사업장</th><th>위치</th><th className="num">현재고</th><th className="num">할당</th><th className="num">가용</th><th>기준 시각</th></tr>
              </thead>
              <tbody>
                {item.inventory.map(v => (
                  <tr key={`${v.source}-${v.site}-${v.location}`}>
                    <td><Badge>{v.source}</Badge></td><td>{v.site}</td><td>{v.location}</td>
                    <td className="num">{formatNumber(v.qtyOnHand)}</td><td className="num">{formatNumber(v.qtyAllocated)}</td>
                    <td className="num"><strong>{formatNumber(v.qtyOnHand - v.qtyAllocated)}</strong> <span className="faint">{v.unit}</span></td>
                    <td className="faint">{formatDateTime(v.asOf)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty">받은 재고 정보가 없습니다.</div>}
      </section>
    </div>
  );
}

function BomTab({ revisionId }: { revisionId: number }) {
  const { api } = useSession();
  const [rule, setRule] = useState<BomRule>('released');
  const bom = useAsync(() => api.getBom(revisionId, rule), [revisionId, rule]);
  return (
    <section className="card">
      <div className="card-head">
        <h2>BOM 정전개</h2>
        <div className="spacer" />
        <label className="field" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: '100%' }}>
          <span>하위 리비전</span>
          <select className="select" style={{ width: 'auto', maxWidth: '100%' }} value={rule} onChange={e => setRule(e.target.value as BomRule)}>
            <option value="released">생산 보기 (최신 승인본)</option>
            <option value="latest">설계 보기 (최신, 작업중 포함)</option>
          </select>
        </label>
      </div>
      <Loaded state={bom}>{nodes => <BomTree nodes={nodes} />}</Loaded>
    </section>
  );
}

function WhereUsedTab({ itemId }: { itemId: number }) {
  const { api } = useSession();
  const used = useAsync(() => api.getWhereUsed(itemId), [itemId]);
  return (
    <section className="card">
      <div className="card-head"><h2>사용처 (역전개)</h2><span className="faint" style={{ fontSize: 12 }}>폐기된 리비전은 빼고 보여 줍니다</span></div>
      <Loaded state={used} empty={rows => rows.length === 0}>
        {rows => (
          <table className="table">
            <thead><tr><th>단계</th><th>상위 품목</th><th>이름</th><th>상위 리비전</th><th className="num">수량</th></tr></thead>
            <tbody>
              {rows.map((w, i) => (
                <tr key={i}>
                  <td className="faint">{w.depth}</td>
                  <td><Link className="mono" to={`/items/${w.parent.itemNo}`}>{w.parent.itemNo}</Link></td>
                  <td><ItemName name={w.parent.name} nameKo={w.parent.nameKo} /></td>
                  <td><RevisionBadge revision={w.parentRevision} /></td>
                  <td className="num">{formatNumber(w.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Loaded>
    </section>
  );
}

function highlight(text: string, terms: string[]) {
  if (!terms.length) return text;
  const re = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

function PassageCard({ p }: { p: Passage }) {
  return (
    <article className="passage">
      <div className="row" style={{ gap: 6 }}>
        <Badge tone="accent">{PASSAGE_PURPOSE[p.purpose]}</Badge>
        {p.mateItemNo && (
          <span className="muted">결합 대상 <Link className="mono" to={`/items/${p.mateItemNo}`}>{p.mateItemNo}</Link> {p.mateName}</span>
        )}
        <div className="spacer" />
        <LinkBadge status={p.status} />
      </div>
      <blockquote>{highlight(p.text, p.hitTerms)}</blockquote>
      <div className="meta">
        <span className="mono">{p.docNo}</span><span>{p.docTitle}</span>
        {p.pageNo !== undefined && <span>{p.pageNo}쪽</span>}
        <span>BM25 {p.score.toFixed(1)}</span>
        {p.productScope.length ? p.productScope.map(s => <span key={s} className="chip">{s} 전용</span>) : <span className="chip">공통</span>}
      </div>
    </article>
  );
}

function DocsTab({ revisionId }: { revisionId: number }) {
  const { api } = useSession();
  const docs = useAsync(() => api.getDocuments(revisionId), [revisionId]);
  const passages = useAsync(() => api.getPassages(revisionId), [revisionId]);
  return (
    <>
      <section className="card">
        <div className="card-head"><h2>연결 문서</h2></div>
        <Loaded state={docs} empty={rows => rows.length === 0}>
          {rows => (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>종류</th><th>문서 번호</th><th>제목</th><th>리비전</th><th>매칭</th><th>상태</th></tr></thead>
                <tbody>
                  {rows.map(d => (
                    <tr key={`${d.documentId}-${d.linkType}`}>
                      <td>{DOC_TYPE[d.docType]}</td>
                      <td className="mono">{d.docNo}</td>
                      <td>{d.title}{d.fileName && <div className="faint mono" style={{ fontSize: 12 }}>{d.fileName}</div>}</td>
                      <td><span className="mono">{d.rev}</span> <span className="faint">{d.pinned ? '고정' : '최신 따라감'}</span></td>
                      <td>{MATCH_METHOD[d.matchMethod]}{d.confidence !== undefined && <span className="faint"> · {d.confidence.toFixed(2)}</span>}</td>
                      <td><LinkBadge status={d.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loaded>
      </section>

      <section className="card">
        <div className="card-head"><h2>근거 구절</h2><span className="faint" style={{ fontSize: 12 }}>사양서 · 설명서에서 찾은 정의와 결합 대상별 절차</span></div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Loaded state={passages} empty={rows => rows.length === 0}>
            {rows => rows.map(p => <PassageCard key={p.id} p={p} />)}
          </Loaded>
        </div>
      </section>
    </>
  );
}

function ViewerTab({ revisionId, title }: { revisionId: number; title: string }) {
  const { api } = useSession();
  const docs = useAsync(() => api.getDocuments(revisionId), [revisionId]);
  const cad = docs.data?.find(d => d.linkType === 'cad_model');
  if (docs.loading && !docs.data) return <div className="empty">불러오는 중…</div>;
  return (
    <>
      <div className="banner banner-info">
        {cad
          ? <>연결된 CAD: <span className="mono">{cad.fileName}</span> ({cad.docNo} {cad.rev}). 목 데이터에는 실제 파일이 없어 예시 모델을 엽니다. 뷰어 안에서 STEP 파일을 직접 열 수도 있습니다.</>
          : <>이 리비전에 연결된 CAD 모델이 없어 예시 모델을 엽니다. 뷰어 안에서 STEP 파일을 직접 열 수 있습니다.</>}
      </div>
      <ViewerPanel fileUrl={cad?.fileUrl} title={title} />
    </>
  );
}

function History({ item }: { item: ItemDetail }) {
  return (
    <section className="card">
      <div className="card-head"><h2>리비전 이력</h2></div>
      {item.revisions.length ? (
        <table className="table">
          <thead><tr><th>리비전</th><th>변경 내용</th><th>승인 시각</th><th>만든 시각</th></tr></thead>
          <tbody>
            {item.revisions.map(r => (
              <tr key={r.id} className={r.status === 'obsolete' ? 'dim' : undefined}>
                <td><RevisionBadge revision={r} /></td>
                <td>{r.changeNote ?? '—'}</td>
                <td>{formatDateTime(r.releasedAt)}</td>
                <td className="faint">{formatDateTime(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <NoRevision />}
    </section>
  );
}
