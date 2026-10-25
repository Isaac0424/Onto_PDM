// 목 데이터 — 설명용 협동로봇(HCR3A · HCR5A) 예시. 실제 품번 · 공급사 · 문서가 아니다.
import type {
  ClassProposal, Identifier, InventoryRow, Item, Material, OutboxRow, PartRequest,
  Product, Revision, RevisionStatus, TaxonomyClass, User, DocType,
} from '../types';

export interface MockDocument {
  id: number;
  docNo: string;
  title: string;
  docType: DocType;
  rev: string;
  fileName?: string;
}

export interface MockDocLink {
  revisionId: number;
  documentId: number;
  linkType: 'cad_model' | 'drawing' | 'spec' | 'manual' | 'reference';
  pinned: boolean;
  matchMethod: 'manual' | 'filename' | 'step_product' | 'bom_import' | 'text_search' | 'ai';
  confidence?: number;
  status: 'suggested' | 'confirmed' | 'rejected';
}

export interface MockPassage {
  id: number;
  revisionId: number;
  purpose: 'definition' | 'assembly' | 'disassembly' | 'reference';
  mateItemNo?: string;
  documentId: number;
  pageNo?: number;
  text: string;
  hitTerms: string[];
  score: number;
  status: 'suggested' | 'confirmed' | 'rejected';
  productScope: string[];
}

export interface MockBomLine {
  id: number;
  parentRevisionId: number;
  childItemId: number;
  quantity: number;
  findNo?: number;
}

export interface MockDb {
  version: 1;
  users: User[];
  products: Product[];
  classes: TaxonomyClass[];
  materials: Material[];
  items: Item[];
  revisions: Revision[];
  bomLines: MockBomLine[];
  identifiers: (Identifier & { itemId: number })[];
  inventory: (InventoryRow & { itemId: number })[];
  documents: MockDocument[];
  docLinks: MockDocLink[];
  passages: MockPassage[];
  partRequests: PartRequest[];
  classProposals: ClassProposal[];
  outbox: OutboxRow[];
  nextItemNo: number;
}

const T0 = '2026-09-01T09:00:00+09:00';

export function createSeed(): MockDb {
  const users: User[] = [
    { id: 1, loginId: 'kim', name: '김관리', role: 'admin' },
    { id: 2, loginId: 'lee', name: '이설계', role: 'engineer' },
  ];

  const classes: TaxonomyClass[] = [
    ['C0100', '체결류', 'Fastener'], ['C0101', '볼트', 'Bolt', 'C0100'],
    ['C0300', '조립 단위', 'Assembly unit'], ['C0301', '관절 모듈', 'Joint module', 'C0300'], ['C0302', '베이스 조립품', 'Base assembly', 'C0300'],
    ['C0400', '하우징 · 커버', 'Housing and cover'], ['C0401', '하우징', 'Housing', 'C0400'], ['C0402', '커버', 'Cover', 'C0400'],
    ['C0500', '동력 전달', 'Power transmission'], ['C0501', '감속기', 'Reducer', 'C0500'],
    ['C0600', '전기 · 전자', 'Electrical'], ['C0601', '서보 모터', 'Servo motor', 'C0600'], ['C0602', '엔코더', 'Encoder', 'C0600'],
    ['C0603', '케이블 하네스', 'Cable harness', 'C0600'], ['C0604', '브레이크', 'Brake', 'C0600'],
  ].map(([code, ko, en, parent]) => ({
    iri: `cls:${code}`, code: code!, labelKo: ko!, labelEn: en, parentIri: parent ? `cls:${parent}` : undefined, kind: 'part' as const,
  }));
  classes.push(
    { iri: 'cls:M0100', code: 'M0100', labelKo: '금속', labelEn: 'Metal', kind: 'material' },
    { iri: 'cls:M0110', code: 'M0110', labelKo: '강', labelEn: 'Steel', parentIri: 'cls:M0100', kind: 'material' },
    { iri: 'cls:M0111', code: 'M0111', labelKo: '스테인리스강', labelEn: 'Stainless steel', parentIri: 'cls:M0110', kind: 'material' },
    { iri: 'cls:M0120', code: 'M0120', labelKo: '알루미늄 합금', labelEn: 'Aluminium alloy', parentIri: 'cls:M0100', kind: 'material' },
  );

  const materials: Material[] = [
    { iri: 'mat:M000001', name: 'SUS304', aliases: ['STS304', 'AISI 304', '1.4301'], classIri: 'cls:M0111', density: 7.93 },
    { iri: 'mat:M000002', name: 'SUS316', aliases: ['STS316', 'AISI 316', '1.4401'], classIri: 'cls:M0111', density: 7.98 },
    { iri: 'mat:M000003', name: 'A6061', aliases: ['AA 6061'], classIri: 'cls:M0120', density: 2.7 },
  ];

  const items: Item[] = [];
  const add = (id: number, itemNo: string, name: string, nameKo: string, itemType: Item['itemType'], cls: string,
               extra: Partial<Item> = {}) => {
    items.push({ id, itemNo, name, nameKo, itemType, unit: 'EA', classIri: `cls:${cls}`, attributes: {}, createdBy: 1, ...extra });
  };
  add(1, 'P0000001', 'Bolt M3x8', '볼트 M3x8', 'standard', 'C0101', { materialIri: 'mat:M000001', attributes: { '호칭 지름': 'M3', '길이(mm)': 8, 규격: 'ISO 4762' } });
  add(2, 'P0000002', 'Bolt M4x10', '볼트 M4x10', 'standard', 'C0101', { materialIri: 'mat:M000001', attributes: { '호칭 지름': 'M4', '길이(mm)': 10, 규격: 'ISO 4762' } });
  add(3, 'P0000100', 'HCR3A Body', 'HCR3A 본체', 'assembly', 'C0300');
  add(4, 'P0000110', 'Base assembly', '베이스 조립품', 'assembly', 'C0302');
  add(5, 'P0000111', 'Base housing', '베이스 하우징', 'part', 'C0401', { materialIri: 'mat:M000003', massKg: 1.84, massSource: 'cad_estimate' });
  add(6, 'P0000112', 'Base cover', '베이스 커버', 'part', 'C0402', { materialIri: 'mat:M000003', massKg: 0.21, massSource: 'cad_estimate' });
  add(7, 'P0000120', 'J1 joint module', 'J1 관절 모듈', 'assembly', 'C0301');
  add(8, 'P0000121', 'J1 reducer', 'J1 감속기', 'purchased', 'C0501', { attributes: { 감속비: '100:1', '허용 순간 토크(N·m)': 147 } });
  add(9, 'P0000122', 'Servo motor 400W', '서보 모터 400W', 'purchased', 'C0601', { attributes: { '정격 출력(W)': 400, '정격 전압(V)': 48 } });
  add(10, 'P0000123', 'Absolute encoder', '절대값 엔코더', 'purchased', 'C0602', { attributes: { '분해능(bit)': 19 } });
  add(11, 'P0000124', 'J1 housing', 'J1 하우징', 'part', 'C0401', { materialIri: 'mat:M000003', massKg: 0.96, massSource: 'cad_estimate' });
  add(12, 'P0000130', 'J2 joint module', 'J2 관절 모듈', 'assembly', 'C0301');
  add(13, 'P0000131', 'J2 reducer', 'J2 감속기', 'purchased', 'C0501', { attributes: { 감속비: '100:1' } });
  add(14, 'P0000140', 'Cable harness', '케이블 하네스', 'purchased', 'C0603');
  add(15, 'P0000150', 'J1 brake', 'J1 브레이크', 'purchased', 'C0604', { createdBy: 2 });
  add(16, 'P0000200', 'HCR5A Body', 'HCR5A 본체', 'assembly', 'C0300');
  add(17, 'P0000220', 'J1 joint module 5kg', 'J1 관절 모듈(5kg)', 'assembly', 'C0301');
  add(18, 'P0000221', 'J1 reducer 5kg', 'J1 감속기(5kg)', 'purchased', 'C0501', { attributes: { 감속비: '120:1' } });
  add(19, 'P0000113', 'Base cover (old)', '베이스 커버(구형)', 'part', 'C0402', { materialIri: 'mat:M000003' });

  const revisions: Revision[] = [];
  let revId = 0;
  const rev = (itemId: number, r: string, seq: number, status: RevisionStatus, extra: Partial<Revision> = {}) => {
    revId += 1;
    revisions.push({
      id: revId, itemId, rev: r, revSeq: seq, status, createdBy: 1, createdAt: T0,
      releasedAt: status === 'released' || status === 'obsolete' ? '2026-09-10T15:00:00+09:00' : undefined, ...extra,
    });
    return revId;
  };
  const r: Record<string, number> = {};
  for (const it of items) {
    if (['P0000100', 'P0000112', 'P0000150', 'P0000113'].includes(it.itemNo)) continue;
    r[it.itemNo] = rev(it.id, 'R00', 0, 'released', { changeNote: '최초 승인' });
  }
  r['P0000100/R00'] = rev(3, 'R00', 0, 'obsolete', { changeNote: '최초 승인' });
  r['P0000100'] = rev(3, 'R01', 1, 'released', { changeNote: 'J2 관절 모듈 추가', releasedAt: '2026-09-28T11:00:00+09:00' });
  r['P0000100/R02'] = rev(3, 'R02', 2, 'wip', { changeNote: 'J1 브레이크 추가 (설계 중)', createdBy: 2, createdAt: '2026-10-20T10:00:00+09:00' });
  r['P0000112'] = rev(6, 'R00', 0, 'released', { changeNote: '최초 승인' });
  r['P0000112/R01'] = rev(6, 'R01', 1, 'in_review', { changeNote: '보강 리브 추가', createdBy: 2, createdAt: '2026-10-18T14:00:00+09:00' });
  r['P0000150'] = rev(15, 'R00', 0, 'wip', { changeNote: '신규 등록', createdBy: 2, createdAt: '2026-10-19T09:30:00+09:00' });
  r['P0000113'] = rev(19, 'R00', 0, 'obsolete', { changeNote: '베이스 커버(P0000112)로 대체' });

  const byNo = (no: string) => items.find(i => i.itemNo === no)!.id;
  const bomLines: MockBomLine[] = [];
  const bom = (parent: string, rows: [string, number][]) => {
    rows.forEach(([child, qty], i) => {
      bomLines.push({ id: bomLines.length + 1, parentRevisionId: r[parent]!, childItemId: byNo(child), quantity: qty, findNo: i + 1 });
    });
  };
  bom('P0000100/R00', [['P0000110', 1], ['P0000120', 1], ['P0000140', 1]]);
  bom('P0000100', [['P0000110', 1], ['P0000120', 1], ['P0000130', 1], ['P0000140', 1]]);
  bom('P0000100/R02', [['P0000110', 1], ['P0000120', 1], ['P0000130', 1], ['P0000140', 1], ['P0000150', 1]]);
  bom('P0000110', [['P0000111', 1], ['P0000112', 1], ['P0000002', 8]]);
  bom('P0000120', [['P0000121', 1], ['P0000122', 1], ['P0000123', 1], ['P0000124', 1], ['P0000001', 12], ['P0000002', 6]]);
  bom('P0000130', [['P0000131', 1], ['P0000122', 1], ['P0000123', 1], ['P0000001', 12]]);
  bom('P0000200', [['P0000110', 1], ['P0000220', 1], ['P0000140', 1]]);
  bom('P0000220', [['P0000221', 1], ['P0000122', 1], ['P0000123', 1], ['P0000124', 1], ['P0000001', 16]]);

  const identifiers: MockDb['identifiers'] = [
    { itemId: 1, scheme: 'legacy', value: 'BLT-0038' }, { itemId: 1, scheme: 'cad_name', value: 'M3x8' },
    { itemId: 2, scheme: 'legacy', value: 'BLT-0041' }, { itemId: 2, scheme: 'cad_name', value: 'M4x10' },
    { itemId: 3, scheme: 'cad_name', value: 'Body_HCR3A' }, { itemId: 3, scheme: 'erp', value: 'ERP-30100' },
    { itemId: 5, scheme: 'cad_name', value: 'Base_HCR3A' }, { itemId: 5, scheme: 'drawing', value: 'DWG-0111' },
    { itemId: 8, scheme: 'supplier', value: 'SUP-A:RG20-100' }, { itemId: 8, scheme: 'erp', value: 'ERP-77121' },
    { itemId: 9, scheme: 'supplier', value: 'SUP-B:SM400-48' }, { itemId: 9, scheme: 'erp', value: 'ERP-77122' },
    { itemId: 11, scheme: 'drawing', value: 'DWG-0124' },
  ];

  const inv = (itemId: number, source: 'ERP' | 'MES', site: string, location: string, onHand: number, alloc: number) =>
    ({ itemId, source, site, location, qtyOnHand: onHand, qtyAllocated: alloc, unit: 'EA', asOf: '2026-10-23T07:00:00+09:00' });
  const inventory: MockDb['inventory'] = [
    inv(1, 'ERP', '본사 공장', '자재 창고', 12400, 3200), inv(1, 'MES', '본사 공장', '조립 1라인', 520, 0),
    inv(2, 'ERP', '본사 공장', '자재 창고', 8300, 1900),
    inv(8, 'ERP', '본사 공장', '자재 창고', 32, 18), inv(9, 'ERP', '본사 공장', '자재 창고', 45, 30),
    inv(10, 'ERP', '본사 공장', '자재 창고', 51, 30), inv(13, 'ERP', '본사 공장', '자재 창고', 20, 12),
    inv(14, 'ERP', '본사 공장', '자재 창고', 26, 10), inv(3, 'ERP', '본사 공장', '완제품 창고', 6, 4),
  ];

  const documents: MockDocument[] = [
    { id: 1, docNo: 'D-CAD-0100', title: 'HCR3A 본체 3D', docType: 'cad_3d', rev: 'R01', fileName: 'Body_HCR3A_R01_3D.stp' },
    { id: 2, docNo: 'D-SPEC-HCR', title: 'HCR 시리즈 사양서', docType: 'spec', rev: 'R02', fileName: 'HCR_series_spec_R02.pdf' },
    { id: 3, docNo: 'D-MAN-HCR3A', title: 'HCR3A 설치 · 유지보수 설명서', docType: 'manual', rev: 'R00', fileName: 'HCR3A_manual_R00.pdf' },
    { id: 4, docNo: 'D-DRW-0124', title: 'J1 하우징 도면', docType: 'drawing', rev: 'R00', fileName: 'J1_housing_R00.pdf' },
    { id: 5, docNo: 'D-CAD-0120', title: 'J1 관절 모듈 3D', docType: 'cad_3d', rev: 'R00', fileName: 'J1_module_HCR3A_R00_3D.stp' },
  ];
  const docLinks: MockDocLink[] = [
    { revisionId: r['P0000100']!, documentId: 1, linkType: 'cad_model', pinned: true, matchMethod: 'filename', confidence: 1, status: 'confirmed' },
    { revisionId: r['P0000100']!, documentId: 2, linkType: 'spec', pinned: false, matchMethod: 'manual', status: 'confirmed' },
    { revisionId: r['P0000100']!, documentId: 3, linkType: 'manual', pinned: false, matchMethod: 'manual', status: 'confirmed' },
    { revisionId: r['P0000120']!, documentId: 5, linkType: 'cad_model', pinned: true, matchMethod: 'step_product', confidence: 1, status: 'confirmed' },
    { revisionId: r['P0000120']!, documentId: 2, linkType: 'spec', pinned: false, matchMethod: 'text_search', confidence: 0.82, status: 'suggested' },
    { revisionId: r['P0000121']!, documentId: 2, linkType: 'spec', pinned: false, matchMethod: 'text_search', confidence: 0.88, status: 'confirmed' },
    { revisionId: r['P0000121']!, documentId: 3, linkType: 'manual', pinned: false, matchMethod: 'text_search', confidence: 0.74, status: 'suggested' },
    { revisionId: r['P0000124']!, documentId: 4, linkType: 'drawing', pinned: true, matchMethod: 'filename', confidence: 1, status: 'confirmed' },
    { revisionId: r['P0000001']!, documentId: 2, linkType: 'spec', pinned: false, matchMethod: 'text_search', confidence: 0.79, status: 'confirmed' },
  ];
  const passages: MockPassage[] = [
    { id: 1, revisionId: r['P0000121']!, purpose: 'definition', documentId: 2, pageNo: 12, score: 8.4, status: 'confirmed', productScope: [],
      hitTerms: ['J1', '감속기'],
      text: 'J1 감속기는 서보 모터의 회전을 100:1로 감속해 베이스에 대한 J1 관절 회전을 만든다. 허용 순간 토크는 147 N·m이다.' },
    { id: 2, revisionId: r['P0000121']!, purpose: 'assembly', mateItemNo: 'P0000124', documentId: 3, pageNo: 34, score: 7.1, status: 'suggested', productScope: ['HCR3A'],
      hitTerms: ['J1', '감속기', '하우징'],
      text: 'J1 감속기 출력 플랜지를 J1 하우징의 맞춤 핀에 맞추고, M3 볼트 12개를 대각선 순서로 1.2 N·m로 체결한다.' },
    { id: 3, revisionId: r['P0000121']!, purpose: 'disassembly', mateItemNo: 'P0000122', documentId: 3, pageNo: 41, score: 6.3, status: 'suggested', productScope: ['HCR3A'],
      hitTerms: ['감속기', '모터'],
      text: '서보 모터를 분리하기 전에 브레이크를 해제하고 J1 축을 기구적으로 고정한다. 모터 축과 감속기 입력부를 잇는 볼트를 먼저 푼다.' },
    { id: 4, revisionId: r['P0000221']!, purpose: 'definition', documentId: 2, pageNo: 13, score: 8.0, status: 'confirmed', productScope: ['HCR5A'],
      hitTerms: ['J1', '감속기'],
      text: 'HCR5A의 J1 감속기는 감속비 120:1로, 5 kg 가반하중에서 허용 순간 토크 196 N·m를 낸다.' },
    { id: 5, revisionId: r['P0000001']!, purpose: 'definition', documentId: 2, pageNo: 58, score: 5.2, status: 'confirmed', productScope: [],
      hitTerms: ['M3', '볼트'],
      text: 'M3×8 육각 홈붙이 볼트(SUS304)는 관절 하우징과 감속기 체결에 쓴다. 재사용하지 않는다.' },
    { id: 6, revisionId: r['P0000120']!, purpose: 'definition', documentId: 2, pageNo: 11, score: 7.6, status: 'suggested', productScope: [],
      hitTerms: ['J1', '관절'],
      text: 'J1 관절 모듈은 베이스 위에서 로봇 전체를 수직축으로 회전시키며, 감속기 · 서보 모터 · 엔코더 · 하우징으로 이루어진다.' },
  ];

  const partRequests: PartRequest[] = [
    { id: 1, sourceSystem: 'PDM', status: 'draft', requestedBy: 2, createdAt: '2026-10-22T16:10:00+09:00', updatedAt: '2026-10-22T16:40:00+09:00',
      payload: { name: 'J2 brake', nameKo: 'J2 브레이크', itemType: 'purchased', unit: 'EA', note: '공급사 사양 확인 후 분류 지정 예정' } },
    { id: 2, sourceSystem: 'PLM', status: 'submitted', requestedBy: 2, createdAt: '2026-10-21T10:00:00+09:00', updatedAt: '2026-10-21T10:05:00+09:00',
      payload: { name: 'Cable clamp', nameKo: '케이블 클램프', itemType: 'purchased', unit: 'EA', classIri: 'cls:C0100',
                 aliases: [{ scheme: 'supplier', value: 'SUP-C:CC-12' }] },
      duplicateCheck: [{ itemNo: 'P0000140', name: 'Cable harness', method: 'fuzzy', score: 0.42 }] },
    { id: 3, sourceSystem: 'AGENT', status: 'draft', requestedBy: 1, classProposalId: 1, createdAt: '2026-10-22T02:13:00+09:00', updatedAt: '2026-10-22T02:13:00+09:00',
      payload: { name: 'Self tapping screw M3x6', nameKo: '셀프태핑 나사 M3x6', itemType: 'standard', unit: 'EA', materialIri: 'mat:M000001',
                 aliases: [{ scheme: 'cad_name', value: 'ST_M3x6' }], note: '분류 에이전트가 HCR3A 설명서 34쪽에서 찾은 부품' } },
    { id: 4, sourceSystem: 'PDM', status: 'approved', requestedBy: 2, reviewedBy: 1, issuedItemNo: 'P0000150',
      createdAt: '2026-10-19T09:00:00+09:00', updatedAt: '2026-10-19T09:30:00+09:00',
      payload: { name: 'J1 brake', nameKo: 'J1 브레이크', itemType: 'purchased', unit: 'EA', classIri: 'cls:C0604' } },
    { id: 5, sourceSystem: 'PDM', status: 'rejected', requestedBy: 2, reviewedBy: 1, reviewNote: 'P0000001과 같은 부품입니다. 기존 품번을 쓰세요.',
      createdAt: '2026-10-15T13:00:00+09:00', updatedAt: '2026-10-15T15:00:00+09:00',
      payload: { name: 'Hex socket bolt M3 8mm', nameKo: '육각 홈붙이 볼트 M3 8', itemType: 'standard', unit: 'EA', classIri: 'cls:C0101' },
      duplicateCheck: [{ itemNo: 'P0000001', name: 'Bolt M3x8', method: 'fuzzy', score: 0.61 }] },
  ];

  const classProposals: ClassProposal[] = [
    { id: 1, status: 'proposed', parentClassIri: 'cls:C0100', labelKo: '셀프태핑 나사', labelEn: 'Self-tapping screw',
      definition: '스스로 나사산을 내며 얇은 판이나 수지 부품에 체결되는 나사',
      properties: [
        { label: '호칭 지름', quantityKind: 'Length', unit: 'mm', required: true, reused: true },
        { label: '길이', quantityKind: 'Length', unit: 'mm', required: true, reused: true },
        { label: '나사 끝 형상', required: false, reused: false },
      ],
      standardMatch: [{ standard: 'ECLASS', note: 'ECLASS 파일을 받은 뒤 대응 후보 확인' }],
      evidence: [{ docNo: 'D-MAN-HCR3A', quote: '베이스 커버는 셀프태핑 나사 M3×6 네 개로 베이스 하우징에 고정한다.' }],
      validation: [], agentRunId: 'run-7f3c2a', model: 'claude-opus-5-5', createdAt: '2026-10-22T02:13:00+09:00' },
    { id: 2, status: 'proposed', parentClassIri: 'cls:C0101', labelKo: '볼트 M5x12', labelEn: 'Bolt M5x12',
      definition: 'M5 길이 12 mm 볼트',
      properties: [{ label: '호칭 지름', quantityKind: 'Length', unit: 'mm', required: true, reused: true }],
      evidence: [{ docNo: 'D-SPEC-HCR', quote: '툴 플랜지는 M5×12 볼트 네 개로 고정한다.' }],
      validation: [{ severity: 'warning', message: '분류 이름에 규격 값이 들어 있다 (볼트 M5x12). 규격은 분류가 아니라 속성으로 둔다' }],
      agentRunId: 'run-7f3c2a', model: 'claude-opus-5-5', createdAt: '2026-10-22T02:14:00+09:00' },
    { id: 3, status: 'merged', parentClassIri: 'cls:C0100', labelKo: '육각 홈붙이 볼트', labelEn: 'Hex socket bolt',
      definition: '육각 홈이 있는 머리를 가진 볼트', properties: [],
      evidence: [{ docNo: 'D-SPEC-HCR', quote: 'M3×8 육각 홈붙이 볼트(SUS304)는 관절 하우징과 감속기 체결에 쓴다.' }],
      validation: [], mergedIntoIri: 'cls:C0101', reviewNote: '볼트(C0101)와 같은 분류. 머리 형상은 속성으로 둔다.',
      agentRunId: 'run-51ad90', model: 'claude-opus-5-5', createdAt: '2026-10-16T02:10:00+09:00' },
  ];

  const outbox: OutboxRow[] = [
    { id: 1, aggregate: 'item_revision', target: 'P0000100 R01', event: 'released', createdAt: '2026-09-28T11:00:00+09:00', publishedAt: '2026-09-28T11:00:02+09:00', attempts: 1 },
    { id: 2, aggregate: 'item', target: 'P0000001', event: 'updated', createdAt: '2026-10-02T09:12:00+09:00', publishedAt: '2026-10-02T09:12:01+09:00', attempts: 1 },
    { id: 3, aggregate: 'class', target: 'cls:C0604 브레이크', event: 'approved', createdAt: '2026-10-18T17:20:00+09:00', publishedAt: '2026-10-18T17:20:03+09:00', attempts: 1 },
    { id: 4, aggregate: 'item_revision', target: 'P0000220 R00', event: 'released', createdAt: '2026-10-22T18:40:00+09:00', attempts: 3, lastError: 'GraphDB 503 Service Unavailable' },
    { id: 5, aggregate: 'item', target: 'P0000122', event: 'updated', createdAt: '2026-10-23T08:55:00+09:00', attempts: 0 },
  ];

  const products: Product[] = [
    { id: 1, code: 'HCR3A', name: '협동로봇 3 kg', description: '가반하중 3 kg, 작업 반경 630 mm', rootItemNo: 'P0000100' },
    { id: 2, code: 'HCR5A', name: '협동로봇 5 kg', description: '가반하중 5 kg, 작업 반경 915 mm', rootItemNo: 'P0000200' },
  ];

  return {
    version: 1, users, products, classes, materials, items, revisions, bomLines, identifiers, inventory,
    documents, docLinks, passages, partRequests, classProposals, outbox, nextItemNo: 300,
  };
}
