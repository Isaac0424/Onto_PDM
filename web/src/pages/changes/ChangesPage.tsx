// 설계 변경 목록: 변경 요청마다 영향 요약(막힘 · 처분 필요 · 확인 필요 · 영향 없음)과 낡음 표시를 보인다.
// 데이터를 읽어 올 곳(PDM 백엔드의 /changes)이 없으면 가짜 변경 건을 만들지 않고 연결 안내만 보인다.
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ChangeCreateRequest, ChangeOrigin, ChangeRunSummary, ChangeSummary, RequestStatus } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { Badge, ErrorText, Loaded, NotConnected } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { CHANGE_ORIGIN, CHANGE_STATUS, CHANGE_STATUS_TONE, ORDER_STATUS, ORDER_STATUS_TONE, SEVERITY, formatDateTime } from '../../labels';
import { useSession } from '../../session';
import { SeverityBadge, useAction } from './changeUi';
import './changes.css';

const STATUS_FILTER: ('' | RequestStatus)[] = ['', 'draft', 'submitted', 'accepted', 'rejected', 'withdrawn'];

/** 영향 요약 칩: 0 건인 심각도는 흐리게. 개수도 글자로 적는다(색에만 기대지 않는다) */
export function RunSummary({ summary }: { summary?: ChangeRunSummary }) {
  if (!summary) return <span className="faint">분석 전</span>;
  return (
    <span className="chg-summary" role="group" aria-label="영향 요약">
      {(['blocked', 'affected', 'review', 'none'] as const).map(s => (
        <span key={s} className={`chg-count ${summary[s] === 0 ? 'chg-count-zero' : ''}`} title={`${SEVERITY[s]} ${summary[s]}건`}>
          <SeverityBadge severity={s} /><b>{summary[s]}</b>
        </span>
      ))}
      {summary.stale && <Badge tone="warning" title="분석 뒤 외부 데이터가 바뀌었어요. 다시 분석하세요.">낡음</Badge>}
      {summary.partial && <Badge tone="warning" title="OPMS 를 읽지 못해 적합성을 판정하지 못했어요.">일부만 분석</Badge>}
    </span>
  );
}

function NewChangeForm({ onClose }: { onClose(): void }) {
  const { api } = useSession();
  const navigate = useNavigate();
  const { run, busy, error } = useAction();
  const [form, setForm] = useState({ title: '', reason: '', origin: 'design' as ChangeOrigin, before_summary: '', after_summary: '', product_code: '' });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: ChangeCreateRequest = {
      title: form.title.trim(), reason: form.reason.trim(), origin: form.origin,
      ...(form.before_summary.trim() ? { before_summary: form.before_summary.trim() } : {}),
      ...(form.after_summary.trim() ? { after_summary: form.after_summary.trim() } : {}),
      ...(form.product_code.trim() ? { product_code: form.product_code.trim() } : {}),
    };
    const created = await run(() => api.createChange(body));
    if (created) navigate(`/changes/${encodeURIComponent(created.code)}`);
  };

  return (
    <form className="card chg-form" onSubmit={submit} aria-label="새 변경 요청">
      <div className="card-head"><h2>새 변경 요청</h2></div>
      <div className="card-body chg-form-grid">
        <label className="field"><span>제목</span><input className="input" required value={form.title} onChange={e => set('title', e.target.value)} placeholder="예: 육각너트 M8 → 가는나사 너트로 교체" /></label>
        <label className="field"><span>변경 이유</span><textarea className="textarea" required value={form.reason} onChange={e => set('reason', e.target.value)} /></label>
        <label className="field"><span>이전 조건</span><textarea className="textarea" value={form.before_summary} onChange={e => set('before_summary', e.target.value)} /></label>
        <label className="field"><span>이후 조건</span><textarea className="textarea" value={form.after_summary} onChange={e => set('after_summary', e.target.value)} /></label>
        <label className="field"><span>출처</span>
          <select className="select" value={form.origin} onChange={e => set('origin', e.target.value as ChangeOrigin)}>
            {(Object.keys(CHANGE_ORIGIN) as ChangeOrigin[]).map(o => <option key={o} value={o}>{CHANGE_ORIGIN[o]}</option>)}
          </select>
        </label>
        <label className="field"><span>제품 코드 (선택)</span><input className="input mono" value={form.product_code} onChange={e => set('product_code', e.target.value)} placeholder="BRK-M8" /></label>
      </div>
      <div className="card-body chg-form-actions">
        <ErrorText {...(error ? { error } : {})} />
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy || !form.title.trim() || !form.reason.trim()}>{busy ? '만드는 중…' : '요청 만들기'}</button>
          <button type="button" className="btn" onClick={onClose}>취소</button>
        </div>
      </div>
    </form>
  );
}

function ChangeTable({ rows }: { rows: ChangeSummary[] }) {
  return (
    <div className="card">
      <div className="table-wrap">
        <table className="table chg-table" aria-label="변경 요청 목록">
          <thead>
            <tr><th>코드</th><th>제목</th><th>상태</th><th>제품</th><th>영향 요약</th><th>요청</th></tr>
          </thead>
          <tbody>
            {rows.map(c => (
              <tr key={c.code}>
                <td data-label="코드"><Link className="mono" to={`/changes/${encodeURIComponent(c.code)}`}>{c.code}</Link></td>
                <td data-label="제목">{c.title}<small className="chg-sub">{CHANGE_ORIGIN[c.origin]}</small></td>
                <td data-label="상태">
                  <Badge tone={CHANGE_STATUS_TONE[c.status]}>{CHANGE_STATUS[c.status]}</Badge>
                  {c.order_status && <Badge tone={ORDER_STATUS_TONE[c.order_status]} title={c.order_code}>지시 {ORDER_STATUS[c.order_status]}</Badge>}
                </td>
                <td data-label="제품" className="mono">{c.product_code ?? '—'}</td>
                <td data-label="영향 요약"><RunSummary {...(c.run_summary ? { summary: c.run_summary } : {})} /></td>
                <td data-label="요청" className="faint">{c.requested_by} · {formatDateTime(c.requested_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ChangesPage() {
  const { api } = useSession();
  const [status, setStatus] = useState<'' | RequestStatus>('');
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const available = useAsync(() => api.changesAvailable(), [api]);
  const list = useAsync(() => api.listChanges({ ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}) }), [api, status, q]);

  return (
    <div className="page chg-page">
      <div className="page-head">
        <div>
          <h1>설계 변경</h1>
          <p className="sub">규격 · 재질 · 공차 · 도면 · 구성 부품이 바뀔 때 어디에 영향이 가는지 찾고, 적용 범위와 처분을 정해 승인합니다. 영향이 있다고 곧 바꿔야 하는 것은 아닙니다.</p>
        </div>
        {available.data === true && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(c => !c)} aria-expanded={creating}>
            <Icon name="add" size={16} />새 변경 요청
          </button>
        )}
      </div>

      {available.loading && available.data === undefined && <div className="empty">불러오는 중…</div>}
      {available.data === false && (
        <NotConnected title="설계 변경 데이터를 읽어 올 곳이 없어요" hint="PDM 백엔드에 연결되면 변경 요청 · 영향 분석 · 처분이 여기에 표시돼요." />
      )}

      {available.data === true && (
        <>
          {creating && <NewChangeForm onClose={() => setCreating(false)} />}
          <div className="row chg-filters" role="search" aria-label="변경 요청 찾기">
            <label className="chg-filter"><span className="faint">상태</span>
              <select className="select" value={status} onChange={e => setStatus(e.target.value as '' | RequestStatus)} aria-label="상태">
                {STATUS_FILTER.map(s => <option key={s || 'all'} value={s}>{s ? CHANGE_STATUS[s] : '전체'}</option>)}
              </select>
            </label>
            <label className="chg-filter chg-filter-q"><span className="faint">검색</span>
              <input className="input" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="코드 · 제목" aria-label="검색" />
            </label>
          </div>
          <Loaded state={list}>
            {page => page.items.length === 0
              ? <div className="empty">{status || q ? '조건에 맞는 변경 요청이 없어요.' : '아직 변경 요청이 없어요. 위의 "새 변경 요청"으로 시작하세요.'}</div>
              : <ChangeTable rows={page.items} />}
          </Loaded>
        </>
      )}
    </div>
  );
}
