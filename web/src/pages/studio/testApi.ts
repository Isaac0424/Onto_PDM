// 시험 전용: 스튜디오 화면이 보유 품번 · 조립 규칙을 읽어 오는 길(PdmApi)에 시험용 답을 넣는다. 제품(앱)에는 가짜 데이터가 없다 (기본 API 는 비어 있다).
// 시험 모델 5부품(하우징 · 제어 기판 · 기판 나사 M3 · 전원 버튼 · 상부 커버)에 맞춘 작은 답만 준다. 필요한 길만 덮어쓸 수 있다.
import { createEmptyApi } from '../../api/emptyApi';
import { ApiError, type AssemblyGuide, type CadPartMatch, type ItemDetail, type PdmApi } from '../../api/types';

const MATCHES: Record<string, Omit<CadPartMatch, 'name'>> = {
  '전원 버튼': {
    status: 'matched', itemNo: 'P-T0000000160', itemName: '전원 버튼', method: 'exact', score: 1,
    classIri: 'cls:C0605', classLabel: '스위치 · 버튼', classPath: ['전기 · 전자', '스위치 · 버튼'],
  },
  '기판 나사 M3': {
    status: 'suggested', itemNo: 'P-T0000000001', itemName: '볼트 M3x8', method: 'cad_name', score: 0.97,
    classIri: 'cls:C0101', classLabel: '볼트', classPath: ['체결류', '볼트'],
  },
  '하우징': {
    status: 'suggested', itemNo: 'P-T0000000124', itemName: 'J1 하우징', method: 'fuzzy', score: 0.55,
    classIri: 'cls:C0401', classLabel: '하우징', classPath: ['하우징 · 커버', '하우징'],
  },
  '상부 커버': { status: 'none', classIri: 'cls:C0402', classLabel: '커버', classPath: ['하우징 · 커버', '커버'] },
};

const base = { operation: 'mount' as const, operationLabel: '장착', source: '시험용 규칙', tools: [] as string[] };
const GUIDES: Record<string, Omit<AssemblyGuide, 'partName'>> = {
  '제어 기판': {
    ...base, ruleId: 'SP-ELC-01', ruleName: '제어 기판 장착', title: '제어 기판 장착',
    caption: '입력 포트가 왼쪽, 출력 포트가 오른쪽으로 오도록 놓습니다.',
    params: [{ label: '입력 포트 위치', value: '왼쪽 (−X)' }, { label: '출력 포트 위치', value: '오른쪽 (+X)' }],
    cautions: ['정전기 방지 손목 스트랩을 착용합니다.'],
  },
  '상부 커버': {
    ...base, operation: 'cover', operationLabel: '덮개', ruleId: 'SP-COV-01', ruleName: '커버 체결', title: '상부 커버 체결', caption: '커버를 덮고 나사로 고정합니다.',
    params: [{ label: '필요한 나사 길이', value: '≥ 7.5 mm (두께 + 1.5 × 지름)' }], cautions: [],
  },
};

const detailOf = (itemNo: string): ItemDetail => ({
  id: 160, itemNo, name: 'Power button', nameKo: '전원 버튼', itemType: 'purchased', unit: 'EA', classIri: 'cls:C0605',
  attributes: { 정격: '12V 50mA', 접점: 'NO' }, createdBy: 1, revisions: [], identifiers: [], inventory: [], products: [],
});

export function studioTestApi(override: Partial<PdmApi> = {}): PdmApi {
  return {
    ...createEmptyApi(),
    connected: true,
    matchCadParts: async names => names.map(name => ({ name, ...(MATCHES[name] ?? { status: 'none' as const }) })),
    getItem: async itemNo => {
      if (itemNo !== 'P-T0000000160') throw new ApiError(`품목 ${itemNo}을(를) 찾을 수 없습니다`, 404);
      return detailOf(itemNo);
    },
    getAssemblyGuides: async parts => parts.flatMap(p => (GUIDES[p.name] ? [{ partName: p.name, ...GUIDES[p.name]! }] : [])),
    ...override,
  };
}
