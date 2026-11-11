import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { RulebookGap, RulebookGrade, RulebookRule, RulebookSource, RulebookStatus, RulebookTool, WorkStandardSummary } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { Badge, Loaded, NotConnected } from '../../components/ui';
import { FASTENER_CLASSES } from '../../extract/fastener.config';
import { useAsync } from '../../hooks/useAsync';
import { useSession } from '../../session';
import { Graph3D } from '../graph/Graph3D';
import { GraphList } from '../graph/GraphList';
import { ruleGraph, type NodeKind, type RuleGraphInput } from '../graph/graphData';
import '../studio/studio.css';
import { DraftChip, GRADE_TEXT, ParamRow, RulebookNotice, SourceBadge, ValueCell, paramLabel, roleShort, unitOfKey, useRulebookStatus } from './rulebookUi';
import './rules.css';

const KIND_LABEL: Record<NodeKind, string> = {
  product: '제품', assembly: '조립품', part: '품목', rule: '규칙', operation: '공정', class: '적용 대상', tool: '공구', caution: '주의사항',
  change: '변경', workorder: '작업지시', purchase: '발주', stock: '재고', joint: '체결부',
};
const SCOPE_TEXT: Record<RulebookRule['scope'], string> = { part: '부품 규칙', role: '역할 규칙', product: '제품 전반' };
const LEVEL_TONE: Record<string, 'warning' | 'info'> = { 경고: 'warning', 주의: 'warning' };
const LOOKUP_KEY_LABEL: Record<string, string> = { model: '모델' };

type DetailTab = 'info' | 'onto' | 'list';

const unconfirmedCount = (r: RulebookRule) => r.parameters.filter(p => !p.confirmed).length;

/** 규칙의 적용 대상 이름(분류 · 역할 · 제품 전반) */
function targetsOf(r: RulebookRule, classLabel: (code: string) => string): string[] {
  const { classes, proposedClasses, role, roleLabel } = r.appliesTo;
  const out = [...classes.map(classLabel), ...proposedClasses.map(c => `${classLabel(c)}(제안)`)];
  if (out.length === 0) out.push(role ? roleShort(roleLabel, role) : '제품 전반');
  return out;
}

function GradeMini({ rule }: { rule: RulebookRule }) {
  const g = rule.byGrade;
  const parts: { grade: RulebookGrade; n: number }[] = (['manual', 'standard', 'cad', 'unknown'] as RulebookGrade[]).map(grade => ({ grade, n: g[grade] ?? 0 })).filter(x => x.n > 0);
  return (
    <span className="rb-grades" aria-label="값의 출처">
      {parts.map(({ grade, n }) => <span key={grade} className={`rb-grade rb-grade-${grade}`} title={`${GRADE_TEXT[grade]} 값 ${n}개`}>{GRADE_TEXT[grade]} {n}</span>)}
    </span>
  );
}

/**
 * 조립 규칙: 왼쪽에 규칙 목록, 오른쪽에 선택한 규칙의 상세. 규칙은 PDM 소유 규칙집(저장소 rules/)을 백엔드가 읽기 전용으로 내보낸 것이고,
 * 모든 값에 출처(사용설명서 쪽 번호 · CAD 추정 · 근거 없음)가 붙는다. 근거가 없는 값은 비워 두고 '작성 필요'라고 말한다. 모든 규칙은 초안(검토 전)이다.
 */
export function RulesPage() {
  const { api } = useSession();
  const rb = api.rulebook;
  const { status, retry } = useRulebookStatus(rb);

  return (
    <div className="page rules-page">
      <div className="page-head">
        <div>
          <h1>조립 규칙</h1>
          <p className="sub">부품을 조립할 때 따르는 규칙입니다. 사용설명서와 CAD 구조에서 근거를 찾아 PDM이 관리하고, 조립 안내(3D 위의 카드와 자막)가 여기서 값을 읽습니다. 근거가 없는 값은 비워 두고 &lsquo;작성 필요&rsquo;로 표시해요.</p>
        </div>
      </div>

      {!rb && <NotConnected title="조립 규칙이 없어요" hint="PDM 백엔드에 연결되면 사내 조립 규칙(체결 · 커넥터 · 설치 등)이 여기에 표시돼요." />}
      {rb && status === 'loading' && <div className="empty" role="status">규칙집을 확인하는 중…</div>}
      {rb && status && status !== 'loading' && status.state !== 'ok' && <RulebookNotice status={status} onRetry={() => void retry()} />}
      {rb && status && status !== 'loading' && status.state === 'ok' && <RulesBoard rb={rb} status={status} />}
    </div>
  );
}

function RulesBoard({ rb, status }: { rb: RulebookSource; status: RulebookStatus }) {
  const { api } = useSession();
  const { ruleId } = useParams();
  const list = useAsync(() => rb.listRules(), [rb]);
  const tools = useAsync(() => rb.listTools().catch((): RulebookTool[] => []), [rb]);
  const standards = useAsync(() => rb.listWorkStandards().catch((): WorkStandardSummary[] => []), [rb]);
  const gaps = useAsync(() => rb.listGaps().catch((): RulebookGap[] => []), [rb]);
  const classes = useAsync(() => api.listClasses().catch(() => []), [api]);

  const classLabel = useMemo(() => {
    const m = new Map<string, string>();
    (classes.data ?? []).forEach(c => m.set(c.code, c.labelKo));
    FASTENER_CLASSES.forEach(c => { if (!m.has(c.classCode)) m.set(c.classCode, c.label); });
    return (code: string) => m.get(code) ?? code;
  }, [classes.data]);
  const toolName = useMemo(() => {
    const m = new Map((tools.data ?? []).map(t => [t.id, t.nameKo] as const));
    return (id: string) => m.get(id) ?? id;
  }, [tools.data]);

  const [query, setQuery] = useState('');
  const [operation, setOperation] = useState('all');
  const [cls, setCls] = useState('all');
  const [role, setRole] = useState('all');
  const [grade, setGrade] = useState<'all' | RulebookGrade>('all');
  const [model, setModel] = useState('all');

  const rules = list.data ?? [];
  const selectedId = ruleId ?? rules[0]?.id;

  const options = useMemo(() => {
    const classSet = new Set<string>(), roleMap = new Map<string, string>(), modelSet = new Set<string>(), gradeSet = new Set<RulebookGrade>();
    rules.forEach(r => {
      [...r.appliesTo.classes, ...r.appliesTo.proposedClasses].forEach(c => classSet.add(c));
      if (r.appliesTo.role) roleMap.set(r.appliesTo.role, roleShort(r.appliesTo.roleLabel, r.appliesTo.role));
      r.appliesTo.models.forEach(m => modelSet.add(m));
      (['manual', 'standard', 'cad', 'unknown'] as RulebookGrade[]).forEach(g => { if ((r.byGrade[g] ?? 0) > 0) gradeSet.add(g); });
    });
    return { classes: [...classSet], roles: [...roleMap], models: [...modelSet].sort(), grades: [...gradeSet] };
  }, [rules]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rules.filter(r =>
      (operation === 'all' || r.operation === operation)
      && (cls === 'all' || r.appliesTo.classes.includes(cls) || r.appliesTo.proposedClasses.includes(cls))
      && (role === 'all' || r.appliesTo.role === role)
      && (grade === 'all' || (r.byGrade[grade] ?? 0) > 0)
      && (model === 'all' || r.appliesTo.models.length === 0 || r.appliesTo.models.includes(model))
      && (!q || [r.id, r.name, r.operationLabel ?? '', ...targetsOf(r, classLabel)].some(s => s.toLowerCase().includes(q))));
  }, [rules, query, operation, cls, role, grade, model, classLabel]);

  const ops = useMemo(() => {
    const m = new Map<string, { label: string; n: number }>();
    rules.forEach(r => m.set(r.operation, { label: r.operationLabel ?? r.operation, n: (m.get(r.operation)?.n ?? 0) + 1 }));
    return [...m.entries()];
  }, [rules]);

  const drafts = rules.filter(r => r.reviewStatus === 'unreviewed').length;
  const c = status.counts;

  return (
    <>
      <p className="rb-status" role="status" aria-label="규칙집 상태">
        <Icon name="rule_folder" size={16} />
        <strong>규칙집 적재됨</strong>
        {c && <span> · 규칙 {c.rules} · 작업표준 {c.workStandards} · 공백 {c.gaps}</span>}
        {list.data && <span> · {drafts === rules.length ? '모두 초안(검토 전)' : `초안 ${drafts} · 검토됨 ${rules.length - drafts}`}</span>}
        {status.byGrade && (
          <span className="rb-status-grades"> · 값 출처: {(['manual', 'cad', 'standard', 'unknown'] as RulebookGrade[]).filter(g => (status.byGrade?.[g] ?? 0) > 0)
            .map(g => `${GRADE_TEXT[g]} ${status.byGrade?.[g]}`).join(' · ')}</span>
        )}
      </p>

      <div className="rules-layout">
        <section className="glass-panel rules-list-panel" aria-label="규칙 목록">
          <header className="panel-head">
            <div>
              <h2>규칙 목록</h2>
              <p className="panel-sub" aria-live="polite">{list.data && `규칙 ${rows.length}${rows.length !== rules.length ? ` / ${rules.length}` : ''}개`}</p>
            </div>
          </header>
          <div className="rules-filters">
            <input className="input" type="search" aria-label="규칙 검색" placeholder="번호 · 이름 · 적용 대상 검색" value={query} onChange={e => setQuery(e.target.value)} />
            <div className="rb-selects">
              <select className="select" aria-label="분류 필터" value={cls} onChange={e => setCls(e.target.value)}>
                <option value="all">분류 전체</option>
                {options.classes.map(code => <option key={code} value={code}>{classLabel(code)}</option>)}
              </select>
              <select className="select" aria-label="역할 필터" value={role} onChange={e => setRole(e.target.value)}>
                <option value="all">역할 전체</option>
                {options.roles.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
              <select className="select" aria-label="출처 필터" value={grade} onChange={e => setGrade(e.target.value as 'all' | RulebookGrade)}>
                <option value="all">출처 전체</option>
                {options.grades.map(g => <option key={g} value={g}>{GRADE_TEXT[g]}</option>)}
              </select>
              <select className="select" aria-label="모델 필터" value={model} onChange={e => setModel(e.target.value)}>
                <option value="all">모델 전체</option>
                {options.models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="rule-chips" role="group" aria-label="공정 필터">
              <button type="button" className="rule-chip" aria-pressed={operation === 'all'} onClick={() => setOperation('all')}>전체 {rules.length || ''}</button>
              {ops.map(([op, { label, n }]) => (
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
                        <span className="rule-item-flags"><DraftChip status={r.reviewStatus} /></span>
                      </span>
                      <span className="rule-name">{r.name}</span>
                      <span className="rule-meta">
                        <span className="rule-op"><Icon name="construction" size={14} />{r.operationLabel ?? r.operation}</span>
                        <span className="rule-target">{targetsOf(r, classLabel).join(' · ')}</span>
                        {r.appliesTo.proposedClasses.length > 0 && <span className="rb-proposed" title="OPMS 에 아직 없는 분류예요">제안(미등록)</span>}
                      </span>
                      <span className="rule-counts">
                        <GradeMini rule={r} />
                        {unconfirmedCount(r) > 0 && <span className="rb-unconf-count"> · 미확정 값 {unconfirmedCount(r)}</span>}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Loaded>
        </section>

        <RuleDetailPanel rb={rb} ruleId={selectedId} classLabel={classLabel} toolName={toolName} standards={standards.data ?? []} gaps={gaps.data ?? []} />
      </div>
    </>
  );
}

function RuleDetailPanel({ rb, ruleId, classLabel, toolName, standards, gaps }: {
  rb: RulebookSource; ruleId: string | undefined; classLabel(code: string): string; toolName(id: string): string; standards: WorkStandardSummary[]; gaps: RulebookGap[];
}) {
  const detail = useAsync<RulebookRule | undefined>(() => (ruleId ? rb.getRule(ruleId) : Promise.resolve(undefined)), [rb, ruleId]);
  const [tab, setTab] = useState<DetailTab>('info');

  return (
    <section className="glass-panel rules-detail-panel" aria-label="규칙 상세">
      <Loaded state={detail} empty={d => !d}>
        {d => d && <RuleDetail key={d.id} rule={d} tab={tab} onTab={setTab} classLabel={classLabel} toolName={toolName} standards={standards} gaps={gaps} />}
      </Loaded>
      {!ruleId && !detail.loading && <div className="empty">규칙을 고르세요.</div>}
    </section>
  );
}

function RuleDetail({ rule, tab, onTab, classLabel, toolName, standards, gaps }: {
  rule: RulebookRule; tab: DetailTab; onTab(t: DetailTab): void; classLabel(code: string): string; toolName(id: string): string; standards: WorkStandardSummary[]; gaps: RulebookGap[];
}) {
  const targets = targetsOf(rule, classLabel);
  const graphInput = useMemo<RuleGraphInput>(() => ({
    id: rule.id, name: rule.name, operation: rule.operation, operationLabel: rule.operationLabel ?? rule.operation,
    appliesTo: targetsOf(rule, classLabel), tools: rule.tools.map(toolName), cautions: rule.cautions.map(c => c.text), usedBy: [],
  }), [rule, toolName, classLabel]);
  const graph = useMemo(() => ruleGraph(graphInput), [graphInput]);
  const [unsupported, setUnsupported] = useState(false);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const node = graph.nodes.find(n => n.id === nodeId);
  useEffect(() => { setNodeId(null); }, [rule.id]);

  const ap = rule.appliesTo;
  const usedIn = standards.filter(s => s.rules.includes(rule.id));
  const gapOf = new Map(gaps.map(g => [g.id, g] as const));
  const tabs: { id: DetailTab; label: string }[] = [{ id: 'info', label: '정보' }, { id: 'onto', label: '온톨로지(3D)' }, { id: 'list', label: '목록' }];

  // 표(lookup)의 열: 행마다 있는 키를 처음 나온 순서대로
  const lookupCols = useMemo(() => {
    const cols: string[] = [];
    rule.lookup?.rows.forEach(r => Object.keys(r.values).forEach(k => { if (!cols.includes(k)) cols.push(k); }));
    return cols;
  }, [rule.lookup]);

  return (
    <>
      <header className="panel-head rule-detail-head">
        <div>
          <p className="rule-eyebrow mono">{rule.id}</p>
          <h2>{rule.name}</h2>
          <div className="rule-badges">
            <span className="rule-op"><Icon name="construction" size={14} />{rule.operationLabel ?? rule.operation}</span>
            <DraftChip status={rule.reviewStatus} />
            <Badge tone="neutral" title="이 규칙이 무엇을 대상으로 하는가">{SCOPE_TEXT[rule.scope]}</Badge>
            {ap.proposedClasses.length > 0 && <span className="rb-proposed" title="OPMS 에 아직 없는 분류예요">제안(미등록)</span>}
            <span className="rule-target">{targets.join(' · ')}</span>
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
          {rule.note && <p className="rule-desc">{rule.note}</p>}

          <section className="rule-section" aria-label="적용 대상">
            <h3>적용 대상 <SourceBadge item={ap} /></h3>
            <dl className="rb-dl">
              {(ap.classes.length > 0 || ap.proposedClasses.length > 0) && (
                <div><dt>분류</dt><dd className="row">
                  {ap.classes.map(c => <span key={c} className="chip" title={c}>{classLabel(c)}</span>)}
                  {ap.proposedClasses.map(c => <span key={c} className="chip rb-proposed" title="OPMS 에 아직 없는 분류예요">{classLabel(c)} · 제안(미등록)</span>)}
                </dd></div>
              )}
              {ap.role && <div><dt>역할</dt><dd>{roleShort(ap.roleLabel, ap.role)}</dd></div>}
              <div><dt>모델</dt><dd className="row">{ap.models.length === 0 ? <span className="faint">모델 제한 없음</span> : ap.models.map(m => <span key={m} className="chip">{m}</span>)}</dd></div>
              {Object.entries(ap.where).map(([k, v]) => (
                <div key={k}><dt>조건</dt><dd>{paramLabel(k)} = {Array.isArray(v) ? v.join(' 또는 ') : String(v)}</dd></div>
              ))}
            </dl>
          </section>

          {rule.parameters.length > 0 && (
            <section className="rule-section">
              <h3>값</h3>
              <div className="rule-table-scroll">
                <table className="table" aria-label="규칙 값">
                  <tbody>{rule.parameters.map(p => <ParamRow key={p.name} p={p} />)}</tbody>
                </table>
              </div>
            </section>
          )}

          {rule.lookup && rule.lookup.rows.length > 0 && (
            <section className="rule-section">
              <h3>{LOOKUP_KEY_LABEL[rule.lookup.key] ?? paramLabel(rule.lookup.key)}별 값</h3>
              <div className="rule-table-scroll">
                <table className="table" aria-label="조건표">
                  <thead>
                    <tr>
                      <th scope="col">{LOOKUP_KEY_LABEL[rule.lookup.key] ?? paramLabel(rule.lookup.key)}</th>
                      {lookupCols.map(k => <th key={k} scope="col">{paramLabel(k)}</th>)}
                      <th scope="col">출처</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rule.lookup.rows.map(row => (
                      <tr key={row.key}>
                        <th scope="row">{row.key}</th>
                        {lookupCols.map(k => <td key={k}><ValueCell item={row} value={row.values[k]} {...(unitOfKey(k) ? { unit: unitOfKey(k)! } : {})} /></td>)}
                        <td><SourceBadge item={row} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {rule.cautions.length > 0 && (
            <section className="rule-section">
              <h3>주의사항</h3>
              <ul className="rule-cautions rb-cautions" aria-label="주의사항">
                {rule.cautions.map(c => (
                  <li key={c.text}>
                    <Icon name={c.level === '참고' || c.level === '안내' ? 'info' : 'warning'} size={14} />
                    <span>
                      <Badge tone={LEVEL_TONE[c.level] ?? 'info'}>{c.level}</Badge> {c.text}
                      <small className="rb-note"><SourceBadge item={c} compact /> {c.refs[0]?.label}</small>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {rule.tools.length > 0 && (
            <section className="rule-section">
              <h3>공구</h3>
              <div className="row">{rule.tools.map(t => <span key={t} className="chip" title={t}>{toolName(t)}</span>)}</div>
            </section>
          )}

          <section className="rule-section">
            <h3>이 규칙을 쓰는 작업표준 <span className="faint">{usedIn.length}</span></h3>
            {usedIn.length === 0
              ? <p className="faint">이 규칙을 쓰는 작업표준서가 없어요.</p>
              : <ul className="rule-used">{usedIn.map(s => (
                  <li key={s.id}><Link to={`/mes?standard=${encodeURIComponent(s.id)}`} className="chip-holo chip-rule mono">{s.id}</Link> <span className="muted">{s.title}</span></li>
                ))}</ul>}
          </section>

          {rule.gapIds.length > 0 && (
            <section className="rule-section" aria-label="작성이 필요한 곳">
              <h3>작성이 필요한 곳 <span className="faint">{rule.gapIds.length}</span></h3>
              <ul className="rb-gaps">
                {rule.gapIds.map(id => (
                  <li key={id}><span className="rb-empty">{id}</span> {gapOf.get(id)?.title ?? ''}{gapOf.get(id)?.who && <small className="rb-note">필요한 곳: {gapOf.get(id)?.who}</small>}</li>
                ))}
              </ul>
            </section>
          )}

          <footer className="rule-source">
            {rule.cadInference && <p>CAD 구조에서 도출: <span className="mono">{rule.cadInference.part}</span>{rule.cadInference.quantity !== undefined && ` × ${rule.cadInference.quantity}`}</p>}
            <span className="mono">{rule.id}</span> · 값 출처 {(['manual', 'standard', 'cad', 'unknown'] as RulebookGrade[]).filter(g => (rule.byGrade[g] ?? 0) > 0).map(g => `${GRADE_TEXT[g]} ${rule.byGrade[g]}`).join(' · ')}
          </footer>
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
            {(['rule', 'operation', 'class', 'tool', 'caution'] as NodeKind[]).map(k => <li key={k} className={`lg lg-${k}`}>{KIND_LABEL[k]}</li>)}
          </ul>
          <p className="rule-picked" aria-live="polite" data-testid="rule-picked">
            {node
              ? <>선택: <strong>{node.sub && node.kind === 'caution' ? node.sub : node.label}</strong> <span className="faint">({KIND_LABEL[node.kind]})</span></>
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
