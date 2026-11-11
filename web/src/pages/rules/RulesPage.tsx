import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AssemblyOperation, AssemblyRuleDetail, AssemblyRuleSummary, RuleIssue } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { Badge, Loaded } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { useSession } from '../../session';
import { Graph3D } from '../graph/Graph3D';
import { GraphList } from '../graph/GraphList';
import { ruleGraph, type NodeKind } from '../graph/graphData';
import '../studio/studio.css';
import './rules.css';

const OPERATION_ICON: Record<AssemblyOperation, string> = {
  fasten: 'construction', weld: 'local_fire_department', press_fit: 'compress', mount: 'memory', insert: 'login', cover: 'check_box_outline_blank',
};

const KIND_LABEL: Record<NodeKind, string> = {
  product: '제품', assembly: '조립품', part: '품목', rule: '규칙', operation: '공정', class: '적용 대상', tool: '공구', caution: '주의사항',
};

type DetailTab = 'info' | 'onto' | 'list';

const CODE_LABEL: Record<RuleIssue['code'], string> = {
  overlap: '겹침', missing_value: '값 빠짐', no_source: '출처', empty_table: '조건표', no_scope: '적용 대상', no_caution: '주의사항', unused: '안 쓰임',
};

const SEVERITY_LABEL = { error: '오류', warning: '경고' } as const;

/** 규칙마다 오류 · 경고 개수 */
function countByRule(issues: RuleIssue[] | undefined) {
  const m = new Map<string, { error: number; warning: number }>();
  (issues ?? []).forEach(i => {
    if (!i.ruleId) return;
    const c = m.get(i.ruleId) ?? { error: 0, warning: 0 };
    c[i.severity] += 1;
    m.set(i.ruleId, c);
  });
  return m;
}

function IssueItem({ issue, withRule }: { issue: RuleIssue; withRule: boolean }) {
  return (
    <li className={`check-item check-item-${issue.severity}`}>
      <span className={`check-badge check-badge-${issue.severity}`}>
        <Icon name={issue.severity === 'error' ? 'error' : 'warning'} size={13} />{SEVERITY_LABEL[issue.severity]}
      </span>
      <span className="check-code">{CODE_LABEL[issue.code]}</span>
      <span className="check-msg">{issue.message}</span>
      {withRule && issue.ruleId && <Link to={`/rules/${issue.ruleId}`} className="mono check-rule">{issue.ruleId}</Link>}
    </li>
  );
}

/**
 * 규칙 검증: 겹침 · 빠진 값 · 출처 · 조건표 · 적용 대상 · 주의사항을 점검한 결과.
 * 오류는 쓸 수 없는 규칙, 경고는 쓸 수는 있지만 확인할 것이다. 의도치 않은 빨강을 피하려고 둘 다 주황 · 호박색으로 구분한다.
 */
function RuleCheck({ issues, loading, error, onRecheck }: { issues: RuleIssue[] | undefined; loading: boolean; error: Error | undefined; onRecheck(): void }) {
  const [open, setOpen] = useState(true);
  const errors = issues?.filter(i => i.severity === 'error').length ?? 0;
  const warnings = issues?.filter(i => i.severity === 'warning').length ?? 0;
  return (
    <section className="glass-panel rules-check" aria-label="규칙 검증">
      <header className="rules-check-head">
        <div>
          <h2>규칙 검증</h2>
          <p className="panel-sub">겹침 · 빠진 값 · 출처 · 조건표 · 적용 대상을 점검합니다</p>
        </div>
        <div className="rules-check-chips" aria-live="polite">
          {issues
            ? <><span className="check-chip check-chip-error">오류 {errors}</span><span className="check-chip check-chip-warning">경고 {warnings}</span></>
            : <span className="faint">{loading ? '검증 중…' : ''}</span>}
        </div>
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={onRecheck}><Icon name="refresh" size={16} />다시 검증</button>
          <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} aria-controls="rules-check-list" onClick={() => setOpen(o => !o)}>{open ? '접기' : '자세히'}</button>
        </div>
      </header>
      {error && <div className="banner banner-danger" role="alert">{error.message}</div>}
      {open && issues && (
        issues.length === 0
          ? <p className="rules-check-ok"><Icon name="check_circle" size={16} />문제가 없습니다.</p>
          : <ul id="rules-check-list" className="check-list" aria-label="검증 결과">{issues.map((i, n) => <IssueItem key={`${i.ruleId}${i.code}${n}`} issue={i} withRule />)}</ul>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: AssemblyRuleSummary['status'] }) {
  return status === 'approved'
    ? <Badge tone="success" title="승인된 규칙">승인</Badge>
    : <Badge tone="warning" title="가상 값 · 검토 전입니다. 실제 작업에 쓰지 않습니다">검토 전</Badge>;
}

function RuleFlag({ counts }: { counts: { error: number; warning: number } }) {
  const total = counts.error + counts.warning;
  return (
    <span className={`rule-flag ${counts.error > 0 ? 'rule-flag-error' : 'rule-flag-warning'}`} aria-label={`검증 문제 ${total}건`} title={`오류 ${counts.error} · 경고 ${counts.warning}`}>
      <Icon name={counts.error > 0 ? 'error' : 'warning'} size={13} />{total}
    </span>
  );
}

function OperationChip({ operation, label }: { operation: AssemblyOperation; label: string }) {
  return <span className="rule-op"><Icon name={OPERATION_ICON[operation]} size={14} />{label}</span>;
}

/**
 * 조립 규칙: 왼쪽에 규칙 목록, 오른쪽에 선택한 규칙의 상세.
 * 상세는 정보 · 온톨로지(3D) · 목록 세 가지로 볼 수 있고, 온톨로지 탭은 규칙 ↔ 공정 · 적용 대상 · 공구 · 주의사항 · 품목 연결을 3D 그래프로 보인다.
 */
export function RulesPage() {
  const { api } = useSession();
  const { ruleId } = useParams();
  const list = useAsync(() => api.listAssemblyRules(), []);
  const [checkTick, setCheckTick] = useState(0);
  const check = useAsync(() => api.validateAssemblyRules(), [checkTick]);
  const issuesByRule = useMemo(() => countByRule(check.data), [check.data]);
  const [query, setQuery] = useState('');
  const [operation, setOperation] = useState<AssemblyOperation | 'all'>('all');

  const selectedId = ruleId ?? list.data?.[0]?.id;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list.data ?? []).filter(r =>
      (operation === 'all' || r.operation === operation)
      && (!q || [r.id, r.name, ...r.appliesTo].some(s => s.toLowerCase().includes(q))));
  }, [list.data, query, operation]);

  const counts = useMemo(() => {
    const m = new Map<AssemblyOperation, { label: string; n: number }>();
    (list.data ?? []).forEach(r => m.set(r.operation, { label: r.operationLabel, n: (m.get(r.operation)?.n ?? 0) + 1 }));
    return [...m.entries()];
  }, [list.data]);

  return (
    <div className="page rules-page">
      <div className="page-head">
        <div>
          <h1>조립 규칙</h1>
          <p className="sub">부품을 조립할 때 따르는 사내 규칙입니다. 조립 안내(3D 위의 카드와 자막)가 여기서 값을 읽습니다. 가상 회사의 목업이고 숫자는 시연용입니다.</p>
        </div>
      </div>

      <RuleCheck issues={check.data} loading={check.loading} error={check.error} onRecheck={() => setCheckTick(t => t + 1)} />

      <div className="rules-layout">
        <section className="glass-panel rules-list-panel" aria-label="규칙 목록">
          <header className="panel-head">
            <div>
              <h2>규칙 목록</h2>
              <p className="panel-sub" aria-live="polite">
                {list.data && `규칙 ${list.data.length}개 · 승인 ${list.data.filter(r => r.status === 'approved').length} · 검토 전 ${list.data.filter(r => r.status === 'draft').length}`}
              </p>
            </div>
          </header>
          <div className="rules-filters">
            <input className="input" type="search" aria-label="규칙 검색" placeholder="번호 · 이름 · 적용 대상 검색"
              value={query} onChange={e => setQuery(e.target.value)} />
            <div className="rule-chips" role="group" aria-label="공정 필터">
              <button type="button" className="rule-chip" aria-pressed={operation === 'all'} onClick={() => setOperation('all')}>전체 {list.data?.length ?? ''}</button>
              {counts.map(([op, { label, n }]) => (
                <button key={op} type="button" className="rule-chip" aria-pressed={operation === op} onClick={() => setOperation(op)}>{label} {n}</button>
              ))}
            </div>
          </div>
          <Loaded state={list} empty={rs => rs.length === 0}>
            {() => rows.length === 0 ? <div className="empty">조건에 맞는 규칙이 없습니다.</div> : (
              <ul className="rule-items">
                {rows.map(r => (
                  <li key={r.id}>
                    <Link to={`/rules/${r.id}`} className={`rule-item ${r.id === selectedId ? 'rule-item-on' : ''}`} aria-current={r.id === selectedId ? 'true' : undefined}>
                      <span className="rule-item-head">
                        <span className="mono rule-id">{r.id}</span>
                        <span className="rule-item-flags">
                          {issuesByRule.get(r.id) && <RuleFlag counts={issuesByRule.get(r.id)!} />}
                          <StatusBadge status={r.status} />
                        </span>
                      </span>
                      <span className="rule-name">{r.name}</span>
                      <span className="rule-meta">
                        <OperationChip operation={r.operation} label={r.operationLabel} />
                        <span className="rule-target">{r.appliesTo.join(' · ')}</span>
                      </span>
                      <span className="rule-kv">
                        {r.keyValues.map(k => <span key={k.label}><small>{k.label}</small>{k.value}</span>)}
                      </span>
                      <span className="rule-counts">주의 {r.cautionCount} · 공구 {r.toolCount}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Loaded>
        </section>

        <RuleDetailPanel ruleId={selectedId} issues={(check.data ?? []).filter(i => i.ruleId === selectedId)} />
      </div>
    </div>
  );
}

function RuleDetailPanel({ ruleId, issues }: { ruleId: string | undefined; issues: RuleIssue[] }) {
  const { api } = useSession();
  const detail = useAsync<AssemblyRuleDetail | undefined>(() => (ruleId ? api.getAssemblyRule(ruleId) : Promise.resolve(undefined)), [ruleId]);
  const [tab, setTab] = useState<DetailTab>('info');

  return (
    <section className="glass-panel rules-detail-panel" aria-label="규칙 상세">
      <Loaded state={detail} empty={d => !d}>
        {d => d && <RuleDetail key={d.id} rule={d} issues={issues} tab={tab} onTab={setTab} />}
      </Loaded>
      {!ruleId && !detail.loading && <div className="empty">규칙을 고르세요.</div>}
    </section>
  );
}

function RuleDetail({ rule, issues, tab, onTab }: { rule: AssemblyRuleDetail; issues: RuleIssue[]; tab: DetailTab; onTab(t: DetailTab): void }) {
  const graph = useMemo(() => ruleGraph(rule), [rule]);
  const [unsupported, setUnsupported] = useState(false);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const node = graph.nodes.find(n => n.id === nodeId);
  useEffect(() => { setNodeId(null); }, [rule.id]);

  const tabs: { id: DetailTab; label: string }[] = [{ id: 'info', label: '정보' }, { id: 'onto', label: '온톨로지(3D)' }, { id: 'list', label: '목록' }];

  return (
    <>
      <header className="panel-head rule-detail-head">
        <div>
          <p className="rule-eyebrow mono">{rule.id}</p>
          <h2>{rule.name}</h2>
          <div className="rule-badges">
            <OperationChip operation={rule.operation} label={rule.operationLabel} />
            <StatusBadge status={rule.status} />
            <span className="rule-target">{rule.appliesTo.join(' · ')}</span>
          </div>
        </div>
      </header>

      <div className="rule-tabs">
        <div className="tabs" role="tablist" aria-label="규칙 보기">
          {tabs.map(t => (
            <button key={t.id} type="button" role="tab" className="tab" aria-selected={tab === t.id} onClick={() => onTab(t.id)}>{t.label}</button>
          ))}
        </div>
      </div>

      {tab === 'info' && (
        <div className="rule-body" role="tabpanel" aria-label="정보">
          <p className="rule-desc">{rule.description}</p>

          {issues.length > 0 && (
            <section className="rule-section" aria-label="이 규칙의 검증 결과">
              <h3>검증 결과 <span className="faint">{issues.length}</span></h3>
              <ul className="check-list">{issues.map((i, n) => <IssueItem key={`${i.code}${n}`} issue={i} withRule={false} />)}</ul>
            </section>
          )}

          <section className="rule-section">
            <h3>적용 조건</h3>
            <ul className="rule-plain">{rule.conditions.map(c => <li key={c}>{c}</li>)}</ul>
          </section>

          <section className="rule-section">
            <h3>값</h3>
            <div className="rule-table-scroll">
              <table className="table" aria-label="규칙 값">
                <tbody>{rule.parameters.map(p => <tr key={p.label}><th scope="row">{p.label}</th><td>{p.value}</td></tr>)}</tbody>
              </table>
            </div>
          </section>

          {rule.table && (
            <section className="rule-section">
              <h3>{rule.table.title}</h3>
              <div className="rule-table-scroll">
                <table className="table" aria-label="조건표">
                  <thead><tr>{rule.table.columns.map(c => <th key={c} scope="col">{c}</th>)}</tr></thead>
                  <tbody>{rule.table.rows.map(row => <tr key={row.join('|')}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </section>
          )}

          {rule.cautions.length > 0 && (
            <section className="rule-section">
              <h3>주의사항</h3>
              <ul className="rule-cautions" aria-label="주의사항">
                {rule.cautions.map(c => <li key={c}><Icon name="warning" size={14} />{c}</li>)}
              </ul>
            </section>
          )}

          {rule.tools.length > 0 && (
            <section className="rule-section">
              <h3>공구</h3>
              <div className="row">{rule.tools.map(t => <span key={t} className="chip">{t}</span>)}</div>
            </section>
          )}

          <section className="rule-section">
            <h3>이 규칙이 적용되는 품목 <span className="faint">{rule.usedBy.length}</span></h3>
            {rule.usedBy.length === 0
              ? <p className="faint">적용되는 보유 품목이 없습니다.</p>
              : <ul className="rule-used">{rule.usedBy.map(u => (
                  <li key={u.itemNo}><Link to={`/items/${u.itemNo}`} className="mono">{u.itemNo}</Link> <span className="muted">{u.name}</span></li>
                ))}</ul>}
          </section>

          <footer className="rule-source mono">{rule.source}</footer>
        </div>
      )}

      {tab === 'onto' && (
        <div className="rule-body" role="tabpanel" aria-label="온톨로지">
          <div className="rule-graph-stage">
            {unsupported ? (
              <>
                <div className="banner banner-info" role="status">이 환경에서는 3D를 쓸 수 없어 목록으로 보여 드립니다.</div>
                <GraphList graph={graph} selectedId={nodeId} onSelect={setNodeId} label={`${rule.id} 온톨로지 목록`} />
              </>
            ) : (
              <Graph3D graph={graph} selectedId={nodeId} onSelect={setNodeId} label={`${rule.id} 온톨로지 그래프`} onUnsupported={() => setUnsupported(true)} />
            )}
          </div>
          <ul className="rule-legend" aria-label="범례">
            {(['rule', 'operation', 'class', 'tool', 'caution', 'part'] as NodeKind[]).map(k => <li key={k} className={`lg lg-${k}`}>{KIND_LABEL[k]}</li>)}
          </ul>
          <p className="rule-picked" aria-live="polite" data-testid="rule-picked">
            {node
              ? <>선택: <strong>{node.sub && node.kind === 'caution' ? node.sub : node.label}</strong> <span className="faint">({KIND_LABEL[node.kind]})</span>
                  {node.kind === 'part' && node.ref && <> · <Link to={`/items/${node.ref}`} className="mono">{node.ref}</Link></>}</>
              : <span className="faint">노드를 누르면 여기에 표시됩니다.</span>}
          </p>
        </div>
      )}

      {tab === 'list' && (
        <div className="rule-body" role="tabpanel" aria-label="목록">
          <GraphList graph={graph} selectedId={nodeId} onSelect={setNodeId} label={`${rule.id} 온톨로지 목록`} />
        </div>
      )}
    </>
  );
}
