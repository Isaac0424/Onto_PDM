// API 응답 형태. db/schema.sql 의 테이블과 docs/pdm-design.md 9장 API 를 따른다 (열 이름은 camelCase).

export type ItemType = 'assembly' | 'part' | 'standard' | 'purchased';
export type RevisionStatus = 'wip' | 'in_review' | 'released' | 'obsolete';
export type BomRule = 'released' | 'latest';
export type UserRole = 'admin' | 'approver' | 'engineer' | 'viewer';

export interface User {
  id: number;
  loginId: string;
  name: string;
  role: UserRole;
}

export interface Product {
  id: number;
  code: string;
  name: string;
  description?: string;
  rootItemNo: string;
}

export interface TaxonomyClass {
  iri: string;          // cls:C0101
  code: string;         // C0101
  labelKo: string;
  labelEn?: string;
  parentIri?: string;
  kind: 'part' | 'material';
}

export interface Material {
  iri: string;          // mat:M000001
  name: string;         // SUS304
  aliases: string[];    // STS304, AISI 304 …
  classIri: string;
  density?: number;     // g/cm³
}

export interface Revision {
  id: number;
  itemId: number;
  rev: string;
  revSeq: number;
  status: RevisionStatus;
  changeNote?: string;
  releasedAt?: string;
  createdBy: number;
  createdAt: string;
}

export interface Identifier {
  scheme: 'legacy' | 'erp' | 'mes' | 'supplier' | 'customer' | 'drawing' | 'cad_name';
  value: string;
}

export interface Item {
  id: number;
  itemNo: string;
  name: string;
  nameKo?: string;
  itemType: ItemType;
  unit: string;
  classIri?: string;
  materialIri?: string;
  attributes: Record<string, string | number>;
  massKg?: number;
  massSource?: 'cad_mass' | 'cad_estimate' | 'measured';
  createdBy: number;
}

/** 목록 · 상세에 쓰는 품목 + 리비전 요약 (item_current 뷰) */
export interface ItemSummary extends Item {
  latestRevision?: Revision;
  releasedRevision?: Revision;
}

export interface ItemDetail extends ItemSummary {
  revisions: Revision[];          // 이 사용자에게 보이는 리비전만
  identifiers: Identifier[];
  inventory: InventoryRow[];
  products: Product[];            // 이 품목을 쓰는 제품 (역전개)
}

export interface InventoryRow {
  source: 'ERP' | 'MES';
  site: string;
  location: string;
  qtyOnHand: number;
  qtyAllocated: number;
  unit: string;
  asOf: string;
}

export interface BomNode {
  lineId: number;
  depth: number;
  findNo?: number;
  quantity: number;
  totalQuantity: number;          // 루트 1개당
  item: ItemSummary;
  revision?: Revision;            // 규칙으로 고른 자식 리비전
  children: BomNode[];
}

export interface WhereUsedRow {
  depth: number;
  parent: ItemSummary;
  parentRevision: Revision;
  quantity: number;
}

export type DocType = 'cad_3d' | 'drawing' | 'spec' | 'manual' | 'bom_sheet' | 'other';
export type LinkStatus = 'suggested' | 'confirmed' | 'rejected';

export interface DocumentLink {
  documentId: number;
  docNo: string;
  title: string;
  docType: DocType;
  linkType: 'cad_model' | 'drawing' | 'spec' | 'manual' | 'reference';
  rev: string;                    // 표시할 리비전
  pinned: boolean;                // true: 리비전 고정, false: 최신 승인본 따라감
  fileName?: string;
  fileUrl?: string;               // /api/files/:id/content
  matchMethod: 'manual' | 'filename' | 'step_product' | 'bom_import' | 'text_search' | 'ai';
  confidence?: number;
  status: LinkStatus;
}

export interface Passage {
  id: number;
  purpose: 'definition' | 'assembly' | 'disassembly' | 'reference';
  mateItemNo?: string;
  mateName?: string;
  docNo: string;
  docTitle: string;
  pageNo?: number;
  text: string;
  hitTerms: string[];
  score: number;
  status: LinkStatus;
  productScope: string[];         // 비어 있으면 공통 구절
}

/**
 * CAD 부품 이름 → 우리 회사가 보유한 품번 매칭 (docs/pdm-design.md 6장).
 * matched: 정확 일치 · 별칭 일치(자동 확정), suggested: CAD 이름 별칭 · 정규화 · 유사도(사람이 확정), none: 보유 품번 없음.
 * 보유하지 않은 부품은 CAD 이름 그대로 두고, 이름으로 추정한 온톨로지 분류(classPath)를 함께 돌려준다.
 */
export interface CadPartMatch {
  name: string;
  status: 'matched' | 'suggested' | 'none';
  itemNo?: string;
  itemName?: string;
  method?: 'exact' | 'alias' | 'cad_name' | 'normalized' | 'fuzzy';
  score?: number;
  classIri?: string;
  classLabel?: string;
  /** 루트부터 분류까지의 이름 */
  classPath?: string[];
}

export type AssemblyOperation = 'fasten' | 'weld' | 'press_fit' | 'mount' | 'insert' | 'cover';

export interface AssemblyPartInput {
  name: string;
  /** CAD 크기 (x, y, z) mm. 규칙이 두께 같은 값을 계산할 때 쓴다 */
  size?: [number, number, number];
  /** 부품의 분류 이름(예: '볼트'). 규칙은 이름보다 분류와 속성에 걸리는 것이 원칙이다 */
  className?: string;
  /** 부품 속성 값(추출 · 확정된 것). 예: { threadSize: 'M3', thickness: 3 } */
  attributes?: Record<string, string | number>;
}

/**
 * 부품 하나를 조립할 때 따를 사내 규칙에서 뽑은 안내 (docs/assembly-rules-spec.md).
 * 3D 위에 카드(params · cautions)와 자막(caption)으로 겹쳐 보인다.
 */
export interface AssemblyGuide {
  partName: string;
  ruleId: string;
  ruleName: string;
  operation: AssemblyOperation;
  operationLabel: string;
  title: string;
  /** 아래 자막 한 줄 */
  caption: string;
  params: { label: string; value: string; ok?: boolean }[];
  cautions: string[];
  tools: string[];
  /** 규칙 출처 문서 */
  source: string;
}

export interface AssemblyRuleSummary {
  id: string;
  name: string;
  operation: AssemblyOperation;
  operationLabel: string;
  /** 적용 대상(분류 · 부품 종류) */
  appliesTo: string[];
  /** 목록에 보일 핵심 값 두 개 */
  keyValues: { label: string; value: string }[];
  cautionCount: number;
  toolCount: number;
  /** approved: 승인된 규칙, draft: 검토 전(가상 값) */
  status: 'approved' | 'draft';
  source: string;
}

export interface AssemblyRuleDetail extends AssemblyRuleSummary {
  description: string;
  /** 이 규칙이 적용되는 조건 */
  conditions: string[];
  parameters: { label: string; value: string }[];
  /** 조건표 (예: 모재 두께별 용접 조건) */
  table?: { title: string; columns: string[]; rows: string[][] };
  cautions: string[];
  tools: string[];
  /** 이 규칙이 적용되는 보유 품목 */
  usedBy: { itemNo: string; name: string }[];
}

// ---- MES 발행: 제조 BOM + 작업표준 묶음 (PRD 6.6) ----
export interface MesBomLine {
  seq: number;
  /** BOM 단계: 최상위 조립품 = 0 */
  level: number;
  itemNo: string;
  name: string;
  /** 부모 1개당 */
  quantity: number;
  /** 최상위 1개당 */
  totalQuantity: number;
  /** 이 품목을 조립하는 작업 단계 번호 (없으면 undefined) */
  step?: number;
  ruleIds: string[];
}

export interface MesWorkStep {
  step: number;
  title: string;
  operationLabel?: string;
  parts: { itemNo: string; name: string; quantity: number }[];
  ruleIds: string[];
  params: { label: string; value: string }[];
  cautions: string[];
  tools: string[];
}

export interface MesPackage {
  productCode: string;
  productName: string;
  rootItemNo: string;
  /** 발행할 최상위 조립품 리비전 (예: R01) */
  revision: string;
  rule: BomRule;
  generatedAt: string;
  bom: MesBomLine[];
  steps: MesWorkStep[];
  documents: { docNo: string; title: string; docType: DocType; rev: string }[];
  /** 발행 전에 확인할 것: 승인되지 않은 리비전, 규칙이 없는 단계 등 */
  warnings: string[];
}

export interface ItemQuery {
  q?: string;
  itemType?: ItemType | '';
  status?: RevisionStatus | '';
  productId?: number | '';
}

/** 화면이 쓰는 API. mock(지금)과 HTTP(백엔드가 생기면)가 같은 형태를 구현한다. */
export interface PdmApi {
  listUsers(): Promise<User[]>;
  listProducts(): Promise<Product[]>;
  listClasses(): Promise<TaxonomyClass[]>;
  listMaterials(): Promise<Material[]>;

  listItems(query: ItemQuery): Promise<ItemSummary[]>;
  getItem(itemNo: string): Promise<ItemDetail>;
  getBom(revisionId: number, rule: BomRule): Promise<BomNode[]>;
  getWhereUsed(itemId: number): Promise<WhereUsedRow[]>;
  getDocuments(revisionId: number): Promise<DocumentLink[]>;
  getPassages(revisionId: number): Promise<Passage[]>;

  matchCadParts(names: string[]): Promise<CadPartMatch[]>;
  /** 조립 규칙이 있는 부품만 돌려준다 */
  getAssemblyGuides(parts: AssemblyPartInput[]): Promise<AssemblyGuide[]>;
  listAssemblyRules(): Promise<AssemblyRuleSummary[]>;
  getAssemblyRule(id: string): Promise<AssemblyRuleDetail>;

  /** 제품의 제조 BOM + 작업 표준 묶음을 만든다 (미리보기). MES 로 내보내거나 발행하지 않는다 (삭제됨, 사용자 지시) */
  buildMesPackage(productCode: string, rule: BomRule): Promise<MesPackage>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
  }
}
