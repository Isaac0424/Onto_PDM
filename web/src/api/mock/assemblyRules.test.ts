import { describe, expect, it } from 'vitest';
import { guideFor, ruleApplies, ruleMatches, summarizeRules, type RuleDef } from './assemblyRules';

const value = (g: ReturnType<typeof guideFor>, label: string) => g?.params.find(p => p.label === label)?.value;

describe('규칙은 분류와 속성에 건다', () => {
  it('분류와 속성이 있으면 이름에 규격이 없어도 걸린다', () => {
    const g = guideFor({ name: '기판 고정 나사', className: '볼트', attributes: { threadSize: 'M3' } });
    expect(g).toMatchObject({ ruleId: 'SP-FAS-01', operation: 'fasten' });
    expect(guideFor({ name: '기판 고정 나사' })).toBeUndefined();                       // 이름만으로는 M3 인 줄 모른다
  });

  it('분류가 같아도 속성 조건이 안 맞으면 걸리지 않는다 (M4 볼트에는 M3 규칙이 없다)', () => {
    expect(guideFor({ name: '볼트 M4x10', className: '볼트', attributes: { threadSize: 'M4' } })).toBeUndefined();
    expect(guideFor({ name: '볼트 M4x10' })).toBeUndefined();                          // 이름만 들어와도 같은 결과
  });

  it('분류를 알면 이름이 비슷해도 분류가 우선이다', () => {
    // 이름은 볼트지만 분류가 커버 → 나사 규칙이 아니라 커버 규칙
    expect(guideFor({ name: '볼트 M3x8', className: '커버', attributes: { thickness: 3 } })?.ruleId).toBe('SP-CVR-01');
    // 이름은 감속기지만 분류가 서보 모터 → 모터 규칙
    expect(guideFor({ name: '감속기형 모터', className: '서보 모터' })?.ruleId).toBe('SP-MOT-01');
    // 이름은 서보 모터가 아니어도 분류가 감속기면 감속기 규칙
    expect(guideFor({ name: 'Reducer A', className: '감속기' })?.ruleId).toBe('SP-RED-01');
  });

  it('상위 분류가 함께 들어와도 사슬 안에 있으면 걸린다', () => {
    expect(guideFor({ name: '고정 볼트', className: '체결류 › 볼트', attributes: { threadSize: 'm3' } })?.ruleId).toBe('SP-FAS-01');
    expect(guideFor({ name: '고정 볼트', className: '체결류', attributes: { threadSize: 'M3' } })).toBeUndefined();   // 사슬에 볼트가 없다
  });

  it('이름만 가진 부품은 이름 패턴으로 찾는다 (하위 호환)', () => {
    expect(guideFor({ name: '기판 나사 M3' })?.ruleId).toBe('SP-FAS-01');
    expect(guideFor({ name: '상부 커버' })?.ruleId).toBe('SP-CVR-01');
    expect(guideFor({ name: '볼펜 심' })).toBeUndefined();
  });

  it('분류에 걸리는 규칙이 없는 규칙(기판 · 스페이서 · 용접 · 압입)은 분류가 있어도 이름으로 찾는다', () => {
    expect(guideFor({ name: '제어 기판', className: '전기 · 전자' })?.ruleId).toBe('SP-ELC-01');
    expect(guideFor({ name: '러그', className: '케이스 부품' })?.ruleId).toBe('SP-WLD-01');
    expect(guideFor({ name: '사파이어 크리스털', className: '유리' })?.ruleId).toBe('SP-PRS-01');
  });

  it('두께는 thickness 속성이 크기보다 먼저다', () => {
    const thin = guideFor({ name: '러그', size: [3, 2.6, 7] });
    const thick = guideFor({ name: '러그', size: [3, 2.6, 7], attributes: { thickness: 8 } });
    expect(value(thin, '개선 형상')).toBe('I형 (개선 없음)');
    expect(value(thick, '개선 형상')).toBe('V형 60° · 다층 용접');
    expect(value(thick, '필러(용접봉) 지름')).toBe('Φ3.2');
    expect(value(thick, '모재 두께')).toBe('8 mm');

    // 커버: 필요한 나사 길이 = 두께 + 4.5. M3 × 12 는 두께 7.5 까지 충족
    const ok = guideFor({ name: '덮개', className: '커버', attributes: { thickness: 5 } });
    const short = guideFor({ name: '덮개', className: '커버', attributes: { thickness: 8 } });
    expect(ok?.params).toContainEqual({ label: '사용 나사', value: 'M3 × 12', ok: true });
    expect(short?.params).toContainEqual({ label: '사용 나사', value: 'M3 × 12', ok: false });
    expect(value(short, '필요 나사 길이')).toBe('≥ 12.5 mm (두께 + 1.5 × 지름)');
  });

  it('두께 속성이 숫자가 아니면 크기를 쓴다', () => {
    const g = guideFor({ name: '상부 커버', size: [126, 80, 3], attributes: { thickness: '미정' } });
    expect(value(g, '커버 두께')).toBe('3 mm');
  });

  it('ruleApplies · ruleMatches', () => {
    expect(ruleMatches('SP-FAS-01', '기판 나사 M3')).toBe(true);
    expect(ruleMatches('SP-FAS-01', '상부 커버')).toBe(false);
    expect(ruleMatches('SP-NOPE', '아무거나')).toBe(false);
    expect(ruleApplies({ ...def(), classes: ['볼트'], when: p => p.attributes?.threadSize === 'M5' }, { name: 'x', className: '볼트', attributes: { threadSize: 'M5' } })).toBe(true);
  });

  it('규칙 상세의 조건 문구가 분류와 속성 방식을 말한다', () => {
    expect(summarizeRules().find(r => r.id === 'SP-FAS-01')?.appliesTo).toEqual(['볼트 (나사 규격 M3)']);
  });
});

/** 시험용으로 만드는 규칙 정의: 기본은 아무 문제 없는 규칙이고, 필요한 칸만 바꿔 쓴다 */
function def(over: Partial<RuleDef> = {}): RuleDef {
  return {
    id: 'SP-T-01', name: '시험 규칙', operation: 'mount', appliesTo: ['시험 부품'], description: '시험용', conditions: ['부품 이름에 시험이 있다'],
    status: 'approved', sample: { name: '시험 부품' }, match: /시험/,
    build: () => ({ title: '시험', caption: '시험', params: [{ label: '값', value: '1' }], cautions: ['조심'], tools: [] }),
    ...over,
  };
}
