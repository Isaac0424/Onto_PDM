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

export type RequestStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled';

export interface PartRequestPayload {
  name?: string;
  nameKo?: string;
  itemType?: ItemType;
  unit?: string;
  classIri?: string;
  materialIri?: string;
  aliases?: Identifier[];
  note?: string;
}

export interface DuplicateCandidate {
  itemNo: string;
  name: string;
  method: 'exact' | 'alias' | 'cad_name' | 'normalized' | 'fuzzy';
  score: number;
}

export interface PartRequest {
  id: number;
  sourceSystem: 'PDM' | 'PLM' | 'AGENT';
  status: RequestStatus;
  payload: PartRequestPayload;
  classProposalId?: number;
  duplicateCheck?: DuplicateCandidate[];
  issuedItemNo?: string;
  requestedBy: number;
  reviewedBy?: number;
  reviewNote?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'merged';

export interface ClassProposal {
  id: number;
  status: ProposalStatus;
  parentClassIri: string;
  labelKo: string;
  labelEn?: string;
  definition: string;
  properties: { label: string; quantityKind?: string; unit?: string; required: boolean; reused: boolean }[];
  standardMatch?: { standard: 'ECLASS' | 'IEC_CDD'; note: string }[];
  evidence: { docNo: string; quote: string }[];
  validation: { severity: 'violation' | 'warning'; message: string }[];
  approvedIri?: string;
  mergedIntoIri?: string;
  agentRunId: string;
  model: string;
  createdAt: string;
  reviewNote?: string;
}

export interface OutboxRow {
  id: number;
  aggregate: 'item' | 'item_revision' | 'class';
  target: string;                 // 사람이 읽는 대상 (품번·리비전·분류)
  event: string;
  createdAt: string;
  publishedAt?: string;
  attempts: number;
  lastError?: string;
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

  listPartRequests(scope: 'mine' | 'all'): Promise<PartRequest[]>;
  getPartRequest(id: number): Promise<PartRequest>;
  savePartRequest(id: number | null, payload: PartRequestPayload): Promise<PartRequest>;   // 임시저장
  submitPartRequest(id: number): Promise<PartRequest>;
  approvePartRequest(id: number, note?: string): Promise<PartRequest>;                    // 관리자 모드: 품번 발급
  rejectPartRequest(id: number, note: string): Promise<PartRequest>;

  listClassProposals(): Promise<ClassProposal[]>;
  approveClassProposal(id: number, note?: string): Promise<ClassProposal>;
  rejectClassProposal(id: number, note: string): Promise<ClassProposal>;
  mergeClassProposal(id: number, intoIri: string, note?: string): Promise<ClassProposal>;

  listOutbox(): Promise<OutboxRow[]>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
  }
}
