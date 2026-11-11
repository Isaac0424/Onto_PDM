import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { BomRule, MesPackage, MesWorkStep } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { Loaded } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { DOC_TYPE, formatDateTime, formatNumber } from '../../labels';
import { useSession } from '../../session';
import '../studio/studio.css';
import './mes.css';

const RULE_TEXT: Record<BomRule, string> = { released: '승인본', latest: '최신' };
/**
 * 작업 표준: 제품의 제조 BOM + 작업 단계(규칙 · 주의사항 · 공구) 묶음을 미리 본다. 엔지니어가 PDM 안에서 확인하는 화면이고,
 * MES 로 내보내거나 발행하지 않는다(삭제됨, 사용자 지시). 작업자 화면(작업 모드)이 읽을 확정본의 바탕이 된다 (docs/worker-view-proposal.md).
 */
export function MesPage() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const [rule, setRule] = useState<BomRule>('released');

  const products = useAsync(() => api.listProducts(), []);
  const code = params.get('product') ?? products.data?.[0]?.code ?? '';
  const pkg = useAsync(() => (code ? api.buildMesPackage(code, rule) : Promise.resolve(undefined)), [code, rule]);

  const choose = (next: { product?: string; rule?: BomRule }) => {
    if (next.rule) setRule(next.rule);
    if (next.product) setParams({ product: next.product }, { replace: true });
  };

  return (
    <div className="mes-page">
      <div className="holo-backdrop" aria-hidden />
      <header className="mes-head">
        <div>
          <p className="holo-eyebrow">제조 · 작업 표준</p>
          <h1>작업 표준</h1>
          <p className="mes-sub">승인된 제조 BOM과 작업 단계(규칙 · 주의사항 · 공구)를 한 묶음으로 확인합니다. PDM 안에서만 쓰고 MES로 내보내지 않습니다.</p>
        </div>
        <div className="row mes-controls">
          <select className="select mes-select" aria-label="제품" value={code} onChange={e => choose({ product: e.target.value })}>
            {(products.data ?? []).map(p => <option key={p.id} value={p.code}>{p.code} · {p.name}</option>)}
          </select>
          <div className="seg" role="group" aria-label="BOM 기준">
            {(['released', 'latest'] as const).map(r => (
              <button key={r} type="button" aria-pressed={rule === r} onClick={() => choose({ rule: r })}>{RULE_TEXT[r]}</button>
            ))}
          </div>
        </div>
      </header>

      {products.data?.length === 0 && <div className="empty">제품이 없습니다.</div>}
      <Loaded state={pkg}>
        {p => p && <Preview pkg={p} />}
      </Loaded>

    </div>
  );
}

function Preview({ pkg }: { pkg: MesPackage }) {
  return (
    <>
      <section className="glass-panel mes-summary" aria-label="묶음 요약">
        <div className="mes-summary-head">
          <div>
            <h2>{pkg.productName} <span className="mono mes-code">{pkg.productCode}</span></h2>
            <p className="panel-sub">
              최상위 조립품 <span className="mono">{pkg.rootItemNo}</span> · 리비전 <span className="mono">{pkg.revision}</span> · {RULE_TEXT[pkg.rule]} 기준 · {formatDateTime(pkg.generatedAt)} 생성
            </p>
          </div>
        </div>
        <div className="mes-chips" role="group" aria-label="요약">
          <span className="chip-holo chip-ok">BOM {formatNumber(pkg.bom.length)}줄</span>
          <span className="chip-holo chip-ok">작업 단계 {pkg.steps.length}</span>
          <span className="chip-holo chip-ok">문서 {pkg.documents.length}건</span>
          <span className={`chip-holo ${pkg.warnings.length > 0 ? 'chip-maybe' : 'chip-ok'}`}>경고 {pkg.warnings.length}</span>
        </div>
        {pkg.warnings.length > 0 && (
          <ul className="mes-warnings" aria-label="경고">
            {pkg.warnings.map(w => <li key={w}><Icon name="warning" size={16} />{w}</li>)}
          </ul>
        )}
      </section>

      <div className="mes-grid">
        <section className="glass-panel" aria-label="제조 BOM 묶음">
          <header className="panel-head"><div><h2>제조 BOM</h2><p className="panel-sub">깊이 우선 순서 · 수량은 부모 1개당, 총수량은 최상위 1개당</p></div></header>
          <div className="table-wrap">
            <table className="table mes-bom" aria-label="제조 BOM">
              <thead>
                <tr><th className="num">순번</th><th>품번</th><th>이름</th><th className="num">수량</th><th className="num">총수량</th><th className="num">단계</th><th>규칙</th></tr>
              </thead>
              <tbody>
                {pkg.bom.map(b => (
                  <tr key={b.seq} className={b.level === 0 ? 'mes-root' : undefined}>
                    <td className="num mono">{b.seq}</td>
                    <td><span className="mono">{b.itemNo}</span></td>
                    <td><span className="mes-indent" style={{ paddingLeft: b.level * 16 }}>{b.level > 0 && <span className="mes-branch" aria-hidden>└</span>}{b.name}</span></td>
                    <td className="num">{formatNumber(b.quantity)}</td>
                    <td className="num">{formatNumber(b.totalQuantity)}</td>
                    <td className="num mono">{b.step ?? '—'}</td>
                    <td>
                      <span className="mes-rules">
                        {b.ruleIds.map(id => <Link key={id} to={`/rules/${id}`} className="chip-holo chip-rule mono">{id}</Link>)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="mes-side">
          <section className="glass-panel" aria-label="작업 단계">
            <header className="panel-head"><div><h2>작업 단계</h2><p className="panel-sub">하위 조립품부터 · 조립품마다 한 단계</p></div></header>
            <Steps steps={pkg.steps} />
          </section>

          <section className="glass-panel" aria-label="문서 묶음">
            <header className="panel-head"><div><h2>문서</h2><p className="panel-sub">연결된 CAD · 도면 · 사양서 · 설명서</p></div></header>
            {pkg.documents.length === 0 ? <div className="empty">연결된 문서가 없습니다.</div> : (
              <div className="table-wrap">
                <table className="table" aria-label="문서">
                  <thead><tr><th>문서 번호</th><th>제목</th><th>종류</th><th>리비전</th></tr></thead>
                  <tbody>
                    {pkg.documents.map(d => (
                      <tr key={d.docNo}><td className="mono">{d.docNo}</td><td>{d.title}</td><td>{DOC_TYPE[d.docType]}</td><td className="mono">{d.rev}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function Steps({ steps }: { steps: MesWorkStep[] }) {
  const [open, setOpen] = useState<Set<number>>(new Set(steps[0] ? [steps[0].step] : []));
  const toggle = (n: number) => setOpen(prev => { const next = new Set(prev); if (!next.delete(n)) next.add(n); return next; });
  if (steps.length === 0) return <div className="empty">작업 단계가 없습니다 (하위 부품이 없는 제품).</div>;
  return (
    <ol className="mes-steps">
      {steps.map(s => {
        const on = open.has(s.step);
        return (
          <li key={s.step} className={`mes-step ${on ? 'mes-step-on' : ''}`}>
            <button type="button" className="mes-step-head" aria-expanded={on} onClick={() => toggle(s.step)}>
              <span className="mes-step-no">{s.step}</span>
              <span className="mes-step-title">{s.title}</span>
              {s.operationLabel && <span className="chip-holo chip-ok">{s.operationLabel}</span>}
              <Icon name={on ? 'expand_less' : 'expand_more'} size={18} />
            </button>
            {on && (
              <div className="mes-step-body">
                <p className="mes-step-parts"><strong>쓰는 부품</strong>{s.parts.map(p => `${p.name} ×${formatNumber(p.quantity)}`).join(' · ')}</p>
                <p className="mes-rules">
                  {s.ruleIds.length === 0 ? <span className="faint">적용된 규칙 없음</span> : s.ruleIds.map(id => <Link key={id} to={`/rules/${id}`} className="chip-holo chip-rule mono">{id}</Link>)}
                </p>
                {s.params.length > 0 && (
                  <dl className="mes-params">
                    {s.params.map(p => <div key={`${p.label}${p.value}`}><dt>{p.label}</dt><dd>{p.value}</dd></div>)}
                  </dl>
                )}
                {s.cautions.length > 0 && (
                  <ul className="mes-cautions" aria-label={`단계 ${s.step} 주의사항`}>
                    {s.cautions.map(c => <li key={c}><Icon name="warning" size={14} />{c}</li>)}
                  </ul>
                )}
                {s.tools.length > 0 && <p className="mes-tools"><Icon name="build" size={14} />{s.tools.join(' · ')}</p>}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
