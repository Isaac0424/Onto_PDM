// ④ 처분: 영향이 있다고 해서 바꾸는 것이 아니다. 대상마다 그대로 허용할지 · 재작업할지 · 격리할지 사람이 정하고 사유를 남긴다.
// 서버가 낸 "제안"은 칩으로만 보이고 미리 채우지 않는다(자동 확정 금지). ERP · MES 에는 쓰지 않는다 — 결정만 기록해 내보낸다.
import { useState } from 'react';
import type { ChangeDetail, DispositionAction, DispositionView, ImpactFindingView } from '../../../api/types';
import { Badge, ErrorText } from '../../../components/ui';
import { DISPOSITION, FINDING_KIND, formatDateTime } from '../../../labels';
import { useSession } from '../../../session';
import { actionsFor, bySeverity, currentDispositions, needsDisposition } from '../changeRules';
import { SeverityBadge, useAction } from '../changeUi';

function DispositionRow({ code, f, current, editable }: { code: string; f: ImpactFindingView; current: DispositionView | undefined; editable: boolean }) {
  const { api } = useSession();
  const { run, busy, error } = useAction();
  const options = actionsFor(f);
  const [action, setAction] = useState<DispositionAction | ''>(current?.action ?? '');
  const [reason, setReason] = useState(current?.reason ?? '');
  const id = `disp-${f.id}`;
  const blocked = f.severity === 'blocked';

  return (
    <tr>
      <td data-label="영향">
        <div><b>{FINDING_KIND[f.kind]}</b> <span className="mono">{f.subject_ref}</span></div>
        <small className="chg-sub">{f.message}</small>
      </td>
      <td data-label="심각도"><SeverityBadge severity={f.severity} /></td>
      <td data-label="처분">
        {blocked && <p className="chg-note" role="note">막힘은 처분이 아니라 변경안을 고쳐 다시 분석해야 풀려요.</p>}
        {f.suggested_disposition && <Badge tone="info" title="시스템 제안이에요. 자동으로 정해지지 않아요.">제안: {DISPOSITION[f.suggested_disposition]}</Badge>}
        {current && <div className="chg-current">현재: <b>{DISPOSITION[current.action]}</b> <span className="faint">· {current.decided_by} · {formatDateTime(current.decided_at)}</span></div>}
        <div className="chg-disp-form">
          <label htmlFor={`${id}-action`} className="sr-only">처분 선택 ({f.subject_ref})</label>
          <select id={`${id}-action`} className="select" value={action} disabled={!editable || busy} onChange={e => setAction(e.target.value as DispositionAction | '')}>
            <option value="">처분 선택…</option>
            {options.map(a => <option key={a} value={a}>{DISPOSITION[a]}</option>)}
          </select>
          <label htmlFor={`${id}-reason`} className="sr-only">사유 ({f.subject_ref})</label>
          <input id={`${id}-reason`} className="input" value={reason} disabled={!editable || busy} placeholder="사유" onChange={e => setReason(e.target.value)} />
          <button type="button" className="btn btn-sm btn-primary" disabled={!editable || busy || action === '' || !reason.trim()}
            onClick={() => action && run(() => api.setDisposition(code, f.id, { action, reason: reason.trim() }))}>저장</button>
        </div>
        <ErrorText {...(error ? { error } : {})} />
      </td>
    </tr>
  );
}

export function DispositionTab({ change }: { change: ChangeDetail }) {
  const run0 = change.latest_run;
  if (!run0) return <div className="empty">영향 분석을 먼저 실행하세요. 처분은 영향 발견마다 정해요.</div>;
  const decided = currentDispositions(change.dispositions);
  const rows = [...run0.findings].filter(f => f.severity !== 'none').sort(bySeverity);
  const editable = !run0.stale && (!change.order || change.order.status === 'draft' || change.order.status === 'in_review');
  const open = rows.filter(f => needsDisposition(f) && !decided.has(f.id)).length;

  return (
    <div className="chg-stack">
      <p className="muted chg-help">
        영향이 있다는 것과 바꿔야 한다는 것은 달라요. 처분이 필요한 영향(<b>처분 필요</b>)은 모두 정해야 승인할 수 있고, <b>확인 필요</b>는 &quot;조치 없음&quot;으로 닫을 수 있어요.
        {open > 0 ? ` 지금 처분이 없는 영향이 ${open}건 있어요.` : ' 처분이 필요한 영향은 모두 정해졌어요.'}
      </p>
      {run0.stale && <div className="banner banner-warning" role="status">분석이 낡았어요. 다시 분석한 뒤에 처분을 정하세요.</div>}
      {rows.length === 0
        ? <div className="empty">처분이 필요한 영향이 없어요.</div>
        : (
          <div className="card">
            <div className="table-wrap">
              <table className="table chg-table" aria-label="처분">
                <thead><tr><th>영향</th><th>심각도</th><th>처분</th></tr></thead>
                <tbody>{rows.map(f => <DispositionRow key={`${f.id}-${decided.get(f.id)?.id ?? 0}`} code={change.code} f={f} current={decided.get(f.id)} editable={editable} />)}</tbody>
              </table>
            </div>
          </div>
        )}
    </div>
  );
}
