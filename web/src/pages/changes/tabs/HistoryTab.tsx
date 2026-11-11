// ⑥ 이력: 누가 언제 무엇을 보고 결정했는지(감사 · 판단 시점 스냅샷). 분석은 매번 쌓이고 지우지 않는다.
// 지금 서버가 주는 것은 최신 분석 하나뿐이라, 그 분석의 근거(온톨로지 버전 · 입력 해시 · 외부 데이터 기준 시각)와 처분 · 검토 · 상태 전이를 시간순으로 보인다.
import type { ChangeDetail } from '../../../api/types';
import { Badge } from '../../../components/ui';
import { DISPOSITION, REVIEW_FUNCTION, REVIEW_VERDICT, formatDateTime } from '../../../labels';

interface Entry { at: string; key: string; text: string; note?: string }

export function HistoryTab({ change }: { change: ChangeDetail }) {
  const entries: Entry[] = [{ at: change.requested_at, key: 'req', text: `${change.requested_by} 님이 변경을 요청했어요.` }];
  const run = change.latest_run;
  if (run) {
    entries.push({
      at: run.computed_at, key: `run-${run.id}`, text: `${run.computed_by} 님이 영향을 분석했어요 (분석 #${run.id}).`,
      note: `온톨로지 ${run.ontology_version} · 입력 ${run.input_hash.slice(0, 8)}${run.temporary ? ' · 임시 판정' : ''}${run.partial ? ' · 일부만 분석' : ''}${run.stale ? ' · 낡음' : ''}`,
    });
  }
  change.dispositions.forEach(d => entries.push({
    at: d.decided_at, key: `d-${d.id}`, text: `${d.decided_by} 님이 영향 #${d.finding_id}의 처분을 “${DISPOSITION[d.action]}”(으)로 정했어요${d.superseded_by !== undefined ? ' (이후 바뀜)' : ''}.`, note: d.reason,
  }));
  change.reviews.forEach(r => entries.push({
    at: r.reviewed_at, key: `r-${r.id}`, text: `${r.reviewer} 님이 ${REVIEW_FUNCTION[r.function]} ${REVIEW_VERDICT[r.verdict]}을(를) 냈어요 (분석 #${r.run_id}).`, ...(r.comment ? { note: r.comment } : {}),
  }));
  if (change.order?.approved_at) entries.push({ at: change.order.approved_at, key: 'appr', text: `${change.order.approved_by ?? ''} 님이 승인했어요${change.order.approved_run_id ? ` (분석 #${change.order.approved_run_id} 기준)` : ''}.` });
  entries.sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="chg-stack">
      {run && Object.keys(run.external_as_of).length > 0 && (
        <p className="muted chg-help">
          외부 데이터 기준 시각:{' '}
          {Object.entries(run.external_as_of).map(([k, v]) => <Badge key={k} tone="neutral" title={v}>{k} {formatDateTime(v)}</Badge>)}
        </p>
      )}
      <ol className="chg-timeline" aria-label="이력">
        {entries.map(e => (
          <li key={e.key}><span className="faint chg-time">{formatDateTime(e.at)}</span> <span>{e.text}</span>{e.note && <small className="chg-sub">{e.note}</small>}</li>
        ))}
      </ol>
    </div>
  );
}
