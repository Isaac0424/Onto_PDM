// 볼트 형상 분류 시험용 메시 생성기 (절차적 · 시험과 문서의 정확도 표가 같이 쓴다).
// 모든 물체를 "고리 쌓기(loft)"로 만든다: 고리 = 높이 z 와 각도별 반지름 ρ(θ). 육각 · 구멍도 반지름 함수라 같은 방식으로 만든다.
// 고리 사이를 삼각형으로 잇고, 첫/마지막 반지름이 0 이면 한 점(꼭짓점)으로 닫는다. cyclic 이면 마지막 고리를 첫 고리에 잇는다(너트 · 와셔 같은 구멍 있는 물체).

export interface Mesh { positions: Float32Array; indices: Uint32Array }
export type Rho = number | ((theta: number) => number);
export interface Ring { z: number; rho: Rho }

export function loft(rings: Ring[], N = 72, cyclic = false): Mesh {
  const pos: number[] = [];
  const start: number[] = [];
  const apex: boolean[] = [];
  rings.forEach(r => {
    start.push(pos.length / 3);
    if (typeof r.rho === 'number' && r.rho === 0) { apex.push(true); pos.push(0, 0, r.z); return; }
    apex.push(false);
    for (let i = 0; i < N; i++) {
      const th = (2 * Math.PI * i) / N;
      const rho = typeof r.rho === 'number' ? r.rho : r.rho(th);
      pos.push(rho * Math.cos(th), rho * Math.sin(th), r.z);
    }
  });
  const idx: number[] = [];
  const link = (a: number, b: number) => {
    const A = start[a]!, B = start[b]!;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      if (apex[a] && apex[b]) return;
      if (apex[a]) idx.push(A, B + j, B + i);
      else if (apex[b]) idx.push(A + i, A + j, B);
      else idx.push(A + i, A + j, B + j, A + i, B + j, B + i);
    }
  };
  for (let j = 0; j + 1 < rings.length; j++) link(j, j + 1);
  if (cyclic) link(rings.length - 1, 0);
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
}

/** 대변이 across 인 정육각형의 반지름 함수 (꼭짓점이 θ=0 에 있다) */
export const hexRho = (across: number) => (th: number) => {
  const phi = ((((th % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3)) - Math.PI / 6);
  return across / 2 / Math.cos(phi);
};

const rectRho = (w: number, h: number) => (th: number) => Math.min(w / 2 / Math.abs(Math.cos(th) || 1e-9), h / 2 / Math.abs(Math.sin(th) || 1e-9));

export type BoltKind = 'hex' | 'socket' | 'button' | 'countersunk' | 'flange';
export type DriveKind = 'hex' | 'torx' | 'cross' | 'slot' | 'none';
export type BoltSize = 'M3' | 'M4' | 'M5' | 'M6' | 'M8';

interface Dim { d: number; pitch: number; s?: number; dk?: number; dc?: number; k: number; c?: number; sock?: number; t?: number }

/** 표준(ISO 4017 · 4762 · 7380 · 10642 · 4162)의 대표 치수 */
export const BOLT_DIMS: Record<BoltKind, Record<BoltSize, Dim>> = {
  hex: {
    M3: { d: 3, pitch: 0.5, s: 5.5, k: 2 }, M4: { d: 4, pitch: 0.7, s: 7, k: 2.8 }, M5: { d: 5, pitch: 0.8, s: 8, k: 3.5 },
    M6: { d: 6, pitch: 1.0, s: 10, k: 4 }, M8: { d: 8, pitch: 1.25, s: 13, k: 5.3 },
  },
  socket: {
    M3: { d: 3, pitch: 0.5, dk: 5.5, k: 3, sock: 2.5, t: 1.5 }, M4: { d: 4, pitch: 0.7, dk: 7, k: 4, sock: 3, t: 2 }, M5: { d: 5, pitch: 0.8, dk: 8.5, k: 5, sock: 4, t: 2.5 },
    M6: { d: 6, pitch: 1.0, dk: 10, k: 6, sock: 5, t: 3 }, M8: { d: 8, pitch: 1.25, dk: 13, k: 8, sock: 6, t: 4 },
  },
  button: {
    M3: { d: 3, pitch: 0.5, dk: 5.7, k: 1.65, sock: 2, t: 1 }, M4: { d: 4, pitch: 0.7, dk: 7.6, k: 2.2, sock: 2.5, t: 1.3 }, M5: { d: 5, pitch: 0.8, dk: 9.5, k: 2.75, sock: 3, t: 1.5 },
    M6: { d: 6, pitch: 1.0, dk: 10.5, k: 3.3, sock: 4, t: 2 }, M8: { d: 8, pitch: 1.25, dk: 14, k: 4.4, sock: 5, t: 2.5 },
  },
  countersunk: {
    M3: { d: 3, pitch: 0.5, dk: 6.72, k: 1.86, sock: 2, t: 1 }, M4: { d: 4, pitch: 0.7, dk: 8.96, k: 2.48, sock: 2.5, t: 1.2 }, M5: { d: 5, pitch: 0.8, dk: 11.2, k: 3.1, sock: 3, t: 1.5 },
    M6: { d: 6, pitch: 1.0, dk: 13.44, k: 3.72, sock: 4, t: 1.8 }, M8: { d: 8, pitch: 1.25, dk: 17.92, k: 4.96, sock: 5, t: 2.3 },
  },
  flange: {
    M3: { d: 3, pitch: 0.5, s: 5.5, dc: 7.6, k: 3.2, c: 0.7 }, M4: { d: 4, pitch: 0.7, s: 7, dc: 9.4, k: 4.3, c: 1.0 }, M5: { d: 5, pitch: 0.8, s: 8, dc: 11.8, k: 5.4, c: 1.0 },
    M6: { d: 6, pitch: 1.0, s: 10, dc: 14.2, k: 6.6, c: 1.5 }, M8: { d: 8, pitch: 1.25, s: 13, dc: 17.9, k: 8.5, c: 2.0 },
  },
};

export const DEFAULT_DRIVE: Record<BoltKind, DriveKind> = { hex: 'none', flange: 'none', socket: 'hex', button: 'hex', countersunk: 'hex' };

/** 구멍(구동부) 모양의 반지름 함수. size = 육각이면 대변 */
function recessRho(kind: Exclude<DriveKind, 'none'>, size: number): (th: number) => number {
  switch (kind) {
    case 'hex': return hexRho(size);
    case 'torx': return th => (0.62 * size * (1 + 0.14 * Math.cos(6 * th))) / 1.14;
    case 'cross': {
      const La = 0.9 * size, w = 0.28 * size;
      return th => {
        const c = Math.abs(Math.cos(th)) || 1e-9, s = Math.abs(Math.sin(th)) || 1e-9;
        return Math.max(Math.min(La / c, w / 2 / s), Math.min(La / s, w / 2 / c));
      };
    }
    case 'slot': return rectRho(1.5 * size, 0.22 * size);
  }
}

export interface BoltOptions {
  /** 고리 하나의 꼭짓점 수 (기본 72). 클수록 삼각형이 많다 */
  N?: number;
  /** 윗면 구멍. 기본: 육각볼트 · 플랜지볼트는 없음, 나머지는 육각 구멍. 'none' = 단순화한 모델(구멍 생략) */
  drive?: DriveKind;
  /** 나사산을 모델링한다(나선형 요철) */
  thread?: boolean;
  /** 머리 높이(k)를 직접 정한다 — 경계 사례 시험용 */
  headHeight?: number;
  /** 머리 지름(dk 또는 육각 대변)을 직접 정한다 */
  headDiameter?: number;
  /** 몸통 지름을 직접 정한다 — 실제 STEP 처럼 나사산을 골지름(minor)으로 그린 외관 나사산 모델 시험용(머리 치수는 호칭 그대로) */
  shaftDiameter?: number;
}

/** 보통 나사의 골지름: 호칭 − 1.2269 × 피치 (ISO 68-1) */
export const minorDiameter = (size: BoltSize): number => {
  const dim = BOLT_DIMS.socket[size];
  return dim.d - 1.2269 * dim.pitch;
};

/**
 * 볼트 메시. z=0 이 나사 끝, 머리가 위. length 는 규격의 길이:
 *  육각 · 소켓 · 버튼 · 플랜지는 머리 아래 길이, 접시머리는 머리를 포함한 전체 길이.
 */
export function boltMesh(kind: BoltKind, size: BoltSize, length: number, o: BoltOptions = {}): Mesh {
  const dim = BOLT_DIMS[kind][size];
  const d = dim.d, Rs = (o.shaftDiameter ?? d) / 2;
  const N = o.N ?? 72;
  const drive = o.drive ?? DEFAULT_DRIVE[kind];
  const k = o.headHeight ?? dim.k;
  const rings: Ring[] = [{ z: 0, rho: 0 }, { z: 0, rho: Rs * 0.82 }, { z: 0.12 * d, rho: Rs }];

  const shaftTop = kind === 'countersunk' ? length - k : length;
  if (o.thread) {
    const step = dim.pitch / 6, amp = 0.05 * d;
    for (let z = 0.12 * d + step; z < shaftTop - 1e-9; z += step) rings.push({ z, rho: th => Rs + amp * Math.cos(th - (2 * Math.PI * z) / dim.pitch) });
  }
  rings.push({ z: shaftTop, rho: Rs });

  let H = shaftTop + k;
  let topRho: Rho;
  let recessMax: number;                                                         // 구멍 반지름이 이 안에 있어야 한다
  switch (kind) {
    case 'hex': {
      const a = o.headDiameter ?? dim.s!;
      const hr = hexRho(a);
      rings.push({ z: shaftTop, rho: hr }, { z: H - 0.1 * k, rho: hr });
      topRho = th => Math.min(hr(th), 0.97 * a / 2 / 0.98);                       // 윗면 모따기: 모서리가 깎여 둥글어진다
      recessMax = a / 2;
      break;
    }
    case 'flange': {
      const a = dim.s!, hr = hexRho(a), Rf = dim.dc! / 2, c = dim.c!;
      rings.push({ z: shaftTop, rho: Rf }, { z: shaftTop + c, rho: Rf }, { z: shaftTop + c, rho: hr }, { z: H - 0.1 * k, rho: hr });
      topRho = th => Math.min(hr(th), 0.97 * a / 2 / 0.98);
      recessMax = a / 2;
      break;
    }
    case 'socket': {
      const Rh = (o.headDiameter ?? dim.dk!) / 2;
      rings.push({ z: shaftTop, rho: Rh }, { z: H - 0.05 * d, rho: Rh });
      topRho = Rh - 0.06 * d;
      recessMax = topRho;
      break;
    }
    case 'button': {
      const Rh = (o.headDiameter ?? dim.dk!) / 2, rTop = 0.5 * Rh;
      rings.push({ z: shaftTop, rho: Rh });
      for (let i = 1; i < 10; i++) {
        const phi = (i / 10) * (Math.PI / 2);
        rings.push({ z: shaftTop + k * Math.sin(phi), rho: rTop + (Rh - rTop) * Math.cos(phi) });
      }
      topRho = rTop;
      recessMax = rTop;
      break;
    }
    case 'countersunk': {
      const Rh = (o.headDiameter ?? dim.dk!) / 2;
      H = shaftTop + k;
      topRho = Rh;                                                                // 90° 원뿔: 반지름이 높이만큼 늘어난다 (아래 윗면 고리가 원뿔의 끝)
      recessMax = Rh - 0.1 * d;
      break;
    }
  }
  rings.push({ z: H, rho: topRho });

  if (drive === 'none') {
    rings.push({ z: H, rho: 0 });
  } else {
    const size0 = dim.sock ?? dim.s! * 0.55;
    const f = recessRho(drive, size0);
    const clip = (th: number) => Math.min(f(th), recessMax * 0.92);
    const t = dim.t ?? 0.5 * k;
    rings.push({ z: H, rho: clip }, { z: H - t, rho: clip }, { z: H - t - 0.4 * size0, rho: 0 });
  }
  return loft(rings, N);
}

/** 볼트가 아닌 부품들 */
export function plateMesh(w = 40, h = 20, t = 3): Mesh { return loft([{ z: 0, rho: 0 }, { z: 0, rho: rectRho(w, h) }, { z: t, rho: rectRho(w, h) }, { z: t, rho: 0 }], 72); }
export function pinMesh(d = 6, L = 20): Mesh { return loft([{ z: 0, rho: 0 }, { z: 0, rho: d / 2 }, { z: L, rho: d / 2 }, { z: L, rho: 0 }], 72); }
/** 머리 없는 나사봉(스터드) */
export function rodMesh(d = 8, L = 40): Mesh { return pinMesh(d, L); }
export function nutMesh(s = 13, m = 6.5, hole = 8): Mesh {
  const hr = hexRho(s);
  return loft([{ z: m, rho: hole / 2 }, { z: m, rho: hr }, { z: 0, rho: hr }, { z: 0, rho: hole / 2 }], 72, true);
}
export function washerMesh(od = 16, id = 8.4, t = 1.6): Mesh {
  return loft([{ z: t, rho: id / 2 }, { z: t, rho: od / 2 }, { z: 0, rho: od / 2 }, { z: 0, rho: id / 2 }], 72, true);
}
export function cubeMesh(a = 10): Mesh { return loft([{ z: 0, rho: 0 }, { z: 0, rho: rectRho(a, a) }, { z: a, rho: rectRho(a, a) }, { z: a, rho: 0 }], 72); }
/** 머리가 양쪽에 있는 아령 모양(볼트가 아니다) */
export function dumbbellMesh(): Mesh {
  return loft([{ z: 0, rho: 0 }, { z: 0, rho: 6 }, { z: 3, rho: 6 }, { z: 3, rho: 3 }, { z: 17, rho: 3 }, { z: 17, rho: 6 }, { z: 20, rho: 6 }, { z: 20, rho: 0 }], 72);
}

// ---------- 변환 ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 시드로 정한 임의 방향의 회전 행렬(행 우선 9개) */
export function randomRotation(seed: number): number[] {
  const r = mulberry32(seed);
  const u = r() * 2 - 1, phi = r() * Math.PI * 2, ang = r() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  const x = s * Math.cos(phi), y = s * Math.sin(phi), z = u;
  const c = Math.cos(ang), n = Math.sin(ang), t = 1 - c;
  return [
    t * x * x + c, t * x * y - n * z, t * x * z + n * y,
    t * x * y + n * z, t * y * y + c, t * y * z - n * x,
    t * x * z - n * y, t * y * z + n * x, t * z * z + c,
  ];
}

export function transform(mesh: Mesh, o: { rotation?: number[]; scale?: number; translate?: [number, number, number] }): Mesh {
  const R = o.rotation ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const s = o.scale ?? 1;
  const [tx, ty, tz] = o.translate ?? [0, 0, 0];
  const p = new Float32Array(mesh.positions.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = mesh.positions[i]!, y = mesh.positions[i + 1]!, z = mesh.positions[i + 2]!;
    p[i] = s * (R[0]! * x + R[1]! * y + R[2]! * z) + tx;
    p[i + 1] = s * (R[3]! * x + R[4]! * y + R[5]! * z) + ty;
    p[i + 2] = s * (R[6]! * x + R[7]! * y + R[8]! * z) + tz;
  }
  return { positions: p, indices: mesh.indices };
}

/** 색인 없는 삼각형 목록(9개씩)으로 푼다 */
export function nonIndexed(mesh: Mesh): Float32Array {
  const out = new Float32Array(mesh.indices.length * 3);
  mesh.indices.forEach((v, i) => { out[i * 3] = mesh.positions[v * 3]!; out[i * 3 + 1] = mesh.positions[v * 3 + 1]!; out[i * 3 + 2] = mesh.positions[v * 3 + 2]!; });
  return out;
}

export const triCount = (m: Mesh) => m.indices.length / 3;

/** Wavefront OBJ 문자열 (뷰어 시험용: 실제 파일로 올려 본다) */
export function toObj(mesh: Mesh, name = 'part'): string {
  const lines = [`o ${name}`];
  for (let i = 0; i < mesh.positions.length; i += 3) lines.push(`v ${mesh.positions[i]!.toFixed(5)} ${mesh.positions[i + 1]!.toFixed(5)} ${mesh.positions[i + 2]!.toFixed(5)}`);
  for (let i = 0; i < mesh.indices.length; i += 3) lines.push(`f ${mesh.indices[i]! + 1} ${mesh.indices[i + 1]! + 1} ${mesh.indices[i + 2]! + 1}`);
  return lines.join('\n') + '\n';
}

// ---------- 실제 STEP(HCR 로봇)에서 본 현상을 재현하는 변형 (작업 V) ----------
// 제조사 CAD 메시는 저장소에 넣지 않는다. 대신 관찰한 현상만 합성 형상으로 만든다:
//  · 같은 볼트 여러 개가 한 부품으로 합쳐진 모델  · 몸통 없이 머리만 있는 볼트  · 머리와 나사 끝 사이가 비어 있는 모델  · 몸통을 골지름으로 그린 모델(boltMesh 의 shaftDiameter)

/** 메시 여러 개를 하나로 합친다 (서로 떨어진 덩어리 = 한 부품 안의 여러 몸체) */
export function mergeMeshes(...meshes: Mesh[]): Mesh {
  let nv = 0, ni = 0;
  for (const m of meshes) { nv += m.positions.length; ni += m.indices.length; }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let pv = 0, pi = 0;
  for (const m of meshes) {
    positions.set(m.positions, pv);
    for (let i = 0; i < m.indices.length; i++) indices[pi + i] = m.indices[i]! + pv / 3;
    pv += m.positions.length;
    pi += m.indices.length;
  }
  return { positions, indices };
}

export type HeadOnlyKind = 'socket' | 'button' | 'countersunk';

/**
 * 몸통 없이 머리만 모델링된 볼트. z=0 이 바닥, 윗면에 막힌 육각 구멍(실제 모델은 깊이가 머리 높이의 약 77%, 바닥은 원뿔).
 * 바닥면은 평평하게 막혀 있다.
 */
export function headOnlyMesh(kind: HeadOnlyKind, size: BoltSize, o: { N?: number; recess?: boolean } = {}): Mesh {
  const dim = BOLT_DIMS[kind][size];
  const d = dim.d, k = dim.k, Rh = dim.dk! / 2;
  const rings: Ring[] = [{ z: 0, rho: 0 }];
  let topRho: Rho;
  let recessMax: number;
  switch (kind) {
    case 'socket':
      rings.push({ z: 0, rho: Rh - 0.06 * d }, { z: 0.05 * d, rho: Rh }, { z: k - 0.05 * d, rho: Rh });
      topRho = Rh - 0.06 * d; recessMax = topRho;
      break;
    case 'button': {
      const rTop = 0.5 * Rh;
      rings.push({ z: 0, rho: Rh });
      for (let i = 1; i < 10; i++) { const phi = (i / 10) * (Math.PI / 2); rings.push({ z: k * Math.sin(phi), rho: rTop + (Rh - rTop) * Math.cos(phi) }); }
      topRho = rTop; recessMax = rTop;
      break;
    }
    case 'countersunk':
      rings.push({ z: 0, rho: Math.max(Rh - k, 0.3 * Rh) });
      topRho = Rh; recessMax = Rh - 0.1 * d;
      break;
  }
  rings.push({ z: k, rho: topRho });
  if (o.recess === false) {
    rings.push({ z: k, rho: 0 });
  } else {
    const f = hexRho(dim.sock!);
    const clip = (th: number) => Math.min(f(th), recessMax * 0.92);
    const depth = 0.6 * k, cone = 0.17 * k;                                        // 실제 모델: 구멍 전체 깊이가 머리 높이의 약 77%, 바닥(약 23%)은 막혀 있다
    rings.push({ z: k, rho: clip }, { z: k - depth, rho: clip }, { z: k - depth - cone, rho: 0 });
  }
  return loft(rings, o.N ?? 72);
}

/**
 * 머리와 나사 끝만 있고 그 사이가 빈 볼트(실제 STEP 의 커버 볼트: 머리 4 mm · 나사 끝 5 mm · 사이 7 mm 가 없다).
 * 나사 끝 조각은 골지름(minor)으로 그린다. 전체 길이는 머리 높이 + stub + gap.
 */
export function gapBoltMesh(size: BoltSize, stub = 5, gap = 7): Mesh {
  const R = minorDiameter(size) / 2;
  const tip = loft([{ z: 0, rho: 0 }, { z: 0, rho: R }, { z: stub, rho: R }, { z: stub, rho: 0 }], 72);
  const head = transform(headOnlyMesh('socket', size), { translate: [0, 0, stub + gap] });
  return mergeMeshes(tip, head);
}
