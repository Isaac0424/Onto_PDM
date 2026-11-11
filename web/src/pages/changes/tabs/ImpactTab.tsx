// ② 영향: 영향 3D 그래프(Graph3D 재사용) + 목록 대안 + 영향 발견 표. 영향이 있다는 것과 바꿔야 한다는 것은 다르다 — 처분은 ④에서 따로 정한다.
// 판정은 서버가 낸 값을 그대로 보인다(임시 판정 · 추정 표시 포함). 3D 를 못 쓰거나 키보드만 쓸 때는 목록이 같은 정보를 준다.
import { Fragment, useMemo, useState } from 'react';
import type { ChangeDetail, ImpactFindingView, Severity } from '../../../api/types';
import { Icon } from '../../../components/AppShell';
import { Badge, Loaded } from '../../../components/ui';
import { useAsync } from '../../../hooks/useAsync';
import { FINDING_KIND, REASON_CODE, SCOPE_CLASS, SEVERITY, formatDateTime } from '../../../labels';
import { useSession } from '../../../session';
import { Graph3D } from '../../graph/Graph3D';
import { GraphList } from '../../graph/GraphList';
import '../../graph/productGraph.css';
import '../../studio/studio.css';
import { bySeverity, quantityLine, SEVERITY_ORDER } from '../changeRules';
import { SeverityBadge, VerdictBadge, useAction } from '../changeUi';
import { impactGraph } from '../impactGraph';

const LEGEND = [
  { cls: 'impact-blocked', label: '막힘' }, { cls: 'impact-affected', label: '처분 필요' },
  { cls: 'impact-review', label: '확인 필요' }, { cls: 'impact-none', label: '영향 없음 · 정보' },
] as const;

function Inputs({ f }: { f: ImpactFindingView }) {
  const rows = Object.entries(f.inputs);
  return (
    <details className="chg-details">
      <summary>입력값 · 근거</summary>
      <dl className="props chg-props">
        {rows.map(([k, v]) => (<Fragment key={k}><dt className="mono">{k}</dt><dd className="mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></Fragment>))}
        <dt>기준 규칙</dt><dd className="mono">{f.basis.rule_id ?? '—'}</dd>
        <dt>온톨로지</dt><dd className="mono">{f.basis.ontology_version}</dd>
        <dt>값 기준 시각</dt><dd>{formatDateTime(f.basis.as_of)}</dd>
      </dl>
    </details>
  );
}

function FindingRow({ f }: { f: ImpactFindingView }) {
  const qty = quantityLine(f);
  return (
    <tr>
      <td data-label="종류">{FINDING_KIND[f.kind]}</td>
      <td data-label="대상" className="mono">{f.subject_ref}</td>
      <td data-label="판정">
        {f.verdict ? <VerdictBadge verdict={f.verdict} /> : <span className="faint">—</span>}
        {f.temporary && <Badge tone="info" title="OPMS 판정 API 가 열리기 전에 PDM 이 계산한 참고 판정이에요(기준 미지정).">임시 판정</Badge>}
        {f.approximate && <Badge tone="warning" title="입력 중에 CAD 에서 추정한 값이 있어요. 실물로 확인하세요.">추정</Badge>}
      </td>
      <td data-label="심각도"><SeverityBadge severity={f.severity} /></td>
      <td data-label="이유">
        <div>{f.message}</div>
        {qty && <div className="mono chg-qty">{qty}</div>}
        <small className="chg-sub">{REASON_CODE[f.reason_code] ?? f.reason_code}{f.scope_class ? ` · ${SCOPE_CLASS[f.scope_class]}` : ''}</small>
        <Inputs f={f} />
      </td>
    </tr>
  );
}

export function ImpactTab({ change }: { change: ChangeDetail }) {
  const { api } = useSession();
  const { run, busy } = useAction();
  const run0 = change.latest_run;
  const graphState = useAsync(() => (run0 ? api.getImpactGraph(change.code) : Promise.resolve({ nodes: [], edges: [] })), [api, change.code, run0?.id]);
  const [view, setView] = useState<'3d' | 'list'>('3d');
  const [unsupported, setUnsupported] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Severity | 'all'>('all');

  const graph = useMemo(() => impactGraph(graphState.data ?? { nodes: [], edges: [] }), [graphState.data]);
  const findings = useMemo(() => [...(run0?.findings ?? [])].sort(bySeverity), [run0]);
  const shown = filter === 'all' ? findings : findings.filter(f => f.severity === filter);
  const selected = graph.nodes.find(n => n.id === selectedId) ?? null;
  const showList = view === 'list' || unsupported;

  if (!run0) {
    return (
      <div className="empty chg-empty">
        <p>아직 영향 분석이 없어요.</p>
        {change.targets.length > 0
          ? <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => api.recomputeImpact(change.code))}>영향 분석 실행</button>
          : <p className="faint">먼저 &quot;대상&quot; 탭에서 변경 대상을 추가하세요.</p>}
      </div>
    );
  }

  return (
    <div className="chg-stack">
      <div className="chg-chips" role="group" aria-label="심각도로 거르기">
        <button type="button" className="pg-fchip chip-none" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>전체 {findings.length}</button>
        {SEVERITY_ORDER.map(s => (
          <button key={s} type="button" className="pg-fchip chip-none" aria-pressed={filter === s} onClick={() => setFilter(s)}>
            {SEVERITY[s]} {run0.summary[s]}
          </button>
        ))}
      </div>

      <div className="holo-frame">
        <div className="holo-strip">
          <span className="led" aria-hidden />
          <span className="holo-model">영향 그래프</span>
          <span className="spacer" />
          <div className="seg" role="group" aria-label="보기">
            <button type="button" aria-pressed={!showList} disabled={unsupported} onClick={() => setView('3d')}><Icon name="view_in_ar" size={14} />3D</button>
            <button type="button" aria-pressed={showList} onClick={() => setView('list')}><Icon name="account_tree" size={14} />목록</button>
          </div>
          <span className="holo-meta">{graph.nodes.length}개 노드 · {graph.edges.length}개 연결</span>
        </div>
        <div className="pg-stage chg-stage">
          <Loaded state={graphState} empty={g => g.nodes.length === 0}>
            {() => showList
              ? <div className="pg-list"><GraphList graph={graph} selectedId={selectedId} onSelect={setSelectedId} label={`${change.code} 영향 목록`} /></div>
              : <Graph3D graph={graph} selectedId={selectedId} onSelect={setSelectedId} label={`${change.code} 영향 그래프`} onUnsupported={() => setUnsupported(true)} />}
          </Loaded>
        </div>
        {unsupported && <div className="banner banner-info" role="status">이 환경에서는 3D를 쓸 수 없어 목록으로 보여 드립니다.</div>}
        <ul className="pg-legend" aria-label="범례">
          {LEGEND.map(l => <li key={l.cls}><i className={`dot dot-${l.cls}`} aria-hidden />{l.label}</li>)}
          <li className="faint">빨강은 &quot;막힘&quot;에만 써요. 모양은 목록의 아이콘과 글자로도 구분해요.</li>
        </ul>
        <i className="corner corner-tl" aria-hidden /><i className="corner corner-tr" aria-hidden />
        <i className="corner corner-bl" aria-hidden /><i className="corner corner-br" aria-hidden />
      </div>
      {selected && <p className="chg-selected" role="status">선택: <b>{selected.label}</b>{selected.sub ? ` · ${selected.sub}` : ''}</p>}

      <div className="card">
        <div className="table-wrap">
          <table className="table chg-table" aria-label="영향 발견">
            <thead><tr><th>종류</th><th>대상</th><th>판정</th><th>심각도</th><th>이유</th></tr></thead>
            <tbody>
              {shown.length === 0
                ? <tr><td colSpan={5} className="empty">이 심각도의 영향이 없어요.</td></tr>
                : shown.map(f => <FindingRow key={f.id} f={f} />)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
