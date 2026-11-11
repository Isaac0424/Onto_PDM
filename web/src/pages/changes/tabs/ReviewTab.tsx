// ⑤ 검토 · 승인: 설계 · 구매 · 생산이 각자 의견을 내고, 모든 조건이 갖춰지면 승인자가 승인한다. 승인하면 새 개정이 발행된다.
// 승인할 수 없는 이유를 목록으로 보여 주고 버튼을 잠근다. 서버도 같은 조건을 다시 확인한다(409).
import { useState } from 'react';
import type { ChangeDetail, ReviewFunction, ReviewVerdict } from '../../../api/types';
import { Icon } from '../../../components/AppShell';
import { Badge, ErrorText } from '../../../components/ui';
import { REVIEW_FUNCTION, REVIEW_VERDICT, formatDateTime } from '../../../labels';
import { useSession } from '../../../session';
import { approvalBlockers, approvedFunctions, requiredFunctions } from '../changeRules';
import { useAction } from '../changeUi';

const VERDICTS: ReviewVerdict[] = ['approve', 'reject', 'comment'];

function ReviewCard({ change, fn }: { change: ChangeDetail; fn: ReviewFunction }) {
  const { api } = useSession();
  const { run, busy, error } = useAction();
  const [verdict, setVerdict] = useState<ReviewVerdict>('approve');
  const [comment, setComment] = useState('');
  const runId = change.latest_run?.id;
  const reviews = change.reviews.filter(r => r.function === fn && r.run_id === runId);
  const approved = runId !== undefined && approvedFunctions(change, runId).has(fn);
  const editable = change.order?.status === 'in_review' && !change.latest_run?.stale;

  return (
    <section className="card" aria-label={`${REVIEW_FUNCTION[fn]} 검토`}>
      <div className="card-head">
        <h3>{REVIEW_FUNCTION[fn]} 검토</h3>
        {approved ? <Badge tone="success"><Icon name="check_circle" size={13} />찬성</Badge> : <Badge tone="warning"><Icon name="schedule" size={13} />대기</Badge>}
      </div>
      <div className="card-body chg-stack">
        {reviews.length === 0 ? <p className="faint">이 분석에 대한 의견이 아직 없어요.</p> : (
          <ul className="chg-reviews">
            {reviews.map(r => <li key={r.id}><b>{REVIEW_VERDICT[r.verdict]}</b> · {r.reviewer} · <span className="faint">{formatDateTime(r.reviewed_at)}</span>{r.comment && <div>{r.comment}</div>}</li>)}
          </ul>
        )}
        {editable && (
          <div className="chg-disp-form">
            <label htmlFor={`rv-${fn}-v`} className="sr-only">{REVIEW_FUNCTION[fn]} 의견 종류</label>
            <select id={`rv-${fn}-v`} className="select" value={verdict} onChange={e => setVerdict(e.target.value as ReviewVerdict)}>
              {VERDICTS.map(v => <option key={v} value={v}>{REVIEW_VERDICT[v]}</option>)}
            </select>
            <label htmlFor={`rv-${fn}-c`} className="sr-only">{REVIEW_FUNCTION[fn]} 의견</label>
            <input id={`rv-${fn}-c`} className="input" value={comment} placeholder="의견" onChange={e => setComment(e.target.value)} />
            <button type="button" className="btn btn-sm" disabled={busy}
              onClick={() => run(() => api.submitReview(change.code, { function: fn, verdict, ...(comment.trim() ? { comment: comment.trim() } : {}) }))}>
              {REVIEW_FUNCTION[fn]} 의견 제출
            </button>
          </div>
        )}
        <ErrorText {...(error ? { error } : {})} />
      </div>
    </section>
  );
}

export function ReviewTab({ change }: { change: ChangeDetail }) {
  const { api } = useSession();
  const { run, busy, error } = useAction();
  const [reason, setReason] = useState('');
  const blockers = approvalBlockers(change);
  const run0 = change.latest_run;
  const inReview = change.order?.status === 'in_review';
  const done = change.order && (change.order.status === 'approved' || change.order.status === 'implemented');

  return (
    <div className="chg-stack">
      {run0 && (
        <div className="chg-reviewgrid">
          {requiredFunctions(run0).map(fn => <ReviewCard key={fn} change={change} fn={fn} />)}
        </div>
      )}

      <section className="card" aria-label="승인">
        <div className="card-head"><h3>승인</h3></div>
        <div className="card-body chg-stack">
          {done ? (
            <p role="status"><Badge tone="success">승인됨</Badge> {change.order?.approved_by} · {formatDateTime(change.order?.approved_at)} — 새 개정이 발행됐어요.</p>
          ) : blockers.length > 0 ? (
            <div className="banner banner-warning" role="status" aria-label="승인할 수 없는 이유">
              <Icon name="lock" size={18} />
              <div><b>아직 승인할 수 없어요.</b><ul className="chg-reasons">{blockers.map(b => <li key={b}>{b}</li>)}</ul></div>
            </div>
          ) : <p role="status" className="muted">승인 조건이 모두 갖춰졌어요.</p>}
          <ErrorText {...(error ? { error } : {})} />
          {!done && (
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={busy || blockers.length > 0} aria-disabled={busy || blockers.length > 0}
                onClick={() => run(() => api.approveChange(change.code))}>승인</button>
              <label htmlFor="reject-reason" className="sr-only">반려 사유</label>
              <input id="reject-reason" className="input chg-reject" value={reason} placeholder="반려 사유" disabled={!inReview || busy} onChange={e => setReason(e.target.value)} />
              <button type="button" className="btn" disabled={!inReview || busy || !reason.trim()} onClick={() => run(() => api.rejectChange(change.code, { reason: reason.trim() }))}>반려</button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
