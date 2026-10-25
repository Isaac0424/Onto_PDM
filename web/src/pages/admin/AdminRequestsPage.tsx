import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PartRequest, TaxonomyClass, User } from '../../api/types';
import { AdminOnly } from '../../components/AppShell';
import { RequestBadge } from '../../components/StatusBadges';
import { Badge, ErrorText, Loaded, Tabs } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { ID_SCHEME, ITEM_TYPE, formatDateTime } from '../../labels';
import { useSession } from '../../session';
import { DuplicateTable } from '../requests/RequestEditPage';
import { classLabel } from '../requests/classOptions';

const FILTERS = {
  submitted: { label: '제출됨', match: (r: PartRequest) => r.status === 'submitted' },
  draft: { label: '임시저장', match: (r: PartRequest) => r.status === 'draft' },
  done: { label: '처리됨', match: (r: PartRequest) => ['approved', 'rejected', 'cancelled'].includes(r.status) },
} as const;
type Filter = keyof typeof FILTERS;

export function AdminRequestsPage() {
  return <AdminOnly><AdminRequests /></AdminOnly>;
}

function AdminRequests() {
  const { api, users } = useSession();
  const [filter, setFilter] = useState<Filter>('submitted');
  const requests = useAsync(() => api.listPartRequests('all'), []);
  const classes = useAsync(() => api.listClasses(), []);
  const all = requests.data ?? [];

  return (
    <div className="page" style={{ maxWidth: 1040 }}>
      <div className="page-head">
        <div>
          <h1>등록 요청 검토</h1>
          <p className="sub">승인하면 대표 품번이 발급되고 품목 · 별칭 · 첫 리비전 R00(작업중)이 함께 만들어집니다. PLM · PDM · 분류 에이전트의 요청이 모두 여기로 옵니다.</p>
        </div>
      </div>
      <Tabs
        value={filter} onChange={id => setFilter(id as Filter)}
        tabs={(Object.keys(FILTERS) as Filter[]).map(k => ({ id: k, label: FILTERS[k].label, count: all.filter(FILTERS[k].match).length }))}
      />
      <Loaded state={requests} empty={rows => rows.filter(FILTERS[filter].match).length === 0}>
        {rows => rows.filter(FILTERS[filter].match).map(r => (
          <RequestReview key={r.id} request={r} classes={classes.data ?? []} users={users} />
        ))}
      </Loaded>
    </div>
  );
}

function RequestReview({ request: r, classes, users }: { request: PartRequest; classes: TaxonomyClass[]; users: User[] }) {
  const { api, bump } = useSession();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const requester = users.find(u => u.id === r.requestedBy)?.name ?? `#${r.requestedBy}`;
  const cls = classLabel(classes, r.payload.classIri);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await fn(); bump(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className="card">
      <div className="card-head">
        <span className="mono faint">#{r.id}</span>
        <Badge tone={r.sourceSystem === 'AGENT' ? 'warning' : 'neutral'}>{r.sourceSystem === 'AGENT' ? '분류 에이전트' : r.sourceSystem}</Badge>
        <h2>{r.payload.nameKo ?? r.payload.name ?? '(이름 없음)'}</h2>
        {r.payload.nameKo && r.payload.name && <span className="muted">{r.payload.name}</span>}
        <div className="spacer" />
        <RequestBadge status={r.status} />
      </div>
      <div className="card-body" style={{ display: 'grid', gap: 16 }}>
        <dl className="props">
          <dt>분류</dt>
          <dd>
            {cls ?? (r.classProposalId
              ? <><Badge tone="warning">분류 제안 #{r.classProposalId} 검토 대기</Badge> <Link to="/admin/proposals">분류 제안 검토로</Link></>
              : <span className="faint">미지정</span>)}
          </dd>
          <dt>구분 · 단위</dt><dd>{r.payload.itemType ? ITEM_TYPE[r.payload.itemType] : '—'} · {r.payload.unit ?? '—'}</dd>
          <dt>별칭</dt>
          <dd>{r.payload.aliases?.length ? r.payload.aliases.map(a => (
            <span key={`${a.scheme}:${a.value}`} className="chip" style={{ marginRight: 4 }}>{ID_SCHEME[a.scheme]} <span className="mono">&nbsp;{a.value}</span></span>
          )) : <span className="faint">없음</span>}</dd>
          <dt>요청자</dt><dd>{requester} · {formatDateTime(r.updatedAt)}</dd>
          {r.payload.note && <><dt>메모</dt><dd>{r.payload.note}</dd></>}
          {r.issuedItemNo && <><dt>발급 품번</dt><dd><Link className="mono" to={`/items/${r.issuedItemNo}`}>{r.issuedItemNo}</Link></dd></>}
          {r.reviewNote && <><dt>검토 메모</dt><dd>{r.reviewNote}</dd></>}
        </dl>

        {r.duplicateCheck && r.duplicateCheck.length > 0 && (
          <div>
            <h3 style={{ marginBottom: 6 }}>중복 후보</h3>
            <DuplicateTable request={r} />
          </div>
        )}

        {r.status === 'submitted' && (
          <div style={{ display: 'grid', gap: 8 }}>
            <label className="field">
              <span>검토 메모</span>
              <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="반려할 때는 사유가 필요합니다" />
            </label>
            <ErrorText error={error} />
            <div className="row">
              <button
                type="button" className="btn btn-primary" disabled={busy || !r.payload.classIri}
                onClick={() => act(() => api.approvePartRequest(r.id, note || undefined))}
                title={r.payload.classIri ? '' : '분류가 정해져야 승인할 수 있습니다'}
              >
                승인 · 품번 발급
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => act(() => api.rejectPartRequest(r.id, note))}>
                반려
              </button>
              {!r.payload.classIri && <span className="faint">분류가 정해져야 승인할 수 있습니다</span>}
            </div>
          </div>
        )}
        {r.status === 'draft' && <p className="faint" style={{ margin: 0 }}>작성자가 아직 제출하지 않은 임시저장입니다.</p>}
      </div>
    </section>
  );
}
