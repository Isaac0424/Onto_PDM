// 실제 STEP(HCR 로봇 4종)로 분류기를 돌려 보고 찾은 현상들의 회귀 시험. 제조사 메시는 저장소에 없고, 현상만 합성 형상으로 재현한다 (docs/fastener-classification.md '실제 STEP 검증').
//  1) 몸통을 나사산의 골지름으로 그린 모델 (3A · 5A 의 커버 볼트: M4 볼트의 몸통이 3.14 mm)
//  2) 같은 볼트 여러 개가 한 부품으로 합쳐진 모델 (12A: 'BOLT-M4X25' 한 부품에 3개)
//  3) 몸통 없이 머리만 있는 볼트 (12A 'BOLT-M4' 23개)
//  4) 머리와 나사 끝 사이가 비어 있는 볼트 (3A · 5A 커버 볼트)
//  5) 큰 부품이 볼트로 읽히는 오탐 (커넥터 · 팔 · 마운트)
import { describe, expect, it } from 'vitest';
import { classifyFastener, type FastenerResult } from './fastener';
import { fastenerAttributes } from './fastener.attributes';
import {
  BOLT_DIMS, boltMesh, gapBoltMesh, headOnlyMesh, loft, mergeMeshes, minorDiameter, nutMesh, plateMesh, randomRotation, transform, washerMesh,
  type BoltKind, type BoltSize, type HeadOnlyKind,
} from './fastener.fixtures';

const top = (r: FastenerResult | null) => r?.candidates[0];
const attr = (r: FastenerResult, key: string) => fastenerAttributes(r).find(a => a.key === key);

describe('몸통을 골지름으로 그린 모델 (외관 나사산)', () => {
  const cases: [BoltKind, BoltSize, string][] = [
    ['socket', 'M3', 'SocketHeadBolt'], ['socket', 'M4', 'SocketHeadBolt'], ['socket', 'M5', 'SocketHeadBolt'], ['socket', 'M6', 'SocketHeadBolt'], ['socket', 'M8', 'SocketHeadBolt'],
    ['hex', 'M4', 'HexBolt'], ['hex', 'M6', 'HexBolt'], ['hex', 'M8', 'HexBolt'],
    ['button', 'M4', 'ButtonHeadBolt'], ['button', 'M6', 'ButtonHeadBolt'],
    ['countersunk', 'M6', 'CountersunkHeadBolt'],
  ];

  it.each(cases)('%s %s: 잰 지름이 골지름이어도 머리 치수가 맞는 호칭으로 읽는다 (M4 = 3.14 mm 를 M3 로 읽지 않는다)', (kind, size, classCode) => {
    const D = BOLT_DIMS[kind][size].d;
    const r = classifyFastener(boltMesh(kind, size, 20, { shaftDiameter: minorDiameter(size) }))!;
    expect(top(r)?.classCode).toBe(classCode);
    expect(top(r)!.score).toBeGreaterThan(0.85);                                    // 비율이 호칭 기준으로 맞으니 점수가 낮지 않다
    expect(r.geometry.nominalDiameter).toBe(D);
    expect(r.geometry.diameterBasis).toBe('minor');
    expect(Math.abs(r.geometry.threadDiameter - minorDiameter(size))).toBeLessThan(0.05);   // 잰 몸통 지름은 골지름 그대로
    expect(attr(r, 'threadSize')?.value).toBe(`M${D}`);
    expect(attr(r, 'threadSize')?.evidence).toContain('골지름');
  });

  it('호칭 지름으로 그린 모델은 그대로 호칭이다 (M4 몸통 4.0 mm 를 M5 골지름 4.02 mm 로 읽지 않는다)', () => {
    for (const [kind, size] of [['socket', 'M4'], ['hex', 'M4'], ['socket', 'M8'], ['socket', 'M5'], ['socket', 'M3']] as const) {
      const r = classifyFastener(boltMesh(kind, size, 20))!;
      expect(r.geometry.nominalDiameter, `${kind} ${size}`).toBe(BOLT_DIMS[kind][size].d);
      expect(r.geometry.diameterBasis, `${kind} ${size}`).toBe('nominal');
    }
  });

  it('골지름 몸통도 임의 방향 · 위치에서 같은 결과다', () => {
    const base = classifyFastener(boltMesh('socket', 'M4', 12, { shaftDiameter: minorDiameter('M4') }))!;
    const r = classifyFastener(transform(boltMesh('socket', 'M4', 12, { shaftDiameter: minorDiameter('M4') }), { rotation: randomRotation(5), translate: [30, -20, 170] }))!;
    expect(top(r)?.classCode).toBe(top(base)?.classCode);
    expect(r.geometry.nominalDiameter).toBe(4);
  });
});

describe('한 부품 안에 볼트 여러 개가 합쳐진 모델', () => {
  const bolt = (i: number, kind: BoltKind = 'socket', size: BoltSize = 'M4', len = 25) =>
    transform(boltMesh(kind, size, len), { rotation: randomRotation(20 + i), translate: [40 * i, 15 * (i % 2), 5 * i] });

  it('같은 볼트 3개가 한 부품이면 하나의 형상으로 읽고 몇 개인지 알려 준다 (한 부품 전체로는 볼트로 읽히지 않는다)', () => {
    const merged = mergeMeshes(bolt(0), bolt(1), bolt(2));
    const r = classifyFastener(merged)!;
    expect(r).not.toBeNull();
    expect(top(r)?.classCode).toBe('SocketHeadBolt');
    expect(r.bodies).toBe(3);
    expect(r.geometry.nominalDiameter).toBe(4);
    expect(Math.abs(r.geometry.underHeadLength - 25)).toBeLessThan(0.3);
    expect(top(r)!.evidence.join(' ')).toContain('볼트 3개');
  });

  it('볼트 하나 · 서로 겹치지 않는 판 둘이 한 부품이면 볼트 한 개로 센다 (볼트가 아닌 덩어리는 세지 않는다)', () => {
    const merged = mergeMeshes(bolt(0), transform(plateMesh(40, 20, 3), { translate: [200, 0, 0] }), transform(plateMesh(30, 30, 3), { translate: [-200, 0, 0] }));
    const r = classifyFastener(merged)!;
    expect(r.bodies).toBe(1);
    expect(top(r)?.classCode).toBe('SocketHeadBolt');
  });

  it('볼트가 하나도 없는 여러 덩어리는 null 이다', () => {
    expect(classifyFastener(mergeMeshes(plateMesh(40, 20, 3), transform(plateMesh(30, 30, 3), { translate: [100, 0, 0] })))).toBeNull();
  });

  it('종류가 섞이면 가장 많은 종류의 형상을 대표로 삼고 근거에 적는다', () => {
    const merged = mergeMeshes(bolt(0), bolt(1), bolt(2, 'hex', 'M6', 30));
    const r = classifyFastener(merged)!;
    expect(top(r)?.classCode).toBe('SocketHeadBolt');
    expect(r.bodies).toBe(3);
    expect(top(r)!.evidence.join(' ')).toContain('가장 많은 종류(2개)');
  });

  it('한 덩어리 볼트는 bodies 가 1 이고 근거에 개수 문구가 없다', () => {
    const r = classifyFastener(boltMesh('socket', 'M6', 25))!;
    expect(r.bodies).toBe(1);
    expect(top(r)!.evidence.join(' ')).not.toContain('한 부품 안에');
  });

  it('삼각형이 너무 많은 부품은 나누지 않는다 (볼트 묶음이 아니라 큰 부품이다)', () => {
    const many = mergeMeshes(...Array.from({ length: 30 }, (_, i) => transform(boltMesh('socket', 'M4', 25, { N: 140 }), { translate: [20 * i, 0, 0] })));
    expect(many.indices.length / 3).toBeGreaterThan(12000);
    expect(classifyFastener(many)).toBeNull();
  });
});

describe('몸통 없이 머리만 모델링된 볼트', () => {
  const kinds: HeadOnlyKind[] = ['socket', 'button', 'countersunk'];

  it.each(['M3', 'M4', 'M5', 'M6', 'M8'] as BoltSize[])('소켓 머리 %s: 머리 치수로 호칭을 짐작하고, 길이는 알 수 없다고 하며 신뢰도를 낮춘다', size => {
    const r = classifyFastener(headOnlyMesh('socket', size))!;
    expect(r).not.toBeNull();
    expect(r.headOnly).toBe(true);
    expect(top(r)?.classCode).toBe('SocketHeadBolt');
    expect(r.geometry.nominalDiameter).toBe(BOLT_DIMS.socket[size].d);
    expect(r.geometry.diameterBasis).toBe('head');
    expect(r.driveType).toBe('HexSocket');
    expect(r.confidence).toBeLessThanOrEqual(0.7);
    expect(top(r)!.evidence.join(' ')).toContain('머리만 보임');
    const attrs = fastenerAttributes(r);
    expect(attrs.find(a => a.key === 'length')).toBeUndefined();                    // 길이를 만들지 않는다
    expect(attrs.find(a => a.key === 'threadSize')).toMatchObject({ value: `M${BOLT_DIMS.socket[size].d}`, estimated: true });
    expect(attrs.find(a => a.key === 'threadSize')!.confidence).toBeLessThanOrEqual(0.5);
    expect(attrs.find(a => a.key === 'threadSize')!.evidence).toContain('머리 치수');
  });

  it('임의 방향으로 놓아도 같다', () => {
    const r = classifyFastener(transform(headOnlyMesh('socket', 'M4'), { rotation: randomRotation(9), translate: [50, 20, -30] }))!;
    expect(r.headOnly).toBe(true);
    expect(top(r)?.classCode).toBe('SocketHeadBolt');
    expect(r.geometry.nominalDiameter).toBe(4);
  });

  it('버튼(돔) 머리도 머리 윤곽으로 읽는다. 머리만 있는 접시머리(원뿔)는 옆면이 곧지 않아 지원하지 않는다', () => {
    const r = classifyFastener(headOnlyMesh('button', 'M6'));
    expect(r).not.toBeNull();
    expect(r!.headOnly).toBe(true);
    expect(top(r)?.classCode).toBe('ButtonHeadBolt');
    expect(top(r)?.proposed).toBe(true);
    expect(kinds).toContain('countersunk');                                         // 생성기는 있으나 분류는 하지 않는다(한계)
  });

  it('여러 개가 한 부품으로 합쳐진 머리만 모델도 센다', () => {
    const merged = mergeMeshes(headOnlyMesh('socket', 'M4'), transform(headOnlyMesh('socket', 'M4'), { translate: [30, 0, 0] }), transform(headOnlyMesh('socket', 'M4'), { translate: [0, 30, 0] }));
    const r = classifyFastener(merged)!;
    expect(r.headOnly).toBe(true);
    expect(r.bodies).toBe(3);
  });

  it('구멍이 없는 원통(단추 · 판)은 볼트가 아니다', () => {
    expect(classifyFastener(headOnlyMesh('socket', 'M4', { recess: false }))).toBeNull();
  });

  it('관통 구멍이 있는 것(너트 · 와셔 · 고리)은 볼트 머리가 아니다', () => {
    expect(classifyFastener(nutMesh(7, 4, 3))).toBeNull();
    expect(classifyFastener(washerMesh(7, 3, 4))).toBeNull();
    expect(classifyFastener(loft([{ z: 4, rho: 1.5 }, { z: 4, rho: 3.5 }, { z: 0, rho: 3.5 }, { z: 0, rho: 1.5 }], 72, true))).toBeNull();
  });

  it('큰 부품(마운트 · 하우징)이 머리 모양처럼 보여도 볼트가 아니다: 짐작한 호칭이 너무 크다', () => {
    // 소켓 머리 M8 을 9배로 키운 것: 지름 117 mm · 높이 72 mm · 구멍 54 mm
    const r = classifyFastener(transform(headOnlyMesh('socket', 'M8'), { scale: 9 }));
    expect(r).toBeNull();
  });

  it('몸통이 있는 볼트는 headOnly 가 아니다', () => {
    expect(classifyFastener(boltMesh('socket', 'M4', 25))!.headOnly).toBeUndefined();
  });
});

describe('머리와 나사 끝 사이가 비어 있는 볼트', () => {
  it('머리 + 나사 끝(골지름)만 있어도 전체를 하나의 볼트로 읽는다: 호칭은 머리 치수와 맞는 M4, 길이는 머리 아래 전체', () => {
    const r = classifyFastener(gapBoltMesh('M4'))!;                                 // 나사 끝 5 + 빈 7 + 머리 4 = 전체 16
    expect(r).not.toBeNull();
    expect(top(r)?.classCode).toBe('SocketHeadBolt');
    expect(r.bodies).toBe(1);
    expect(r.geometry.nominalDiameter).toBe(4);
    expect(r.geometry.diameterBasis).toBe('minor');
    expect(Math.abs(r.geometry.overallLength - 16)).toBeLessThan(0.1);
    expect(Math.abs(r.geometry.underHeadLength - 12)).toBeLessThan(0.1);
    expect(attr(r, 'threadSize')?.value).toBe('M4');
  });
});

describe('큰 부품이 볼트로 읽히는 오탐 막기', () => {
  it('머리 모양을 정하지 못한 채 머리 윤곽 · 단면이 어느 클래스와도 안 맞으면(플랜지 달린 원통 · 커넥터) 볼트가 아니다', () => {
    // 실제 12A 커넥터: 몸통 33.6 mm · 길이 20 mm · 그 위에 지름 50 mm 플랜지 판(윤곽 점수: 플랜지 1, 육각 0)
    const connector = loft([
      { z: 0, rho: 0 }, { z: 0, rho: 16.8 }, { z: 20, rho: 16.8 }, { z: 20, rho: 25 }, { z: 24, rho: 25 }, { z: 24, rho: 20 }, { z: 36, rho: 20 }, { z: 36, rho: 0 },
    ], 72);
    expect(classifyFastener(connector)).toBeNull();
  });

  it('단위가 mm 로 분명한 파일에서 몸통이 52 mm 를 넘으면 볼트가 아니다 (팔 · 하우징). 단위가 없는 파일은 크기를 믿지 않는다', () => {
    const big = boltMesh('socket', 'M8', 80);
    const scaled = (k: number) => ({ ...transform(big, { scale: k }) });
    expect(classifyFastener({ ...scaled(7), unit: 'mm' })).toBeNull();               // 몸통 56 mm
    expect(classifyFastener({ ...scaled(5), unit: 'mm' })).not.toBeNull();           // 몸통 40 mm (M42 에 가까운 큰 볼트까지는 허용)
    expect(classifyFastener(scaled(7))).not.toBeNull();                              // 단위 없음: 크기와 상관없이 형상으로만 본다
  });

  it('머리 모양을 정하지 못해도 머리 윤곽이 볼트 같으면(팬 · 치즈 머리, 단순화한 모델) 나사 규격 · 길이 후보는 남긴다', () => {
    const r = classifyFastener(boltMesh('button', 'M6', 20, { drive: 'none', headHeight: 4.2, headDiameter: 11 }))!;   // 높이/d 0.7: 버튼보다 높고 소켓보다 낮다
    expect(r).not.toBeNull();
    expect(attr(r, 'threadSize')?.value).toBe('M6');
    expect(attr(r, 'length')).toMatchObject({ value: 20 });
  });
});

describe('속성 후보 변환: 호칭 · 길이', () => {
  it('골지름 몸통이어도 길이는 머리 아래 길이이고 호칭은 머리와 맞는 M4 다', () => {
    const r = classifyFastener(boltMesh('socket', 'M4', 12, { shaftDiameter: minorDiameter('M4') }))!;
    expect(attr(r, 'threadSize')).toMatchObject({ value: 'M4', estimated: true });
    expect(attr(r, 'threadSize')!.confidence).toBeLessThan(0.75);                    // 호칭을 직접 잰 것보다 신뢰도를 낮춘다
    expect(attr(r, 'length')).toMatchObject({ value: 12, unit: 'mm' });
    expect(attr(r, 'socketSize')).toMatchObject({ value: 3 });
  });
});

describe('길이 후보는 규격 길이(정수 · 0.5 mm)에 맞춘다', () => {
  it('실제 STEP 처럼 15 mm 볼트가 14.95 로 잰다: 14.9 가 아니라 15 로 올리고 근거에 잰 값을 남긴다 (이름의 "15"와 충돌로 보이지 않게)', () => {
    const r = classifyFastener(boltMesh('socket', 'M4', 14.95))!;
    expect(attr(r, 'length')).toMatchObject({ value: 15, unit: 'mm' });
    expect(attr(r, 'length')!.evidence).toContain('규격 길이 15');
  });

  it('규격 길이에 가깝지 않은 값은 그대로(1자리) 둔다', () => {
    expect(attr(classifyFastener(boltMesh('socket', 'M4', 14.7))!, 'length')?.value).toBe(14.7);
    expect(attr(classifyFastener(boltMesh('socket', 'M6', 25.5))!, 'length')?.value).toBe(25.5);
  });
});
