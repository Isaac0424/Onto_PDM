import { Icon } from '../../components/AppShell';
import { summaryText, type RequiredItem, type RequiredView } from './requiredAttrs';

/** 속성 패널이 보일 "OPMS 필수 속성" 블록의 상태 */
export type RequiredBlockView =
  | { status: 'loading' }
  | { status: 'offline' }                         // OPMS 를 읽을 수 없다(연결 상태 줄이 이유를 말한다)
  | { status: 'no-class' }                        // 볼트로 보이지만 종류를 정하지 못했다
  | { status: 'error'; message: string }          // OPMS 에 그런 분류가 없거나 읽지 못했다
  | { status: 'ready'; view: RequiredView };

const ESTIMATED_TEXT: Record<NonNullable<RequiredItem['source']>, string> = { cad: 'CAD 추정', name: '이름에서 추정', spec: '사양서 후보', bom: 'BOM 후보' };

const STATE_CHIP: Record<RequiredItem['state'], { text: string; className: string; title: string }> = {
  confirmed: { text: '확정', className: 'chip-ok', title: '사람이 확정한 값이에요' },
  estimated: { text: 'CAD 추정', className: 'chip-maybe', title: '확정 전 후보예요. 확정하면 확인으로 세요' },
  convention: { text: 'OPMS가 채워요', className: 'req-chip-conv', title: '값이 없으면 OPMS가 관례로 정하는 값이에요. 비어 있다고 세지 않아요' },
  empty: { text: '미확인', className: 'req-chip-empty', title: '비어 있어요' },
};

const pct = (n: number, total: number) => (total === 0 ? 0 : Math.round((n / total) * 100));

/**
 * OPMS 필수 속성 체크리스트. 분류가 요구하는 속성마다 확정 · CAD 추정 · OPMS가 채움 · 미확인을 보인다.
 * 값 범위에 걸리면 호박색 확인 칩이다(오류가 아니므로 빨강을 쓰지 않는다).
 */
export function RequiredBlock({ view }: { view: RequiredBlockView }) {
  if (view.status === 'loading') {
    return <p className="fast-note req-note" role="status" aria-label="OPMS 필수 속성"><Icon name="hourglass_top" size={14} />OPMS 필수 속성을 읽는 중…</p>;
  }
  if (view.status === 'offline') {
    return <p className="fast-note req-note" role="status" aria-label="OPMS 필수 속성"><Icon name="cloud_off" size={14} />OPMS에 연결되면 필수 속성을 확인해요.</p>;
  }
  if (view.status === 'no-class') {
    return <p className="fast-note req-note" role="status" aria-label="OPMS 필수 속성"><Icon name="info" size={14} />볼트 종류를 확정하면 OPMS 필수 속성을 확인해요.</p>;
  }
  if (view.status === 'error') {
    return <p className="fast-note req-note" role="status" aria-label="OPMS 필수 속성"><Icon name="cloud_off" size={14} />OPMS 필수 속성을 읽지 못했어요. {view.message}</p>;
  }

  const v = view.view;
  const solid = pct(v.known, v.total);
  const soft = pct(v.estimated, v.total);
  return (
    <section className="req-block" aria-label="OPMS 필수 속성">
      <h3>OPMS 필수 속성 · 확인 {v.known}/{v.total}</h3>
      <p className="req-sub">{v.classLabel} 기준{v.basis ? ` · ${v.basis.proposedLabel}은(는) OPMS에 아직 없어 상위 분류로 확인해요. 등록되면 필수 속성이 더 생길 수 있어요` : ''}</p>
      <div className="req-summary" role="status" aria-label="필수 속성 완성도">
        <span className="req-bar" role="meter" aria-label="확인한 필수 속성" aria-valuemin={0} aria-valuemax={v.total} aria-valuenow={v.known}>
          <i className="req-bar-solid" style={{ width: `${solid}%` }} />
          <i className="req-bar-soft" style={{ width: `${soft}%`, left: `${solid}%` }} />
        </span>
        <span className="req-summary-text">{summaryText(v)}</span>
      </div>
      <ul className="req-list" aria-label="필수 속성">
        {v.items.map(i => {
          const base = STATE_CHIP[i.state];
          const chip = i.state === 'estimated' && i.source ? { ...base, text: ESTIMATED_TEXT[i.source] } : base;
          return (
            <li key={i.key} className={`req-row req-row-${i.state}`}>
              <div className="req-main">
                <span className="req-label">{i.label}</span>
                {i.valueText && <span className="req-value mono">{i.valueText}</span>}
                <span className={`chip-holo ${chip.className}`} title={chip.title}>{chip.text}</span>
                {i.warn && <span className="chip-holo chip-maybe req-warn" role="note">{i.warn}</span>}
              </div>
              {i.note && <p className="req-hint faint">{i.note}</p>}
              {i.state === 'estimated' && i.evidence && (
                <details className="attr-evidence">
                  <summary>근거{i.confidence !== undefined ? ` · 신뢰도 ${Math.round(i.confidence * 100)}%` : ''}</summary>
                  <p>{i.evidence}</p>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
