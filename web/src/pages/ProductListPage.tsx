import { Link } from 'react-router-dom';
import { Loaded, NotConnected } from '../components/ui';
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
          <p className="sub">제품마다 최상위 조립품 하나를 가리킵니다. 제품별로 쓰이는 부품의 연결을 볼 수 있습니다.</p>
        </div>
      </div>
      {!api.connected ? <NotConnected title="제품 데이터가 없어요" hint="OPMS에 연결되면 제품과 최상위 조립품이 여기에 표시돼요." /> : (
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
                    <dd><span className="mono">{p.rootItemNo}</span></dd>
                  </dl>
                  <div className="row">
                    <Link className="btn btn-sm btn-primary" to={`/products/${p.code}`}>연결 보기</Link>
                  </div>
                </div>
              </section>
            ))}
          </div>
        )}
      </Loaded>
      )}
    </div>
  );
}
