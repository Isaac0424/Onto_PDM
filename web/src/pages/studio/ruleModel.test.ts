import { describe, expect, it } from 'vitest';
import { buildRuleView, classPathOf } from './useRuleSelection';
import { modelFromNames } from './ruleModel';
import type { RuleSelectResponse, SelectedRule, TaxonomyClass } from '../../api/types';

describe('로봇 모델 읽기(modelFromNames)', () => {
  it('파일 · 부품 이름에서 정확히 하나로 읽을 때만 모델을 돌려준다', () => {
    expect(modelFromNames(['Body HCR12A R00 3D.stp'])).toBe('HCR-12A');
    expect(modelFromNames(['Body HCR3A R00 3D.stp'])).toBe('HCR-3A');
    expect(modelFromNames(['HCR_2G_5A_3D CAD Models'])).toBe('HCR-5A');
    expect(modelFromNames(['hcr-12a-assy', undefined])).toBe('HCR-12A');
    expect(modelFromNames(['Body.stp', 'HCR12A_1ST_ARM_ASSY_R1_ASM', 'HCR12A_2ND_ARM_COVER_A_R1'])).toBe('HCR-12A');       // 같은 모델이 여러 번 나와도 하나
    expect(modelFromNames(['HCR3A_BASE_COVER_BOLT_1'])).toBe('HCR-3A');
  });

  it('없거나 서로 다른 모델이 섞여 있으면 모른다고 한다 (지어내지 않는다)', () => {
    expect(modelFromNames([])).toBeUndefined();
    expect(modelFromNames(['base.step', 'BOLT-M4X15'])).toBeUndefined();
    expect(modelFromNames(['Body HCR12A R00 3D.stp', 'HCR3A_BASE_COVER'])).toBeUndefined();
  });

  it('다른 글자에 붙은 것은 모델이 아니다', () => {
    expect(modelFromNames(['XHCR12A'])).toBeUndefined();
    expect(modelFromNames(['HCR12AB'])).toBeUndefined();
    expect(modelFromNames(['HCR7A'])).toBeUndefined();
  });
});

const cls = (code: string, parent?: string): TaxonomyClass => ({ iri: `cls:${code}`, code, labelKo: code, ...(parent ? { parentIri: `cls:${parent}` } : {}), kind: 'part' });
const CLASSES = [cls('MechanicalPart'), cls('Fastener', 'MechanicalPart'), cls('Bolt', 'Fastener'), cls('SocketHeadBolt', 'Bolt')];

describe('분류 경로(classPathOf)', () => {
  it('루트부터 그 분류까지의 코드 목록', () => {
    expect(classPathOf(CLASSES, 'SocketHeadBolt')).toEqual(['MechanicalPart', 'Fastener', 'Bolt', 'SocketHeadBolt']);
    expect(classPathOf(CLASSES, 'Bolt')).toEqual(['MechanicalPart', 'Fastener', 'Bolt']);
  });

  it('OPMS 에 없는 분류(제안)는 상위 분류의 경로 뒤에 붙고, 상위 분류도 모르면 자기 자신뿐이다', () => {
    expect(classPathOf(CLASSES, 'ButtonHeadBolt', 'Bolt')).toEqual(['MechanicalPart', 'Fastener', 'Bolt', 'ButtonHeadBolt']);
    expect(classPathOf(CLASSES, 'ButtonHeadBolt')).toEqual(['ButtonHeadBolt']);
    expect(classPathOf([], 'SocketHeadBolt', 'Bolt')).toEqual(['SocketHeadBolt']);                      // 분류 목록을 못 읽었다
  });

  it('순환이 있어도 멈춘다', () => {
    const loop = [cls('A', 'B'), cls('B', 'A')];
    expect(classPathOf(loop, 'A').length).toBeLessThanOrEqual(33);
  });
});

const rule = (id: string, applicable: SelectedRule['applicable'], role?: string): SelectedRule => ({
  rule: {
    id, name: id, operation: 'BoltFastening', scope: 'part', reviewStatus: 'unreviewed', tools: [], cautions: [], parameters: [], byGrade: {}, gapIds: [],
    appliesTo: { source: 'manual', refs: [], estimated: false, approvalRequired: false, confirmed: true, classes: ['Bolt'], proposedClasses: [], ...(role ? { role, roleLabel: `${role} 라벨 (3.3)` } : {}), models: [], where: {} },
  },
  applicable, matchedConditions: [], failedConditions: [], unconfirmedParameters: [],
  unknownConditions: applicable === 'unknown' && role ? [{ kind: 'role', key: 'role', expected: role, result: 'unknown', message: '' }] : [],
});
const response = (rules: SelectedRule[]): RuleSelectResponse => ({ classCode: 'Bolt', rules, counts: { yes: 0, unknown: 0, no: 0 }, note: '' });
const input = { classCode: 'Bolt', basis: 'confirmed' as const, attributes: {} };

describe('규칙 결과 → 카드 모양(buildRuleView)', () => {
  it('적용(yes)과 확정하면 적용(unknown)을 나누고, 역할을 몰라 확정 못 하는 규칙의 역할이 선택지가 된다', () => {
    const v = buildRuleView(response([rule('A', 'yes'), rule('B', 'unknown', 'robot_base_mount'), rule('C', 'unknown', 'tool_mount'), rule('D', 'unknown', 'tool_mount')]), 'estimated', input);
    expect(v).toMatchObject({ status: 'ready', basis: 'estimated', classCode: 'Bolt' });
    if (v.status !== 'ready') throw new Error('ready 가 아니다');
    expect(v.applied.map(r => r.rule.id)).toEqual(['A']);
    expect(v.pending.map(r => r.rule.id)).toEqual(['B', 'C', 'D']);
    expect(v.roleChoices).toEqual([{ role: 'robot_base_mount', label: 'robot_base_mount 라벨 (3.3)' }, { role: 'tool_mount', label: 'tool_mount 라벨 (3.3)' }]);   // 같은 역할은 한 번만
  });

  it('이미 고른 역할은 규칙이 적용으로 옮겨 가도 선택지에 남는다 (다시 눌러 해제할 수 있다)', () => {
    const v = buildRuleView(response([rule('B', 'yes', 'robot_base_mount')]), 'confirmed', { ...input, role: 'robot_base_mount' });
    if (v.status !== 'ready') throw new Error('ready 가 아니다');
    expect(v.applied).toHaveLength(1);
    expect(v.pending).toHaveLength(0);
    expect(v.role).toBe('robot_base_mount');
    expect(v.roleChoices).toEqual([{ role: 'robot_base_mount', label: 'robot_base_mount 라벨 (3.3)' }]);
  });

  it('고른 역할의 규칙이 하나도 없으면 역할 이름만 남는다', () => {
    const v = buildRuleView(response([]), 'confirmed', { ...input, role: 'ground_line' });
    if (v.status !== 'ready') throw new Error('ready 가 아니다');
    expect(v.roleChoices).toEqual([{ role: 'ground_line', label: 'ground_line' }]);
  });
});
