// 설계 변경 화면이 쓰는 순수 규칙: 처분 선택지 · 승인을 막는 이유 · 필요한 검토. 판정(짝 · 그립 길이)은 하지 않는다 — 서버가 낸 영향 발견을 읽을 뿐이다.
// 서버가 최종 판단하고(409), 여기 계산은 "왜 아직 승인할 수 없는가"를 미리 알려 주는 안내다. 서버의 changes/models.py 와 같은 규칙을 따른다.
import type {
  ChangeDetail, DispositionAction, DispositionView, FindingKind, ImpactFindingView, ImpactRunView, ReviewFunction, Severity,
} from '../../api/types';
import { ORDER_STATUS, REVIEW_FUNCTION } from '../../labels';

export const SEVERITY_ORDER: readonly Severity[] = ['blocked', 'affected', 'review', 'none'];
const RANK: Record<Severity, number> = { blocked: 0, affected: 1, review: 2, none: 3 };

const FIT_ACTIONS: DispositionAction[] = ['block_change', 'choose_substitute', 'review_with_design', 'accept_risk', 'no_action_needed'];
/** 대상 종류별 처분 선택지(서버 ALLOWED_ACTIONS 와 같다). 선택지는 PDM 안의 결정 기록이고 ERP · MES 에 쓰지 않는다 */
const ACTIONS: Record<FindingKind, DispositionAction[]> = {
  work_order: ['apply_new', 'use_as_is', 'continue_old', 'change_in_progress', 'cancel_reissue', 'no_action_needed'],
  purchase_order_line: ['receive_and_use', 'amend', 'cancel', 'accept_risk', 'no_action_needed'],
  stock_lot: ['use_up', 'quarantine', 'return', 'scrap', 'accept_risk', 'no_action_needed'],
  fit_pair: FIT_ACTIONS, fit_grip: FIT_ACTIONS, strength_grade: FIT_ACTIONS, substitute: FIT_ACTIONS,
  bom_usage: ['acknowledge', 'no_action_needed'],
  product: ['acknowledge', 'no_action_needed'],
};

/**
 * 이 영향에 고를 수 있는 처분. `blocked` 는 변경안을 고쳐서 풀어야 하므로 "위험 수용"과 "조치 없음"은 내지 않는다
 * (사유를 적은 예외 승인을 허용할지는 안전 · 품질 정책이라 정해지지 않았다 — docs/change-impact-design.md 10.3-2).
 */
export function actionsFor(f: Pick<ImpactFindingView, 'kind' | 'severity'>): DispositionAction[] {
  const all = ACTIONS[f.kind];
  return f.severity === 'blocked' ? all.filter(a => a !== 'accept_risk' && a !== 'no_action_needed') : all;
}

/** 처분이 필요한가: affected 는 반드시, blocked 는 승인 전에 해소해야 하므로 처분을 남길 수 있다, review 는 "조치 없음"으로 닫을 수 있다(선택) */
export const needsDisposition = (f: ImpactFindingView) => f.severity === 'affected';

export const bySeverity = (a: ImpactFindingView, b: ImpactFindingView) => RANK[a.severity] - RANK[b.severity] || a.id - b.id;

/** 영향마다 지금 유효한 처분(대체된 것은 뺀다) */
export function currentDispositions(list: readonly DispositionView[]): Map<number, DispositionView> {
  const out = new Map<number, DispositionView>();
  for (const d of list) if (d.superseded_by === undefined) out.set(d.finding_id, d);
  return out;
}

/** 이 분석에서 필요한 검토 기능: 설계는 늘, 구매는 발주 · 재고 영향이, 생산은 작업지시 영향이 있을 때 */
export function requiredFunctions(run: Pick<ImpactRunView, 'findings'>): ReviewFunction[] {
  const live = run.findings.filter(f => f.severity !== 'none');
  const out: ReviewFunction[] = ['design'];
  if (live.some(f => f.kind === 'purchase_order_line' || f.kind === 'stock_lot')) out.push('purchasing');
  if (live.some(f => f.kind === 'work_order')) out.push('production');
  return out;
}

/** 이 분석을 보고 찬성한 기능(분석이 바뀌면 이전 검토는 무효다) */
export function approvedFunctions(c: Pick<ChangeDetail, 'reviews'>, runId: number): Set<ReviewFunction> {
  const latest = new Map<ReviewFunction, ChangeDetail['reviews'][number]>();
  for (const r of c.reviews) {
    if (r.run_id !== runId || r.verdict === 'comment') continue;
    const prev = latest.get(r.function);
    if (!prev || r.id > prev.id) latest.set(r.function, r);
  }
  return new Set([...latest].filter(([, r]) => r.verdict === 'approve').map(([fn]) => fn));
}

/** 승인을 막는 이유(없으면 빈 배열). 서버가 최종 판단한다 */
export function approvalBlockers(c: ChangeDetail): string[] {
  const out: string[] = [];
  const { order, latest_run: run } = c;
  if (!order) out.push('요청을 접수해 변경 지시를 만드세요.');
  else if (order.status !== 'in_review') out.push(`지시가 검토 단계가 아니에요(지금: ${ORDER_STATUS[order.status]}).`);
  if (c.targets.length === 0) out.push('변경 대상이 없어요.');
  else if (c.targets.some(t => t.scopes.length === 0)) out.push('적용 범위가 없는 대상이 있어요.');
  if (!run) { out.push('영향 분석을 먼저 실행하세요.'); return out; }
  if (run.stale) out.push('외부 데이터가 바뀌었어요. 영향을 다시 분석하세요.');
  if (run.partial) out.push('OPMS 를 읽지 못한 분석이에요. OPMS 에 연결된 뒤 다시 분석하세요.');
  const blocked = run.findings.filter(f => f.severity === 'blocked').length;
  if (blocked > 0) out.push(`막힘(blocked) ${blocked}건: 변경안을 고쳐 다시 분석하세요.`);
  const decided = currentDispositions(c.dispositions);
  const open = run.findings.filter(f => needsDisposition(f) && !decided.has(f.id)).length;
  if (open > 0) out.push(`처분이 필요한 영향 ${open}건.`);
  const approved = approvedFunctions(c, run.id);
  const missing = requiredFunctions(run).filter(fn => !approved.has(fn));
  if (missing.length > 0) out.push(`${missing.map(fn => REVIEW_FUNCTION[fn]).join(' · ')} 검토가 필요해요.`);
  return out;
}

/** 필요 길이 · 사용 길이 · 부족분이 있으면 한 줄 수치(예: "필요 32.5 mm · 볼트 30 mm · 2.5 mm 부족") */
export function quantityLine(f: ImpactFindingView): string | undefined {
  if (f.required === undefined || f.actual === undefined) return undefined;
  const unit = typeof f.inputs['unit'] === 'string' ? f.inputs['unit'] : 'mm';
  const n = (v: number) => `${Math.round(v * 1000) / 1000}`;
  const head = `필요 ${n(f.required)} ${unit} · ${f.kind === 'fit_grip' ? '볼트 ' : '실제 '}${n(f.actual)} ${unit}`;
  if (f.gap !== undefined && f.gap > 0) return `${head} · ${n(f.gap)} ${unit} 부족`;
  return head;
}
