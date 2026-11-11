import { describe, expect, it } from 'vitest';
import { classifyFastener, type FastenerResult } from './fastener';
import { FASTENER_CONFIG } from './fastener.config';
import { estimateFastener } from './fastener.estimate';
import { boltMesh, nutMesh, plateMesh } from './fastener.fixtures';

// 확정 전에도 형상 분석이 만든 규격(추정)으로 보유 품번을 찾을 수 있는가: 충분히 확실한 볼트만 추정 값을 내놓는다.
const of = (r: FastenerResult | null) => estimateFastener(r);

describe('추정 규격 (estimateFastener)', () => {
  it('충분히 확실한 볼트는 클래스 · 머리 모양 · 나사 규격 · 길이를 내놓는다', () => {
    expect(of(classifyFastener(boltMesh('socket', 'M6', 25)))).toMatchObject({
      classCode: 'SocketHeadBolt', headType: 'Socket', proposed: false, threadSize: 'M6', length: 25, unitAssumed: false,
    });
    expect(of(classifyFastener(boltMesh('hex', 'M8', 30)))).toMatchObject({ classCode: 'HexBolt', headType: 'Hex', threadSize: 'M8', length: 30 });
  });

  it('OPMS 에 아직 없는 분류(버튼 · 접시)는 proposed 로 표시한다 (매칭은 클래스 없이 머리 모양으로만 한다)', () => {
    expect(of(classifyFastener(boltMesh('button', 'M4', 8)))).toMatchObject({ classCode: 'ButtonHeadBolt', headType: 'Button', proposed: true, threadSize: 'M4', length: 8 });
    expect(of(classifyFastener(boltMesh('countersunk', 'M4', 8)))).toMatchObject({ classCode: 'CountersunkHeadBolt', headType: 'Countersunk', proposed: true });
  });

  it('볼트가 아닌 것(판 · 너트)은 추정이 없다', () => {
    expect(of(classifyFastener(plateMesh(60, 30, 4)))).toBeUndefined();
    expect(of(classifyFastener(nutMesh(10, 5, 6)))).toBeUndefined();
    expect(of(null)).toBeUndefined();
  });

  it('구동부 구멍을 뺀 단순화 모델(ambiguous)은 추정하지 않는다: 종류를 단정할 수 없다', () => {
    const r = classifyFastener(boltMesh('socket', 'M6', 20, { drive: 'none' }))!;
    expect(r.ambiguous).toBe(true);
    expect(of(r)).toBeUndefined();
  });

  it('1위 점수가 문턱(autoMatch.minScore) 미만이면 추정하지 않는다', () => {
    const r = classifyFastener(boltMesh('socket', 'M6', 25))!;
    const weak: FastenerResult = { ...r, candidates: r.candidates.map((c, i) => (i === 0 ? { ...c, score: FASTENER_CONFIG.autoMatch.minScore - 0.01 } : c)) };
    expect(of(weak)).toBeUndefined();
    const edge: FastenerResult = { ...r, candidates: r.candidates.map((c, i) => (i === 0 ? { ...c, score: FASTENER_CONFIG.autoMatch.minScore } : c)) };
    expect(of(edge)).toBeDefined();
  });

  it('단위를 알 수 없거나 표준 호칭과 맞지 않는 지름은 규격으로 말하지 않는다', () => {
    const r = classifyFastener(boltMesh('socket', 'M6', 25))!;
    expect(of({ ...r, unit: { known: false, assumed: false } })).toBeUndefined();
    expect(of({ ...r, geometry: { ...r.geometry, nominalDiameter: undefined as unknown as number, threadDiameter: 6.9 } })).toBeUndefined();
  });

  it('머리만 있는 모델은 길이 없이 나사 규격만 내놓는다', () => {
    const r = classifyFastener(boltMesh('socket', 'M4', 15))!;
    const headOnly: FastenerResult = { ...r, headOnly: true };
    const e = of(headOnly);
    expect(e?.threadSize).toBe('M4');
    expect(e?.length).toBeUndefined();
  });

  it('파일에 단위가 없어 mm 로 가정한 값은 그렇게 표시한다 (OBJ · STL · GLB)', () => {
    const r = classifyFastener(boltMesh('socket', 'M6', 25))!;
    expect(of({ ...r, unit: { known: true, assumed: true } })?.unitAssumed).toBe(true);
  });
});
