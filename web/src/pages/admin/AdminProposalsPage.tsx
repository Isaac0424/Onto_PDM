import { useState } from 'react';
import type { ClassProposal, TaxonomyClass } from '../../api/types';
import { AdminOnly } from '../../components/AppShell';
import { ProposalBadge } from '../../components/StatusBadges';
import { Badge, ErrorText, Loaded, Tabs } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { formatDateTime } from '../../labels';
import { useSession } from '../../session';
import { classLabel, classOptions } from '../requests/classOptions';

export function AdminProposalsPage() {
  return <AdminOnly><AdminProposals /></AdminOnly>;
}

function AdminProposals() {
  const { api } = useSession();
  const [filter, setFilter] = useState<'open' | 'done'>('open');
  const proposals = useAsync(() => api.listClassProposals(), []);
  const classes = useAsync(() => api.listClasses(), []);
  const all = proposals.data ?? [];
  const match = (p: ClassProposal) => (filter === 'open' ? p.status === 'proposed' : p.status !== 'proposed');

  return (
    <div className="page" style={{ maxWidth: 1040 }}>
      <div className="page-head">
        <div>
          <h1>분류 제안 검토</h1>
          <p className="sub">분류 에이전트가 STEP · BOM · 사양서에서 분류체계에 없는 부품을 찾아 제안합니다. 승인 전에는 그래프 운영 저장소에 들어가지 않습니다.</p>
        </div>
      </div>
      <Tabs
        value={filter} onChange={id => setFilter(id as 'open' | 'done')}
        tabs={[
          { id: 'open', label: '검토 대기', count: all.filter(p => p.status === 'proposed').length },
          { id: 'done', label: '처리됨', count: all.filter(p => p.status !== 'proposed').length },
        ]}
      />
      <Loaded state={proposals} empty={rows => rows.filter(match).length === 0}>
        {rows => rows.filter(match).map(p => <ProposalCard key={p.id} proposal={p} classes={classes.data ?? []} />)}
      </Loaded>
    </div>
  );
}

function ProposalCard({ proposal: p, classes }: { proposal: ClassProposal; classes: TaxonomyClass[] }) {
  const { api, bump } = useSession();
  const [note, setNote] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const violations = p.validation.filter(v => v.severity === 'violation');
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await fn(); bump(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className="card">
      <div className="card-head">
        <span className="mono faint">#{p.id}</span>
        <h2>{p.labelKo}</h2>
        {p.labelEn && <span className="muted">{p.labelEn}</span>}
        <div className="spacer" />
        <ProposalBadge status={p.status} />
      </div>
      <div className="card-body" style={{ display: 'grid', gap: 16 }}>
        <dl className="props">
          <dt>상위 분류</dt><dd>{classLabel(classes, p.parentClassIri)}</dd>
          <dt>정의</dt><dd>{p.definition}</dd>
          <dt>표준 대응</dt>
          <dd>{p.standardMatch?.length ? p.standardMatch.map(s => <div key={s.standard}><Badge>{s.standard}</Badge> {s.note}</div>) : <span className="faint">없음</span>}</dd>
          <dt>실행</dt><dd className="faint"><span className="mono">{p.agentRunId}</span> · {p.model} · {formatDateTime(p.createdAt)}</dd>
          {p.approvedIri && <><dt>확정 분류</dt><dd className="mono">{p.approvedIri}</dd></>}
          {p.mergedIntoIri && <><dt>합친 분류</dt><dd>{classLabel(classes, p.mergedIntoIri)}</dd></>}
          {p.reviewNote && <><dt>검토 메모</dt><dd>{p.reviewNote}</dd></>}
        </dl>

        {p.properties.length > 0 && (
          <div>
            <h3 style={{ marginBottom: 6 }}>필요한 속성</h3>
            <table className="table">
              <thead><tr><th>속성</th><th>수량 종류 · 단위</th><th>필수</th><th>출처</th></tr></thead>
              <tbody>
                {p.properties.map(pr => (
                  <tr key={pr.label}>
                    <td>{pr.label}</td>
                    <td>{pr.quantityKind ? `${pr.quantityKind} · ${pr.unit}` : <span className="faint">—</span>}</td>
                    <td>{pr.required ? '예' : '아니오'}</td>
                    <td>{pr.reused ? '기존 속성' : <Badge tone="warning">새 속성</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <h3 style={{ marginBottom: 6 }}>근거</h3>
          {p.evidence.map((e, i) => (
            <div key={i} className="passage" style={{ marginBottom: 8 }}>
              <blockquote>{e.quote}</blockquote>
              <div className="meta"><span className="mono">{e.docNo}</span></div>
            </div>
          ))}
        </div>

        {p.validation.length > 0 && (
          <div style={{ display: 'grid', gap: 6 }}>
            {p.validation.map((v, i) => (
              <div key={i} className={`banner ${v.severity === 'violation' ? 'banner-danger' : 'banner-warning'}`}>
                {v.severity === 'violation' ? '위반' : '경고'}: {v.message}
              </div>
            ))}
          </div>
        )}

        {p.status === 'proposed' && (
          <div style={{ display: 'grid', gap: 8 }}>
            <label className="field">
              <span>검토 메모</span>
              <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="거절할 때는 사유가 필요합니다" />
            </label>
            <ErrorText error={error} />
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={busy || violations.length > 0}
                      onClick={() => act(() => api.approveClassProposal(p.id, note || undefined))}>
                새 분류로 승인
              </button>
              <select className="select" style={{ width: 'auto' }} aria-label="합칠 분류" value={mergeInto} onChange={e => setMergeInto(e.target.value)}>
                <option value="">기존 분류 선택…</option>
                {classOptions(classes).map(o => <option key={o.iri} value={o.iri}>{o.label} ({o.code})</option>)}
              </select>
              <button type="button" className="btn" disabled={busy || !mergeInto}
                      onClick={() => act(() => api.mergeClassProposal(p.id, mergeInto, note || undefined))}>
                기존 분류에 합치기
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => act(() => api.rejectClassProposal(p.id, note))}>
                거절
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
