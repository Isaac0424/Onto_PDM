import { Link } from 'react-router-dom';
import type { LayerInfo, PartInfo } from 'explode-studio';
import type { CadPartMatch } from '../../api/types';
import { Icon } from '../../components/AppShell';

export interface StepRow {
  name: string;
  ko: string;
  count: number;
}

/** 한 단계(층)에 들어가는 부품을 CAD 이름별로 묶는다 */
export function rowsOf(layer: LayerInfo, parts: PartInfo[]): StepRow[] {
  const byName = new Map<string, StepRow>();
  for (const id of layer.partIds) {
    const p = parts[id];
    if (!p) continue;
    const row = byName.get(p.name);
    if (row) row.count += 1;
    else byName.set(p.name, { name: p.name, ko: p.ko, count: 1 });
  }
  return [...byName.values()];
}

export function MatchChip({ match, requested }: { match?: CadPartMatch; requested?: number }) {
  if (!match) return <span className="chip-holo chip-wait">매칭 중…</span>;
  if (match.status === 'matched') {
    return <Link to={`/items/${match.itemNo}`} className="chip-holo chip-ok mono" title={`${match.itemName} · 보유 품번`} onClick={e => e.stopPropagation()}>{match.itemNo}</Link>;
  }
  if (match.status === 'suggested') {
    return <span className="chip-holo chip-maybe mono" title={`${match.itemName} · ${Math.round((match.score ?? 0) * 100)}% 후보`}>후보 {match.itemNo}</span>;
  }
  if (requested) return <span className="chip-holo chip-sent" title="OPMS로 등록 요청을 보냈습니다">요청됨 #{requested}</span>;
  return (
    <span className="chip-holo chip-none" title="보유 품번 없음 · CAD 이름 그대로 표시">
      {match.classLabel ? `분류 ${match.classLabel}` : '미보유'}
    </span>
  );
}

/**
 * 제조(조립) 순서. CAD 구조에서 뽑은 단계마다 쓰이는 부품과 보유 품번 매칭을 보인다.
 * 보유하지 않은 부품은 CAD 이름 그대로, 이름으로 추정한 온톨로지 분류가 있으면 함께 표시한다.
 */
export function AssemblySteps({
  layers, parts, matches, requested, step, selectedName, onStep, onSelect, onRequestAll,
}: {
  layers: LayerInfo[];
  parts: PartInfo[];
  matches: Map<string, CadPartMatch>;
  requested: Map<string, number>;
  step: number;
  selectedName?: string;
  onStep(step: number): void;
  onSelect(name: string): void;
  onRequestAll(): void;
}) {
  const names = [...new Set(parts.map(p => p.name))];
  const count = { matched: 0, suggested: 0, none: 0 };
  names.forEach(n => { const m = matches.get(n); if (m) count[m.status] += 1; });
  const pending = names.filter(n => matches.get(n)?.status === 'none' && !requested.has(n));

  return (
    <section className="glass-panel steps-panel" aria-label="제조 순서">
      <header className="panel-head">
        <div>
          <h2>제조 순서</h2>
          <p className="panel-sub">CAD 구조에서 나눈 {layers.length}단계 · 부품 {names.length}종</p>
        </div>
      </header>

      <div className="match-summary" role="group" aria-label="보유 품번 매칭 현황">
        <span className="chip-holo chip-ok">보유 {count.matched}</span>
        <span className="chip-holo chip-maybe">후보 {count.suggested}</span>
        <span className="chip-holo chip-none">미보유 {count.none}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-primary btn-sm" disabled={pending.length === 0} onClick={onRequestAll}>
          <Icon name="outbox" size={16} />OPMS 등록 요청 {pending.length > 0 ? pending.length : ''}
        </button>
      </div>

      <ol className="step-list">
        {layers.map((layer, i) => {
          const rows = rowsOf(layer, parts);
          const active = step === layer.step;
          return (
            <li key={layer.index} className={`step ${active ? 'step-on' : ''}`}>
              <button type="button" className="step-head" aria-current={active ? 'step' : undefined} onClick={() => onStep(layer.step)}>
                <span className="step-no">{i + 1}</span>
                <span className="step-title">{layer.title}</span>
                <span className="step-n">{layer.partIds.length}개</span>
              </button>
              <ul className="step-parts">
                {rows.map(row => (
                  <li key={row.name}>
                    <button type="button" className={`part-row ${selectedName === row.name ? 'part-on' : ''}`} onClick={() => onSelect(row.name)}>
                      <span className="part-name">{row.name}{row.ko && <small>{row.ko}</small>}</span>
                      {row.count > 1 && <span className="part-qty">×{row.count}</span>}
                      <MatchChip match={matches.get(row.name)} requested={requested.get(row.name)} />
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
        {layers.length === 0 && <li className="empty">CAD 파일을 올리면 제조 순서가 나옵니다.</li>}
      </ol>
    </section>
  );
}
