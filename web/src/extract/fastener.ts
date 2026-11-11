// CAD 형상으로 볼트 종류를 판단한다 (순수 함수, three.js 에 의존하지 않는다).
//   형상 → 특징(머리 윤곽 · 단면 · 윗면 구멍 · 지름 · 길이) → 클래스 후보 점수 → 속성 후보(fastener.attributes.ts)
// 원칙(OPMS 와 같다): 뽑은 값은 근거와 신뢰도를 붙인 후보이고 사람이 확정해야 한다. 형상으로 알 수 없는 것(강도 등급 · 재질 · 도금 · 피치)은 만들지 않는다.
// 클래스 이름과 headType 은 OPMS 가 소유한다. OPMS 에 없는 클래스는 proposed 로만 표시한다 (docs/opms-request-bolt-shape.md, docs/fastener-classification.md).
import { mmFactor, isUnitUnspecified } from './cad';
import type { PartMesh } from './types';
import { FASTENER_CLASSES, FASTENER_CONFIG as C, type FastenerClassSpec, type HeadType, type Trap } from './fastener.config';
import {
  findFrame, finiteMax, finiteMin, harmonic, median, normalizeMesh, planeStat, prepare, rayProfile, sectionAt, splitBodies,
  type Prepared, type Sections, type TriMesh,
} from './fastener.geometry';

export type { HeadType } from './fastener.config';

export type FastenerMesh = PartMesh;

/** OPMS 의 구동부(driveType) 후보 값 (요청서 요청 3: 후속) */
export type DriveCode = 'HexSocket' | 'Torx' | 'Phillips' | 'Slotted' | 'ExternalHex';
export type RecessKind = 'hex' | 'lobed' | 'cross' | 'slot' | 'unknown';

export interface FastenerRecess {
  present: boolean;
  /** 구멍의 모양 (present 일 때) */
  kind: RecessKind | null;
  /** 육각 구멍의 대변 (mm) */
  acrossFlats?: number;
  /** 윗면에서 구멍 바닥까지 (mm) */
  depth?: number;
}

/** 표준 호칭 지름을 어떻게 정했나: nominal = 몸통이 호칭 지름, minor = 몸통이 나사산의 골지름(외관 나사산), head = 몸통이 모델에 없어 머리 치수로 짐작 */
export type DiameterBasis = 'nominal' | 'minor' | 'head';

export interface FastenerGeometry {
  /** 나사 호칭 전의 몸통 지름 (mm). 머리만 있는 모델은 머리 치수로 짐작한 호칭 지름 */
  threadDiameter: number;
  /** 표준 호칭 지름 (mm). 몸통 지름이 호칭 · 골지름 중 어느 것과도 맞지 않으면 없다 */
  nominalDiameter?: number;
  diameterBasis?: DiameterBasis;
  /** 머리 아래에서 나사 끝까지 (mm) */
  underHeadLength: number;
  /** 머리 윗면에서 나사 끝까지 (mm). 접시머리는 이 값이 규격상의 길이다 */
  overallLength: number;
  /** 머리의 가장 큰 지름 = 육각이면 대각(꼭짓점 사이), 플랜지면 플랜지 지름 (mm) */
  headDiameter: number;
  /** 육각 머리의 대변 (mm) — 단면이 육각일 때만 */
  headAcrossFlats?: number;
  headHeight: number;
  /** 머리 윤곽 점수(0~1): 원통 · 돔 · 원뿔(접시) · 플랜지 */
  profile: { cylinder: number; dome: number; cone: number; flange: number };
  /** 머리 단면이 육각인 정도(0~1) */
  hexness: number;
  recess: FastenerRecess;
}

export interface FastenerCandidate {
  classCode: string;
  /** 한국어 클래스 이름 */
  label: string;
  headType: HeadType;
  /** 0~1. 형상 일치도 × 구동부 확인 정도 */
  score: number;
  /** OPMS 에 아직 없는 클래스(제안) */
  proposed: boolean;
  evidence: string[];
}

export interface FastenerResult {
  /** 점수 내림차순. 일치하는 것이 없으면 비어 있다(머리 모양을 정하지 못한 볼트 형상) */
  candidates: FastenerCandidate[];
  /** 1위 후보의 신뢰도(0~1): 1위 점수에서 2위와의 근접함만큼 깎는다. 후보가 없으면 0 */
  confidence: number;
  /** 구동부 정보가 없거나 1·2위가 가까워 단정할 수 없다 */
  ambiguous: boolean;
  driveType: DriveCode | null;
  geometry: FastenerGeometry;
  /** 좌표 단위 정보 */
  unit: { /** 단위를 알아서 mm 로 환산했다 */ known: boolean; /** 파일에 단위가 없어 mm 로 가정했다 */ assumed: boolean };
  /** 한 부품 안에서 볼트로 읽힌 서로 떨어진 덩어리 수(같은 이름의 볼트 여러 개가 한 부품으로 합쳐진 경우). 한 개면 1 */
  bodies?: number;
  /** 몸통이 모델에 없고 머리만 있다(호칭 · 종류는 머리 치수에서 짐작, 길이는 알 수 없다) */
  headOnly?: boolean;
}

export const HEAD_TYPE_LABEL: Record<HeadType, string> = {
  Hex: '육각 머리', HexFlange: '육각 플랜지 머리', Socket: '소켓 헤드', Button: '버튼 머리', Countersunk: '접시 머리',
};

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
/** x0 에서 0, x1 에서 1 이 되는 선형 구간 (x0 > x1 이면 작을수록 1) */
const ramp = (x: number, x0: number, x1: number) => (Number.isFinite(x) ? clamp((x - x0) / (x1 - x0)) : 0);
const trap = (x: number, [a, b, c, d]: Trap) => (x <= a || x >= d ? 0 : x < b ? (x - a) / (b - a) : x <= c ? 1 : (d - x) / (d - c));
const round = (v: number, digits = 2) => { const k = 10 ** digits; return Math.round(v * k) / k; };
const f2 = (v: number) => round(v, 2).toString();

/** 축을 따라 [zFrom, zTo] 를 n 등분한 평면들의 단면. z 는 나사 끝(0)에서 머리 윗면 쪽으로 커진다 */
interface ZSections { n: number; zs: Float64Array; sec: Sections; at(k: number): number }

function zGrid(P: Prepared, flipped: boolean, zFrom: number, zTo: number, n: number): ZSections {
  const dz = (zTo - zFrom) / n;
  const zs = new Float64Array(n);
  for (let k = 0; k < n; k++) zs[k] = zFrom + (k + 0.5137) * dz;               // 꼭짓점 높이와 우연히 겹치지 않게 비껴 잡는다
  const t0 = flipped ? P.tMax - zs[n - 1]! : P.tMin + zs[0]!;
  const sec = sectionAt(P, t0, dz, n);
  return { n, zs, sec, at: flipped ? k => n - 1 - k : k => k };
}

/** 오름차순 (z, v) 표본의 선형 보간. NaN 은 건너뛴다 */
function interp(zs: ArrayLike<number>, vs: ArrayLike<number>, z: number): number {
  let prevZ = NaN, prevV = NaN;
  for (let i = 0; i < zs.length; i++) {
    const v = vs[i]!;
    if (!Number.isFinite(v)) continue;
    if (zs[i]! >= z) {
      if (!Number.isFinite(prevZ) || zs[i] === z) return v;
      return prevV + ((z - prevZ) / (zs[i]! - prevZ)) * (v - prevV);
    }
    prevZ = zs[i]!; prevV = v;
  }
  return prevV;
}

function recessKind(inner: Float64Array): RecessKind {
  const mn = finiteMin(inner), mx = finiteMax(inner);
  if (!(mx > 0)) return 'unknown';
  const ratio = mn / mx;
  const hs = [2, 4, 6].map(k => harmonic(inner, k));
  const dom = [2, 4, 6][hs.indexOf(Math.max(...hs))]!;
  const r = C.recess;
  if (dom === 6 && ratio >= r.hexRatio[0] && ratio <= r.hexRatio[1] && hs[2]! >= C.hex.harmonicMin) return 'hex';
  if (dom === 6 && ratio < r.lobedRatio && ratio > 0.5) return 'lobed';
  if (dom === 4 && ratio < r.crossRatio) return 'cross';
  if (dom === 2 && ratio < r.slotRatio) return 'slot';
  return 'unknown';
}

const DRIVE_OF: Record<Exclude<RecessKind, 'unknown'>, DriveCode> = { hex: 'HexSocket', lobed: 'Torx', cross: 'Phillips', slot: 'Slotted' };

const recessText = (r: FastenerRecess): string => {
  if (!r.present) return '구동부 구멍을 확인하지 못함';
  const name = r.kind === 'hex' ? '육각' : r.kind === 'lobed' ? '별(Torx 형)' : r.kind === 'cross' ? '십자' : r.kind === 'slot' ? '일자' : '모양 미상의';
  const size = r.kind === 'hex' && r.acrossFlats ? `(대변 ${f2(r.acrossFlats)} mm)` : '';
  return `윗면에 ${name} 구멍${size}`;
};

/** 클래스 하나의 점수와 근거 */
/** 머리 윤곽 · 단면이 이 클래스와 맞는 정도(0~1). 치수 비율 · 구동부는 보지 않는다 */
function headFitOf(spec: FastenerClassSpec, g: FastenerGeometry): { profileFit: number; sectionFit: number } {
  const p = g.profile;
  const profileFit = Math.min(1, spec.profile.cylinder * p.cylinder + spec.profile.dome * p.dome + spec.profile.cone * p.cone + spec.profile.flange * p.flange);
  const sectionFit = spec.section === 'hex' ? g.hexness : 1 - g.hexness;
  return { profileFit, sectionFit };
}

function scoreClass(spec: FastenerClassSpec, g: FastenerGeometry, ratios: { diameter: number; across: number; height: number }): FastenerCandidate {
  const p = g.profile;
  const { profileFit, sectionFit } = headFitOf(spec, g);
  const widthVal = spec.headType === 'Hex' ? ratios.across : ratios.diameter;
  const comps = [Math.max(0.15, trap(widthVal, spec.widthRatio)), Math.max(0.15, trap(ratios.height, spec.heightRatio))];
  if (spec.hexWidthRatio) comps.push(Math.max(0.15, trap(ratios.across, spec.hexWidthRatio)));
  const ratioFit = Math.pow(comps.reduce((a, b) => a * b, 1), 1 / comps.length);
  const r = g.recess;
  const D = C.drive;
  const drive = spec.driveFamily === 'socket'
    ? (!r.present ? D.absent : r.kind === 'hex' ? D.hexSocket : r.kind === 'unknown' ? D.unknownRecess : D.otherRecess)
    : (r.present ? D.externalWithRecess : 1);
  const score = round(Math.min(0.98, profileFit * sectionFit * ratioFit * drive), 3);

  const profName = p.cone > 0.5 ? '원뿔(접시)' : p.dome > 0.5 ? '돔' : p.flange > 0.5 ? '아래 플랜지 + 위 육각' : '원통';
  const widthName = spec.headType === 'Hex' ? '대변/나사 지름' : spec.headType === 'HexFlange' ? '플랜지 지름/나사 지름' : '머리 지름/나사 지름';
  const evidence = [
    `머리 윤곽 ${profName}형, 단면 ${g.hexness >= 0.5 ? '육각' : '원형'}`,
    `${widthName} ${f2(widthVal)}(기준 ${spec.widthRatio[1]}~${spec.widthRatio[2]}), 높이/나사 지름 ${f2(ratios.height)}(기준 ${spec.heightRatio[1]}~${spec.heightRatio[2]})`
      + (spec.hexWidthRatio ? `, 육각 대변/나사 지름 ${f2(ratios.across)}` : ''),
    spec.driveFamily === 'socket' ? recessText(r) : (r.present ? `${recessText(r)} (육각 머리 계열과 맞지 않음)` : '윗면에 구멍 없음(머리 바깥을 공구로 잡는 형)'),
    `→ ${HEAD_TYPE_LABEL[spec.headType]}(추정)${spec.proposed ? ' · OPMS 미등록 제안 클래스' : ''}`,
  ];
  return { classCode: spec.classCode, label: spec.label, headType: spec.headType, score, proposed: spec.proposed, evidence };
}


// ---------- 호칭 지름 ----------

interface NominalOption { D: number; basis: DiameterBasis; err: number; ref: number }

/** 잰 지름(mm)이 맞는 표준 호칭 · 골지름 후보. 둘 다 맞을 수 있다(예: 3.14 mm = M3 호칭 +4.7% = M4 골지름) */
function nominalOptions(dMm: number): NominalOption[] {
  const out: NominalOption[] = [];
  const T = C.thread;
  for (const D of C.nominalSizes) {
    const eN = Math.abs(dMm - D) / D;
    if (eN <= C.nominalTolerance) out.push({ D, basis: 'nominal', err: eN, ref: D });
    const pitch = T.coarsePitch[D];
    if (pitch === undefined) continue;
    const minor = D - T.minorFactor * pitch;
    const eM = Math.abs(dMm - minor) / minor;
    if (eM <= T.minorTolerance) out.push({ D, basis: 'minor', err: eM, ref: minor });
  }
  return out;
}

/** 단면 중심(경계 상자의 가운데)이 평면마다 얼마나 흩어지는가(최대 반지름 대비). 하나의 회전체는 거의 0 이다 */
function axisDrift(sec: Sections, rMax: number): number {
  const cx: number[] = [], cy: number[] = [];
  for (let k = 0; k < sec.n; k++) {
    const st = planeStat(sec, k);
    if (st.count > 0 && Number.isFinite(st.R)) { cx.push(st.cx); cy.push(st.cy); }
  }
  if (cx.length === 0 || !(rMax > 0)) return 0;
  const mx = median(cx), my = median(cy);
  let worst = 0;
  for (let i = 0; i < cx.length; i++) worst = Math.max(worst, Math.hypot(cx[i]! - mx, cy[i]! - my));
  return worst / rMax;
}

interface Ctx {
  toMm: number;
  unit: FastenerResult['unit'];
  /** 파일이 단위를 분명히 적었다(mm · cm · in …). 단위가 없는 파일(STL · OBJ)은 크기를 믿을 수 없어 절대 크기 한도를 적용하지 않는다 */
  explicitUnit: boolean;
}

interface HeadInput {
  P: Prepared;
  Z: number;
  /** 머리 쪽을 촘촘히 자른 평면들(z 는 몸통 끝 쪽 0 에서 머리 윗면 쪽으로 커진다) */
  d0: ZSections;
  zd: Float64Array;
  Rd: number[];
  /** 머리가 시작하는 높이 (머리만 있으면 0) */
  zH: number;
  /** 몸통 반지름. 머리만 있으면 null */
  Rs: number | null;
  Rh: number;
  /** 머리 높이 */
  k: number;
}

/** 머리 윤곽 · 단면 · 윗면 구멍을 읽고, 호칭 지름을 정해 클래스 후보를 만든다 (몸통이 있는 볼트와 머리만 있는 볼트가 같이 쓴다) */
function describeHead(h: HeadInput, ctx: Ctx): FastenerResult | null {
  const { Z, d0, zd, Rd, zH, Rs, Rh, k } = h;
  const { toMm, unit } = ctx;
  const nD = zd.length;

  // ---- 머리 윤곽: 머리 높이를 0~1 로 본 위치의 반지름 비 ----
  const rAt = (s: number) => interp(zd, Rd, zH + s * k) / Rh;
  const r10 = rAt(0.1), r15 = rAt(0.15), r35 = rAt(0.35), r55 = rAt(0.55), r80 = rAt(0.8), r90 = rAt(0.9);
  const PR = C.profile;
  const pCone = ramp(r10, PR.coneBottom[0], PR.coneBottom[1]);
  const pDome = ramp(r35 - r90, PR.domeShrink[0], PR.domeShrink[1]) * (1 - pCone);
  const pFlange = ramp(r15 / r55, PR.flangeStep[0], PR.flangeStep[1]) * clamp(1 - (r55 - r80) / PR.flangePlateau) * (1 - pCone);
  const pCyl = (1 - pCone) * (1 - pDome) * (1 - pFlange);

  // ---- 머리 단면(육각 · 원): 위쪽 몸체의 중간 높이에서 바깥 윤곽의 반지름 비 ----
  let bodyStart = zH;
  if (pFlange > 0.3) {                                                            // 플랜지 판 위에서 육각 몸체가 시작한다
    const mid = ((r15 + r55) / 2) * Rh;
    for (let i = 0; i < nD; i++) if (zd[i]! > zH && Rd[i]! < mid) { bodyStart = zd[i]!; break; }
  }
  const nearest = (z: number) => { let b = 0; for (let i = 1; i < nD; i++) if (Math.abs(zd[i]! - z) < Math.abs(zd[b]! - z)) b = i; return b; };
  const bodyK = nearest(bodyStart + 0.45 * (Z - bodyStart));
  const body = rayProfile(d0.sec, d0.at(bodyK), C.rays);
  const oMin = finiteMin(body.outer), oMax = finiteMax(body.outer);
  const ratio = oMin / oMax;
  const h6 = harmonic(body.outer, 6);
  const otherMax = Math.max(...[3, 4, 5, 8].map(n => harmonic(body.outer, n)));
  let hexness = ramp(ratio, C.hex.ratioRound, C.hex.ratioHex);
  if (h6 < C.hex.harmonicMin || h6 < 0.8 * otherMax) hexness *= 0.2;
  const acrossFlats = 2 * oMin;

  // ---- 윗면 구멍(구동부) ----
  const zLow = Math.max(zH, Z - C.recess.scanFraction * k);
  const scan: { k: number; z: number; rp: ReturnType<typeof rayProfile> }[] = [];
  for (let i = nD - 1; i >= 0 && zd[i]! >= zLow; i--) scan.push({ k: i, z: zd[i]!, rp: rayProfile(d0.sec, d0.at(i), C.rays) });
  const holes = scan.filter(s => s.rp.holeFraction >= C.recess.holeFraction);
  const recess: FastenerRecess = { present: holes.length >= C.recess.minPlanes, kind: null };
  if (recess.present) {
    const deepest = Math.min(...holes.map(s => s.z));
    const depth = Z - deepest;
    const target = Z - C.recess.measureDepthFraction * depth;
    const pick = holes.reduce((a, b) => (Math.abs(b.z - target) < Math.abs(a.z - target) ? b : a));
    recess.kind = recessKind(pick.rp.inner);
    recess.depth = round(depth * toMm, 3);
    if (recess.kind === 'hex') recess.acrossFlats = round(2 * finiteMin(pick.rp.inner) * toMm, 3);
  }

  const geometry: FastenerGeometry = {
    threadDiameter: 0,
    underHeadLength: round(zH * toMm, 4),
    overallLength: round(Z * toMm, 4),
    headDiameter: round(2 * Rh * toMm, 4),
    ...(hexness >= 0.5 ? { headAcrossFlats: round(acrossFlats * toMm, 4) } : {}),
    headHeight: round(k * toMm, 4),
    profile: { cylinder: round(pCyl, 3), dome: round(pDome, 3), cone: round(pCone, 3), flange: round(pFlange, 3) },
    hexness: round(hexness, 3),
    recess,
  };

  // ---- 호칭 지름과 클래스 후보 ----
  const rank = (dInt: number): FastenerCandidate[] => {
    const ratios = { diameter: (2 * Rh) / dInt, across: acrossFlats / dInt, height: k / dInt };
    return FASTENER_CLASSES
      .map(spec => scoreClass(spec, geometry, ratios))
      .filter(c => c.score >= C.minScore)
      .sort((a, b) => b.score - a.score);
  };
  const headOnly = Rs === null;
  const dMeasured = headOnly ? NaN : 2 * Rs!;
  let candidates: FastenerCandidate[] = [];
  let nominal: { D: number; basis: DiameterBasis; note: string } | undefined;

  if (headOnly) {
    // 몸통이 없다: 표준 호칭 중 머리 치수가 가장 잘 맞는 것을 짐작한다
    let bestScore = 0;
    for (const D of C.nominalSizes) {
      const c = rank(D / toMm);
      if (c.length && c[0]!.score > bestScore) {
        bestScore = c[0]!.score;
        candidates = c;
        nominal = { D, basis: 'head', note: `몸통이 모델에 없어 머리 치수(지름 ${f2(geometry.headDiameter)} mm, 높이 ${f2(geometry.headHeight)} mm)에서 M${D}로 짐작함` };
      }
    }
  } else {
    let bestScore = 0;
    if (unit.known) {
      for (const opt of nominalOptions(dMeasured * toMm)) {
        const c = rank(opt.D / toMm);
        const s = (c[0]?.score ?? 0) * (opt.basis === 'minor' ? C.thread.minorPrior : 1) * (1 - 3 * opt.err);
        if (c.length && s > bestScore) {
          bestScore = s;
          candidates = c;
          nominal = {
            D: opt.D, basis: opt.basis,
            note: opt.basis === 'minor'
              ? `몸통 지름 ${f2(dMeasured * toMm)} mm 는 M${opt.D} 나사산의 골지름(${f2(opt.ref)} mm)과 같고 머리 치수도 M${opt.D} 규격과 맞아 호칭을 M${opt.D}로 봄(나사산을 골지름으로 그린 모델)`
              : `몸통 지름 ${f2(dMeasured * toMm)} mm → 표준 호칭 M${opt.D}`,
          };
        }
      }
    }
    if (!nominal) candidates = rank(dMeasured);                                    // 호칭과 맞지 않으면 잰 지름 그대로 비율을 본다
  }

  if (candidates.length === 0) {
    // 머리 모양을 정하지 못했다. 머리 윤곽 · 단면이 어느 클래스와도 안 맞으면(커넥터 · 원통형 부품) 볼트로 보지 않는다. 팬 · 치즈 머리 같은 것은 남긴다
    if (headOnly) return null;
    const fit = Math.max(...FASTENER_CLASSES.map(spec => { const x = headFitOf(spec, geometry); return x.profileFit * x.sectionFit; }));
    if (fit < C.gate.emptyCandidateHeadFit) return null;
  }
  if (nominal) {
    geometry.nominalDiameter = nominal.D;
    geometry.diameterBasis = nominal.basis;
  }
  geometry.threadDiameter = round(headOnly ? nominal!.D : dMeasured * toMm, 4);

  // 근거 문장에 호칭 판단과 (머리만 있는 모델) 설명을 더한다
  const notes: string[] = [];
  if (nominal && nominal.basis !== 'nominal') notes.push(nominal.note);
  if (headOnly) notes.push('몸통(나사부)이 모델에 없어 머리만 보임 — 길이는 알 수 없음');
  if (notes.length) candidates = candidates.map(c => ({ ...c, evidence: [c.evidence[0]!, ...notes, ...c.evidence.slice(1)] }));

  const top = candidates[0], second = candidates[1];
  let confidence = top ? round(clamp(top.score * (1 - 0.5 * (second ? second.score / top.score : 0)), 0, 0.95), 3) : 0;
  if (headOnly) confidence = round(confidence * C.headOnly.confidenceFactor, 3);
  const topSpec = top ? FASTENER_CLASSES.find(s => s.classCode === top.classCode) : undefined;
  const driveUnknown = topSpec?.driveFamily === 'socket' && !recess.present;
  const ambiguous = !top || driveUnknown || (!!second && second.score / top.score >= C.ambiguousRatio);

  const driveType: DriveCode | null = recess.present
    ? (recess.kind && recess.kind !== 'unknown' ? DRIVE_OF[recess.kind] : null)
    : hexness >= 0.5 ? 'ExternalHex' : null;

  return { candidates, confidence, ambiguous, driveType, geometry, unit, ...(headOnly ? { headOnly: true } : {}) };
}

/**
 * 몸통 없이 머리만 모델링된 볼트: 곧은 옆면의 기둥이고 한쪽 윗면에만 막힌 구멍이 있어야 한다.
 * 양쪽에 구멍(너트 · 와셔)이거나 구멍이 없으면(판 · 단추) null. 어느 쪽이 윗면인지는 구멍이 있는 쪽으로 정한다.
 */
function headOnlyBody(P: Prepared, Z: number, ctx: Ctx): FastenerResult | null {
  const H = C.headOnly;
  const nD = C.densePlanes;
  let best: FastenerResult | null = null;
  for (const flipped of [false, true]) {
    const d0 = zGrid(P, flipped, 0, Z, nD);
    const zd = d0.zs;
    const Rd = Array.from(zd, (_, k) => planeStat(d0.sec, d0.at(k)).R);
    const Rh = finiteMax(Rd);
    if (!(Rh > 0)) continue;
    const aspect = Z / (2 * Rh);
    if (aspect < H.aspect[0] || aspect > H.aspect[1]) continue;
    if (Rd.filter(r => Number.isFinite(r) && r >= H.uniformBand * Rh).length / nD < H.uniformFraction) continue;   // 옆면이 곧지 않다
    let bottomHole = false;
    for (let i = 0; i < nD && zd[i]! <= H.bottomSolid * Z; i++) {
      if (rayProfile(d0.sec, d0.at(i), C.rays).holeFraction >= C.recess.holeFraction) { bottomHole = true; break; }
    }
    if (bottomHole) continue;                                                      // 바닥에도 구멍: 관통 구멍(너트 · 와셔)
    const r = describeHead({ P, Z, d0, zd, Rd, zH: 0, Rs: null, Rh, k: Z }, ctx);
    if (!r || !r.candidates.length) continue;
    const g = r.geometry;
    // 몸통이 없어 근거가 약하므로 더 엄격히 본다: 육각 구멍이 확인되고, 짐작한 호칭이 작은 볼트 범위이고, 구멍 크기가 그 호칭의 렌치 구멍 비율과 맞아야 한다
    const socketRatio = g.recess.acrossFlats && g.nominalDiameter ? g.recess.acrossFlats / g.nominalDiameter : NaN;
    const ok = g.recess.present && g.recess.kind === 'hex' && r.candidates[0]!.score >= H.minScore
      && (g.nominalDiameter ?? Infinity) <= H.maxNominal && socketRatio >= H.socketRatio[0] && socketRatio <= H.socketRatio[1];
    if (ok && (!best || r.candidates[0]!.score > best.candidates[0]!.score)) best = r;
  }
  return best;
}

/** 한 덩어리(부품 하나, 또는 한 부품 안의 볼트 하나)를 분류한다 */
function classifyBody(m: TriMesh, ctx: Ctx): FastenerResult | null {
  const { toMm } = ctx;
  const frame = findFrame(m);
  if (!frame) return null;
  const P = prepare(m, frame);
  const Z = P.tMax - P.tMin;
  if (!(Z > 0)) return null;

  // ---- 1) 전체를 한 번 훑어 머리 쪽과 몸통 반지름을 어림한다 ----
  const nC = C.coarsePlanes;
  const c0 = zGrid(P, false, 0, Z, nC);
  let zc = Array.from(c0.zs);
  let Rc = zc.map((_, k) => planeStat(c0.sec, k).R);
  const rMax0 = finiteMax(Rc);
  if (!(rMax0 > 0)) return null;
  if (axisDrift(c0.sec, rMax0) > C.gate.maxAxisDrift) return null;                // 단면 중심이 한 축 위에 있지 않다: 여러 몸체가 흩어져 있다(하나의 회전체가 아니다)
  let weight = 0, wsum = 0;
  Rc.forEach((r, k) => { if (r >= 0.9 * rMax0) { weight += k; wsum++; } });
  const flipped = wsum > 0 && weight / wsum < (nC - 1) / 2;                       // 가장 굵은 쪽을 머리로 본다
  if (flipped) { zc = zc.map(z => Z - z).reverse(); Rc = Rc.slice().reverse(); }

  const zcRange = (lo: number, hi: number) => Rc.filter((r, k) => Number.isFinite(r) && zc[k]! >= lo && zc[k]! <= hi);
  const rsEst = median(zcRange(0.08 * Z, 0.30 * Z));
  if (!(rsEst > 0) || rMax0 / rsEst < C.gate.headToShaft) return headOnlyBody(P, Z, ctx);   // 머리가 없다: 핀 · 막대 · 너트 · 와셔 · 판, 또는 머리만 있는 볼트

  let zhC = NaN;                                                                  // 머리가 시작하는 높이(어림)
  for (let k = 0; k < nC; k++) {
    if (zc[k]! < 0.05 * Z || !(Rc[k]! > 1.1 * rsEst)) continue;
    const prev = k > 0 ? Rc[k - 1]! : NaN;
    zhC = Number.isFinite(prev) ? zc[k - 1]! + clamp((1.1 * rsEst - prev) / (Rc[k]! - prev)) * (zc[k]! - zc[k - 1]!) : zc[k]!;
    break;
  }
  if (!Number.isFinite(zhC)) return headOnlyBody(P, Z, ctx);
  const dzC = Z / nC;

  // ---- 2) 머리 근처를 촘촘히 다시 본다 ----
  const nD = C.densePlanes;
  const zFrom = Math.max(0, zhC - 3.5 * dzC);
  const d0 = zGrid(P, flipped, zFrom, Z, nD);
  const zd = d0.zs;
  const Rd = Array.from(zd, (_, k) => planeStat(d0.sec, d0.at(k)).R);

  const shaftSamples = zcRange(0.1 * zhC, zhC - 1.5 * dzC);
  const Rs = shaftSamples.length >= 3 ? median(shaftSamples) : rsEst;
  let zH = NaN;
  for (let k = 0; k < nD; k++) {
    if (!(Rd[k]! > 1.04 * Rs)) continue;
    const prev = k > 0 ? Rd[k - 1]! : NaN;
    zH = Number.isFinite(prev) ? zd[k - 1]! + clamp((1.04 * Rs - prev) / (Rd[k]! - prev)) * (zd[k]! - zd[k - 1]!) : zd[k]!;
    break;
  }
  if (!Number.isFinite(zH)) return headOnlyBody(P, Z, ctx);
  const Rh = finiteMax(Rd);
  const d = 2 * Rs;
  const k = Z - zH;
  const G = C.gate;
  if (Rh / Rs < G.headToShaft || zH / d < G.lengthRatio[0] || zH / d > G.lengthRatio[1]) return null;
  if (k / d < G.headHeightRatio[0] || k / d > G.headHeightRatio[1] || Z / d < G.overallRatio) return null;
  if (ctx.explicitUnit && d * toMm > G.maxShaftDiameterMm) return null;           // 몸통이 너무 굵다(팔 · 하우징). 단위가 분명할 때만 절대 크기를 본다
  const tipR = finiteMax(zcRange(0, 0.06 * Z));
  if (Number.isFinite(tipR) && tipR > G.tipMax * Rs) return null;                  // 양쪽이 모두 굵다
  const band = zcRange(0.1 * zH, zH - dzC);
  if (band.length >= 2 && band.filter(r => Math.abs(r / Rs - 1) <= G.shaftBand).length / band.length < G.shaftBandFraction) return null;   // 몸통이 고르지 않다(뾰족 · 테이퍼)

  return describeHead({ P, Z, d0, zd, Rd, zH, Rs, Rh, k }, ctx);
}

/**
 * 볼트 형상으로 머리 종류 후보를 만든다. 볼트로 보이지 않으면(판 · 상자 · 핀 · 너트 · 와셔 · 머리 없는 막대) null.
 * 입력은 월드 좌표의 삼각형 메시(한 부품). 임의 방향 · 위치 · 균일 배율이어도 같은 결과를 낸다.
 * 부품 전체가 볼트로 읽히지 않을 때, 서로 떨어진 덩어리가 여럿이면(같은 이름의 볼트 여러 개가 한 부품으로 합쳐진 경우)
 * 덩어리마다 분류해 가장 많은 종류의 결과를 돌려주고 bodies 에 볼트로 읽힌 덩어리 수를 적는다.
 */
export function classifyFastener(mesh: FastenerMesh): FastenerResult | null {
  const m = normalizeMesh(mesh.positions, mesh.indices);
  if (!m || m.tri.length / 3 < C.minTriangles) return null;

  // 단위: 모르면 mm 로 가정. 모르는 단위(furlong)면 치수는 만들지 않는다(known=false)
  const factor = mmFactor(mesh.unit);
  const unit = { known: factor !== undefined, assumed: isUnitUnspecified(mesh.unit) && mesh.unit !== undefined };
  const ctx: Ctx = { toMm: factor ?? 1, unit, explicitUnit: factor !== undefined && mesh.unit !== undefined && !isUnitUnspecified(mesh.unit) };

  // 먼저 부품 전체를 한 덩어리로 본다. 볼트 하나(머리와 나사 끝 사이가 비어 있는 모델 포함)로 뚜렷하게 읽히면 여기서 끝난다
  const whole = classifyBody(m, ctx);
  if (whole && whole.confidence >= C.split.trustWhole) return { ...whole, bodies: 1 };

  // 볼트로 읽히지 않거나 근거가 약하면 서로 떨어진 덩어리로 나눠 본다(같은 볼트 여러 개가 한 부품으로 합쳐진 경우)
  const nTri = m.tri.length / 3;
  const parts = nTri <= C.split.maxTriangles ? splitBodies(m, C.split.weldTolerance, C.split.maxBodies) : null;
  if (!parts) return whole ? { ...whole, bodies: 1 } : null;                        // 한 덩어리(또는 너무 큰 부품): 전체 결과를 그대로

  const found = parts
    .filter(p => p.tri.length / 3 >= C.minTriangles)
    .map(p => classifyBody(p, ctx))
    .filter((r): r is FastenerResult => r !== null);
  if (found.length === 0) return null;

  // 가장 많은 종류(1위 클래스)의 결과를 대표로 삼는다. 같은 수면 신뢰도가 높은 쪽
  const groups = new Map<string, FastenerResult[]>();
  for (const r of found) {
    const key = r.candidates[0]?.classCode ?? '-';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length || b[0]!.confidence - a[0]!.confidence)[0]!;
  const rep = [...best].sort((a, b) => b.confidence - a.confidence)[0]!;
  const bodyNote = groups.size === 1
    ? `한 부품 안에 같은 모양의 볼트 ${found.length}개가 떨어져 있어 하나의 형상으로 판단함`
    : `한 부품 안에 볼트 ${found.length}개가 있고 가장 많은 종류(${best.length}개)의 형상으로 판단함`;
  const candidates = rep.candidates.map(c => ({ ...c, evidence: [c.evidence[0]!, ...(found.length > 1 ? [bodyNote] : []), ...c.evidence.slice(1)] }));
  return { ...rep, candidates, bodies: found.length };
}
