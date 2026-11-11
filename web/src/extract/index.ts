// 속성 추출: CAD 형상 · 부품 이름 · 사양서 본문에서 후보를 뽑는다. 모두 순수 함수라 화면 · 서버 어디서든 쓴다.
// 원칙(OPMS 와 같다): 원문에 없는 값은 채우지 않는다. 뽑은 값은 근거와 신뢰도를 붙인 후보이고, 사람이 확정해야 부품 속성이 된다.
// 설명: docs/attribute-extraction.md (볼트 형상 분류: docs/fastener-classification.md)
import { extractCad } from './cad';
import { classifyFastener } from './fastener';
import { fastenerAttributes } from './fastener.attributes';
import { extractSpec } from './spec';
import type { CadPartInput, PartAttributes } from './types';

export type { CadPartInput, ExtractedAttribute, PartAttributes, PartMesh } from './types';
export { classifyFastener, HEAD_TYPE_LABEL } from './fastener';
export type { DriveCode, FastenerCandidate, FastenerGeometry, FastenerMesh, FastenerRecess, FastenerResult, HeadType } from './fastener';
export { fastenerAttributes, nominalThreadSize } from './fastener.attributes';

/** 볼트로 보이는 부품에서는 상자 크기 기반 치수(길이 · 너비 · 높이 · 두께)가 머리까지 포함한 값이라 규격의 길이와 다르다 → 형상 분류 값으로 바꾼다 */
const BBOX_KEYS = new Set(['length', 'width', 'height', 'thickness']);

/**
 * CAD 부품 목록에서 형상 · 이름 기반 속성 후보를 뽑는다 (치수 · 두께 · 규격 표기 · 체적).
 * 부품에 mesh 가 있으면 볼트 형상 분류도 돌려 머리 모양 · 구동부 · 나사 규격 · 길이 · 육각구멍 크기 후보를 더한다(볼트가 아니면 아무것도 더하지 않는다).
 */
export function extractCadAttributes(parts: CadPartInput[]): PartAttributes[] {
  return extractCad(parts).map((pa, i) => {
    const part = parts[i]!;
    if (!part.mesh && !part.fastener) return pa;
    const result = part.fastener ?? classifyFastener({ ...part.mesh!, unit: part.mesh!.unit ?? part.unit });
    if (!result) return pa;
    return {
      partName: pa.partName,
      attributes: [...pa.attributes.filter(a => !(a.source === 'cad' && BBOX_KEYS.has(a.key))), ...fastenerAttributes(result)],
    };
  });
}

/** 사양서 본문에서, 주어진 부품 이름에 관련된 속성 후보를 뽑는다 (토크 · 재료 · 치수 · 규격 · 정격). 부품 이름은 구절을 찾는 열쇠다 */
export function extractSpecAttributes(text: string, partNames: string[]): PartAttributes[] {
  return extractSpec(text, partNames);
}
