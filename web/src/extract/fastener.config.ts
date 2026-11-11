// 볼트 형상 분류의 설정. 코드와 분리해 둔 이유: 이 값들은 "정본"이 아니라 PDM 쪽 분류기 설정이다.
// 정본(클래스 · headType 값)은 OPMS 가 소유한다(docs/opms-request-bolt-shape.md). OPMS 에 반영되면 classCode · headType 은 OPMS 에서 읽고 이 표는 줄인다.
//
// 비율 구간(Trap)은 ISO 4014/4017(육각), 4162·15072(육각 플랜지), 4762(소켓), 7380(버튼), 10642(접시)의 M4~M12 대표 치수에서 잡은 **참고치**다.
// 표준 표로 검증하기 전까지는 참고치로만 본다(docs/fastener-classification.md). 구간 경계에서 점수가 뚝 끊기지 않게 사다리꼴로 둔다.

/** 사다리꼴 구간: [0 이 되는 하한, 1 이 되기 시작, 1 이 끝남, 0 이 되는 상한] */
export type Trap = readonly [number, number, number, number];

/** OPMS 의 headType 값 (CR-NEXT-head-type-ontology 4.9절 목록 중 CAD 에서 구분하는 것) */
export type HeadType = 'Hex' | 'HexFlange' | 'Socket' | 'Button' | 'Countersunk';

export interface FastenerClassSpec {
  classCode: string;
  label: string;
  labelEn: string;
  headType: HeadType;
  /** OPMS 에 아직 없는 클래스(요청서 요청 2). 화면에는 "제안(미등록)"으로만 표시한다 */
  proposed: boolean;
  /** 머리 윤곽 가중치(0~1): 이 클래스가 어떤 윤곽을 가진 머리인가. 단순화한 모델(윤곽이 뭉개진 것)도 낮게 인정한다 */
  profile: { cylinder: number; dome: number; cone: number; flange: number };
  /** 머리 단면: hex = 육각, round = 원 */
  section: 'hex' | 'round';
  /** 육각 머리 클래스는 대변, 플랜지는 플랜지 지름, 나머지는 머리 지름을 나사 지름으로 나눈 값 */
  widthRatio: Trap;
  /** 플랜지 클래스에서 위쪽 육각의 대변 / 나사 지름 */
  hexWidthRatio?: Trap;
  /** 머리 높이 / 나사 지름 (접시머리는 원뿔 높이, 플랜지는 플랜지 두께 포함) */
  heightRatio: Trap;
  /** socket: 윗면 구멍(렌치 구멍)이 있는 계열, external: 구멍 없이 머리 바깥을 공구로 잡는 계열 */
  driveFamily: 'socket' | 'external';
}

export const FASTENER_CLASSES: readonly FastenerClassSpec[] = [
  {
    classCode: 'HexBolt', label: '육각볼트', labelEn: 'Hex bolt', headType: 'Hex', proposed: false,
    profile: { cylinder: 1, dome: 0, cone: 0, flange: 0 }, section: 'hex',
    widthRatio: [1.30, 1.45, 1.85, 2.05], heightRatio: [0.40, 0.52, 0.85, 1.0], driveFamily: 'external',
  },
  {
    classCode: 'HexFlangeBolt', label: '육각플랜지볼트', labelEn: 'Hex flange bolt', headType: 'HexFlange', proposed: false,
    profile: { cylinder: 0, dome: 0, cone: 0, flange: 1 }, section: 'hex',
    widthRatio: [1.65, 1.85, 2.65, 2.9], hexWidthRatio: [1.30, 1.45, 1.85, 2.05], heightRatio: [0.55, 0.75, 1.3, 1.5], driveFamily: 'external',
  },
  {
    classCode: 'SocketHeadBolt', label: '육각구멍붙이볼트', labelEn: 'Socket head cap screw', headType: 'Socket', proposed: false,
    profile: { cylinder: 1, dome: 0.2, cone: 0, flange: 0 }, section: 'round',
    widthRatio: [1.30, 1.45, 1.95, 2.2], heightRatio: [0.70, 0.88, 1.15, 1.35], driveFamily: 'socket',
  },
  {
    classCode: 'ButtonHeadBolt', label: '버튼헤드볼트', labelEn: 'Button head cap screw', headType: 'Button', proposed: true,
    profile: { cylinder: 0.3, dome: 1, cone: 0, flange: 0 }, section: 'round',
    widthRatio: [1.45, 1.65, 2.05, 2.3], heightRatio: [0.32, 0.42, 0.66, 0.85], driveFamily: 'socket',
  },
  {
    classCode: 'CountersunkHeadBolt', label: '접시머리볼트', labelEn: 'Countersunk head cap screw', headType: 'Countersunk', proposed: true,
    profile: { cylinder: 0, dome: 0, cone: 1, flange: 0 }, section: 'round',
    widthRatio: [1.65, 1.88, 2.45, 2.7], heightRatio: [0.38, 0.48, 0.78, 0.95], driveFamily: 'socket',
  },
];

export const FASTENER_CONFIG = {
  /** 축을 따라 자르는 평면 수: 전체를 한 번 훑고(coarse), 머리 근처를 촘촘히(dense) 다시 본다 */
  coarsePlanes: 96,
  densePlanes: 80,
  /** 단면에서 중심으로부터 쏘는 광선 수 (육각 · 구멍 모양을 읽는 각도 해상도) */
  rays: 90,
  minTriangles: 12,

  /** 볼트 후보 게이트: 이 중 하나라도 어기면 볼트가 아니다(null) */
  gate: {
    /** 머리 최대 반지름 / 몸통 반지름 */
    headToShaft: 1.3,
    /** 몸통 구간에서 반지름이 몸통 값의 ±이 비율 안에 있어야 하는 표본의 비율 */
    shaftBand: 0.1,
    shaftBandFraction: 0.8,
    /** 반대쪽 끝(나사 끝)의 최대 반지름 / 몸통 반지름. 이보다 굵으면 양쪽이 모두 굵은 부품 */
    tipMax: 1.15,
    /** 머리 아래 길이 / 나사 지름 */
    lengthRatio: [0.5, 40] as const,
    /** 머리 높이 / 나사 지름 */
    headHeightRatio: [0.3, 1.6] as const,
    /** 전체 길이 / 나사 지름 */
    overallRatio: 1.0,
    /** 평면마다 단면 중심(경계 상자의 가운데)이 중앙값에서 벗어나는 최대 거리 / 최대 반지름. 이보다 크면 한 축의 회전체가 아니다(흩어진 여러 몸체) */
    maxAxisDrift: 0.12,
    /** 몸통 지름의 상한(mm). 표준 호칭 중 가장 큰 M48 에 여유를 둔 값: 이보다 굵은 몸통은 볼트가 아니다(팔 · 하우징 같은 큰 부품) */
    maxShaftDiameterMm: 52,
    /** 후보가 하나도 없을 때(머리 모양을 정하지 못함) 이 값 미만이면 볼트 결과로 내지 않는다: 머리 윤곽 × 단면이 어느 클래스와도 거의 안 맞는 커넥터 · 원통 부품 */
    emptyCandidateHeadFit: 0.5,
  },

  /**
   * 외관 나사산: 모델이 나사 몸통을 호칭 지름이 아니라 나사산의 골지름(minor diameter = D − 1.2269·P)으로 그리는 경우가 흔하다
   * (실제 STEP: 호칭 M4 볼트의 몸통이 3.14 mm = M4 골지름, M3 는 2.39 mm). 잰 지름이 호칭과 골지름 둘 다에 맞을 수 있어,
   * 머리 치수(머리 지름 · 높이)가 규격과 맞는 쪽을 고른다. 보통 나사(coarse) 피치 기준(ISO 261).
   */
  thread: {
    coarsePitch: {
      1.6: 0.35, 2: 0.4, 2.5: 0.45, 3: 0.5, 3.5: 0.6, 4: 0.7, 5: 0.8, 6: 1, 8: 1.25, 10: 1.5, 12: 1.75, 14: 2, 16: 2, 18: 2.5,
      20: 2.5, 22: 2.5, 24: 3, 27: 3, 30: 3.5, 33: 3.5, 36: 4, 42: 4.5, 48: 5,
    } as Readonly<Record<number, number>>,
    /** 골지름 = 호칭 − 이 계수 × 피치 (ISO 68-1 외나사) */
    minorFactor: 1.2269,
    /** 잰 지름이 골지름의 ±이 비율 안이면 골지름으로 모델링한 것으로 본다 */
    minorTolerance: 0.03,
    /** 호칭과 골지름이 같은 점수일 때 호칭을 우선하는 가중치(골지름 쪽에 곱한다) */
    minorPrior: 0.85,
  },

  /** 한 부품 안에 볼트가 여러 개 합쳐져 있을 때(같은 이름의 볼트들이 한 부품으로 묶임) 서로 떨어진 덩어리로 나눈다 */
  split: {
    /** 부품 전체를 한 덩어리로 분류한 결과의 신뢰도가 이 이상이면 나누지 않고 그대로 쓴다(약하면 흩어진 여러 몸체일 수 있어 나눠 본다) */
    trustWhole: 0.45,
    /** 이 삼각형 수를 넘는 부품은 나누지 않는다(볼트 묶음이 아니다: M4 볼트 하나가 600~700개) */
    maxTriangles: 12000,
    /** 덩어리가 이보다 많으면 볼트 묶음이 아니다 */
    maxBodies: 64,
    /** 꼭짓점을 같은 점으로 보는 거리(부품 크기 대비) */
    weldTolerance: 5e-5,
  },

  /**
   * 머리만 모델링된 볼트(몸통이 없다). 원통 · 육각 기둥 모양이고 한쪽 윗면에만 막힌 구멍이 있어야 한다
   * (양쪽 구멍 = 너트 · 와셔, 구멍 없음 = 판 · 단추는 볼트로 보지 않는다).
   */
  headOnly: {
    /** 높이 / 머리 지름 범위 */
    aspect: [0.25, 1.2] as const,
    /** 반지름이 최대의 이 비 이상인 평면이 전체의 이 비율 이상이어야 한다(옆면이 곧은 기둥) */
    uniformBand: 0.88,
    uniformFraction: 0.45,
    /** 바닥 쪽 이 비율 구간에는 구멍이 없어야 한다(막힌 구멍). 렌치 구멍은 깊어서(실제 모델은 머리 높이의 약 80%) 바닥 가까이만 본다 */
    bottomSolid: 0.15,
    /** 몸통이 없어 호칭 · 길이를 머리에서 짐작하므로 신뢰도에 곱한다 */
    confidenceFactor: 0.7,
    /** 1위 후보 점수가 이 이상이어야 한다 */
    minScore: 0.6,
    /** 머리에서 짐작한 호칭의 상한(mm): 이보다 큰 볼트 머리로 보이는 것은 하우징 · 마운트 같은 큰 부품이다 */
    maxNominal: 24,
    /** 렌치 구멍 대변 / 호칭 지름 (ISO 4762: M3 0.83, M4 0.75, M6 0.83, M8 0.75, M12 0.83) */
    socketRatio: [0.5, 0.95] as const,
  },

  /** 머리 윤곽을 읽는 기준(머리 높이를 0~1 로 본 위치의 반지름 비) */
  profile: {
    /** 머리 아래(s=0.1) 반지름이 머리 최대의 이 비 이하이면 원뿔(접시)이다: [0점 경계, 1점 경계] */
    coneBottom: [0.78, 0.58] as const,
    /** 위쪽 줄어듦(r(0.35)-r(0.9))이 클수록 돔(버튼): [0점 경계, 1점 경계] */
    domeShrink: [0.08, 0.20] as const,
    /** 아래 판의 반지름 / 위쪽 반지름 (플랜지): [0점 경계, 1점 경계] */
    flangeStep: [1.04, 1.12] as const,
    /** 플랜지의 위쪽이 평평해야 하는 한도(r(0.55)-r(0.8)) */
    flangePlateau: 0.06,
  },

  /** 단면이 육각인가: 외곽 반지름의 최소/최대 비 (정육각형 = 0.866, 원 ≈ 1) */
  hex: { ratioHex: 0.92, ratioRound: 0.97, harmonicMin: 0.02 },

  /** 윗면 구멍(구동부) */
  recess: {
    /** 광선 중 이 비율 이상이 두 번 이상 경계를 만나면 구멍이 있는 단면이다 */
    holeFraction: 0.25,
    /** 구멍이 있는 평면이 이 수 이상 이어져야 구멍으로 본다 */
    minPlanes: 2,
    /** 구멍 깊이의 이 비율 위치에서 모양을 잰다 (입구 모따기를 피한다) */
    measureDepthFraction: 0.4,
    /** 머리 높이의 이 비율까지 아래로 구멍을 찾는다 */
    scanFraction: 0.95,
    hexRatio: [0.80, 0.95] as const,
    lobedRatio: 0.80,
    crossRatio: 0.6,
    slotRatio: 0.4,
  },

  /** 구동부 정보가 점수에 미치는 영향 (1 = 영향 없음) */
  drive: {
    /** 육각 구멍을 확인함 */
    hexSocket: 1,
    /** 구멍은 있으나 육각이 아닌 모양을 확인함(별 · 십자 · 일자) */
    otherRecess: 0.6,
    /** 구멍은 있으나 모양을 못 정함 */
    unknownRecess: 0.7,
    /** 구멍을 확인하지 못함(단순화한 모델일 수 있다) */
    absent: 0.55,
    /** 육각 머리 계열인데 윗면에 구멍이 있음 */
    externalWithRecess: 0.4,
  },

  /**
   * 사람이 확정하기 전에도 형상 분석이 만든 규격(추정)으로 보유 품번 후보를 찾는 조건 (fastener.estimate.ts).
   * 결과는 '후보 · 추정'으로만 보이고 품번 확정은 늘 사람이 한다. 이 조건은 "추정이 틀린 값으로 OPMS 에 묻는" 일을 줄이는 문턱이다.
   */
  autoMatch: {
    /**
     * 1위 후보의 점수가 이 이상이어야 한다. 머리만 있는 모델의 하한(headOnly.minScore)과 같은 0.6 이다:
     * 실제 STEP(12A · 3A · 5A)에서 정답 볼트의 1위 점수는 대부분 0.6 이상이고, 그 미만이면 머리 윤곽 · 단면이 어느 종류와도
     * 약하게만 맞아서 호칭 · 길이 추정도 믿기 어렵다. 여기에 1·2위가 가깝거나 구멍을 못 읽은 모델(ambiguous)은 따로 뺀다.
     */
    minScore: 0.6,
  },

  /** 이 점수 미만의 후보는 목록에 올리지 않는다 */
  minScore: 0.1,
  /** 2위/1위 점수 비가 이 이상이면 "헷갈림" */
  ambiguousRatio: 0.6,

  /** 나사 호칭 지름(mm). 잰 지름이 이 중 하나의 ±이 비율 안이면 M{호칭}으로 반올림한다 */
  nominalSizes: [1.6, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 27, 30, 33, 36, 42, 48] as const,
  nominalTolerance: 0.06,
};
