// OPMS 분류 등록 요청 초안: 형상으로 본 볼트 종류가 OPMS 에 아직 없는 클래스(제안)일 때, 요청에 실을 클래스 이름 · 정의 · 근거를 만든다.
// PDM 의 등록 요청 화면은 삭제돼서 이 초안은 보내지 않는다. 사람이 복사해서 OPMS 팀에 전달한다(docs/opms-request-bolt-shape.md).
import type { ExtractedAttribute } from '../../extract';
import type { FastenerCandidate } from '../../extract/fastener';

/** 요청 본문에 싣는 속성 키: 형상 분류가 만든 것만 */
const SHAPE_KEYS = ['headType', 'driveType', 'threadSize', 'length', 'socketSize'];

/** OPMS 에 요청할 정의 문장 (docs/opms-request-bolt-shape.md 2절) */
const DEFINITION: Record<string, { labelEn: string; definition: string }> = {
  ButtonHeadBolt: { labelEn: 'Button head cap screw', definition: '낮은 돔형 머리에 육각 구멍이 있어 육각 렌치로 조이는 볼트' },
  CountersunkHeadBolt: { labelEn: 'Countersunk head cap screw', definition: '윗면이 평평한 90도 원뿔 머리에 육각 구멍이 있어 체결면에 묻히는 볼트' },
};

export interface ClassRequestDraft {
  kind: 'new_class_proposal';
  source: 'onto-pdm:cad-shape';
  part: string;
  proposedClass: { code: string; label: string; labelEn?: string; parent: 'Bolt'; headType: string; definition?: string };
  /** 이 부품에서 형상으로 뽑은 값(후보) */
  attributes: { key: string; label: string; value: string | number; unit?: string; confidence: number; estimated: boolean; confirmed: boolean; evidence: string }[];
  /** 클래스를 고른 형상 근거 */
  evidence: string[];
  /** OPMS 필수 속성(상위 분류 기준) 중 CAD 로 채우지 못해 OPMS 검토 화면에서 채워야 하는 것 */
  missingRequired: { key: string; label: string }[];
  notes: string[];
}

/**
 * 미등록(제안) 클래스를 확정한 부품의 등록 요청 초안. 등록된 클래스면 요청할 것이 없어 undefined.
 * confirmedKeys: 사람이 확정한 속성 키(요청에서 구분해 보인다).
 */
export function classRequestDraft(
  part: string, cand: FastenerCandidate, attrs: ExtractedAttribute[], confirmedKeys: ReadonlySet<string> = new Set(),
  missingRequired: readonly { key: string; label: string }[] = [],
): ClassRequestDraft | undefined {
  if (!cand.proposed) return undefined;
  const info = DEFINITION[cand.classCode];
  return {
    kind: 'new_class_proposal',
    source: 'onto-pdm:cad-shape',
    part,
    proposedClass: {
      code: cand.classCode, label: cand.label, ...(info ? { labelEn: info.labelEn } : {}), parent: 'Bolt', headType: cand.headType,
      ...(info ? { definition: info.definition } : {}),
    },
    attributes: attrs.filter(a => a.source === 'cad' && SHAPE_KEYS.includes(a.key)).map(a => ({
      key: a.key, label: a.label, value: a.value, ...(a.unit ? { unit: a.unit } : {}), confidence: a.confidence,
      estimated: !!a.estimated, confirmed: confirmedKeys.has(a.key), evidence: a.evidence,
    })),
    evidence: cand.evidence,
    missingRequired: missingRequired.map(m => ({ key: m.key, label: m.label })),
    notes: [
      'OPMS 에 아직 없는 분류입니다. headType 값으로 구분하려면 CR-NEXT-head-type-ontology 가 먼저 적용돼야 합니다.',
      '값은 CAD 형상에서 추정한 후보입니다(강도 등급 · 재질 · 도금 · 피치는 형상으로 알 수 없습니다).',
      ...(missingRequired.length > 0
        ? [`OPMS 필수 속성 중 비어 있는 것(상위 분류 볼트 기준): ${missingRequired.map(m => m.label).join(', ')}. 등록 요청 때 OPMS 검토 화면에서 채워야 합니다.`]
        : []),
    ],
  };
}

export const classRequestText = (d: ClassRequestDraft) => JSON.stringify(d, null, 2);
