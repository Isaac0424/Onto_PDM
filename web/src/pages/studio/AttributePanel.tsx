import { useMemo } from 'react';
import { Icon } from '../../components/AppShell';
import type { ExtractedAttribute } from '../../extract';
import { FastenerBlock, type ShapeView } from './FastenerBlock';
import { RequiredBlock, type RequiredBlockView } from './RequiredBlock';

export type Decision = 'confirmed' | 'rejected';

/** 같은 후보인지 가르는 열쇠 (키 · 출처 · 값). 부품마다 따로 쓴다 */
export const candidateId = (a: ExtractedAttribute) => `${a.key}|${a.source}|${a.value}${a.unit ? ` ${a.unit}` : ''}`;

const SOURCE_LABEL: Record<ExtractedAttribute['source'], string> = { cad: 'CAD', name: '이름', spec: '사양서', bom: 'BOM' };

export const valueText = (a: Pick<ExtractedAttribute, 'value' | 'unit'>) => `${a.value}${a.unit ? ` ${a.unit}` : ''}`;

export interface PartOverview {
  name: string;
  /** 제외하지 않은 후보 수 */
  count: number;
  confirmed: number;
}

export interface AttributePanelProps {
  /** 고른 부품 (없으면 모델 전체 요약) */
  partName?: string;
  /** 그 부품의 후보 전부(제외한 것 포함) */
  candidates: ExtractedAttribute[];
  /** 후보 id → 결정 */
  decisions: Map<string, Decision>;
  overview: PartOverview[];
  onDecide(id: string, decision: Decision | undefined): void;
  onRestore(): void;
  onSelectPart(name: string): void;
  /** 형상으로 본 볼트 종류 (분석 중이거나 볼트로 분류됐을 때만. 볼트가 아니면 없다) */
  shape?: ShapeView;
  /** 볼트 종류를 이 클래스로 확정한다(undefined 면 확정 취소) */
  onPickClass?(code: string | undefined): void;
  /** 분류가 요구하는 OPMS 필수 속성 체크리스트 (볼트로 분류된 부품만. 없으면 블록이 없다) */
  required?: RequiredBlockView;
}

/** 같은 키에 값이 서로 다른 후보가 둘 이상(제외하지 않은 것 중)이면 그 키는 충돌이다 */
export function conflictKeys(list: ExtractedAttribute[], decisions: Map<string, Decision>): Set<string> {
  const values = new Map<string, Set<string>>();
  list.filter(a => decisions.get(candidateId(a)) !== 'rejected').forEach(a => {
    const set = values.get(a.key) ?? new Set<string>();
    set.add(valueText(a).toLowerCase());
    values.set(a.key, set);
  });
  return new Set([...values].filter(([, v]) => v.size > 1).map(([k]) => k));
}

function Confidence({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="attr-conf" title={`신뢰도 ${pct}%`}>
      <span className="attr-meter" role="meter" aria-label="신뢰도" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></span>
      <span className="attr-pct mono">{pct}%</span>
    </span>
  );
}

/**
 * 속성 후보: CAD 형상 · 부품 이름 · 사양서에서 뽑은 값을 보여 주고, 사람이 확정하거나 제외한다.
 * 원문에 없는 값은 채우지 않는다. 뽑은 값은 후보이고, 확정해야 부품 속성이 되어 조립 규칙에 쓰인다.
 */
export function AttributePanel({ partName, candidates, decisions, overview, onDecide, onRestore, onSelectPart, shape, onPickClass, required }: AttributePanelProps) {
  const conflicts = useMemo(() => conflictKeys(candidates, decisions), [candidates, decisions]);
  const shown = candidates.filter(a => decisions.get(candidateId(a)) !== 'rejected');
  const rejected = candidates.length - shown.length;

  return (
    <section className="glass-panel attr-panel" aria-label="속성 후보">
      <header className="panel-head">
        <div>
          <h2>속성</h2>
          <p className="panel-sub">
            {partName ? `${partName} · 뽑은 값은 후보입니다. 확정해야 조립 규칙에 쓰입니다` : '부품을 고르면 CAD · 이름 · 사양서에서 뽑은 속성 후보가 보입니다'}
          </p>
        </div>
      </header>

      {partName ? (
        <div className="attr-body">
          {shape && <FastenerBlock view={shape} onPick={code => onPickClass?.(code)} />}
          {required && <RequiredBlock view={required} />}
          {shown.length === 0 ? (
            <p className="attr-empty">{candidates.length === 0 ? '이 부품에서 뽑은 속성 후보가 없습니다.' : '남은 후보가 없습니다.'}</p>
          ) : (
            <ul className="attr-list" aria-label={`${partName} 속성 후보`}>
              {shown.map(a => {
                const id = candidateId(a);
                const state = decisions.get(id);
                return (
                  <li key={id} className={`attr-row ${state === 'confirmed' ? 'attr-row-ok' : ''}`}>
                    <div className="attr-main">
                      <span className="attr-label">{a.label}</span>
                      <span className="attr-value mono">{valueText(a)}</span>
                      <span className={`chip-holo attr-src attr-src-${a.source}`}>{SOURCE_LABEL[a.source]}</span>
                      {a.estimated && <span className="chip-holo chip-maybe" title="형상에서 추정한 값입니다">추정</span>}
                      {conflicts.has(a.key) && <span className="chip-holo chip-maybe" title="출처마다 값이 다릅니다. 하나만 확정할 수 있습니다">충돌</span>}
                      {state === 'confirmed' && <span className="chip-holo chip-ok">확정</span>}
                    </div>
                    <Confidence value={a.confidence} />
                    <details className="attr-evidence">
                      <summary>근거</summary>
                      <p>{a.evidence}</p>
                    </details>
                    <div className="attr-actions">
                      {state === 'confirmed'
                        ? <button type="button" className="btn btn-sm" aria-label={`${a.label} 확정 취소`} onClick={() => onDecide(id, undefined)}>확정 취소</button>
                        : (
                          <>
                            <button type="button" className="btn btn-primary btn-sm" aria-label={`${a.label} ${valueText(a)} 확정`} onClick={() => onDecide(id, 'confirmed')}><Icon name="check" size={16} />확정</button>
                            <button type="button" className="btn btn-sm" aria-label={`${a.label} ${valueText(a)} 제외`} onClick={() => onDecide(id, 'rejected')}>제외</button>
                          </>
                        )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {rejected > 0 && <button type="button" className="btn btn-ghost btn-sm attr-restore" onClick={onRestore}>제외한 후보 {rejected}개 되돌리기</button>}
        </div>
      ) : (
        <ul className="attr-overview" aria-label="부품별 속성 후보">
          {overview.length === 0 && <li className="attr-empty">모델을 열면 부품별 후보가 나옵니다.</li>}
          {overview.map(o => (
            <li key={o.name}>
              <button type="button" className="attr-over-row" onClick={() => onSelectPart(o.name)}>
                <span className="attr-over-name">{o.name}</span>
                <span className="faint">후보 {o.count}</span>
                {o.confirmed > 0 && <span className="chip-holo chip-ok">확정 {o.confirmed}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
