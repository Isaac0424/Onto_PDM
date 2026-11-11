// 볼트 형상 분류의 기하 계산 (three.js 에 의존하지 않는 순수 함수). 삼각형 메시만 받는다.
//   1) 표면 면적 가중 공분산으로 회전축을 찾고  2) 축에 수직인 평면으로 메시를 잘라 단면 선분을 얻고
//   3) 단면 중심에서 광선을 쏴 바깥 · 안쪽 경계를 읽는다.

export interface TriMesh {
  positions: Float64Array;
  /** 삼각형 꼭짓점 번호 (3개씩) */
  tri: Uint32Array;
}

/** 삼각형 꼭짓점 배열(+ 선택 색인)을 하나의 모양으로 맞춘다. 읽을 수 없으면 null */
export function normalizeMesh(positions: ArrayLike<number>, indices?: ArrayLike<number>): TriMesh | null {
  const n = positions.length;
  if (n < 9 || n % 3 !== 0) return null;
  const p = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = positions[i]!;
    if (!Number.isFinite(v)) return null;
    p[i] = v;
  }
  const nv = n / 3;
  if (!indices) {
    if (nv % 3 !== 0) return null;
    const tri = new Uint32Array(nv);
    for (let i = 0; i < nv; i++) tri[i] = i;
    return { positions: p, tri };
  }
  if (indices.length < 3) return null;
  const keep: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!;
    if (a >= 0 && b >= 0 && c >= 0 && a < nv && b < nv && c < nv && a !== b && b !== c && a !== c) keep.push(a, b, c);
  }
  return keep.length >= 9 ? { positions: p, tri: Uint32Array.from(keep) } : null;
}

type V3 = [number, number, number];

export interface Frame {
  origin: V3;
  /** 회전축(단위 벡터) */
  axis: V3;
  e1: V3;
  e2: V3;
  eigenvalues: V3;
  area: number;
}

/** 3x3 대칭 행렬의 고유값 · 고유벡터 (야코비 회전). 고유값 내림차순 */
function eigenSym3(m: number[]): { values: V3; vectors: V3[] } {
  const a = m.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 60; sweep++) {
    const off = a[1]! * a[1]! + a[2]! * a[2]! + a[5]! * a[5]!;
    if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p * 3 + q]!;
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (a[q * 3 + q]! - a[p * 3 + p]!) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {                         // A ← A·J
        const akp = a[k * 3 + p]!, akq = a[k * 3 + q]!;
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {                         // A ← Jᵀ·A
        const apk = a[p * 3 + k]!, aqk = a[q * 3 + k]!;
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {                         // V ← V·J
        const vkp = v[k * 3 + p]!, vkq = v[k * 3 + q]!;
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j * 3 + j]! - a[i * 3 + i]!);
  return {
    values: order.map(i => a[i * 3 + i]!) as V3,
    vectors: order.map(i => [v[i]!, v[3 + i]!, v[6 + i]!] as V3),
  };
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * 표면 면적 가중 공분산으로 회전축을 찾는다.
 * 볼트처럼 축대칭인 물체는 축에 수직인 두 고유값이 같다(육각도 6회 대칭이라 2차 모멘트는 등방). 그래서 가장 긴 축이 아니라
 * "나머지 둘과 따로 떨어진 고유값"의 방향을 축으로 쓴다: 짧고 굵은 볼트(머리 지름 > 전체 길이)나 납작한 와셔도 같은 규칙으로 맞는다.
 */
export function findFrame(m: TriMesh): Frame | null {
  const { positions: P, tri } = m;
  let area = 0;
  const mu = [0, 0, 0];
  const s2 = new Array<number>(9).fill(0);
  for (let t = 0; t < tri.length; t += 3) {
    const ia = tri[t]! * 3, ib = tri[t + 1]! * 3, ic = tri[t + 2]! * 3;
    const ax = P[ia]!, ay = P[ia + 1]!, az = P[ia + 2]!;
    const bx = P[ib]!, by = P[ib + 1]!, bz = P[ib + 2]!;
    const cx = P[ic]!, cy = P[ic + 1]!, cz = P[ic + 2]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const A = 0.5 * Math.hypot(nx, ny, nz);
    if (!(A > 0)) continue;
    area += A;
    const sx = ax + bx + cx, sy = ay + by + cy, sz = az + bz + cz;
    mu[0]! += A * sx / 3; mu[1]! += A * sy / 3; mu[2]! += A * sz / 3;
    const k = A / 12;
    const a = [ax, ay, az], b = [bx, by, bz], c = [cx, cy, cz], s = [sx, sy, sz];
    for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) {
      s2[i * 3 + j]! += k * (a[i]! * a[j]! + b[i]! * b[j]! + c[i]! * c[j]! + s[i]! * s[j]!);
    }
  }
  if (!(area > 0)) return null;
  const mean: V3 = [mu[0]! / area, mu[1]! / area, mu[2]! / area];
  const cov = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) {
    const v = s2[i * 3 + j]! / area - mean[i]! * mean[j]!;
    cov[i * 3 + j] = v;
    cov[j * 3 + i] = v;
  }
  const { values, vectors } = eigenSym3(cov);
  const gapTop = values[0] - values[1];
  const gapBottom = values[1] - values[2];
  const axis = norm(gapTop >= gapBottom ? vectors[0]! : vectors[2]!);
  const helper: V3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = norm(cross(axis, helper));
  const e2 = norm(cross(axis, e1));
  return { origin: mean, axis, e1, e2, eigenvalues: values, area };
}

export interface Prepared {
  U: Float64Array;
  V: Float64Array;
  T: Float64Array;
  tri: Uint32Array;
  tMin: number;
  tMax: number;
}

/** 모든 꼭짓점을 (축에 수직인 두 좌표 U · V, 축 방향 T) 로 옮긴다 */
export function prepare(m: TriMesh, f: Frame): Prepared {
  const nv = m.positions.length / 3;
  const U = new Float64Array(nv), V = new Float64Array(nv), T = new Float64Array(nv);
  let tMin = Infinity, tMax = -Infinity;
  const [ox, oy, oz] = f.origin;
  for (let i = 0; i < nv; i++) {
    const x = m.positions[i * 3]! - ox, y = m.positions[i * 3 + 1]! - oy, z = m.positions[i * 3 + 2]! - oz;
    U[i] = x * f.e1[0] + y * f.e1[1] + z * f.e1[2];
    V[i] = x * f.e2[0] + y * f.e2[1] + z * f.e2[2];
    const t = x * f.axis[0] + y * f.axis[1] + z * f.axis[2];
    T[i] = t;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  return { U, V, T, tri: m.tri, tMin, tMax };
}

export interface Sections {
  n: number;
  /** 평면 k 의 선분은 data[offsets[k]*4 ... offsets[k+1]*4): (u1 v1 u2 v2) */
  offsets: Int32Array;
  data: Float64Array;
}


/** 축에 수직인 평면 t0 + k·dt (k = 0..n-1) 으로 메시를 자른 단면 선분들 */
export function sectionAt(p: Prepared, t0: number, dt: number, n: number): Sections {
  const { U, V, T, tri } = p;
  const tEnd = t0 + (n - 1) * dt;
  const counts = new Int32Array(n);
  const fill = new Int32Array(n);
  const offsets = new Int32Array(n + 1);
  let data = new Float64Array(0);
  // 1차: 평면마다 선분 수를 센다 → 2차: 채운다
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1) {
      for (let k = 0; k < n; k++) offsets[k + 1] = offsets[k]! + counts[k]!;
      data = new Float64Array(offsets[n]! * 4);
    }
    for (let t = 0; t < tri.length; t += 3) {
      const a = tri[t]!, b = tri[t + 1]!, c = tri[t + 2]!;
      const ta = T[a]!, tb = T[b]!, tc = T[c]!;
      const lo = Math.min(ta, tb, tc), hi = Math.max(ta, tb, tc);
      if (hi < t0 || lo > tEnd) continue;
      const kA = Math.max(0, Math.ceil((lo - t0) / dt));
      const kB = Math.min(n - 1, Math.floor((hi - t0) / dt));
      for (let k = kA; k <= kB; k++) {
        const tp = t0 + k * dt;
        const ca = ta >= tp, cb = tb >= tp, cc = tc >= tp;
        if (ca === cb && cb === cc) continue;
        if (pass === 0) { counts[k]!++; continue; }
        // 서로 다른 쪽에 있는 두 변과 평면의 교점
        let px = 0, py = 0, qx = 0, qy = 0, got = 0;
        if (ca !== cb) {
          const s = (tp - ta) / (tb - ta);
          px = U[a]! + s * (U[b]! - U[a]!); py = V[a]! + s * (V[b]! - V[a]!); got = 1;
        }
        if (cb !== cc) {
          const s = (tp - tb) / (tc - tb);
          const x = U[b]! + s * (U[c]! - U[b]!), y = V[b]! + s * (V[c]! - V[b]!);
          if (got === 0) { px = x; py = y; got = 1; } else { qx = x; qy = y; got = 2; }
        }
        if (cc !== ca) {
          const s = (tp - tc) / (ta - tc);
          const x = U[c]! + s * (U[a]! - U[c]!), y = V[c]! + s * (V[a]! - V[c]!);
          if (got === 0) { px = x; py = y; } else { qx = x; qy = y; }
        }
        const at = (offsets[k]! + fill[k]!++) * 4;
        data[at] = px; data[at + 1] = py; data[at + 2] = qx; data[at + 3] = qy;
      }
    }
  }
  return { n, offsets, data };
}

export interface PlaneStat {
  count: number;
  cx: number;
  cy: number;
  /** 단면 중심(경계 상자의 가운데)에서 가장 먼 점까지의 거리 = 외접 반지름. 선분이 없으면 NaN */
  R: number;
}

export function planeStat(s: Sections, k: number): PlaneStat {
  const from = s.offsets[k]! * 4, to = s.offsets[k + 1]! * 4;
  if (to <= from) return { count: 0, cx: 0, cy: 0, R: NaN };
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = from; i < to; i += 2) {
    const u = s.data[i]!, v = s.data[i + 1]!;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const cx = (minU + maxU) / 2, cy = (minV + maxV) / 2;
  let r2 = 0;
  for (let i = from; i < to; i += 2) {
    const d = (s.data[i]! - cx) ** 2 + (s.data[i + 1]! - cy) ** 2;
    if (d > r2) r2 = d;
  }
  return { count: (to - from) / 4, cx, cy, R: Math.sqrt(r2) };
}

export interface RayProfile {
  cx: number;
  cy: number;
  /** 각도마다 가장 먼 경계까지의 거리 (바깥 윤곽) */
  outer: Float64Array;
  /** 각도마다 가장 가까운 경계까지의 거리 (구멍이 있으면 구멍 벽, 없으면 바깥 윤곽과 같다) */
  inner: Float64Array;
  /** 경계를 두 번 이상 만난 광선의 비율: 단면 가운데가 비어 있는(구멍) 정도 */
  holeFraction: number;
}

/** 단면 중심에서 K 개의 광선을 쏴 경계를 읽는다. 선분 끝점(이웃 삼각형과 공유)을 정확히 지나지 않도록 각도를 비껴 잡는다 */
export function rayProfile(s: Sections, k: number, K: number): RayProfile {
  const stat = planeStat(s, k);
  const outer = new Float64Array(K), inner = new Float64Array(K);
  const from = s.offsets[k]! * 4, to = s.offsets[k + 1]! * 4;
  if (to <= from) return { cx: 0, cy: 0, outer, inner, holeFraction: 0 };
  const nSeg = (to - from) / 4;
  const sx = new Float64Array(nSeg), sy = new Float64Array(nSeg), ex = new Float64Array(nSeg), ey = new Float64Array(nSeg);
  for (let i = 0; i < nSeg; i++) {
    const at = from + i * 4;
    sx[i] = s.data[at]! - stat.cx;
    sy[i] = s.data[at + 1]! - stat.cy;
    ex[i] = s.data[at + 2]! - stat.cx - sx[i]!;
    ey[i] = s.data[at + 3]! - stat.cy - sy[i]!;
  }
  const tol = 1e-6 * (stat.R || 1);
  let multi = 0;
  const hits: number[] = [];
  for (let j = 0; j < K; j++) {
    const th = ((j + 0.37) / K) * Math.PI * 2;
    const dx = Math.cos(th), dy = Math.sin(th);
    hits.length = 0;
    for (let i = 0; i < nSeg; i++) {
      const denom = dx * ey[i]! - dy * ex[i]!;
      if (Math.abs(denom) < 1e-14) continue;
      const sd = (sx[i]! * ey[i]! - sy[i]! * ex[i]!) / denom;
      if (sd <= 1e-12) continue;
      const u = (sx[i]! * dy - sy[i]! * dx) / denom;
      if (u < 0 || u > 1) continue;
      hits.push(sd);
    }
    if (hits.length === 0) { outer[j] = NaN; inner[j] = NaN; continue; }
    hits.sort((a, b) => a - b);
    const uniq: number[] = [hits[0]!];
    for (let i = 1; i < hits.length; i++) if (hits[i]! - uniq[uniq.length - 1]! > tol) uniq.push(hits[i]!);
    outer[j] = uniq[uniq.length - 1]!;
    inner[j] = uniq[0]!;
    if (uniq.length >= 2) multi++;
  }
  return { cx: stat.cx, cy: stat.cy, outer, inner, holeFraction: multi / K };
}

/** 각도 함수 값(등간격 K 개)의 k 차 조화 성분 크기 / 평균. 6 차가 크면 육각, 4 차면 십자 … */
export function harmonic(values: Float64Array, k: number): number {
  const K = values.length;
  let mean = 0, n = 0;
  for (let i = 0; i < K; i++) if (Number.isFinite(values[i]!)) { mean += values[i]!; n++; }
  if (n < K * 0.8) return 0;
  mean /= n;
  let re = 0, im = 0;
  for (let i = 0; i < K; i++) {
    const v = Number.isFinite(values[i]!) ? values[i]! : mean;
    const a = (2 * Math.PI * k * (i + 0.37)) / K;
    re += v * Math.cos(a);
    im += v * Math.sin(a);
  }
  return mean > 0 ? (2 * Math.hypot(re, im)) / K / mean : 0;
}

export const finiteMin = (a: ArrayLike<number>): number => { let m = Infinity; for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]!) && a[i]! < m) m = a[i]!; return m; };
export const finiteMax = (a: ArrayLike<number>): number => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]!) && a[i]! > m) m = a[i]!; return m; };

export function median(a: number[]): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * 서로 떨어진 덩어리(연결 성분)로 나눈다. 같은 이름의 볼트 여러 개가 한 부품으로 합쳐진 경우를 위해서다.
 * 삼각분할은 면마다 꼭짓점을 따로 가질 수 있어 색인이 아니라 **위치**로 꼭짓점을 합친 뒤(weld) 이어진 삼각형끼리 묶는다.
 * 덩어리가 하나이거나 maxBodies 를 넘으면 null (나누지 않는다).
 */
export function splitBodies(m: TriMesh, weldRel: number, maxBodies: number): TriMesh[] | null {
  const P = m.positions;
  const nv = P.length / 3;
  let lo0 = Infinity, lo1 = Infinity, lo2 = Infinity, hi0 = -Infinity, hi1 = -Infinity, hi2 = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = P[i * 3]!, y = P[i * 3 + 1]!, z = P[i * 3 + 2]!;
    if (x < lo0) lo0 = x; if (x > hi0) hi0 = x;
    if (y < lo1) lo1 = y; if (y > hi1) hi1 = y;
    if (z < lo2) lo2 = z; if (z > hi2) hi2 = z;
  }
  const extent = Math.max(hi0 - lo0, hi1 - lo1, hi2 - lo2);
  if (!(extent > 0)) return null;
  const cell = extent * weldRel;

  // 위치가 같은 꼭짓점에 같은 번호를 준다 (쓰이는 꼭짓점만)
  const weldId = new Int32Array(nv).fill(-1);
  const seen = new Map<string, number>();
  let nw = 0;
  const idOf = (v: number): number => {
    const cached = weldId[v]!;
    if (cached >= 0) return cached;
    const key = `${Math.round(P[v * 3]! / cell)},${Math.round(P[v * 3 + 1]! / cell)},${Math.round(P[v * 3 + 2]! / cell)}`;
    let id = seen.get(key);
    if (id === undefined) { id = nw++; seen.set(key, id); }
    weldId[v] = id;
    return id;
  };

  const tri = m.tri;
  const nt = tri.length / 3;
  const a = new Int32Array(nt), b = new Int32Array(nt), c = new Int32Array(nt);
  for (let t = 0; t < nt; t++) { a[t] = idOf(tri[t * 3]!); b[t] = idOf(tri[t * 3 + 1]!); c[t] = idOf(tri[t * 3 + 2]!); }

  const parent = new Int32Array(nw);
  for (let i = 0; i < nw; i++) parent[i] = i;
  const find = (x: number): number => { while (parent[x]! !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; } return x; };
  const union = (x: number, y: number) => { const rx = find(x), ry = find(y); if (rx !== ry) parent[ry] = rx; };
  for (let t = 0; t < nt; t++) { union(a[t]!, b[t]!); union(b[t]!, c[t]!); }

  const group = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) {
    const r = find(a[t]!);
    const list = group.get(r);
    if (list) list.push(t); else group.set(r, [t]);
    if (group.size > maxBodies) return null;
  }
  if (group.size < 2) return null;

  const bodies: TriMesh[] = [];
  for (const tris of group.values()) {
    const remap = new Map<number, number>();
    const pos: number[] = [];
    const idx = new Uint32Array(tris.length * 3);
    tris.forEach((t, i) => {
      for (let j = 0; j < 3; j++) {
        const v = tri[t * 3 + j]!;
        let nvv = remap.get(v);
        if (nvv === undefined) { nvv = remap.size; remap.set(v, nvv); pos.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!); }
        idx[i * 3 + j] = nvv;
      }
    });
    bodies.push({ positions: Float64Array.from(pos), tri: idx });
  }
  return bodies;
}
