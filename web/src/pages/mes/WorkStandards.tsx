import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { RulebookGap, RulebookRule, RulebookSource, RulebookStatus, RulebookTool, WorkStandard, WorkStandardSummary } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { Badge, Loaded } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { DraftChip, GRADE_TEXT, SourceBadge, ValueCell, formatValue, roleShort } from '../rules/rulebookUi';
import '../rules/rules.css';

const KIND_TEXT: Record<WorkStandardSummary['kind'], string> = { procedure: '작업 절차', structure_only: 'CAD 구조만' };
const LEVEL_TONE: Record<string, 'warning' | 'info'> = { 경고: 'warning', 주의: 'warning' };

/**
 * 작업 표준: 규칙집(저장소 rules/)의 작업표준서를 목록 · 상세로 본다. 작업 순서 · 주의사항(사용설명서 경고 문구 + 쪽 번호) · 품질 확인 · 점검 항목 · 공구,
 * 값마다 출처 배지. 근거가 없는 곳은 '작성 필요 G-0xx' 이고, 표준 시간은 근거가 없어 비어 있다. 모두 초안(검토 전)이다. 인쇄하기 좋은 상세 레이아웃이 있다.
 */
export function WorkStandardsView({ rb, status }: { rb: RulebookSource; status: RulebookStatus }) {
  const [params, setParams] = useSearchParams();
  const list = useAsync(() => rb.listWorkStandards(), [rb]);
  const tools = useAsync(() => rb.listTools().catch((): RulebookTool[] => []), [rb]);
  const rules = useAsync(() => rb.listRules().catch((): RulebookRule[] => []), [rb]);
  const gaps = useAsync(() => rb.listGaps().catch((): RulebookGap[] => []), [rb]);
  const [showGaps, setShowGaps] = useState(false);
  const [query, setQuery] = useState('');
  const [model, setModel] = useState('all');
  const [kind, setKind] = useState<'all' | WorkStandardSummary['kind']>('all');

  const all = list.data ?? [];
  const selectedId = params.get('standard') ?? all[0]?.id;
  const models = useMemo(() => [...new Set(all.flatMap(w => w.models))].sort(), [all]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(w => (model === 'all' || w.models.includes(model)) && (kind === 'all' || w.kind === kind) && (!q || [w.id, w.title, w.purpose].some(s => s.toLowerCase().includes(q))));
  }, [all, model, kind, query]);
  const select = (id: string) => setParams(prev => { const n = new URLSearchParams(prev); n.set('standard', id); return n; }, { replace: true });

  const toolName = useMemo(() => {
    const m = new Map((tools.data ?? []).map(t => [t.id, t.nameKo] as const));
    return (id: string) => m.get(id) ?? id;
  }, [tools.data]);
  const ruleOf = useMemo(() => new Map((rules.data ?? []).map(r => [r.id, r] as const)), [rules.data]);
  const gapOf = useMemo(() => new Map((gaps.data ?? []).map(g => [g.id, g] as const)), [gaps.data]);
  const c = status.counts;
  const drafts = all.filter(w => w.reviewStatus === 'unreviewed').length;

  return (
    <>
      <p className="rb-status ws-print-hide" role="status" aria-label="규칙집 상태">
        <Icon name="rule_folder" size={16} />
        <strong>규칙집 적재됨</strong>
        {c && <span> · 작업표준 {c.workStandards} · 규칙 {c.rules} · 공백 {c.gaps}</span>}
        {list.data && <span> · {drafts === all.length ? '모두 초안(검토 전)' : `초안 ${drafts} · 검토됨 ${all.length - drafts}`}</span>}
      </p>

      <div className="ws-layout">
        <section className="glass-panel ws-list ws-print-hide" aria-label="작업표준서 목록">
          <header className="panel-head">
            <div>
              <h2>작업표준서</h2>
              <p className="panel-sub" aria-live="polite">{list.data && `${rows.length}${rows.length !== all.length ? ` / ${all.length}` : ''}건`}</p>
            </div>
            <span className="spacer" />
            <button type="button" className="btn btn-sm" aria-expanded={showGaps} onClick={() => setShowGaps(v => !v)}>
              <Icon name="edit_note" size={16} />작성 필요 목록{gaps.data ? ` ${gaps.data.length}` : ''}
            </button>
          </header>
          <div className="rules-filters">
            <input className="input" type="search" aria-label="작업표준서 검색" placeholder="번호 · 제목 · 목적 검색" value={query} onChange={e => setQuery(e.target.value)} />
            <div className="rb-selects">
              <select className="select" aria-label="모델 필터" value={model} onChange={e => setModel(e.target.value)}>
                <option value="all">모델 전체</option>
                {models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <select className="select" aria-label="종류 필터" value={kind} onChange={e => setKind(e.target.value as 'all' | WorkStandardSummary['kind'])}>
                <option value="all">종류 전체</option>
                <option value="procedure">{KIND_TEXT.procedure}</option>
                <option value="structure_only">{KIND_TEXT.structure_only}</option>
              </select>
            </div>
          </div>
          <Loaded state={list} empty={ws => ws.length === 0}>
            {() => rows.length === 0 ? <div className="empty">조건에 맞는 작업표준서가 없습니다.</div> : (
              <ul className="rule-items">
                {rows.map(w => (
                  <li key={w.id}>
                    <button type="button" className={`rule-item ws-item ${w.id === selectedId ? 'rule-item-on' : ''}`} aria-current={w.id === selectedId ? 'true' : undefined} onClick={() => select(w.id)}>
                      <span className="rule-item-head"><span className="mono rule-id">{w.id}</span><DraftChip status={w.reviewStatus} /></span>
                      <span className="rule-name">{w.title}</span>
                      <span className="rule-meta">
                        <span className="rule-op">{KIND_TEXT[w.kind]}</span>
                        <span className="rule-target">{w.models.join(' · ')}</span>
                      </span>
                      <span className="rule-counts">
                        {w.kind === 'procedure' ? `단계 ${w.stepCount}${w.inspectionCount > 0 ? ` · 점검 ${w.inspectionCount}` : ''}` : `조립품 ${w.assemblyCount}`}
                        {w.gapIds.length > 0 && <span className="rb-unconf-count"> · 작성 필요 {w.gapIds.length}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Loaded>
        </section>

        <div className="ws-main">
          {showGaps && <GapPanel gaps={gaps.data ?? []} />}
          <StandardDetail rb={rb} id={selectedId} toolName={toolName} ruleOf={ruleOf} gapOf={gapOf} />
        </div>
      </div>
    </>
  );
}

function GapPanel({ gaps }: { gaps: RulebookGap[] }) {
  return (
    <section className="glass-panel ws-gaps ws-print-hide" aria-label="작성 필요 목록">
      <header className="panel-head"><div><h2>작성이 필요한 곳</h2><p className="panel-sub">근거가 없어 값을 비워 둔 곳이에요. 누가 무엇을 채워야 하는지 적었어요.</p></div></header>
      {gaps.length === 0 ? <div className="empty">작성이 필요한 곳이 없어요.</div> : (
        <ul className="ws-gap-list">
          {gaps.map(g => (
            <li key={g.id} id={`gap-${g.id}`}>
              <p><span className="rb-empty">{g.id}</span> <strong>{g.title}</strong></p>
              <dl className="rb-dl">
                <div><dt>필요한 것</dt><dd>{g.needs}</dd></div>
                <div><dt>이유</dt><dd>{g.why}</dd></div>
                <div><dt>채울 곳</dt><dd>{g.who}</dd></div>
                {g.blocks.length > 0 && <div><dt>막힌 것</dt><dd className="row">{g.blocks.map(b => (
                  b.startsWith('AR-') ? <Link key={b} to={`/rules/${b}`} className="chip-holo chip-rule mono">{b}</Link> : <span key={b} className="chip mono">{b}</span>
                ))}</dd></div>}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StandardDetail({ rb, id, toolName, ruleOf, gapOf }: {
  rb: RulebookSource; id: string | undefined; toolName(id: string): string; ruleOf: Map<string, RulebookRule>; gapOf: Map<string, RulebookGap>;
}) {
  const detail = useAsync<WorkStandard | undefined>(() => (id ? rb.getWorkStandard(id) : Promise.resolve(undefined)), [rb, id]);
  return (
    <section className="glass-panel ws-detail" aria-label="작업표준서 상세">
      <Loaded state={detail} empty={d => !d}>
        {d => d && <Detail ws={d} toolName={toolName} ruleOf={ruleOf} gapOf={gapOf} />}
      </Loaded>
      {!id && !detail.loading && <div className="empty">작업표준서를 고르세요.</div>}
    </section>
  );
}

function Detail({ ws, toolName, ruleOf, gapOf }: { ws: WorkStandard; toolName(id: string): string; ruleOf: Map<string, RulebookRule>; gapOf: Map<string, RulebookGap> }) {
  const time = ws.standardTime;
  // 주의사항: 작업표준서는 규칙 번호만 가리키고, 문구(사용설명서 경고 + 쪽 번호)는 그 규칙에 있다
  const precautions = ws.precautions.flatMap(rid => (ruleOf.get(rid)?.cautions ?? []).map(c => ({ rid, c })));
  const missingPrecaution = ws.precautions.filter(rid => !ruleOf.has(rid));

  return (
    <>
      <header className="panel-head rule-detail-head">
        <div>
          <p className="rule-eyebrow mono">{ws.id} · {ws.revision}</p>
          <h2>{ws.title}</h2>
          <div className="rule-badges">
            <DraftChip status={ws.reviewStatus} />
            <Badge tone={ws.kind === 'procedure' ? 'info' : 'warning'} title={ws.kind === 'structure_only' ? 'CAD 구조만 있고 작업 절차는 근거가 없어 작성이 필요해요' : undefined}>{KIND_TEXT[ws.kind]}</Badge>
            {ws.models.map(m => <span key={m} className="chip">{m}</span>)}
          </div>
        </div>
        <span className="spacer" />
        <button type="button" className="btn btn-sm ws-print-hide" onClick={() => window.print()}><Icon name="print" size={16} />인쇄</button>
      </header>

      <div className="rule-body">
        <p className="rule-desc">{ws.purpose}</p>

        {ws.procedureGap && (
          <div className="banner banner-warning" role="status">
            <Icon name="edit_note" size={18} />
            <span>이 작업표준서에는 작업 절차(순서 · 토크 · 공구)가 없어요. 근거 자료가 없어 비워 뒀어요. <span className="rb-empty">작성 필요 {ws.procedureGap}</span></span>
          </div>
        )}

        <section className="rule-section" aria-label="표준 시간">
          <h3>표준 시간</h3>
          {formatValue(time.value, time.unit) === undefined
            ? <p><span className="rb-empty" title="근거가 없어 비워 뒀어요">표준 시간 없음 — 근거 없음{time.gapId ? ` (${time.gapId})` : ''}</span></p>
            : <p><ValueCell item={time} value={time.value} {...(time.unit ? { unit: time.unit } : {})} /> <SourceBadge item={time} /></p>}
        </section>

        {ws.tools.length > 0 && (
          <section className="rule-section" aria-label="공구">
            <h3>공구</h3>
            <div className="row">{ws.tools.map(t => <span key={t} className="chip" title={t}>{toolName(t)}</span>)}</div>
          </section>
        )}

        {ws.steps.length > 0 && (
          <section className="rule-section" aria-label="작업 순서">
            <h3>작업 순서</h3>
            <ol className="ws-steps">
              {ws.steps.map(s => (
                <li key={s.seq} className="ws-step">
                  <span className="ws-step-no" aria-hidden>{s.seq}</span>
                  <div>
                    <p className="ws-step-text">
                      {s.operationLabel && <span className="rule-op">{s.operationLabel}</span>} {s.text}
                    </p>
                    {s.condition && <small className="rb-note">조건: {s.condition}</small>}
                    {s.targets.length > 0 && (
                      <p className="ws-step-meta">{s.targets.map(t => <span key={t.role} className="chip">{roleShort(t.roleLabel, t.role)}{t.quantity !== undefined ? ` × ${t.quantity}` : ''}</span>)}</p>
                    )}
                    <p className="ws-step-meta">
                      <SourceBadge item={s} />
                      {s.rules.map(r => <Link key={r} to={`/rules/${r}`} className="chip-holo chip-rule mono ws-print-hide">{r}</Link>)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {(precautions.length > 0 || missingPrecaution.length > 0) && (
          <section className="rule-section" aria-label="주의사항">
            <h3>주의사항</h3>
            <ul className="rule-cautions rb-cautions" aria-label="작업 주의사항">
              {precautions.map(({ rid, c }) => (
                <li key={`${rid}${c.text}`}>
                  <Icon name={c.level === '참고' || c.level === '안내' ? 'info' : 'warning'} size={14} />
                  <span>
                    <Badge tone={LEVEL_TONE[c.level] ?? 'info'}>{c.level}</Badge> {c.text}
                    <small className="rb-note"><SourceBadge item={c} compact /> {c.refs[0]?.label} · <Link to={`/rules/${rid}`} className="mono">{rid}</Link></small>
                  </span>
                </li>
              ))}
              {missingPrecaution.map(rid => <li key={rid}><Icon name="warning" size={14} /><span className="rb-empty">규칙 {rid}을(를) 읽지 못했어요</span></li>)}
            </ul>
          </section>
        )}

        {ws.checks.length > 0 && (
          <section className="rule-section" aria-label="품질 확인">
            <h3>품질 확인</h3>
            <ul className="ws-checks">
              {ws.checks.map(c => (
                <li key={c.text}>
                  <Icon name="check_circle" size={16} />
                  <span>{c.text}{c.criterion && <small className="rb-note">판정 기준: {c.criterion}</small>}<small className="rb-note"><SourceBadge item={c} compact /> {c.refs[0]?.label}</small></span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {ws.inspectionItems.length > 0 && (
          <section className="rule-section" aria-label="점검 항목">
            <h3>점검 항목 <span className="faint">{ws.inspectionItems.length}</span></h3>
            <div className="rule-table-scroll">
              <table className="table" aria-label="점검 항목 표">
                <thead><tr><th scope="col" className="num">순번</th><th scope="col">대상</th><th scope="col">점검 내용</th><th scope="col">주기</th><th scope="col">출처</th></tr></thead>
                <tbody>
                  {ws.inspectionItems.map(i => (
                    <tr key={i.seq}>
                      <td className="num mono">{i.seq}</td>
                      <td>{i.group}{i.target && i.target !== '전체' ? ` · ${i.target}` : ''}</td>
                      <td>{i.check}</td>
                      <td>{i.cycle.label ?? (i.cycle.value != null ? `${i.cycle.value}${i.cycle.unit ?? ''}마다` : '—')}{i.cycleNote && <small className="rb-note">{i.cycleNote}</small>}</td>
                      <td><SourceBadge item={i} compact /> <small className="rb-note">{i.refs[0]?.label}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {ws.eventChecks.length > 0 && (
          <section className="rule-section" aria-label="사건별 확인">
            <h3>사건 뒤 확인</h3>
            <ul className="ws-checks">
              {ws.eventChecks.map(e => <li key={e.event}><Icon name="warning" size={16} /><span><strong>{e.event}</strong> — {e.text}<small className="rb-note"><SourceBadge item={e} compact /> {e.refs[0]?.label}</small></span></li>)}
            </ul>
          </section>
        )}

        {ws.assemblies.length > 0 && (
          <section className="rule-section" aria-label="대상 CAD 구조">
            <h3>CAD 구조에서 센 체결 부품</h3>
            <p className="faint">수량 · 규격은 CAD 구조와 형상 분석에서 도출한 값이라 추정이에요. 조립 절차는 근거가 없어 작성이 필요해요.</p>
            {ws.assemblies.map(a => (
              <div key={a.cadName} className="rule-table-scroll">
                <table className="table" aria-label={`${a.label} 체결 부품`}>
                  <caption className="ws-caption">{a.label} <span className="mono faint">{a.cadName}</span></caption>
                  <thead><tr><th scope="col">CAD 부품</th><th scope="col" className="num">수량</th><th scope="col">분류</th><th scope="col">규격</th><th scope="col">출처</th></tr></thead>
                  <tbody>
                    {a.parts.map(p => (
                      <tr key={p.cadName}>
                        <td className="mono">{p.cadName}</td>
                        <td className="num"><ValueCell item={p} value={p.quantity} /></td>
                        <td>{p.classCode ?? <span className="faint">—</span>}</td>
                        <td>{[p.threadSize, p.lengthMm !== undefined ? `${p.lengthMm} mm` : undefined].filter(Boolean).join(' × ') || <span className="faint">—</span>}</td>
                        <td><SourceBadge item={p} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        )}

        {ws.rules.length > 0 && (
          <section className="rule-section ws-print-hide" aria-label="관련 규칙">
            <h3>관련 규칙 <span className="faint">{ws.rules.length}</span></h3>
            <div className="row">{ws.rules.map(r => <Link key={r} to={`/rules/${r}`} className="chip-holo chip-rule mono" title={ruleOf.get(r)?.name}>{r}</Link>)}</div>
          </section>
        )}

        {ws.gapIds.length > 0 && (
          <section className="rule-section" aria-label="작성이 필요한 곳">
            <h3>작성이 필요한 곳 <span className="faint">{ws.gapIds.length}</span></h3>
            <ul className="rb-gaps">
              {ws.gapIds.map(g => <li key={g}><span className="rb-empty">{g}</span> {gapOf.get(g)?.title ?? ''}</li>)}
            </ul>
          </section>
        )}

        <footer className="rule-source">
          <span className="mono">{ws.id}</span> · 값 출처 {(['manual', 'standard', 'cad', 'unknown'] as const).filter(g => (ws.byGrade[g] ?? 0) > 0).map(g => `${GRADE_TEXT[g]} ${ws.byGrade[g]}`).join(' · ')}
          {ws.sourceFiles.length > 0 && <span> · 근거 파일 {ws.sourceFiles.length}개</span>}
          <span className="ws-print-only"> · 초안(검토 전) · 실제 작업에 쓰기 전에 설계 · 공정 담당의 검토가 필요해요.</span>
        </footer>
      </div>
    </>
  );
}
