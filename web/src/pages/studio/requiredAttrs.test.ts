import { describe, expect, it } from 'vitest';
import type { OpmsClassSpec, OpmsPropertyRule } from '../../api/types';
import type { ExtractedAttribute } from '../../extract';
import { checkRequired, emptyLabels, NOT_FROM_CAD_NOTE, summaryText, type RequiredItem } from './requiredAttrs';

// 실제 OPMS 0.15.0 의 SocketHeadBolt 필수 속성과 같은 모양의 규칙(가짜 데이터가 아니라 분류 규칙이다): 필수 8개, 길이 ≥3, 육각구멍 ≥1.5,
// 나사 방향은 원문에 없으면 오른나사, 피치는 나사 규격별 보통 나사 값(값 표)으로 OPMS 가 채운다.
const rule = (key: string, label: string, datatype: string, extra: Partial<OpmsPropertyRule> = {}): OpmsPropertyRule => ({ key, label, datatype, required: true, ...extra });
const SOCKET: OpmsClassSpec = {
  code: 'SocketHeadBolt', label: '육각구멍붙이볼트',
  properties: [
    rule('threadSize', '나사 규격', 'string'),
    rule('length', '길이', 'decimal', { unit: 'mm', min: 3 }),
    rule('material', '재질', 'concept'),
    rule('surfaceTreatment', '표면처리', 'concept'),
    rule('pitch', '피치', 'decimal', { unit: 'mm', lookupDefault: { key: 'threadSize', seriesLabel: '보통 나사', values: { M3: [0.5], M4: [0.7], M8: [1.25] } } }),
    rule('threadDirection', '나사 방향', 'concept', { omittedDefault: { code: 'RightHand', label: '오른나사' } }),
    rule('strengthGrade', '강도 등급', 'string'),
    rule('socketSize', '육각구멍 크기', 'decimal', { unit: 'mm', min: 1.5 }),
    rule('widthAcrossFlats', '이면폭', 'decimal', { unit: 'mm', required: false }),                 // 필수가 아니면 세지 않는다
  ],
};

const cand = (key: string, value: string | number, unit?: string, confidence = 0.8): ExtractedAttribute => ({
  key, label: key, value, ...(unit ? { unit } : {}), source: 'cad', evidence: `${key} 근거`, confidence, estimated: true,
});
const by = (items: RequiredItem[], key: string) => items.find(i => i.key === key)!;

describe('OPMS 필수 속성 체크리스트', () => {
  it('필수 속성만 세고(8개), CAD 에서 아무것도 못 읽었으면 관례로 채워지는 것(나사 방향)만 확인으로 센다', () => {
    const v = checkRequired({ spec: SOCKET, confirmed: {}, candidates: [] });
    expect(v.total).toBe(8);
    expect(v.items.map(i => i.key)).not.toContain('widthAcrossFlats');
    expect(by(v.items, 'threadDirection')).toMatchObject({ state: 'convention', valueText: '오른나사' });
    expect(v).toMatchObject({ known: 1, estimated: 0, empty: 7 });
  });

  it('상태 4가지: 확정 · CAD 추정 · OPMS가 채움(관례) · 비어 있음', () => {
    const v = checkRequired({
      spec: SOCKET,
      confirmed: { threadSize: 'M4', length: 15 },
      candidates: [cand('socketSize', 3, 'mm', 0.7), cand('length', 14.95, 'mm'), cand('threadSize', 'M4')],
    });
    expect(by(v.items, 'threadSize')).toMatchObject({ state: 'confirmed', valueText: 'M4' });
    expect(by(v.items, 'length')).toMatchObject({ state: 'confirmed', valueText: '15 mm' });          // 확정이 추정(14.95)보다 우선
    expect(by(v.items, 'socketSize')).toMatchObject({ state: 'estimated', valueText: '3 mm', confidence: 0.7, evidence: 'socketSize 근거' });
    expect(by(v.items, 'pitch')).toMatchObject({ state: 'convention', valueText: '0.7 mm' });
    expect(by(v.items, 'threadDirection')).toMatchObject({ state: 'convention', valueText: '오른나사' });
    expect(['material', 'surfaceTreatment', 'strengthGrade'].map(k => by(v.items, k).state)).toEqual(['empty', 'empty', 'empty']);
    expect(v).toMatchObject({ total: 8, known: 4, estimated: 1, empty: 3, warnings: 0 });
    expect(summaryText(v)).toBe('확인 4/8 · 추정 1개 · 미확인 3개(재질, 표면처리, 강도 등급)');
    expect(emptyLabels(v)).toEqual(['재질', '표면처리', '강도 등급']);
  });

  it('CAD 로 알 수 없는 속성(재질 · 표면처리 · 강도 등급)은 어디서 채우는지 안내하고, 읽을 수 있는데 못 읽은 것은 다르게 말한다', () => {
    const v = checkRequired({ spec: SOCKET, confirmed: {}, candidates: [] });
    expect(by(v.items, 'material').note).toBe(NOT_FROM_CAD_NOTE);
    expect(by(v.items, 'material').note).toContain('등록 요청 때 OPMS 검토 화면에서 채워요');
    expect(by(v.items, 'strengthGrade').note).toBe(NOT_FROM_CAD_NOTE);
    expect(by(v.items, 'length').note).toBe('CAD에서 읽지 못했어요. 등록 요청 때 OPMS 검토 화면에서 채워요.');
  });

  it('피치는 나사 규격이 정해져야 OPMS 가 보통 나사 값으로 채운다: 규격을 모르면 비어 있음, 추정 규격이면 다시 확인하라고 알린다', () => {
    const none = by(checkRequired({ spec: SOCKET, confirmed: {}, candidates: [] }).items, 'pitch');
    expect(none).toMatchObject({ state: 'empty' });
    expect(none.note).toContain('나사 규격이 정해지면 보통 나사 값으로 OPMS가 채워요');

    const est = by(checkRequired({ spec: SOCKET, confirmed: {}, candidates: [cand('threadSize', 'M8')] }).items, 'pitch');
    expect(est).toMatchObject({ state: 'convention', valueText: '1.25 mm' });
    expect(est.note).toContain('추정이라 다시 확인해요');

    const sure = by(checkRequired({ spec: SOCKET, confirmed: { threadSize: 'M8' }, candidates: [] }).items, 'pitch');
    expect(sure.note).not.toContain('추정');
    const off = by(checkRequired({ spec: SOCKET, confirmed: { threadSize: 'M30' }, candidates: [] }).items, 'pitch');   // 표에 없는 규격
    expect(off.state).toBe('empty');
    expect(off.note).toContain('M30');
  });

  it('값 범위(OPMS min · max)에 걸리면 경고한다: 추정이면 "추정이라 다시 확인", 확정이면 그냥 알린다 (오류가 아니라 확인 필요)', () => {
    const v = checkRequired({ spec: SOCKET, confirmed: { socketSize: 1 }, candidates: [cand('length', 2.5, 'mm')] });
    expect(by(v.items, 'length')).toMatchObject({ state: 'estimated', warn: 'OPMS 기준(≥3 mm)보다 작아요 · 추정이라 다시 확인해요' });
    expect(by(v.items, 'socketSize')).toMatchObject({ state: 'confirmed', warn: 'OPMS 기준(≥1.5 mm)보다 작아요' });
    expect(v.warnings).toBe(2);
    const ok = checkRequired({ spec: SOCKET, confirmed: { length: 3 }, candidates: [] });                  // 경계값(=min)은 통과
    expect(by(ok.items, 'length').warn).toBeUndefined();
  });

  it('최댓값(max)도 본다', () => {
    const spec: OpmsClassSpec = { code: 'X', label: 'X', properties: [rule('length', '길이', 'decimal', { unit: 'mm', max: 300 })] };
    expect(by(checkRequired({ spec, confirmed: { length: 301 }, candidates: [] }).items, 'length').warn).toBe('OPMS 기준(≤300 mm)보다 커요');
  });

  it('분류가 값을 정해 둔 속성(고정 값)은 비어 있다고 세지 않는다', () => {
    const spec: OpmsClassSpec = { code: 'X', label: 'X', properties: [rule('headType', '머리 모양', 'concept', { fixed: 'Socket' })] };
    const v = checkRequired({ spec, confirmed: {}, candidates: [] });
    expect(by(v.items, 'headType')).toMatchObject({ state: 'convention', valueText: 'Socket' });
    expect(v.empty).toBe(0);
  });

  it('같은 키의 후보가 여럿이면 신뢰도가 높은 것을 쓴다', () => {
    const v = checkRequired({ spec: SOCKET, confirmed: {}, candidates: [cand('length', 10, 'mm', 0.4), cand('length', 15, 'mm', 0.9)] });
    expect(by(v.items, 'length').valueText).toBe('15 mm');
  });

  it('OPMS 에 없는 제안 분류는 상위 분류 기준이라고 밝힌다', () => {
    const v = checkRequired({ spec: SOCKET, confirmed: {}, candidates: [], proposedLabel: '버튼헤드볼트' });
    expect(v.basis).toEqual({ proposedLabel: '버튼헤드볼트' });
    expect(checkRequired({ spec: SOCKET, confirmed: {}, candidates: [] }).basis).toBeUndefined();
  });

  it('추정 값이 어디서 왔는지 말한다: 같은 신뢰도면 CAD 형상이 부품 이름보다 먼저, 이름에서만 읽었으면 그렇게 안내한다', () => {
    const fromName: ExtractedAttribute = { ...cand('threadSize', 'M4', undefined, 0.8), source: 'name', evidence: '이름의 M4' };
    const both = checkRequired({ spec: SOCKET, confirmed: {}, candidates: [fromName, cand('threadSize', 'M4')] });
    expect(by(both.items, 'threadSize')).toMatchObject({ state: 'estimated', source: 'cad' });
    const nameOnly = by(checkRequired({ spec: SOCKET, confirmed: {}, candidates: [fromName] }).items, 'threadSize');
    expect(nameOnly).toMatchObject({ state: 'estimated', source: 'name' });
    expect(nameOnly.note).toContain('부품 이름에서 추정한 값이에요');
  });

  it('목록은 확정 → 추정 → OPMS가 채움 → 미확인 순으로 정렬돼 비어 있는 것이 아래에 모인다(같은 상태 안에서는 OPMS 순서)', () => {
    const v = checkRequired({ spec: SOCKET, confirmed: { length: 15 }, candidates: [cand('threadSize', 'M4'), cand('socketSize', 3)] });
    expect(v.items.map(i => i.key)).toEqual(['length', 'threadSize', 'socketSize', 'pitch', 'threadDirection', 'material', 'surfaceTreatment', 'strengthGrade']);
    expect(v.items.map(i => i.state)).toEqual(['confirmed', 'estimated', 'estimated', 'convention', 'convention', 'empty', 'empty', 'empty']);
  });

  it('필수 속성이 없는 분류도 안전하다', () => {
    const v = checkRequired({ spec: { code: 'X', label: 'X', properties: [] }, confirmed: {}, candidates: [] });
    expect(v).toMatchObject({ total: 0, known: 0, estimated: 0, empty: 0 });
    expect(summaryText(v)).toBe('확인 0/0');
  });
});
