import { AdminOnly } from '../../components/AppShell';
import { Badge, Loaded } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { formatDateTime } from '../../labels';
import { useSession } from '../../session';

export function AdminPublishPage() {
  return <AdminOnly><AdminPublish /></AdminOnly>;
}

function AdminPublish() {
  const { api } = useSession();
  const outbox = useAsync(() => api.listOutbox(), []);
  const rows = outbox.data ?? [];
  const pending = rows.filter(r => !r.publishedAt && !r.lastError).length;
  const failed = rows.filter(r => !r.publishedAt && r.lastError).length;
  const done = rows.filter(r => r.publishedAt).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>그래프 발행 상태</h1>
          <p className="sub">승인 · 변경이 같은 트랜잭션에서 발행 대기열(outbox)에 기록되고, 발행기가 GraphDB에 반영합니다.</p>
        </div>
      </div>
      <div className="card" style={{ display: 'flex', flexWrap: 'wrap' }}>
        <div className="stat"><strong>{pending}</strong><span>대기</span></div>
        <div className="stat"><strong style={{ color: failed ? 'var(--danger)' : undefined }}>{failed}</strong><span>실패 (재시도 중)</span></div>
        <div className="stat"><strong>{done}</strong><span>발행 완료</span></div>
      </div>
      <section className="card">
        <Loaded state={outbox} empty={r => r.length === 0}>
          {list => (
            <div className="table-wrap">
              <table className="table" aria-label="발행 대기열">
                <thead><tr><th>번호</th><th>대상</th><th>이벤트</th><th>기록 시각</th><th>상태</th><th className="num">시도</th><th>오류</th></tr></thead>
                <tbody>
                  {list.map(o => (
                    <tr key={o.id}>
                      <td className="mono faint">{o.id}</td>
                      <td className="mono">{o.target}</td>
                      <td>{o.aggregate} · {o.event}</td>
                      <td className="faint">{formatDateTime(o.createdAt)}</td>
                      <td>
                        {o.publishedAt ? <Badge tone="success">발행 {formatDateTime(o.publishedAt)}</Badge>
                          : o.lastError ? <Badge tone="danger">실패</Badge> : <Badge tone="info">대기</Badge>}
                      </td>
                      <td className="num">{o.attempts}</td>
                      <td className="faint">{o.lastError ?? ''}</td>
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
