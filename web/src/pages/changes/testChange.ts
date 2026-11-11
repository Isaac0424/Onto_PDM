// 시험 전용: 설계 변경 화면을 시험할 변경 건과 API. 제품(앱)에는 가짜 데이터가 없다 (기본 API 는 비어 있다).
// 모든 값은 시험 픽스처다(source_system='fixture'): BRK-M8 "M8 체결 브래킷 모듈" 의 SC-1(너트 교체) · SC-2(상판 두께 8→12 mm) 시나리오.
//   그립 길이 = Σ판 두께 + 와셔 두께×수 + 너트 높이 + 2×피치 = 16 + 3.2 + 6.8 + 2.5 = 28.5 (볼트 30 → 통과) · 상판 12 mm 면 32.5 (2.5 mm 부족)
import { createEmptyApi } from '../../api/emptyApi';
import {
  ApiError, type ChangeDetail, type ChangeRunSummary, type ChangeSummary, type DispositionView, type ImpactFindingView, type ImpactGraphView,
  type ImpactRunView, type PdmApi, type Severity,
} from '../../api/types';

export const T0 = '2026-11-12T09:00:00+09:00';
const basis = { ontology_version: '0.19.0', rule_id: 'bolt_nut', as_of: T0 };

export function summaryOf(findings: ImpactFindingView[], flags: { stale?: boolean; partial?: boolean } = {}): ChangeRunSummary {
  const count = (s: Severity) => findings.filter(f => f.severity === s).length;
  return { blocked: count('blocked'), affected: count('affected'), review: count('review'), none: count('none'), stale: flags.stale ?? false, partial: flags.partial ?? false };
}

export function runOf(order: string, findings: ImpactFindingView[], extra: Partial<ImpactRunView> = {}): ImpactRunView {
  return {
    id: 1, order_code: order, computed_at: T0, computed_by: 'engineer', input_hash: 'abcdef0123456789', ontology_version: '0.19.0', temporary: true, partial: false,
    external_as_of: { work_order: T0, purchase_order_line: T0, stock_lot: T0 }, stale: false, stale_reasons: [], warnings: [],
    summary: summaryOf(findings, extra), findings, ...extra,
  };
}

const finding = (id: number, f: Partial<ImpactFindingView> & Pick<ImpactFindingView, 'kind' | 'severity' | 'message' | 'reason_code' | 'subject_ref'>): ImpactFindingView => ({
  subject_type: 'part', basis, temporary: false, approximate: false, inputs: {}, ...f, id,
});

// ---- SC-1: 너트 P-…22 → P-…23(피치 1.0). 볼트(피치 1.25)와 짝이 맞지 않아 막힘 ----
export const SC1_FINDINGS: ImpactFindingView[] = [
  finding(11, {
    kind: 'fit_pair', severity: 'blocked', verdict: 'no', reason_code: 'pair_mismatch', subject_ref: 'P-00000000001 ↔ P-00000000023', temporary: true,
    message: '피치 1.25 ↔ 1.0 — 볼트와 너트의 나사 피치가 달라 짝이 맞지 않습니다.', inputs: { bolt_pitch: 1.25, nut_pitch: 1.0, threadSize: 'M8' }, suggested_disposition: 'block_change',
  }),
  finding(12, {
    kind: 'fit_grip', severity: 'none', verdict: 'ok', reason_code: 'thin_margin', subject_ref: 'BRK-M8 체결부 J1', temporary: true,
    message: '필요 28.5 mm, 볼트 30 mm — 여유 1.5 mm', required: 28.5, actual: 30, gap: 0, inputs: { plates: [8, 8], washers: '2×1.6', nutHeight: 6.8, pitch: 1.25, boltLength: 30 },
  }),
  finding(13, { kind: 'bom_usage', severity: 'none', reason_code: 'used_in_completed', subject_ref: '체결 세트 R00', message: '체결 세트 R00 · BRK-M8 R00 에서 쓰여요.' }),
  finding(14, { kind: 'work_order', severity: 'affected', reason_code: 'used_in_progress', subject_ref: 'WO-FX-0002', scope_class: 'inside', message: '진행 중인 작업지시가 기존 너트를 써요.', suggested_disposition: 'change_in_progress' }),
  finding(15, { kind: 'purchase_order_line', severity: 'affected', reason_code: 'open_po_line', subject_ref: 'PO-FX-100/10', scope_class: 'inside', message: '미입고 120개가 기존 너트예요.' }),
  finding(16, { kind: 'stock_lot', severity: 'affected', reason_code: 'stock_on_hand', subject_ref: 'LT-N-01', scope_class: 'inside', message: '재고 300개가 기존 너트예요.' }),
];

// ---- SC-2: 상판 두께 8 → 12 mm. 그립 길이 32.5 > 볼트 30 → 막힘 ----
export const SC2_FINDINGS: ImpactFindingView[] = [
  finding(21, {
    kind: 'fit_grip', severity: 'blocked', verdict: 'no', reason_code: 'shortfall', subject_ref: 'BRK-M8 체결부 J1', temporary: true, approximate: true,
    message: '필요 32.5 mm · 볼트 30 mm · 2.5 mm 부족', required: 32.5, actual: 30, gap: 2.5,
    inputs: { plates: [12, 8], washers: '2×1.6', nutHeight: 6.8, pitch: 1.25, boltLength: 30, plate_thickness_source: 'cad_estimate' }, suggested_disposition: 'choose_substitute',
  }),
  finding(22, {
    kind: 'substitute', severity: 'review', verdict: 'conditional', reason_code: 'substitute_conditional', subject_ref: 'P-00000000015 (플랜지볼트 M8×40)', temporary: true,
    message: '플랜지볼트가 육각볼트 + 평와셔를 대신하는 조합이라 사람이 확인해야 해요.',
  }),
  finding(23, { kind: 'work_order', severity: 'affected', reason_code: 'used_in_progress', subject_ref: 'WO-FX-0003', scope_class: 'partial', message: '일련번호 구간이 #120 경계에 걸쳐요.' }),
];

export const sc1Graph: ImpactGraphView = {
  nodes: [
    { id: 'cr:1', label: 'CR-2026-0001', kind: 'change' },
    { id: 'item:nut22', label: '육각너트 M8 P-…22', kind: 'item', severity: 'affected' },
    { id: 'item:nut23', label: '육각너트 M8(가는나사) P-…23', kind: 'item', severity: 'blocked' },
    { id: 'rev:set', label: '체결 세트 R00', kind: 'revision', severity: 'none' },
    { id: 'product:brk', label: 'BRK-M8', kind: 'product', severity: 'none' },
    { id: 'wo:2', label: 'WO-FX-0002', kind: 'work_order', severity: 'affected' },
  ],
  edges: [
    { source: 'cr:1', target: 'item:nut22', kind: 'changes' }, { source: 'item:nut22', target: 'item:nut23', kind: 'replaces' },
    { source: 'item:nut22', target: 'rev:set', kind: 'contains' }, { source: 'rev:set', target: 'product:brk', kind: 'contains' },
    { source: 'product:brk', target: 'wo:2', kind: 'uses_bom' },
  ],
};

const order = (code: string, status: NonNullable<ChangeDetail['order']>['status']) => ({ code, status, product_code: 'BRK-M8' });

export function sc1Change(over: Partial<ChangeDetail> = {}): ChangeDetail {
  return {
    code: 'CR-2026-0001', title: '너트 P-…22 → P-…23 교체', reason: '조달 가능한 가는나사 너트로 바꾸자는 요청', origin: 'design',
    before_summary: '육각너트 M8 피치 1.25', after_summary: '육각너트 M8 피치 1.0', status: 'accepted', product_code: 'BRK-M8',
    requested_by: 'engineer', requested_at: T0, order: order('CO-2026-0001', 'in_review'),
    targets: [{
      id: 1, change_kind: 'replace', item_no: 'P-00000000022', replacement_item_no: 'P-00000000023', before: {}, after: {}, note: '',
      scopes: [{ id: 1, applies: 'new', effective_from: '2026-12-01', site: 'A공장' }],
    }],
    latest_run: runOf('CO-2026-0001', SC1_FINDINGS), dispositions: [], reviews: [], ...over,
  };
}

export function sc2Change(over: Partial<ChangeDetail> = {}): ChangeDetail {
  return {
    code: 'CR-2026-0002', title: '상판 브래킷 두께 8 → 12 mm', reason: '강성 보강', origin: 'design', before_summary: '두께 8 mm', after_summary: '두께 12 mm', status: 'accepted',
    product_code: 'BRK-M8', requested_by: 'engineer', requested_at: T0, order: order('CO-2026-0002', 'in_review'),
    targets: [{
      id: 2, change_kind: 'attribute_edit', item_no: 'BRK-TOP', from_revision: 'R00', to_revision: 'R01', before: { thickness: 8 }, after: { thickness: 12 }, note: '',
      scopes: [{ id: 2, applies: 'new', serial_from: 120 }],
    }],
    latest_run: runOf('CO-2026-0002', SC2_FINDINGS, { id: 2 }), dispositions: [], reviews: [], ...over,
  };
}

const summaryRow = (c: ChangeDetail): ChangeSummary => ({
  code: c.code, title: c.title, status: c.status, ...(c.order ? { order_code: c.order.code, order_status: c.order.status } : {}),
  ...(c.product_code ? { product_code: c.product_code } : {}), origin: c.origin, requested_by: c.requested_by, requested_at: c.requested_at,
  ...(c.latest_run ? { run_summary: c.latest_run.summary } : {}),
});

export interface ChangeTestApi extends PdmApi {
  /** 시험이 부른 쓰기: `메서드 인자…` */
  calls: string[];
  state: Map<string, ChangeDetail>;
}

/** 메모리 안의 작은 변경 서버. 쓰기는 상태를 바꾼다(서버의 상세 규칙은 흉내 내지 않는다) */
export function changeTestApi(changes: ChangeDetail[] = [sc1Change(), sc2Change()], override: Partial<PdmApi> = {}): ChangeTestApi {
  const state = new Map(changes.map(c => [c.code, c]));
  const calls: string[] = [];
  const get = (id: string) => { const c = state.get(id); if (!c) throw new ApiError('변경 건을 찾을 수 없습니다', 404, 'CHANGE_NOT_FOUND'); return c; };
  const put = (c: ChangeDetail) => { state.set(c.code, c); return c; };
  let nextId = 100;
  return {
    ...createEmptyApi(),
    connected: true,
    calls, state,
    changesAvailable: async () => true,
    listChanges: async q => {
      const rows = [...state.values()].filter(c => (!q?.status || c.status === q.status) && (!q?.q || `${c.code} ${c.title}`.includes(q.q)));
      return { items: rows.map(summaryRow), total: rows.length, page: 1, size: 25 };
    },
    getChange: async id => state.get(id) ?? null,
    createChange: async body => {
      calls.push(`createChange ${body.title}`);
      return put({ code: 'CR-2026-0099', title: body.title, reason: body.reason, origin: body.origin ?? 'design', before_summary: body.before_summary ?? '', after_summary: body.after_summary ?? '', status: 'draft', requested_by: 'engineer', requested_at: T0, targets: [], dispositions: [], reviews: [] });
    },
    addChangeTarget: async (id, body) => {
      calls.push(`addChangeTarget ${id} ${JSON.stringify(body)}`);
      const c = get(id);
      const t = { id: nextId++, ...body, before: body.before ?? {}, after: body.after ?? {}, note: body.note ?? '', scopes: [] };
      put({ ...c, targets: [...c.targets, t] });
      return t;
    },
    removeChangeTarget: async (id, tid) => { calls.push(`removeChangeTarget ${id} ${tid}`); const c = get(id); put({ ...c, targets: c.targets.filter(t => t.id !== tid) }); },
    setChangeScope: async (id, tid, body) => {
      calls.push(`setChangeScope ${id} ${tid} ${JSON.stringify(body)}`);
      const c = get(id);
      const scopes = body.scopes.map(s => ({ id: nextId++, applies: 'new' as const, ...s }));
      put({ ...c, targets: c.targets.map(t => (t.id === tid ? { ...t, scopes } : t)) });
      return scopes;
    },
    getImpact: async id => state.get(id)?.latest_run ?? null,
    recomputeImpact: async id => {
      calls.push(`recomputeImpact ${id}`);
      const c = get(id);
      const run = { ...(c.latest_run ?? runOf(c.order?.code ?? 'CO', [])), stale: false, id: (c.latest_run?.id ?? 0) + 1 };
      put({ ...c, latest_run: { ...run, summary: { ...run.summary, stale: false } } });
      return run;
    },
    getImpactGraph: async () => sc1Graph,
    setDisposition: async (id, findingId, body) => {
      calls.push(`setDisposition ${id} ${findingId} ${body.action} ${body.reason}`);
      const c = get(id);
      const d: DispositionView = { id: nextId++, finding_id: findingId, finding_kind: c.latest_run?.findings.find(f => f.id === findingId)?.kind ?? 'work_order', action: body.action, reason: body.reason, decided_by: 'approver', decided_at: T0 };
      put({ ...c, dispositions: [...c.dispositions, d] });
      return d;
    },
    submitReview: async (id, body) => {
      calls.push(`submitReview ${id} ${body.function} ${body.verdict}`);
      const c = get(id);
      const r = { id: nextId++, run_id: c.latest_run?.id ?? 0, reviewer: 'approver', reviewed_at: T0, comment: body.comment ?? '', ...body };
      put({ ...c, reviews: [...c.reviews, r] });
      return r;
    },
    acceptChange: async id => { calls.push(`acceptChange ${id}`); const c = get(id); return put({ ...c, status: 'accepted', order: order('CO-2026-0050', 'draft') }); },
    submitChange: async id => { calls.push(`submitChange ${id}`); const c = get(id); return put({ ...c, order: order(c.order?.code ?? 'CO', 'in_review') }); },
    approveChange: async id => {
      calls.push(`approveChange ${id}`);
      const c = get(id);
      return put({ ...c, order: { ...order(c.order?.code ?? 'CO', 'implemented'), approved_by: 'approver', approved_at: T0, approved_run_id: c.latest_run?.id ?? 1 } });
    },
    rejectChange: async (id, body) => { calls.push(`rejectChange ${id} ${body.reason}`); const c = get(id); return put({ ...c, order: order(c.order?.code ?? 'CO', 'rejected') }); },
    ...override,
  };
}

/** 승인 조건이 모두 갖춰진 변경 건: 막힘 없음 · 처분 완료 · 설계 / 구매 / 생산 찬성 */
export function readyChange(): ChangeDetail {
  const findings = SC1_FINDINGS.filter(f => f.id !== 11);
  const run = runOf('CO-2026-0001', findings);
  const dispositions: DispositionView[] = findings.filter(f => f.severity === 'affected').map((f, i) => ({
    id: 200 + i, finding_id: f.id, finding_kind: f.kind, action: 'use_up', reason: '재고 소진 후 전환', decided_by: 'approver', decided_at: T0,
  }));
  const reviews = (['design', 'purchasing', 'production'] as const).map((fn, i) => ({ id: 300 + i, function: fn, verdict: 'approve' as const, comment: '', run_id: 1, reviewer: 'approver', reviewed_at: T0 }));
  return sc1Change({ latest_run: run, dispositions, reviews });
}
