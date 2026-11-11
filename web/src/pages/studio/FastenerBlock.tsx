import { useState } from 'react';
import { Icon } from '../../components/AppShell';
import { HEAD_TYPE_LABEL, type FastenerResult } from '../../extract/fastener';

/** 속성 패널이 보일 "형상으로 본 볼트 종류" 상태: 분석 중이거나, 볼트로 분류됐다(볼트가 아니면 이 블록 자체가 없다) */
export type ShapeView =
  | { status: 'analyzing' }
  | {
    status: 'done';
    result: FastenerResult;
    /** 사람이 이 종류로 확정한 클래스 코드 */
    pickedClass?: string;
    /** 확정한 클래스가 OPMS 미등록 제안이면, OPMS 에 전달할 요청 본문 초안 */
    draft?: string;
  };

/** 1·2위 점수가 이보다 가까우면 단정하지 않는다고 알린다 */
const CLOSE_RATIO = 0.8;

const pct = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100);

/**
 * 형상으로 본 볼트 종류. 머리 윤곽 · 단면 · 윗면 구멍으로 점수를 낸 후보를 보이고, 사람이 하나를 확정한다.
 * 단정하지 않는다: 구동부 구멍이 보이지 않거나 점수가 가까우면 후보가 여러 개라고 알린다.
 * OPMS 에 없는 분류는 "제안(미등록)"으로만 표시한다. 빨강은 쓰지 않는다(오류가 아니다).
 */
export function FastenerBlock({ view, onPick }: { view: ShapeView; onPick(code: string | undefined): void }) {
  const [copied, setCopied] = useState(false);

  if (view.status === 'analyzing') {
    return <p className="fast-note fast-analyzing" role="status" aria-label="형상 분석"><Icon name="hourglass_top" size={14} />형상 분석 중…</p>;
  }
  const { result, pickedClass, draft } = view;
  const list = result.candidates.slice(0, 4);
  const top = list[0];
  const second = list[1];
  const holeMissing = !!top?.evidence.some(e => e.includes('확인하지 못함'));
  const close = !!top && !!second && second.score >= top.score * CLOSE_RATIO;
  const notice = !top
    ? '볼트로 보이지만 머리 모양을 정하지 못했어요. 나사 규격과 길이만 후보로 남겨요.'
    : holeMissing ? '후보가 여러 개예요 — 구동부 구멍이 보이지 않아요. 머리 윤곽만으로는 하나로 정하지 않았어요.'
    : (result.ambiguous || close) ? '후보가 여러 개예요 — 1·2위 점수가 가까워 하나로 정하지 않았어요.'
    : undefined;

  const copy = async () => {
    try { await navigator.clipboard.writeText(draft ?? ''); setCopied(true); } catch { setCopied(false); }
  };

  return (
    <section className="fast-block" aria-label="형상으로 본 볼트 종류">
      <h3>형상으로 본 볼트 종류</h3>
      {notice && <p className="fast-note" role="note"><Icon name="info" size={14} />{notice}</p>}
      {list.length > 0 && (
        <ul className="fast-list" aria-label="볼트 종류 후보">
          {list.map(c => {
            const picked = pickedClass === c.classCode;
            return (
              <li key={c.classCode} className={`fast-row ${picked ? 'fast-row-ok' : ''}`}>
                <div className="fast-main">
                  <span className="fast-name">{c.label}</span>
                  <span className="chip-holo" title={`머리 모양 ${c.headType}`}>{HEAD_TYPE_LABEL[c.headType]}</span>
                  {c.proposed && <span className="chip-holo chip-maybe" title="OPMS 에 아직 없는 분류예요. 등록을 요청할 수 있어요">제안(미등록)</span>}
                  {picked && <span className="chip-holo chip-ok">확정</span>}
                </div>
                <span className="attr-conf" title={`점수 ${pct(c.score)}%`}>
                  <span className="attr-meter" role="meter" aria-label={`${c.label} 점수`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(c.score)}><i style={{ width: `${pct(c.score)}%` }} /></span>
                  <span className="attr-pct mono">{pct(c.score)}%</span>
                </span>
                <details className="attr-evidence">
                  <summary>근거</summary>
                  <ul className="fast-evidence">{c.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
                </details>
                <div className="attr-actions">
                  {picked
                    ? <button type="button" className="btn btn-sm" aria-label={`${c.label} 확정 취소`} onClick={() => { setCopied(false); onPick(undefined); }}>확정 취소</button>
                    : <button type="button" className="btn btn-primary btn-sm" aria-label={`${c.label} 이 종류로 확정`} onClick={() => { setCopied(false); onPick(c.classCode); }}><Icon name="check" size={16} />이 종류로 확정</button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {draft && (
        <details className="fast-draft">
          <summary>OPMS 분류 등록 요청 초안</summary>
          <p className="faint">OPMS에 아직 없는 분류예요. 요청에 붙일 클래스 이름과 근거예요. 지금은 복사해서 전달해요.</p>
          <pre aria-label="OPMS 분류 등록 요청 본문">{draft}</pre>
          <button type="button" className="btn btn-sm" onClick={() => void copy()}>{copied ? '복사했어요' : '요청 내용 복사'}</button>
        </details>
      )}
    </section>
  );
}
