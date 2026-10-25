import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ItemQuery, ItemType, RevisionStatus } from '../api/types';
import { RevisionBadge } from '../components/StatusBadges';
import { ItemName, Loaded } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { ITEM_TYPE, REVISION_STATUS } from '../labels';
import { useSession } from '../session';

export function ItemListPage() {
  const { api, adminMode } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query: ItemQuery = {
    q: params.get('q') ?? '',
    itemType: (params.get('type') ?? '') as ItemType | '',
    status: (params.get('status') ?? '') as RevisionStatus | '',
    productId: params.get('product') ? Number(params.get('product')) : '',
  };
  const [q, setQ] = useState(query.q ?? '');

  const items = useAsync(() => api.listItems(query), [JSON.stringify(query)]);
  const products = useAsync(() => api.listProducts(), []);
  const classes = useAsync(() => api.listClasses(), []);
  const classLabel = (iri?: string) => classes.data?.find(c => c.iri === iri)?.labelKo ?? '—';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>품목</h1>
          <p className="sub">
            {adminMode ? '관리자 모드: 다른 사람의 작업중 · 검토중 리비전도 보입니다.' : '승인된 품목과 내가 작업 중인 품목이 보입니다.'}
          </p>
        </div>
      </div>

      <div className="card">
        <form className="row" style={{ padding: 12 }} onSubmit={e => { e.preventDefault(); setParam('q', q.trim()); }}>
          <input
            className="input" style={{ flex: '1 1 240px', width: 'auto' }} value={q} onChange={e => setQ(e.target.value)}
            placeholder="품번 · 이름 · 별칭" aria-label="검색어"
          />
          <select className="select" style={{ width: 'auto' }} aria-label="구분" value={query.itemType} onChange={e => setParam('type', e.target.value)}>
            <option value="">모든 구분</option>
            {Object.entries(ITEM_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="select" style={{ width: 'auto' }} aria-label="최신 리비전 상태" value={query.status} onChange={e => setParam('status', e.target.value)}>
            <option value="">모든 상태</option>
            {Object.entries(REVISION_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="select" style={{ width: 'auto' }} aria-label="제품" value={query.productId} onChange={e => setParam('product', e.target.value)}>
            <option value="">모든 제품</option>
            {products.data?.map(p => <option key={p.id} value={p.id}>{p.code}</option>)}
          </select>
          <button type="submit" className="btn btn-primary">검색</button>
        </form>

        <Loaded state={items} empty={rows => rows.length === 0}>
          {rows => (
            <div className="table-wrap">
              <table className="table" aria-label="품목 목록">
                <thead>
                  <tr><th>품번</th><th>이름</th><th>분류</th><th>구분</th><th>최신 리비전</th><th>승인 리비전</th></tr>
                </thead>
                <tbody>
                  {rows.map(it => (
                    <tr key={it.id} className="clickable" onClick={() => navigate(`/items/${it.itemNo}`)}>
                      <td><Link className="mono" to={`/items/${it.itemNo}`} onClick={e => e.stopPropagation()}>{it.itemNo}</Link></td>
                      <td><ItemName name={it.name} nameKo={it.nameKo} /></td>
                      <td>{classLabel(it.classIri)}</td>
                      <td>{ITEM_TYPE[it.itemType]}</td>
                      <td><RevisionBadge revision={it.latestRevision} /></td>
                      <td>{it.releasedRevision ? <span className="mono">{it.releasedRevision.rev}</span> : <span className="faint">없음</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="faint" style={{ padding: '8px 12px', fontSize: 12 }}>{rows.length}개</div>
            </div>
          )}
        </Loaded>
      </div>
    </div>
  );
}
