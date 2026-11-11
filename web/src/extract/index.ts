// 속성 추출: CAD 형상 · 부품 이름 · 사양서 본문에서 후보를 뽑는다. 모두 순수 함수라 화면 · 서버 어디서든 쓴다.
// 원칙(OPMS 와 같다): 원문에 없는 값은 채우지 않는다. 뽑은 값은 근거와 신뢰도를 붙인 후보이고, 사람이 확정해야 부품 속성이 된다.
// 설명: docs/attribute-extraction.md
import { extractCad } from './cad';
import { extractSpec } from './spec';
import type { CadPartInput, PartAttributes } from './types';

export type { CadPartInput, ExtractedAttribute, PartAttributes } from './types';

/** CAD 부품 목록에서 형상 · 이름 기반 속성 후보를 뽑는다 (치수 · 두께 · 규격 표기 · 체적) */
export function extractCadAttributes(parts: CadPartInput[]): PartAttributes[] {
  return extractCad(parts);
}

/** 사양서 본문에서, 주어진 부품 이름에 관련된 속성 후보를 뽑는다 (토크 · 재료 · 치수 · 규격 · 정격). 부품 이름은 구절을 찾는 열쇠다 */
export function extractSpecAttributes(text: string, partNames: string[]): PartAttributes[] {
  return extractSpec(text, partNames);
}
