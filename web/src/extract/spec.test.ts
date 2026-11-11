import { describe, expect, it } from 'vitest';
import { extractSpecAttributes } from './index';
import { snippet, splitSentences } from './spec';

const one = (text: string, name: string) => extractSpecAttributes(text, [name])[0]!.attributes;
const get = (attrs: ReturnType<typeof one>, key: string) => attrs.filter(a => a.key === key);

describe('splitSentences', () => {
  it('줄과 문장 끝으로 나누되 소수점은 끊지 않는다', () => {
    expect(splitSentences('토크는 0.6 N·m 이다. 다음 줄\n세 번째 문장!  네 번째')).toEqual(['토크는 0.6 N·m 이다.', '다음 줄', '세 번째 문장!', '네 번째']);
  });
});

describe('extractSpecAttributes: 토크', () => {
  const text = '기판 나사 M3의 체결 토크는 0.6 N·m ±10% 이다.';

  it('토크 · 허용 오차 · 나사 규격을 뽑고, 근거는 원문 구절 그대로다', () => {
    const a = one(text, '기판 나사 M3');
    expect(get(a, 'torque')[0]).toMatchObject({ value: 0.6, unit: 'N·m', source: 'spec' });
    expect(get(a, 'torque')[0]!.evidence).toBe(text);
    expect(get(a, 'torqueTolerance')[0]).toMatchObject({ value: 10, unit: '%' });
    expect(get(a, 'threadSize')[0]!.value).toBe('M3');
  });

  it('0.6Nm · N-m · kgf·cm 표기를 N·m 로 환산하고 환산 사실을 evidence 에 남긴다', () => {
    expect(get(one('배터리 커버 나사는 0.6Nm 로 조인다.', '배터리 커버 나사'), 'torque')[0]!.value).toBe(0.6);
    expect(get(one('배터리 커버 나사는 0.6 N-m 로 조인다.', '배터리 커버 나사'), 'torque')[0]!.value).toBe(0.6);
    const kgf = get(one('볼트 체결 토크는 6 kgf·cm 이다.', '볼트'), 'torque')[0]!;
    expect(kgf.value).toBe(0.588);
    expect(kgf.unit).toBe('N·m');
    expect(kgf.evidence).toContain('환산: 6 kgf·cm → 0.588 N·m');
  });

  it('토크가 없으면 허용 오차만 따로 만들지 않는다', () => {
    expect(get(one('기판 나사는 ±10% 의 오차를 가진다.', '기판 나사'), 'torqueTolerance')).toEqual([]);
  });
});

describe('extractSpecAttributes: 재료 · 치수 · 정격', () => {
  it('재료 표기를 대표 이름으로 모은다 (STS304 · AISI 304 · 1.4301 → SUS304)', () => {
    expect(get(one('하우징 재질은 SUS304 이다.', '하우징'), 'material')[0]!.value).toBe('SUS304');
    expect(get(one('하우징 재질은 STS 304 이다.', '하우징'), 'material')[0]!.value).toBe('SUS304');
    expect(get(one('Housing material: AISI 316L.', 'Housing'), 'material')[0]!.value).toBe('SUS316L');
    expect(get(one('하우징은 1.4301 소재이다.', '하우징'), 'material')[0]!.value).toBe('SUS304');
    expect(get(one('브래킷은 SS400 으로 만든다.', '브래킷'), 'material')[0]!.value).toBe('SS400');
    expect(get(one('커버는 A6061-T6 알루미늄이다.', '커버'), 'material')[0]!.value).toBe('A6061');
  });

  it('두께 · 길이 · 지름: 단위가 없으면 mm 로 읽되 신뢰도를 낮춘다', () => {
    const a = one('상부 커버의 두께는 3mm 이고 길이 126 mm, 지름 Φ8 의 구멍이 있다.', '상부 커버');
    expect(get(a, 'thickness')[0]).toMatchObject({ value: 3, unit: 'mm' });
    expect(get(a, 'length')[0]!.value).toBe(126);
    expect(get(a, 'diameter')[0]!.value).toBe(8);
    const noUnit = get(one('상부 커버 두께 3', '상부 커버'), 'thickness')[0]!;
    expect(noUnit.value).toBe(3);
    expect(noUnit.confidence).toBeLessThan(get(a, 'thickness')[0]!.confidence);
    expect(noUnit.evidence).toContain('단위가 없어 mm 로 읽음');
    expect(get(one('상부 커버 두께 0.5 cm', '상부 커버'), 'thickness')[0]!.value).toBe(5);
  });

  it('정격 전압 · 전류 · 출력, 나사 길이(M3x8)', () => {
    const a = one('전원 버튼은 12V 50mA 접점이며 400W 부하는 쓰지 않는다.', '전원 버튼');
    expect(get(a, 'ratedVoltage')[0]).toMatchObject({ value: 12, unit: 'V' });
    expect(get(a, 'ratedCurrent')[0]).toMatchObject({ value: 50, unit: 'mA' });
    expect(get(a, 'ratedPower')[0]).toMatchObject({ value: 400, unit: 'W' });
    const t = one('기판 나사는 M3x8 을 쓴다.', '기판 나사');
    expect(get(t, 'threadSize')[0]!.value).toBe('M3');
    expect(get(t, 'length')[0]!.value).toBe(8);
  });
});

describe('extractSpecAttributes: 부품 이름 근처로 제한', () => {
  const text = [
    '제어 기판은 정전기에 약하다. 취급 시 ESD 스트랩을 착용한다.',
    '기판 나사 M3의 체결 토크는 0.6 N·m 이다.',
    '상부 커버의 체결 토크는 1.2 N·m 이다.',
    '배터리는 3.7V 이다.',
  ].join('\n');

  it('다른 부품 구절의 값은 가져오지 않는다', () => {
    const [board, screw, cover, battery] = extractSpecAttributes(text, ['제어 기판', '기판 나사 M3', '상부 커버', '배터리']);
    expect(get(screw!.attributes, 'torque').map(a => a.value)).toEqual([0.6]);
    expect(get(cover!.attributes, 'torque').map(a => a.value)).toEqual([1.2]);
    expect(get(board!.attributes, 'torque')).toEqual([]);                          // 기판은 '기판 나사' 문장에 나오지만 나사 이름 전체가 필요하다
    expect(get(battery!.attributes, 'ratedVoltage')[0]!.value).toBe(3.7);
  });

  it('부품 이름이 한 번도 안 나오면 아무것도 만들지 않는다', () => {
    expect(one('이 장비의 체결 토크는 0.6 N·m 이다. 재질은 SUS304 이다.', '서보 모터')).toEqual([]);
    expect(extractSpecAttributes('', ['하우징'])).toEqual([{ partName: '하우징', attributes: [] }]);
    expect(extractSpecAttributes('아무 글', [])).toEqual([]);
  });

  it('앞뒤 한 문장은 보되(신뢰도 낮춤) 두 문장 이상 떨어진 값은 버린다', () => {
    const t = '하우징 체결 방법을 설명한다.\n체결 토크는 0.6 N·m 이다.\n그림을 참고한다.\n재질은 SUS304 이다.';
    const a = one(t, '하우징');
    expect(get(a, 'torque')[0]!.value).toBe(0.6);
    expect(get(a, 'material')).toEqual([]);                                        // 세 문장 뒤
    const direct = get(one('하우징의 체결 토크는 0.6 N·m 이다.', '하우징'), 'torque')[0]!;
    expect(get(a, 'torque')[0]!.confidence).toBeLessThan(direct.confidence);
  });

  it('이웃 문장이 다른 부품(함께 주어진 이름) 이야기면 그 값은 쓰지 않는다', () => {
    const t = '하우징은 알루미늄이다.\n서보 모터의 정격은 48V 이다.';
    const [housing, motor] = extractSpecAttributes(t, ['하우징', '서보 모터']);
    expect(get(housing!.attributes, 'ratedVoltage')).toEqual([]);
    expect(get(motor!.attributes, 'ratedVoltage')[0]!.value).toBe(48);
    // 다른 부품 이름을 모르면 이웃 문장을 구분할 수 없어 낮은 신뢰도로 후보에 오른다
    expect(get(one(t, '하우징'), 'ratedVoltage')[0]!.confidence).toBeLessThan(0.5);
  });
});

describe('extractSpecAttributes: 충돌과 중복', () => {
  it('같은 속성에 다른 값이 있으면 둘 다 후보로 두고 신뢰도를 낮춘다', () => {
    const t = '기판 나사 체결 토크는 0.6 N·m 이다.\n개정 전 기판 나사 체결 토크는 0.8 N·m 였다.';
    const torque = get(one(t, '기판 나사'), 'torque');
    expect(torque.map(a => a.value).sort()).toEqual([0.6, 0.8]);
    const single = get(one('기판 나사 체결 토크는 0.6 N·m 이다.', '기판 나사'), 'torque')[0]!;
    expect(torque.every(a => a.confidence < single.confidence)).toBe(true);
    expect(torque.every(a => a.evidence.includes('다른 값이 있어 확인이 필요함'))).toBe(true);
  });

  it('같은 값이 여러 구절에 있으면 하나만 둔다 (가장 가까운 구절)', () => {
    const t = '기판 나사 체결 토크는 0.6 N·m 이다.\n요약: 토크 0.6 N·m.\n기판 나사는 별도 포장한다.';
    const torque = get(one(t, '기판 나사'), 'torque');
    expect(torque).toHaveLength(1);
    expect(torque[0]!.evidence).toBe('기판 나사 체결 토크는 0.6 N·m 이다.');
  });

  it('영어 사양서도 읽는다', () => {
    const a = one('The Bolt M8 tightening torque is 25 N·m. Material: SUS304.', 'Bolt M8');
    expect(get(a, 'torque')[0]!.value).toBe(25);
    expect(get(a, 'material')[0]!.value).toBe('SUS304');
  });
});

describe('snippet', () => {
  it('짧으면 그대로, 길면 값 주변 120자만 남긴다', () => {
    expect(snippet('짧다', 0)).toBe('짧다');
    const long = `${'가'.repeat(150)} 0.6 N·m ${'나'.repeat(150)}`;
    const s = snippet(long, 151);
    expect(s.replace(/…/g, '').length).toBeLessThanOrEqual(120);
    expect(s).toContain('0.6 N·m');
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true);
  });
});
