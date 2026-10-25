import { Link, useNavigate } from 'react-router-dom';
import { RequestBadge } from '../../components/StatusBadges';
import { Loaded } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { formatDateTime } from '../../labels';
import { useSession } from '../../session';
import { classLabel } from './classOptions';

export function RequestListPage() {
  const { api } = useSession();
  const navigate = useNavigate();
  const requests = useAsync(() => api.listPartRequests('mine'), []);
  const classes = useAsync(() => api.listClasses(), []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>내 등록 요청</h1>
          <p className="sub">임시저장은 빈 칸이 있어도 저장되고 나와 관리자만 봅니다. 제출하면 관리자 모드에서 검토해 품번을 발급합니다.</p>
        </div>
        <div className="spacer" />
        <Link to="/requests/new" className="btn btn-primary">새 등록 요청</Link>
      </div>
      <section className="card">
        <Loaded state={requests} empty={rows => rows.length === 0}>
          {rows => (
            <div className="table-wrap">
              <table className="table" aria-label="내 등록 요청">
                <thead><tr><th>번호</th><th>이름</th><th>분류</th><th>상태</th><th>발급 품번</th><th>수정 시각</th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/requests/${r.id}`)}>
                      <td className="mono">#{r.id}</td>
                      <td>{r.payload.nameKo ?? r.payload.name ?? <span className="faint">(이름 없음)</span>}</td>
                      <td>{classLabel(classes.data ?? [], r.payload.classIri) ?? <span className="faint">미지정</span>}</td>
                      <td><RequestBadge status={r.status} /></td>
                      <td>{r.issuedItemNo ? <Link className="mono" to={`/items/${r.issuedItemNo}`} onClick={e => e.stopPropagation()}>{r.issuedItemNo}</Link> : '—'}</td>
                      <td className="faint">{formatDateTime(r.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Loaded>
      </section>
    </div>
  );
}
