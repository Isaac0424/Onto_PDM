import { Link } from 'react-router-dom';
import { Loaded } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { useSession } from '../session';

export function ProductListPage() {
  const { api } = useSession();
  const products = useAsync(() => api.listProducts(), []);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>제품</h1>
          <p className="sub">제품마다 최상위 조립품 하나를 가리킵니다. 사양서 · 설명서 검색의 모델명 기준입니다.</p>
        </div>
      </div>
      <Loaded state={products} empty={rows => rows.length === 0}>
        {rows => (
          <div className="grid-2">
            {rows.map(p => (
              <section key={p.id} className="card">
                <div className="card-head">
                  <h2 className="mono">{p.code}</h2>
                  <span className="muted">{p.name}</span>
                </div>
                <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {p.description && <p style={{ margin: 0 }} className="muted">{p.description}</p>}
                  <dl className="props">
                    <dt>최상위 조립품</dt>
                    <dd><Link className="mono" to={`/items/${p.rootItemNo}`}>{p.rootItemNo}</Link></dd>
                  </dl>
                  <div className="row">
                    <Link className="btn btn-sm" to={`/items/${p.rootItemNo}?tab=bom`}>BOM 보기</Link>
                    <Link className="btn btn-sm" to={`/items?product=${p.id}`}>이 제품의 품목</Link>
                  </div>
                </div>
              </section>
            ))}
          </div>
        )}
      </Loaded>
    </div>
  );
}
