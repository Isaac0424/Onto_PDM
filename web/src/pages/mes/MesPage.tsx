import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { BomRule, MesPackage, MesPublication, MesWorkStep } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { Badge, Loaded } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { DOC_TYPE, formatDateTime, formatNumber } from '../../labels';
import { useSession } from '../../session';
import '../studio/studio.css';
import { downloadText, mesFileName, packageToCsv, packageToJson } from './exportMes';
import './mes.css';

const RULE_TEXT: Record<BomRule, string> = { released: '승인본', latest: '최신' };
const STATUS: Record<MesPublication['status'], { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  sent: { label: '발행됨', tone: 'success' }, pending: { label: '대기', tone: 'warning' }, failed: { label: '실패', tone: 'danger' },
};

/**
 * MES 발행: 제품의 제조 BOM + 작업표준 묶음을 미리 보고, MES 로 발행하거나 파일(JSON · CSV)로 내려받는다.
 * 묶음 내용과 발행 규칙(승인본만 · 같은 리비전은 한 번만)은 docs/mes-handoff.md.
 */
export function MesPage() {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const [rule, setRule] = useState<BomRule>('released');
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [publishError, setPublishError] = useState<string>();

  const products = useAsync(() => api.listProducts(), []);
  const code = params.get('product') ?? products.data?.[0]?.code ?? '';
  const pkg = useAsync(() => (code ? api.buildMesPackage(code, rule) : Promise.resolve(undefined)), [code, rule, version]);
  const pubs = useAsync(() => api.listMesPublications(), [version]);

  const choose = (next: { product?: string; rule?: BomRule }) => {
    setNotice(undefined); setPublishError(undefined);
    if (next.rule) setRule(next.rule);
    if (next.product) setParams({ product: next.product }, { replace: true });
  };

  async function publish() {
    setBusy(true); setNotice(undefined); setPublishError(undefined);
    try {
      const pub = await api.publishMes(code, rule);
      setNotice(`${code} ${pub.revision}(${RULE_TEXT[rule]})을(를) MES로 발행했습니다 (#${pub.id})`);
      setVersion(v => v + 1);
    } catch (e) {
      setPublishError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mes-page">
      <div className="holo-backdrop" aria-hidden />
      <header className="mes-head">
        <div>
          <p className="holo-eyebrow">제조 · MES</p>
          <h1>MES 발행</h1>
          <p className="mes-sub">승인된 제조 BOM과 작업표준(단계 · 규칙 · 주의사항)을 한 묶음으로 만들어 MES로 넘깁니다.</p>
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

      {notice && <div className="banner banner-info" role="status">{notice}</div>}
      {publishError && <div className="banner banner-warning" role="alert">{publishError}</div>}

      {products.data?.length === 0 && <div className="empty">제품이 없습니다.</div>}
      <Loaded state={pkg}>
        {p => p && <Preview pkg={p} busy={busy} onPublish={() => void publish()} />}
      </Loaded>

      <section className="glass-panel mes-history" aria-label="발행 이력">
        <header className="panel-head">
          <div>
            <h2>발행 이력</h2>
            <p className="panel-sub">MES로 내보낸 기록입니다 (목: 실제 전송 없이 기록만 남깁니다).</p>
          </div>
        </header>
        <Loaded state={pubs}>
          {rows => (rows.length === 0 ? <div className="empty">발행 이력이 없습니다.</div> : <History rows={rows} />)}
        </Loaded>
      </section>
    </div>
  );
}

function History({ rows }: { rows: MesPublication[] }) {
  return (
    <div className="table-wrap">
      <table className="table" aria-label="발행 이력">
        <thead>
          <tr><th>번호</th><th>제품</th><th>리비전</th><th>기준</th><th>상태</th><th>시각</th><th className="num">BOM 줄</th><th className="num">단계</th></tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td className="mono">#{r.id}</td>
              <td><Link to={`/mes?product=${r.productCode}`} className="mono">{r.productCode}</Link></td>
              <td className="mono">{r.revision}</td>
              <td>{RULE_TEXT[r.rule]}</td>
              <td><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge></td>
              <td>{formatDateTime(r.sentAt ?? r.createdAt)}</td>
              <td className="num">{r.bomLines}</td>
              <td className="num">{r.steps}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Preview({ pkg, busy, onPublish }: { pkg: MesPackage; busy: boolean; onPublish(): void }) {
  return (
    <>
      <section className="glass-panel mes-summary" aria-label="묶음 요약">
        <div className="mes-summary-head">
          <div>
            <h2>{pkg.productName} <span className="mono mes-code">{pkg.productCode}</span></h2>
            <p className="panel-sub">
              최상위 조립품 <Link to={`/items/${pkg.rootItemNo}`} className="mono">{pkg.rootItemNo}</Link> · 리비전 <span className="mono">{pkg.revision}</span> · {RULE_TEXT[pkg.rule]} 기준 · {formatDateTime(pkg.generatedAt)} 생성
            </p>
          </div>
          <div className="row mes-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={onPublish}><Icon name="outbox" size={16} />MES로 발행</button>
            <button type="button" className="btn" onClick={() => downloadText(packageToJson(pkg), mesFileName(pkg, 'json'), 'application/json')}><Icon name="data_object" size={16} />JSON 내려받기</button>
            <button type="button" className="btn" onClick={() => downloadText(packageToCsv(pkg), mesFileName(pkg, 'csv'), 'text/csv')}><Icon name="download" size={16} />CSV 내려받기</button>
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
                    <td><Link to={`/items/${b.itemNo}`} className="mono">{b.itemNo}</Link></td>
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
