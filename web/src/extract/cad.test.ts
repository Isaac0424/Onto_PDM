import { describe, expect, it } from 'vitest';
import { extractCadAttributes } from './index';

const attrsOf = (p: Parameters<typeof extractCadAttributes>[0][number]) => extractCadAttributes([p])[0]!.attributes;
const byKey = (attrs: ReturnType<typeof attrsOf>, key: string, source?: string) => attrs.filter(a => a.key === key && (!source || a.source === source));

describe('extractCadAttributes: 형상', () => {
  it('크기를 큰 순으로 길이 · 너비 · 높이로 읽고, 가장 얇은 치수를 두께로 둔다', () => {
    const a = attrsOf({ name: '상부 커버', size: [3, 126, 80] });
    expect(byKey(a, 'length')[0]).toMatchObject({ value: 126, unit: 'mm', source: 'cad', confidence: 0.9 });
    expect(byKey(a, 'width')[0]).toMatchObject({ value: 80 });
    expect(byKey(a, 'height')[0]).toMatchObject({ value: 3 });
    expect(byKey(a, 'thickness')[0]).toMatchObject({ value: 3, unit: 'mm', source: 'cad' });
    expect(byKey(a, 'thickness')[0]!.evidence).toContain('가장 얇은 치수 = 3 mm');
    expect(byKey(a, 'thickness')[0]!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('inch · cm 는 mm 로 환산하고 evidence 에 원값을 남긴다', () => {
    const a = attrsOf({ name: '플레이트', size: [1, 2, 4], unit: 'in' });
    expect(byKey(a, 'length')[0]).toMatchObject({ value: 101.6, unit: 'mm' });
    expect(byKey(a, 'length')[0]!.evidence).toContain('원값 4 in → 101.6 mm');
    expect(byKey(a, 'thickness')[0]).toMatchObject({ value: 25.4 });
    expect(byKey(attrsOf({ name: '블록', size: [1.5, 2, 3], unit: 'cm' }), 'width')[0]).toMatchObject({ value: 20 });
  });

  it('크기가 null 이거나 단위를 모르면 치수류를 만들지 않는다', () => {
    expect(attrsOf({ name: '하우징', size: null })).toEqual([]);
    expect(attrsOf({ name: '하우징', size: [1, 2, 3], unit: 'furlong' })).toEqual([]);
    expect(attrsOf({ name: '하우징', size: [0, 2, 3] })).toEqual([]);                              // 0 이하는 읽을 수 없다
  });

  it('체적: 닫힌 메시는 계산값, 추정이면 estimated 로 신뢰도를 낮춘다', () => {
    const exact = byKey(attrsOf({ name: '블록', size: null, volume: 1000 }), 'volume')[0]!;
    expect(exact).toMatchObject({ value: 1000, unit: 'mm³', confidence: 0.8 });
    expect(exact.estimated).toBeUndefined();
    const guess = byKey(attrsOf({ name: '블록', size: null, volume: 1000, volumeEstimated: true }), 'volume')[0]!;
    expect(guess.estimated).toBe(true);
    expect(guess.confidence).toBeLessThan(exact.confidence);
    expect(byKey(attrsOf({ name: '블록', size: null, volume: 1 , unit: 'cm' }), 'volume')[0]!.value).toBe(1000);   // 1 cm³ = 1000 mm³
  });
});

describe('extractCadAttributes: 이름의 규격 표기', () => {
  it('M3 → 나사 규격, M3x8 · M3×12 → 규격 + 길이', () => {
    const a = attrsOf({ name: '기판 나사 M3', size: null });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ key: 'threadSize', value: 'M3', source: 'name' });
    expect(a[0]!.evidence).toContain('M3');

    const b = attrsOf({ name: '볼트 M3×12', size: null });
    expect(byKey(b, 'threadSize')[0]!.value).toBe('M3');
    expect(byKey(b, 'length')[0]).toMatchObject({ value: 12, unit: 'mm', source: 'name' });
    expect(byKey(attrsOf({ name: 'Bolt M4x10', size: null }), 'length')[0]!.value).toBe(10);
  });

  it('Φ · φ · D 지름, 400W 정격 출력, 48V 전압', () => {
    expect(byKey(attrsOf({ name: '핀 Φ10', size: null }), 'diameter')[0]).toMatchObject({ value: 10, unit: 'mm', confidence: 0.9 });
    expect(byKey(attrsOf({ name: '핀 φ6.5', size: null }), 'diameter')[0]!.value).toBe(6.5);
    const d = byKey(attrsOf({ name: '핀 D10', size: null }), 'diameter')[0]!;
    expect(d).toMatchObject({ value: 10, estimated: true });                                       // D 표기는 추정
    expect(d.confidence).toBeLessThan(0.9);
    expect(byKey(attrsOf({ name: '서보 모터 400W', size: null }), 'ratedPower')[0]).toMatchObject({ value: 400, unit: 'W' });
    expect(byKey(attrsOf({ name: '모터 2.2kW', size: null }), 'ratedPower')[0]).toMatchObject({ value: 2.2, unit: 'kW' });
    expect(byKey(attrsOf({ name: '전원 12V', size: null }), 'ratedVoltage')[0]!.value).toBe(12);
  });

  it('5kg 같은 값은 질량 후보지만 신뢰도를 낮추고 g 는 kg 로 환산한다', () => {
    const a = byKey(attrsOf({ name: '협동로봇 3 kg', size: null }), 'mass')[0]!;
    expect(a).toMatchObject({ value: 3, unit: 'kg' });
    expect(a.confidence).toBeLessThanOrEqual(0.5);
    expect(a.evidence).toContain('정격 · 가반하중일 수 있음');
    const g = byKey(attrsOf({ name: '추 120g', size: null }), 'mass')[0]!;
    expect(g.value).toBe(0.12);
    expect(g.evidence).toContain('120 g → 0.12 kg');
  });

  it('모르는 표기는 일반 키(표기 치수)로 두고, 이름에 규격이 없으면 아무것도 만들지 않는다', () => {
    expect(byKey(attrsOf({ name: 'Spacer 3mm', size: null }), 'nominalSize')[0]).toMatchObject({ value: 3, unit: 'mm' });
    expect(attrsOf({ name: '하우징', size: null })).toEqual([]);
    expect(attrsOf({ name: 'HCR3A 본체', size: null })).toEqual([]);                                // 3A 는 전류가 아니다 (이름 코드)
    expect(attrsOf({ name: 'DWG-0111 도면', size: null })).toEqual([]);
  });

  it('같은 글자를 두 규칙이 읽지 않는다 (M3x8 의 8 이 표기 치수로 또 나오지 않는다)', () => {
    const a = attrsOf({ name: '나사 M3x8mm', size: null });
    expect(byKey(a, 'length')).toHaveLength(1);
    expect(byKey(a, 'nominalSize')).toHaveLength(0);
  });

  it('형상 속성과 이름 속성은 함께 나오고, 출처로 구분된다', () => {
    const a = attrsOf({ name: '상부 커버 Φ12', size: [3, 126, 80] });
    expect(byKey(a, 'thickness', 'cad')).toHaveLength(1);
    expect(byKey(a, 'diameter', 'name')).toHaveLength(1);
    expect(a.every(x => x.evidence.length > 0 && x.confidence > 0 && x.confidence <= 1)).toBe(true);
  });

  it('부품 순서와 이름을 그대로 돌려준다', () => {
    const r = extractCadAttributes([{ name: 'A', size: null }, { name: 'B M3', size: null }]);
    expect(r.map(x => x.partName)).toEqual(['A', 'B M3']);
  });
});

describe('단위 정보가 없는 CAD (STL · OBJ · GLB)', () => {
  it('뷰어가 \'단위\' 같은 자리표시를 돌려줘도 mm 로 가정해 치수 · 두께 후보를 만들고, 추정으로 표시한다', () => {
    for (const unit of ['', '단위', 'unit']) {
      const a = attrsOf({ name: '하우징', size: [120, 80, 20], unit });
      expect(byKey(a, 'length')[0]).toMatchObject({ value: 120, unit: 'mm', estimated: true, confidence: 0.55 });
      expect(byKey(a, 'thickness')[0]).toMatchObject({ value: 20, unit: 'mm', estimated: true });
      expect(byKey(a, 'thickness')[0]!.evidence).toContain('단위 정보가 없어 mm 로 가정');
    }
  });

  it('단위가 명시된 파일은 가정이 아니다 (추정 표시 없음, 신뢰도 그대로)', () => {
    const a = attrsOf({ name: '하우징', size: [120, 80, 20], unit: 'mm' });
    expect(byKey(a, 'length')[0]).toMatchObject({ confidence: 0.9 });
    expect(byKey(a, 'length')[0]).not.toHaveProperty('estimated');
  });

  it('모르는 단위는 여전히 만들지 않는다', () => {
    expect(attrsOf({ name: '하우징', size: [1, 2, 3], unit: 'furlong' })).toEqual([]);
  });
});
