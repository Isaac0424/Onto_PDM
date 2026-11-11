// 시험 전용: 제품 연결 그래프 화면을 시험할 작은 제품 하나. 제품(앱)에는 가짜 데이터가 없다 (기본 API 는 비어 있다).
// API 가 돌려주는 모양(PdmApi)을 그대로 따라, 화면이 읽는 길(listProducts · getItem · listClasses · getBom · getDocuments · getAssemblyGuides)만 구현한다.
//
//   T-100 시험 제품 → 시험 본체 ┬ 베이스 조립품 ┬ 베이스 커버(R00 승인 · R01 검토중)
//                              │               └ 볼트 M4x10 ×8
//                              ├ J1 관절 모듈 ┬ J1 감속기 · 볼트 M3x8 ×12 · 볼트 M4x10 ×6
//                              ├ J2 관절 모듈 ┬ J2 감속기 · 볼트 M3x8 ×12
//                              ├ 케이블 하네스
//                              └ (최상위 조립품 R02 · 작업중에만) J1 브레이크
import { createEmptyApi } from '../../api/emptyApi';
import {
  ApiError,
  type AssemblyGuide, type AssemblyPartInput, type BomNode, type BomRule, type DocumentLink, type Item, type ItemSummary, type PdmApi, type Revision,
  type RevisionStatus, type TaxonomyClass,
} from '../../api/types';

const T0 = '2026-09-01T09:00:00+09:00';

const cls = (code: string, ko: string, parent?: string): TaxonomyClass => ({ iri: `cls:${code}`, code, labelKo: ko, ...(parent ? { parentIri: `cls:${parent}` } : {}), kind: 'part' });
const CLASSES: TaxonomyClass[] = [
  cls('C01', '체결류'), cls('C0101', '볼트', 'C01'),
  cls('C04', '하우징 · 커버'), cls('C0402', '커버', 'C04'),
  cls('C05', '동력 전달'), cls('C0501', '감속기', 'C05'),
  cls('C06', '전기 · 전자'), cls('C0603', '케이블 하네스', 'C06'),
];

const ITEMS: Item[] = [];
const item = (id: number, itemNo: string, name: string, itemType: Item['itemType'], classCode?: string, attributes: Item['attributes'] = {}) => {
  ITEMS.push({ id, itemNo, name, nameKo: name, itemType, unit: 'EA', ...(classCode ? { classIri: `cls:${classCode}` } : {}), attributes, createdBy: 1 });
  return id;
};
const ROOT = item(100, 'P-T0000000100', '시험 본체', 'assembly');
const BASE = item(110, 'P-T0000000110', '베이스 조립품', 'assembly');
const J1 = item(120, 'P-T0000000120', 'J1 관절 모듈', 'assembly');
const J2 = item(130, 'P-T0000000130', 'J2 관절 모듈', 'assembly');
const COVER = item(112, 'P-T0000000112', '베이스 커버', 'part', 'C0402');
const RED1 = item(121, 'P-T0000000121', 'J1 감속기', 'purchased', 'C0501', { 감속비: '100:1', '허용 순간 토크(N·m)': 147 });
const RED2 = item(131, 'P-T0000000131', 'J2 감속기', 'purchased', 'C0501', { 감속비: '100:1' });
const M3 = item(1, 'P-T0000000001', '볼트 M3x8', 'standard', 'C0101', { '호칭 지름': 'M3', '길이(mm)': 8, 규격: 'ISO 4762' });
const M4 = item(2, 'P-T0000000002', '볼트 M4x10', 'standard', 'C0101', { '호칭 지름': 'M4', '길이(mm)': 10, 규격: 'ISO 4762' });
const CABLE = item(140, 'P-T0000000140', '케이블 하네스', 'purchased', 'C0603');
const BRAKE = item(150, 'P-T0000000150', 'J1 브레이크', 'purchased');

const REVS: Revision[] = [];
let revSeq = 0;
const rev = (itemId: number, r: string, seq: number, status: RevisionStatus) => {
  revSeq += 1;
  REVS.push({ id: revSeq, itemId, rev: r, revSeq: seq, status, createdBy: 1, createdAt: T0, ...(status === 'released' ? { releasedAt: T0 } : {}) });
  return revSeq;
};
const R: Record<string, number> = {
  root: rev(ROOT, 'R01', 1, 'released'), rootWip: rev(ROOT, 'R02', 2, 'wip'),
  base: rev(BASE, 'R00', 0, 'released'), j1: rev(J1, 'R00', 0, 'released'), j2: rev(J2, 'R00', 0, 'released'),
  coverOld: rev(COVER, 'R00', 0, 'released'), coverNew: rev(COVER, 'R01', 1, 'in_review'),
  red1: rev(RED1, 'R00', 0, 'released'), red2: rev(RED2, 'R00', 0, 'released'),
  m3: rev(M3, 'R00', 0, 'released'), m4: rev(M4, 'R00', 0, 'released'), cable: rev(CABLE, 'R00', 0, 'released'), brake: rev(BRAKE, 'R00', 0, 'wip'),
};

/** 부모 리비전 → [자식 품목, 수량] */
const LINES: Record<number, [number, number][]> = {
  [R.root!]: [[BASE, 1], [J1, 1], [J2, 1], [CABLE, 1]],
  [R.rootWip!]: [[BASE, 1], [J1, 1], [J2, 1], [CABLE, 1], [BRAKE, 1]],
  [R.base!]: [[COVER, 1], [M4, 8]],
  [R.j1!]: [[RED1, 1], [M3, 12], [M4, 6]],
  [R.j2!]: [[RED2, 1], [M3, 12]],
};

const revsOf = (itemId: number) => REVS.filter(r => r.itemId === itemId).sort((a, b) => a.revSeq - b.revSeq);
const summary = (it: Item): ItemSummary => {
  const revs = revsOf(it.id);
  const released = revs.filter(r => r.status === 'released');
  return { ...it, latestRevision: revs[revs.length - 1], releasedRevision: released[released.length - 1] };
};
/** 승인본 기준이면 최신 승인본(없으면 최신), 최신 기준이면 최신 */
const effective = (itemId: number, rule: BomRule): Revision | undefined => {
  const revs = revsOf(itemId).filter(r => r.status !== 'obsolete');
  const released = revs.filter(r => r.status === 'released');
  return rule === 'released' && released.length ? released[released.length - 1] : revs[revs.length - 1];
};
const explode = (revisionId: number, rule: BomRule, depth: number, total: number): BomNode[] =>
  (LINES[revisionId] ?? []).map(([childId, qty], i) => {
    const child = ITEMS.find(x => x.id === childId)!;
    const childRev = effective(childId, rule);
    return {
      lineId: revisionId * 100 + i, depth, findNo: i + 1, quantity: qty, totalQuantity: total * qty, item: summary(child),
      ...(childRev ? { revision: childRev } : {}), children: childRev ? explode(childRev.id, rule, depth + 1, total * qty) : [],
    };
  });

const DOCS: Record<number, DocumentLink[]> = {
  [R.root!]: [
    { documentId: 1, docNo: 'D-CAD-T100', title: '시험 본체 3D', docType: 'cad_3d', linkType: 'cad_model', rev: 'R01', pinned: true, matchMethod: 'filename', status: 'confirmed' },
    { documentId: 2, docNo: 'D-SPEC-T', title: '시험 사양서', docType: 'spec', linkType: 'spec', rev: 'R02', pinned: false, matchMethod: 'manual', status: 'confirmed' },
  ],
  [R.j1!]: [{ documentId: 5, docNo: 'D-CAD-T120', title: 'J1 관절 모듈 3D', docType: 'cad_3d', linkType: 'cad_model', rev: 'R00', pinned: true, matchMethod: 'step_product', status: 'confirmed' }],
  [R.red1!]: [
    { documentId: 2, docNo: 'D-SPEC-T', title: '시험 사양서', docType: 'spec', linkType: 'spec', rev: 'R02', pinned: false, matchMethod: 'text_search', status: 'confirmed' },
    { documentId: 3, docNo: 'D-MAN-T', title: '시험 설명서', docType: 'manual', linkType: 'manual', rev: 'R00', pinned: false, matchMethod: 'text_search', status: 'suggested' },
  ],
  [R.coverOld!]: [{ documentId: 4, docNo: 'D-DRW-T112', title: '베이스 커버 도면', docType: 'drawing', linkType: 'drawing', rev: 'R00', pinned: true, matchMethod: 'filename', status: 'confirmed' }],
};

/** 이름(분류)으로 규칙을 돌려주는 가짜 엔진: 감속기 · 커버는 장착 SP-RED-01, 볼트 M3 는 볼트 체결 SP-FAS-01. 볼트 M4 와 케이블은 규칙이 없다 */
const guideFor = (p: AssemblyPartInput): AssemblyGuide | undefined => {
  const base = { partName: p.name, params: [], cautions: [], tools: [], source: '시험용 규칙', title: p.name, caption: '' };
  if (p.className === '감속기' || p.className === '커버') return { ...base, ruleId: 'SP-RED-01', ruleName: '장착 규칙', operation: 'mount', operationLabel: '장착' };
  if (p.name === '볼트 M3x8') return { ...base, ruleId: 'SP-FAS-01', ruleName: '볼트 체결 규칙', operation: 'fasten', operationLabel: '볼트 체결' };
  return undefined;
};

export const TEST_PRODUCT_CODE = 'T-100';
export const TEST_PRODUCT_NAME = '시험 제품';

/** 시험 제품이 들어 있는 API. 필요한 길만 덮어쓸 수 있다 */
export function createProductTestApi(override: Partial<PdmApi> = {}): PdmApi {
  const products = [{ id: 1, code: TEST_PRODUCT_CODE, name: TEST_PRODUCT_NAME, description: '시험용 제품', rootItemNo: 'P-T0000000100' }, { id: 2, code: 'T-200', name: '시험 제품 B', rootItemNo: 'P-T0000000200' }];
  return {
    ...createEmptyApi(),
    connected: true,
    listProducts: async () => products,
    listClasses: async () => CLASSES,
    getItem: async itemNo => {
      const it = ITEMS.find(x => x.itemNo === itemNo);
      if (!it) throw new ApiError(`품목 ${itemNo}을(를) 찾을 수 없습니다`, 404);
      return { ...summary(it), revisions: [...revsOf(it.id)].reverse(), identifiers: [], inventory: [], products: [] };
    },
    getBom: async (revisionId, rule) => explode(revisionId, rule, 1, 1),
    getDocuments: async revisionId => DOCS[revisionId] ?? [],
    getAssemblyGuides: async parts => parts.flatMap(p => guideFor(p) ?? []),
    ...override,
  };
}
