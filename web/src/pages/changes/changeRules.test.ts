import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/types';
import { actionsFor, approvalBlockers, approvedFunctions, currentDispositions, quantityLine, requiredFunctions } from './changeRules';
import { describeError } from './changeUi';
import { impactGraph } from './impactGraph';
import { SC1_FINDINGS, SC2_FINDINGS, readyChange, sc1Change, sc1Graph, sc2Change, runOf } from './testChange';
import { parseAttributes } from './tabs/TargetsTab';
import { toScope } from './tabs/ScopeTab';

describe('처분 선택지', () => {
  it('종류별로 서버와 같은 선택지를 준다', () => {
    expect(actionsFor({ kind: 'work_order', severity: 'affected' })).toContain('change_in_progress');
    expect(actionsFor({ kind: 'stock_lot', severity: 'affected' })).toEqual(expect.arrayContaining(['use_up', 'quarantine', 'return', 'scrap']));
    expect(actionsFor({ kind: 'bom_usage', severity: 'none' })).toEqual(['acknowledge', 'no_action_needed']);
  });
  it('막힘(blocked)에는 위험 수용 · 조치 없음을 내지 않는다(변경안을 고쳐 풀어야 한다)', () => {
    const a = actionsFor({ kind: 'fit_pair', severity: 'blocked' });
    expect(a).toEqual(['block_change', 'choose_substitute', 'review_with_design']);
    expect(actionsFor({ kind: 'fit_pair', severity: 'review' })).toContain('no_action_needed');
  });
});

describe('승인을 막는 이유', () => {
  it('SC-1: 막힘 · 처분 없음 · 검토 없음이 모두 이유로 나온다', () => {
    const reasons = approvalBlockers(sc1Change());
    expect(reasons).toContain('막힘(blocked) 1건: 변경안을 고쳐 다시 분석하세요.');
    expect(reasons).toContain('처분이 필요한 영향 3건.');
    expect(reasons.join(' ')).toContain('설계 · 구매 · 생산 검토가 필요해요.');
  });
  it('조건이 모두 갖춰지면 이유가 없다', () => {
    expect(approvalBlockers(readyChange())).toEqual([]);
  });
  it('낡은 분석 · 일부만 분석 · 분석 없음은 승인을 막는다', () => {
    const base = readyChange();
    expect(approvalBlockers({ ...base, latest_run: runOf('CO-2026-0001', SC1_FINDINGS.slice(1), { stale: true }) }).join(' ')).toContain('외부 데이터가 바뀌었어요');
    expect(approvalBlockers({ ...base, latest_run: runOf('CO-2026-0001', [], { partial: true }) }).join(' ')).toContain('OPMS 를 읽지 못한 분석');
    const { latest_run: _omit, ...noRun } = base;
    expect(approvalBlockers(noRun)).toContain('영향 분석을 먼저 실행하세요.');
  });
  it('지시가 검토 단계가 아니거나 범위가 없으면 이유가 나온다', () => {
    const base = readyChange();
    expect(approvalBlockers({ ...base, order: { code: 'CO', status: 'draft' } }).join(' ')).toContain('검토 단계가 아니에요');
    expect(approvalBlockers({ ...base, targets: [{ ...base.targets[0]!, scopes: [] }] })).toContain('적용 범위가 없는 대상이 있어요.');
  });
  it('이전 분석에 한 검토는 무효다(분석이 바뀌면 다시 받는다)', () => {
    const base = readyChange();
    const reviews = base.reviews.map(r => ({ ...r, run_id: 0 }));
    expect(approvalBlockers({ ...base, reviews }).join(' ')).toContain('검토가 필요해요');
    expect(approvedFunctions({ reviews }, 1).size).toBe(0);
  });
});

describe('필요한 검토 · 현재 처분', () => {
  it('설계는 늘, 구매는 발주 · 재고가, 생산은 작업지시가 있을 때', () => {
    expect(requiredFunctions({ findings: SC1_FINDINGS })).toEqual(['design', 'purchasing', 'production']);
    expect(requiredFunctions({ findings: SC2_FINDINGS })).toEqual(['design', 'production']);
    expect(requiredFunctions({ findings: [] })).toEqual(['design']);
  });
  it('대체된 처분은 현재 처분이 아니다', () => {
    const m = currentDispositions([
      { id: 1, finding_id: 14, finding_kind: 'work_order', action: 'apply_new', reason: 'a', decided_by: 'x', decided_at: '', superseded_by: 2 },
      { id: 2, finding_id: 14, finding_kind: 'work_order', action: 'use_as_is', reason: 'b', decided_by: 'x', decided_at: '' },
    ]);
    expect(m.get(14)?.action).toBe('use_as_is');
  });
});

describe('수치 한 줄', () => {
  it('SC-2: 필요 32.5 mm · 볼트 30 mm · 2.5 mm 부족', () => {
    expect(quantityLine(SC2_FINDINGS[0]!)).toBe('필요 32.5 mm · 볼트 30 mm · 2.5 mm 부족');
  });
  it('SC-1 기준(R00): 부족하지 않으면 부족분을 적지 않는다', () => {
    expect(quantityLine(SC1_FINDINGS[1]!)).toBe('필요 28.5 mm · 볼트 30 mm');
  });
  it('수치가 없으면 없다', () => { expect(quantityLine(SC1_FINDINGS[0]!)).toBeUndefined(); });
});

describe('영향 그래프 변환', () => {
  it('변경 노드가 0단계이고 심각도가 톤이 된다(막힘만 impact_blocked)', () => {
    const g = impactGraph(sc1Graph);
    const by = (id: string) => g.nodes.find(n => n.id === id)!;
    expect(by('cr:1').level).toBe(0);
    expect(by('item:nut22').level).toBe(1);
    expect(by('wo:2').level).toBe(4);
    expect(by('item:nut23').tone).toBe('impact_blocked');
    expect(by('item:nut22').tone).toBe('impact_affected');
    expect(by('product:brk').tone).toBe('impact_none');
    expect(by('item:nut23').sub).toBe('막힘');                           // 색에만 기대지 않도록 글자로도 적는다
    expect(by('cr:1').kind).toBe('change');
    expect(by('wo:2').kind).toBe('workorder');
    expect(g.edges).toHaveLength(5);
  });
  it('끊어진 간선과 닿지 않는 노드를 견딘다', () => {
    const g = impactGraph({ nodes: [{ id: 'a', label: 'a', kind: 'change' }, { id: 'b', label: 'b', kind: 'item' }], edges: [{ source: 'a', target: 'zzz', kind: 'changes' }] });
    expect(g.edges).toHaveLength(0);
    expect(g.nodes.find(n => n.id === 'b')!.level).toBeGreaterThan(0);
    expect(impactGraph({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
  });
});

describe('입력 변환', () => {
  it('키=값 줄을 읽고 숫자는 숫자로', () => {
    expect(parseAttributes('thickness=12\nmaterial: SUS304\n\n잘못된 줄')).toEqual({ thickness: 12, material: 'SUS304' });
  });
  it('범위 입력: 빈 칸은 보내지 않고 로트는 쉼표로 나눈다', () => {
    expect(toScope({ effective_from: '2026-12-01', effective_to: '', site: ' A공장 ', lots: 'L1, L2 ,', serial_from: '120', serial_to: '', applies: 'new', note: '' }))
      .toEqual({ applies: 'new', effective_from: '2026-12-01', site: 'A공장', lot_nos: ['L1', 'L2'], serial_from: 120 });
  });
});

describe('서버 오류 설명', () => {
  it('서버 메시지가 먼저이고 처분 필요 수 · 필요한 검토가 덧붙는다', () => {
    expect(describeError(new ApiError('처분이 없는 영향이 있습니다.', 409, 'DISPOSITION_REQUIRED', { finding_ids: [14, 15] }))).toBe('처분이 없는 영향이 있습니다. 처분이 필요한 영향 2건.');
    expect(describeError(new ApiError('', 409, 'REVIEW_REQUIRED', { functions: ['purchasing', 'production'] }))).toContain('필요한 검토: 구매 · 생산.');
    expect(describeError(new ApiError('', 409, 'IMPACT_STALE'))).toBe('외부 데이터가 바뀌었어요. 다시 분석하세요.');
    expect(describeError(new Error('x'))).toBe('x');
  });
});

describe('시험 픽스처', () => {
  it('SC-2 변경 건은 수치가 맞는다(그립 32.5 > 30)', () => {
    const f = sc2Change().latest_run!.findings[0]!;
    expect(f.required).toBe(32.5);
    expect(f.actual! + f.gap!).toBe(f.required);
  });
});
