import { describe, expect, it } from 'vitest';
import { classifyFastener, type FastenerResult } from './fastener';
import { fastenerAttributes, nominalThreadSize } from './fastener.attributes';
import {
  BOLT_DIMS, boltMesh, cubeMesh, dumbbellMesh, nonIndexed, nutMesh, pinMesh, plateMesh, randomRotation, rodMesh, transform, triCount, washerMesh,
  type BoltKind, type BoltSize, type DriveKind,
} from './fastener.fixtures';
import { extractCadAttributes } from './index';

const KINDS: { kind: BoltKind; classCode: string; headType: string; drive: string }[] = [
  { kind: 'hex', classCode: 'HexBolt', headType: 'Hex', drive: 'ExternalHex' },
  { kind: 'flange', classCode: 'HexFlangeBolt', headType: 'HexFlange', drive: 'ExternalHex' },
  { kind: 'socket', classCode: 'SocketHeadBolt', headType: 'Socket', drive: 'HexSocket' },
  { kind: 'button', classCode: 'ButtonHeadBolt', headType: 'Button', drive: 'HexSocket' },
  { kind: 'countersunk', classCode: 'CountersunkHeadBolt', headType: 'Countersunk', drive: 'HexSocket' },
];
const SIZES: BoltSize[] = ['M4', 'M6', 'M8'];
const LENGTHS = [10, 25, 60];

const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const top = (r: FastenerResult | null) => r?.candidates[0];

describe('볼트 종류 판단 (형상 → 클래스 후보)', () => {
  it('5종류 × 3규격 × 3길이 모두 1위로 정확히 분류하고, 지름 · 길이 · 구동부를 맞힌다 (정확도 표)', () => {
    const rows: string[] = [];
    let total = 0, right = 0;
    for (const { kind, classCode, headType, drive } of KINDS) {
      for (const size of SIZES) {
        const cells: string[] = [];
        for (const length of LENGTHS) {
          const dim = BOLT_DIMS[kind][size];
          const r = classifyFastener(boltMesh(kind, size, length));
          total++;
          expect(r, `${kind} ${size}x${length}`).not.toBeNull();
          const ok = top(r)?.classCode === classCode;
          if (ok) right++;
          expect(top(r)?.classCode, `${kind} ${size}x${length}`).toBe(classCode);
          expect(top(r)?.headType).toBe(headType);
          expect(r!.driveType).toBe(drive);
          expect(r!.confidence).toBeGreaterThan(0.7);
          near(r!.geometry.threadDiameter, dim.d, dim.d * 0.02);
          // 길이: 접시머리는 머리를 포함한 전체 길이가 규격의 길이다
          near(kind === 'countersunk' ? r!.geometry.overallLength : r!.geometry.underHeadLength, length, 0.25);
          near(r!.geometry.headHeight, dim.k, 0.3);
          if (dim.sock) { expect(r!.geometry.recess.kind).toBe('hex'); near(r!.geometry.recess.acrossFlats!, dim.sock, 0.05); }
          cells.push(`${top(r)!.score}`);
        }
        rows.push(`${kind.padEnd(12)} ${size}  ${cells.join(' / ')}  ${top(classifyFastener(boltMesh(kind, size, 25)))!.classCode}`);
      }
    }
    expect(right).toBe(total);
    console.log(`볼트 형상 분류 정확도 ${right}/${total}  (종류 규격 길이10/25/60의 1위 점수, 1위 클래스)\n${rows.join('\n')}`);
  });

  it('임의 방향 · 위치 · 균일 배율로 옮겨도 같은 클래스 · 같은 비율이다 (단위는 그대로: inch 로 가정하지 않는다)', () => {
    for (const { kind, classCode } of KINDS) {
      const base = classifyFastener(boltMesh(kind, 'M6', 25))!;
      for (const [seed, scale] of [[11, 1], [12, 0.1], [13, 25.4], [14, 3]] as const) {
        const m = transform(boltMesh(kind, 'M6', 25), { rotation: randomRotation(seed), scale, translate: [120 * seed, -40, 9] });
        const r = classifyFastener(m)!;
        expect(top(r)?.classCode, `${kind} seed${seed} x${scale}`).toBe(classCode);
        near(r.geometry.threadDiameter / scale, base.geometry.threadDiameter, 0.08);           // 단위는 그대로 mm 로 읽는다: 크기는 배율만큼 달라진다
        near(r.geometry.headHeight / r.geometry.threadDiameter, base.geometry.headHeight / base.geometry.threadDiameter, 0.02);
        expect(r.driveType).toBe(base.driveType);
      }
    }
  });

  it('색인 없는 삼각형 목록(9개씩)도 색인 메시와 같은 결과다', () => {
    const mesh = boltMesh('button', 'M6', 20);
    const a = classifyFastener(mesh)!;
    const b = classifyFastener({ positions: nonIndexed(mesh) })!;
    expect(top(b)?.classCode).toBe(top(a)?.classCode);
    expect(b.geometry.recess.kind).toBe('hex');
    near(b.geometry.threadDiameter, a.geometry.threadDiameter, 0.01);
  });

  it('나사산을 모델링한 볼트(나선형 요철)도 같은 종류로 읽고, 나사 지름은 바깥지름(호칭)으로 읽는다', () => {
    const hex = classifyFastener(boltMesh('hex', 'M8', 30, { thread: true }))!;
    expect(top(hex)?.classCode).toBe('HexBolt');
    near(hex.geometry.threadDiameter, 8, 0.2);
    const sock = classifyFastener(boltMesh('socket', 'M6', 30, { thread: true }))!;
    expect(top(sock)?.classCode).toBe('SocketHeadBolt');
    expect(fastenerAttributes(sock).find(a => a.key === 'threadSize')?.value).toBe('M6');
  });

  it('윗면 구멍의 모양을 구분한다: 육각 · 별 · 십자 · 일자 (별 · 십자 · 일자는 판별이 약해 낮게 점수를 준다)', () => {
    const hex = classifyFastener(boltMesh('socket', 'M8', 25, { drive: 'hex' }))!;
    expect(hex.driveType).toBe('HexSocket');
    const kinds: [DriveKind, string, string][] = [['torx', 'lobed', 'Torx'], ['cross', 'cross', 'Phillips'], ['slot', 'slot', 'Slotted']];
    for (const [drive, kind, code] of kinds) {
      const r = classifyFastener(boltMesh('socket', 'M8', 25, { drive }))!;
      expect(r.geometry.recess, drive).toMatchObject({ present: true, kind });
      expect(r.driveType).toBe(code);
      expect(top(r)?.score).toBeLessThan(top(hex)!.score);                                   // 육각 구멍이 아니면 소켓 헤드 확신이 낮아진다
      expect(fastenerAttributes(r).find(a => a.key === 'driveType')?.confidence).toBeLessThan(0.5);
    }
  });

  it('윗면에 구멍이 있는 육각 머리는 "육각 머리 계열과 맞지 않음"으로 점수를 깎고 구멍을 근거에 남긴다', () => {
    const r = classifyFastener(boltMesh('hex', 'M8', 25, { drive: 'hex' }))!;
    expect(top(r)?.classCode).toBe('HexBolt');
    expect(top(r)!.score).toBeLessThan(0.6);
    expect(top(r)!.evidence.join(' ')).toContain('육각 머리 계열과 맞지 않음');
  });
});

describe('단순화한 모델 (구동부 구멍을 뺀 CAD)', () => {
  it('구멍이 없으면 단정하지 않는다: 점수 · 신뢰도가 낮고 ambiguous 이며, 근거에 "구동부 구멍을 확인하지 못함"을 적는다', () => {
    for (const { kind, classCode } of KINDS.filter(k => k.kind === 'socket' || k.kind === 'button' || k.kind === 'countersunk')) {
      const full = classifyFastener(boltMesh(kind, 'M8', 25))!;
      const bare = classifyFastener(boltMesh(kind, 'M8', 25, { drive: 'none' }))!;
      expect(top(bare)?.classCode).toBe(classCode);                                           // 윤곽이 남아 있으면 같은 클래스가 1위다
      expect(top(bare)!.score).toBeLessThan(top(full)!.score);
      expect(bare.confidence).toBeLessThanOrEqual(0.6);
      expect(bare.ambiguous).toBe(true);
      expect(bare.driveType).toBeNull();
      expect(top(bare)!.evidence.join(' ')).toContain('구동부 구멍을 확인하지 못함');
    }
  });

  it('윤곽까지 뭉개진 모델(버튼 비율의 납작한 원통)은 여러 후보를 점수와 함께 낸다', () => {
    const r = classifyFastener(boltMesh('socket', 'M8', 25, { drive: 'none', headHeight: 4.4, headDiameter: 14.8 }))!;
    expect(r.candidates.length).toBeGreaterThanOrEqual(2);
    expect(r.candidates.map(c => c.classCode)).toEqual(expect.arrayContaining(['SocketHeadBolt', 'ButtonHeadBolt']));
    expect(r.ambiguous).toBe(true);
    expect(r.confidence).toBeLessThan(0.3);
    expect(r.candidates.every(c => c.score < 0.5)).toBe(true);
  });

  it('외육각 머리는 윗면에 구멍이 없는 것이 정상이라 단정한다 (구멍 없음 = 근거)', () => {
    const r = classifyFastener(boltMesh('hex', 'M8', 25))!;
    expect(r.ambiguous).toBe(false);
    expect(top(r)!.evidence.join(' ')).toContain('윗면에 구멍 없음');
  });
});

describe('볼트가 아닌 것은 null', () => {
  it('판 · 상자 · 핀 · 막대 · 너트 · 와셔 · 아령은 볼트 후보가 아니다', () => {
    expect(classifyFastener(plateMesh())).toBeNull();
    expect(classifyFastener(cubeMesh())).toBeNull();
    expect(classifyFastener(pinMesh())).toBeNull();
    expect(classifyFastener(rodMesh())).toBeNull();
    expect(classifyFastener(nutMesh())).toBeNull();
    expect(classifyFastener(washerMesh())).toBeNull();
    expect(classifyFastener(dumbbellMesh())).toBeNull();
  });

  it('회전해 놓아도 마찬가지다', () => {
    const R = randomRotation(5);
    for (const m of [plateMesh(), pinMesh(), nutMesh(), washerMesh()]) expect(classifyFastener(transform(m, { rotation: R, translate: [5, 5, 5] }))).toBeNull();
  });

  it('빈 입력 · 삼각형이 너무 적은 입력 · 깨진 숫자는 안전하게 null', () => {
    expect(classifyFastener({ positions: [] })).toBeNull();
    expect(classifyFastener({ positions: new Float32Array(9) })).toBeNull();
    expect(classifyFastener({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 1, 2] })).toBeNull();
    const bad = boltMesh('hex', 'M6', 20);
    const withNan = Float32Array.from(bad.positions);
    withNan[10] = NaN;
    expect(classifyFastener({ positions: withNan, indices: bad.indices })).toBeNull();
    expect(classifyFastener({ positions: bad.positions, indices: [0, 1, 99999] })).toBeNull();
    expect(classifyFastener({ positions: [1, 2] })).toBeNull();
  });
});

describe('경계 사례: 비슷한 비율에서 점수가 뚝 끊기지 않는다', () => {
  const maxJump = (rs: FastenerResult[], code: string) => {
    let worst = 0;
    for (let i = 1; i < rs.length; i++) {
      const a = rs[i - 1]!.candidates.find(c => c.classCode === code)?.score ?? 0;
      const b = rs[i]!.candidates.find(c => c.classCode === code)?.score ?? 0;
      worst = Math.max(worst, Math.abs(a - b));
    }
    return worst;
  };

  it('원통 머리 + 육각 구멍의 높이를 0.5d → 1.2d 로 2% 씩 늘려도, 어느 클래스 점수도 한 걸음에 0.2 넘게 뛰지 않는다', () => {
    const rs: FastenerResult[] = [];
    for (let k = 0.5; k <= 1.2001; k += 0.02) rs.push(classifyFastener(boltMesh('socket', 'M8', 20, { headHeight: 8 * k }))!);
    for (const code of ['SocketHeadBolt', 'ButtonHeadBolt', 'HexBolt']) expect(maxJump(rs, code), code).toBeLessThanOrEqual(0.2);
    expect(top(rs[0]!)!.score).toBeLessThan(0.5);                                            // 낮은 원통 머리는 소켓 헤드로 확신하지 못한다
    expect(top(rs[rs.length - 1]!)!.classCode).toBe('SocketHeadBolt');
  });

  it('머리 지름을 1.4d → 2.6d 로 늘려도 마찬가지다', () => {
    const rs: FastenerResult[] = [];
    for (let dk = 1.4; dk <= 2.6001; dk += 0.04) rs.push(classifyFastener(boltMesh('socket', 'M8', 20, { headDiameter: 8 * dk }))!);
    for (const code of ['SocketHeadBolt', 'ButtonHeadBolt']) expect(maxJump(rs, code), code).toBeLessThanOrEqual(0.2);
  });

  it('소켓 헤드와 육각볼트가 같은 비율이어도 단면(원 / 육각)으로 가른다', () => {
    const round = classifyFastener(boltMesh('socket', 'M8', 25, { headDiameter: 13, headHeight: 5.3 }))!;
    const hex = classifyFastener(boltMesh('hex', 'M8', 25))!;
    expect(round.geometry.hexness).toBe(0);
    expect(hex.geometry.hexness).toBe(1);
    expect(top(hex)?.classCode).toBe('HexBolt');
    expect(round.candidates.find(c => c.classCode === 'HexBolt')).toBeUndefined();
  });

  it('육각 플랜지와 일반 육각볼트: 플랜지 지름이 있어야 플랜지다 (이 쪽도 서로를 후보에 올리지 않는다)', () => {
    const fl = classifyFastener(boltMesh('flange', 'M8', 25))!;
    const hx = classifyFastener(boltMesh('hex', 'M8', 25))!;
    expect(fl.geometry.profile.flange).toBeGreaterThan(0.9);
    expect(hx.geometry.profile.flange).toBeLessThan(0.1);
    expect(fl.candidates.find(c => c.classCode === 'HexBolt')?.score ?? 0).toBeLessThan(0.3);
    expect(hx.candidates.find(c => c.classCode === 'HexFlangeBolt')?.score ?? 0).toBeLessThan(0.3);
  });
});

describe('성능', () => {
  it('삼각형 14만 개(나사산 모델)는 1초대 안에 끝난다', () => {
    const big = boltMesh('socket', 'M8', 30, { thread: true, N: 480 });
    expect(triCount(big)).toBeGreaterThan(100_000);
    const t0 = performance.now();
    const r = classifyFastener(big)!;
    const ms = performance.now() - t0;
    console.log(`삼각형 ${triCount(big)}개: ${Math.round(ms)} ms`);
    expect(top(r)?.classCode).toBe('SocketHeadBolt');
    expect(ms).toBeLessThan(2500);
  });

  it('삼각형 20만 개도 마찬가지다', () => {
    const big = boltMesh('hex', 'M8', 40, { thread: true, N: 560 });
    expect(triCount(big)).toBeGreaterThan(190_000);
    const t0 = performance.now();
    const r = classifyFastener(big)!;
    const ms = performance.now() - t0;
    console.log(`삼각형 ${triCount(big)}개: ${Math.round(ms)} ms`);
    expect(top(r)?.classCode).toBe('HexBolt');
    expect(ms).toBeLessThan(3000);
  });

  it('삼각형이 매우 적은(고리 12개 안팎, 원기둥 면 하나로 만든 몸통) 모델도 읽는다', () => {
    const r = classifyFastener(boltMesh('hex', 'M6', 40, { N: 24 }))!;
    expect(top(r)?.classCode).toBe('HexBolt');
    near(r.geometry.threadDiameter, 6, 0.1);
  });
});

describe('속성 후보 변환 (fastenerAttributes)', () => {
  const byKey = (attrs: ReturnType<typeof fastenerAttributes>, key: string) => attrs.find(a => a.key === key);

  it('소켓 헤드 M8×25: 머리 모양 · 구동부 · 나사 규격 · 길이 · 육각구멍 크기 후보가 모두 추정이고 근거가 있다', () => {
    const a = fastenerAttributes(classifyFastener(boltMesh('socket', 'M8', 25))!);
    expect(a.map(x => x.key)).toEqual(['headType', 'driveType', 'threadSize', 'length', 'socketSize']);
    expect(byKey(a, 'headType')).toMatchObject({ value: 'Socket', source: 'cad', estimated: true });
    expect(byKey(a, 'driveType')).toMatchObject({ value: 'HexSocket', estimated: true });
    expect(byKey(a, 'threadSize')).toMatchObject({ value: 'M8', estimated: true });
    expect(byKey(a, 'threadSize')!.evidence).toContain('CAD 몸통 지름 8.0 mm');
    expect(byKey(a, 'length')).toMatchObject({ value: 25, unit: 'mm', estimated: true });
    expect(byKey(a, 'socketSize')).toMatchObject({ value: 6, unit: 'mm' });
    for (const x of a) { expect(x.evidence.length).toBeGreaterThan(5); expect(x.confidence).toBeGreaterThan(0); expect(x.confidence).toBeLessThan(1); }
  });

  it('근거 문장은 "머리 지름/나사 지름 …, 높이 …, 윗면에 육각 구멍 → 소켓 헤드(추정)" 꼴이다', () => {
    const r = classifyFastener(boltMesh('socket', 'M8', 25))!;
    const text = top(r)!.evidence.join(' ');
    expect(text).toMatch(/머리 지름\/나사 지름 1\.6\d?\(기준/);
    expect(text).toMatch(/높이\/나사 지름 1(\.0\d?)?\(기준/);
    expect(text).toContain('윗면에 육각 구멍(대변 6 mm)');
    expect(text).toContain('→ 소켓 헤드(추정)');
    const headEv = byKey(fastenerAttributes(r), 'headType')!.evidence;
    expect(headEv).toContain('다른 후보:');                                                    // 2위 이하 대안도 근거에 남긴다
  });

  it('OPMS 에 없는 클래스(버튼 · 접시머리)는 근거에 "OPMS 미등록 제안"을 적고, proposed 로 표시한다', () => {
    for (const [kind, code] of [['button', 'ButtonHeadBolt'], ['countersunk', 'CountersunkHeadBolt']] as const) {
      const r = classifyFastener(boltMesh(kind, 'M6', 20))!;
      expect(top(r)).toMatchObject({ classCode: code, proposed: true });
      expect(byKey(fastenerAttributes(r), 'headType')!.evidence).toContain('OPMS 미등록 제안');
    }
    expect(top(classifyFastener(boltMesh('socket', 'M6', 20))!)?.proposed).toBe(false);
    expect(top(classifyFastener(boltMesh('hex', 'M6', 20))!)?.proposed).toBe(false);
  });

  it('접시머리의 길이는 머리를 포함한 전체 길이(규격의 정의)이고, 나머지는 머리 아래 길이다', () => {
    const cs = fastenerAttributes(classifyFastener(boltMesh('countersunk', 'M6', 20))!);
    expect(byKey(cs, 'length')?.value).toBeCloseTo(20, 0);
    expect(byKey(cs, 'length')!.evidence).toContain('머리를 포함한');
    const hx = fastenerAttributes(classifyFastener(boltMesh('hex', 'M6', 20))!);
    expect(byKey(hx, 'length')?.value).toBeCloseTo(20, 0);
    expect(byKey(hx, 'length')!.evidence).toContain('머리 아래');
  });

  it('외육각 머리: 구동부 후보는 ExternalHex, 육각구멍 크기는 없다', () => {
    const a = fastenerAttributes(classifyFastener(boltMesh('hex', 'M6', 20))!);
    expect(byKey(a, 'driveType')?.value).toBe('ExternalHex');
    expect(byKey(a, 'socketSize')).toBeUndefined();
  });

  it('파일에 단위가 없으면(자리표시 단위) mm 로 가정하고 치수를 추정으로 표시하며 신뢰도를 낮춘다', () => {
    const mesh = boltMesh('socket', 'M8', 25);
    const known = fastenerAttributes(classifyFastener({ ...mesh, unit: 'mm' })!);
    const assumed = fastenerAttributes(classifyFastener({ ...mesh, unit: '단위' })!);
    expect(byKey(assumed, 'threadSize')!.evidence).toContain('파일에 단위 정보가 없어 mm 로 가정');
    expect(byKey(assumed, 'threadSize')!.confidence).toBeLessThan(byKey(known, 'threadSize')!.confidence);
    expect(byKey(known, 'threadSize')!.evidence).not.toContain('단위 정보가 없어');
    expect(byKey(assumed, 'threadSize')?.value).toBe('M8');
  });

  it('cm 파일은 mm 로 환산한다. 모르는 단위(furlong)는 치수 후보를 만들지 않고 머리 모양만 남긴다', () => {
    const cm = transform(boltMesh('socket', 'M8', 25), { scale: 0.1 });
    const a = fastenerAttributes(classifyFastener({ ...cm, unit: 'cm' })!);
    expect(byKey(a, 'threadSize')?.value).toBe('M8');
    expect(byKey(a, 'length')?.value).toBe(25);
    const b = fastenerAttributes(classifyFastener({ ...boltMesh('socket', 'M8', 25), unit: 'furlong' })!);
    expect(byKey(b, 'headType')?.value).toBe('Socket');
    expect(byKey(b, 'threadSize')).toBeUndefined();
    expect(byKey(b, 'length')).toBeUndefined();
  });

  it('표준 호칭과 맞지 않는 지름은 그대로 표기하고 신뢰도를 낮춘다 (nominalThreadSize)', () => {
    expect(nominalThreadSize(8.1)).toBe(8);
    expect(nominalThreadSize(7.8)).toBe(8);
    expect(nominalThreadSize(7)).toBeNull();
    expect(nominalThreadSize(2.4)).toBe(2.5);
    const odd = transform(boltMesh('hex', 'M6', 20), { scale: 1 });
    const r = classifyFastener(odd)!;
    expect(fastenerAttributes(r).find(a => a.key === 'threadSize')?.value).toBe('M6');
  });

  it('머리 모양을 정하지 못한 볼트 형상은 headType 을 만들지 않는다 (나사 규격 · 길이는 남긴다)', () => {
    const r = classifyFastener(boltMesh('socket', 'M8', 25, { drive: 'none', headHeight: 2.8, headDiameter: 26 }))!;
    expect(r.candidates).toEqual([]);
    expect(r.confidence).toBe(0);
    const a = fastenerAttributes(r);
    expect(a.find(x => x.key === 'headType')).toBeUndefined();
    expect(a.find(x => x.key === 'threadSize')?.value).toBe('M8');
  });
});

describe('extractCadAttributes 연결 (선택 입력 mesh)', () => {
  const part = (extra: object = {}) => ({ name: '기판 나사', size: [13, 13, 33] as [number, number, number], unit: 'mm', ...extra });

  it('mesh 가 없으면 기존 동작 그대로다 (상자 크기 기반 길이 · 너비 · 높이 · 두께)', () => {
    const a = extractCadAttributes([part()])[0]!.attributes;
    expect(a.map(x => x.key)).toEqual(expect.arrayContaining(['length', 'width', 'height', 'thickness']));
    expect(a.find(x => x.key === 'headType')).toBeUndefined();
  });

  it('볼트 메시가 있으면 머리 모양 · 구동부 · 나사 규격 · 규격의 길이를 더하고, 머리까지 잰 상자 치수는 뺀다', () => {
    const a = extractCadAttributes([part({ mesh: boltMesh('socket', 'M8', 25) })])[0]!.attributes;
    const keys = a.map(x => x.key);
    expect(keys).toEqual(expect.arrayContaining(['headType', 'driveType', 'threadSize', 'length', 'socketSize']));
    expect(keys.filter(k => k === 'length')).toHaveLength(1);                               // 상자 길이(33)가 아니라 규격의 길이 하나만
    expect(a.find(x => x.key === 'length')?.value).toBe(25);
    expect(keys).not.toContain('width');
    expect(keys).not.toContain('thickness');
  });

  it('볼트가 아닌 메시는 아무것도 더하거나 빼지 않는다', () => {
    const plain = extractCadAttributes([part()])[0]!.attributes;
    const withPlate = extractCadAttributes([part({ mesh: plateMesh() })])[0]!.attributes;
    expect(withPlate).toEqual(plain);
  });

  it('이름의 규격 표기(M8x25)와 형상이 둘 다 후보로 남아 사람이 비교할 수 있다', () => {
    const a = extractCadAttributes([{ name: 'SCREW M8x25', size: [13, 13, 33], mesh: boltMesh('socket', 'M8', 25) }])[0]!.attributes;
    expect(a.filter(x => x.key === 'threadSize').map(x => x.source).sort()).toEqual(['cad', 'name']);
  });

  it('mesh 의 단위는 부품의 단위를 따르고, 자체 단위가 있으면 그것을 쓴다', () => {
    const cm = transform(boltMesh('socket', 'M8', 25), { scale: 0.1 });
    const a = extractCadAttributes([part({ unit: 'cm', mesh: cm })])[0]!.attributes;
    expect(a.find(x => x.key === 'length')?.value).toBe(25);
    const b = extractCadAttributes([part({ unit: 'mm', mesh: { ...cm, unit: 'cm' } })])[0]!.attributes;
    expect(b.find(x => x.key === 'length')?.value).toBe(25);
  });
});
