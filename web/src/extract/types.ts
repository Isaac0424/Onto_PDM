// 속성 추출의 공용 모양. 추출은 순수 함수라 화면 · 서버 어디서든 쓴다.
// 원칙(OPMS 와 같다): 원문에 없는 값은 채우지 않는다. 뽑은 값은 후보이고, 사람이 확정해야 부품 속성이 된다.

export interface ExtractedAttribute {
  /** 속성 키 (OPMS 속성 이름과 맞춘다: threadSize, length, thickness, material, torque …) */
  key: string;
  label: string;
  value: string | number;
  unit?: string;
  /** cad: CAD 형상에서 계산, name: 부품 이름의 규격 표기, spec: 사양서 구절, bom: BOM 시트 */
  source: 'cad' | 'name' | 'spec' | 'bom';
  /** 근거: 계산식이나 사양서 원문 구절 */
  evidence: string;
  /** 0~1. 형상에서 정확히 읽은 값은 높고, 추정(열린 메시의 체적 등)은 낮다 */
  confidence: number;
  /** 추정값이면 true (화면에서 "추정" 표시) */
  estimated?: boolean;
}

export interface PartAttributes {
  partName: string;
  attributes: ExtractedAttribute[];
}

export interface CadPartInput {
  name: string;
  /** CAD 크기 (x, y, z) */
  size: [number, number, number] | null;
  /** 크기의 단위 (기본 mm) */
  unit?: string;
  /** CAD 에서 읽은 체적(있으면). 열린 메시는 추정이라 estimated 를 따로 알린다 */
  volume?: number;
  /** volume 이 열린 메시 등에서 추정한 값이면 true */
  volumeEstimated?: boolean;
}
