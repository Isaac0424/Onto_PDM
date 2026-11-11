// 설계 변경 상세: 요청 · 지시 머리와 여섯 탭(대상 · 영향 · 적용 범위 · 처분 · 검토 · 이력).
// 쓰기(접수 · 제출 · 분석 · 처분 · 승인)는 서버가 상태 · 권한 · 조건을 판정한다. 화면은 이유를 미리 보여 주고 서버의 거절 이유를 그대로 전한다.
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ChangeDetail } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { Badge, ErrorText, Loaded, NotConnected, Tabs, type TabDef } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { CHANGE_ORIGIN, CHANGE_STATUS, CHANGE_STATUS_TONE, ORDER_STATUS, ORDER_STATUS_TONE, formatDateTime } from '../../labels';
import { useSession } from '../../session';
import { currentDispositions, needsDisposition } from './changeRules';
import { useAction } from './changeUi';
import { ImpactBanner } from './ImpactBanner';
import { DispositionTab } from './tabs/DispositionTab';
import { HistoryTab } from './tabs/HistoryTab';
import { ImpactTab } from './tabs/ImpactTab';
import { ReviewTab } from './tabs/ReviewTab';
import { ScopeTab } from './tabs/ScopeTab';
import { TargetsTab } from './tabs/TargetsTab';
import './changes.css';

type TabId = 'targets' | 'impact' | 'scope' | 'disposition' | 'review' | 'history';

function ChangeView({ change }: { change: ChangeDetail }) {
  const { api } = useSession();
  const { run, busy, error } = useAction();
  const [tab, setTab] = useState<TabId>('impact');
  const { order, latest_run: latest } = change;

  const decided = currentDispositions(change.dispositions);
  const openCount = latest ? latest.findings.filter(f => needsDisposition(f) && !decided.has(f.id)).length : 0;
  const tabs: TabDef[] = [
    { id: 'targets', label: '대상', count: change.targets.length },
    { id: 'impact', label: '영향', ...(latest ? { count: latest.findings.length } : {}) },
    { id: 'scope', label: '적용 범위' },
    { id: 'disposition', label: '처분', ...(openCount > 0 ? { count: openCount } : {}) },
    { id: 'review', label: '검토 · 승인' },
    { id: 'history', label: '이력' },
  ];

  return (
    <>
      <header className="page-head chg-head">
        <div>
          <p className="chg-back"><Link to="/changes"><Icon name="arrow_back" size={14} /> 설계 변경</Link></p>
          <h1><span className="mono">{change.code}</span> {change.title}</h1>
          <p className="chg-badges">
            <Badge tone={CHANGE_STATUS_TONE[change.status]}>요청 {CHANGE_STATUS[change.status]}</Badge>
            {order && <Badge tone={ORDER_STATUS_TONE[order.status]} title={order.code}>지시 {ORDER_STATUS[order.status]}</Badge>}
            <Badge>{CHANGE_ORIGIN[change.origin]}</Badge>
            {change.product_code && <span className="mono muted">{change.product_code}</span>}
            <span className="faint">{change.requested_by} · {formatDateTime(change.requested_at)}</span>
          </p>
        </div>
        <div className="row chg-actions">
          {!order && (change.status === 'draft' || change.status === 'submitted') && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.acceptChange(change.code))}>접수 (지시 만들기)</button>
          )}
          {order?.status === 'draft' && (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.submitChange(change.code))}>검토 요청</button>
          )}
          {change.targets.length > 0 && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => api.recomputeImpact(change.code))}>
              <Icon name="refresh" size={14} />{latest ? '영향 다시 분석' : '영향 분석 실행'}
            </button>
          )}
        </div>
      </header>

      <ErrorText {...(error ? { error } : {})} />

      <section className="card chg-summary-card" aria-label="요청 내용">
        <div className="card-body">
          <dl className="props chg-props">
            <dt>변경 이유</dt><dd>{change.reason}</dd>
            {change.before_summary && (<><dt>이전 조건</dt><dd>{change.before_summary}</dd></>)}
            {change.after_summary && (<><dt>이후 조건</dt><dd>{change.after_summary}</dd></>)}
          </dl>
        </div>
      </section>

      {latest && <ImpactBanner run={latest} />}

      <Tabs tabs={tabs} value={tab} onChange={id => setTab(id as TabId)} />
      <div role="tabpanel" aria-label={tabs.find(t => t.id === tab)?.label} className="chg-panel">
        {tab === 'targets' && <TargetsTab change={change} />}
        {tab === 'impact' && <ImpactTab change={change} />}
        {tab === 'scope' && <ScopeTab change={change} />}
        {tab === 'disposition' && <DispositionTab change={change} />}
        {tab === 'review' && <ReviewTab change={change} />}
        {tab === 'history' && <HistoryTab change={change} />}
      </div>
    </>
  );
}

export function ChangeDetailPage() {
  const { id = '' } = useParams();
  const { api } = useSession();
  const available = useAsync(() => api.changesAvailable(), [api]);
  const change = useAsync(() => (available.data ? api.getChange(id) : Promise.resolve(null)), [api, id, available.data]);

  if (available.loading && available.data === undefined) return <div className="page chg-page"><div className="empty">불러오는 중…</div></div>;
  if (available.data === false) {
    return (
      <div className="page chg-page">
        <NotConnected title="설계 변경 데이터를 읽어 올 곳이 없어요" hint="PDM 백엔드에 연결되면 변경 요청 · 영향 분석 · 처분이 여기에 표시돼요." />
      </div>
    );
  }
  return (
    <div className="page chg-page">
      <Loaded state={change}>
        {c => c === null
          ? <div className="banner banner-warning" role="alert">변경 건 <span className="mono">{id}</span>을(를) 찾을 수 없어요. <Link to="/changes">목록으로</Link></div>
          : <ChangeView key={c.code} change={c} />}
      </Loaded>
    </div>
  );
}
