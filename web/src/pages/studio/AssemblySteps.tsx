import type { LayerInfo, PartInfo } from 'explode-studio';
import type { CadPartMatch } from '../../api/types';

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

/** 추정 규격(M4 · 15 mm)을 사람이 읽는 말로 */
export const estimatedText = (e: NonNullable<CadPartMatch['estimated']>): string =>
  [e.threadSize, e.length !== undefined ? `${e.length} mm` : undefined].filter(Boolean).join(' · ');

export function MatchChip({ match, analyzing = false }: { match?: CadPartMatch; analyzing?: boolean }) {
  if (!match) return <span className="chip-holo chip-wait">매칭 중…</span>;
  const est = match.estimated;
  const guess = est ? `CAD 형상에서 ${estimatedText(est)} 로 추정한 규격으로 찾았어요 · 규격을 확정하면 더 정확해져요` : '';
  if (match.status === 'matched') {
    return <span className="chip-holo chip-ok mono" title={`${match.itemName} · 보유 품번`}>{match.itemNo}</span>;
  }
  if (match.status === 'suggested') {
    const n = match.candidates?.length ?? 1;
    const tail = est ? ' · 추정' : '';
    if (n > 1) return <span className="chip-holo chip-maybe" title={`${match.itemNo} ${match.itemName ?? ''} 외 ${n - 1}개 · 부품을 눌러 하나를 고르세요${est ? ` · ${guess}` : ''}`}>후보 {n}개{tail}</span>;
    return <span className="chip-holo chip-maybe mono" title={`${match.itemName} · ${Math.round((match.score ?? 0) * 100)}% 후보${est ? ` · ${guess}` : ''}`}>후보 {match.itemNo}{tail}</span>;
  }
  // 보유 품번은 규격으로 찾는다: 아직 규격이 없거나 OPMS 를 못 읽은 것은 '미보유'가 아니다
  if (match.reason === 'needs_values') {
    if (analyzing) return <span className="chip-holo chip-wait" title="CAD 형상으로 규격을 추정하는 중이에요">형상 분석 중…</span>;
    return <span className="chip-holo chip-wait" title="CAD로 규격을 추정하지 못했어요 — 속성 탭에서 확정하면 찾아요">규격 확정 필요</span>;
  }
  if (match.reason === 'unreachable') return <span className="chip-holo chip-wait" title="OPMS를 읽지 못했어요. 연결되면 다시 찾아요">연결 안 됨</span>;
  if (est) return <span className="chip-holo chip-none" title={`OPMS에 같은 규격이 없어요 · ${guess}`}>미보유 · 추정 규격</span>;
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
  layers, parts, matches, analyzing, connected = true, step, selectedName, onStep, onSelect,
}: {
  layers: LayerInfo[];
  parts: PartInfo[];
  matches: Map<string, CadPartMatch>;
  /** CAD 형상 분석이 아직 끝나지 않은 부품: 끝나면 추정 규격으로 찾을 수 있어 '규격 확정 필요'로 세지 않는다 */
  analyzing?: ReadonlySet<string>;
  /** 보유 품번을 읽어 올 곳(OPMS)에 연결돼 있는가. 아니면 매칭 칩 대신 안내를 보인다 */
  connected?: boolean;
  step: number;
  selectedName?: string;
  onStep(step: number): void;
  onSelect(name: string): void;
}) {
  const names = [...new Set(parts.map(p => p.name))];
  const count = { matched: 0, suggested: 0, none: 0, waiting: 0, unreachable: 0 };
  names.forEach(n => {
    const m = matches.get(n);
    if (!m) return;
    if (m.status === 'none' && m.reason === 'needs_values') { if (!analyzing?.has(n)) count.waiting += 1; }
    else if (m.status === 'none' && m.reason === 'unreachable') count.unreachable += 1;
    else count[m.status] += 1;
  });

  return (
    <section className="glass-panel steps-panel" aria-label="제조 순서">
      <header className="panel-head">
        <div>
          <h2>제조 순서</h2>
          <p className="panel-sub">CAD 구조에서 나눈 {layers.length}단계 · 부품 {names.length}종</p>
        </div>
      </header>

      {connected ? (
        <div className="match-summary" role="group" aria-label="보유 품번 매칭 현황">
          <span className="chip-holo chip-ok">보유 {count.matched}</span>
          <span className="chip-holo chip-maybe">후보 {count.suggested}</span>
          <span className="chip-holo chip-none">미보유 {count.none}</span>
          {count.waiting > 0 && <span className="chip-holo chip-wait" title="CAD로 규격을 추정하지 못했어요 — 속성 탭에서 확정하면 찾아요">규격 확정 대기 {count.waiting}</span>}
          {count.unreachable > 0 && <span className="chip-holo chip-wait">연결 안 됨 {count.unreachable}</span>}
        </div>
      ) : (
        <p className="match-note" role="note">보유 품번 매칭은 OPMS에 연결되면 표시돼요.</p>
      )}

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
                      {connected && <MatchChip match={matches.get(row.name)} analyzing={analyzing?.has(row.name) ?? false} />}
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
