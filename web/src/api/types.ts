// API 응답 형태. db/schema.sql 의 테이블과 docs/pdm-design.md 9장 API 를 따른다 (열 이름은 camelCase).

export type ItemType = 'assembly' | 'part' | 'standard' | 'purchased';
export type RevisionStatus = 'wip' | 'in_review' | 'released' | 'obsolete';
export type BomRule = 'released' | 'latest';

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
  method?: 'exact' | 'alias' | 'cad_name' | 'normalized' | 'fuzzy' | 'attributes';
  score?: number;
  classIri?: string;
  classLabel?: string;
  /** 루트부터 분류까지의 이름 */
  classPath?: string[];
  /** status 가 none 일 때의 이유: needs_values(규격을 확정하면 찾는다) · no_candidate(OPMS 에 후보가 없다) · unreachable(OPMS 를 읽지 못했다) */
  reason?: 'needs_values' | 'no_candidate' | 'unreachable';
  /** 후보가 여럿이면 점수순으로 모두 (itemNo 등은 그 중 첫째). 사람이 하나를 고른다 */
  candidates?: CadPartCandidate[];
  /**
   * 사람이 확정하지 않은 CAD 형상 추정 값(나사 규격 · 길이)으로 찾은 결과다 (화면이 붙인다. API 는 모른다).
   * 이 결과는 늘 후보이고 자동으로 보유 품번이 되지 않는다. 사람이 그 값을 확정하면 이 표시가 사라진다.
   */
  estimated?: { threadSize?: string; length?: number; /** 파일에 단위 정보가 없어 mm 로 가정한 값 */ unitAssumed?: boolean };
}

/** 매칭 후보 하나. OPMS 부품에는 이름이 없어 itemName 은 분류 · 핵심 속성으로 만든 표시 이름이다 */
export interface CadPartCandidate {
  itemNo: string;
  itemName: string;
  score: number;
  classLabel?: string;
  classPath?: string[];
  /** 핵심 속성별 일치(hit=null 은 값이 없어 비교에서 뺐다) */
  matched?: { label: string; hit: boolean | null; doc?: string; part?: string }[];
  /** 문서 값이 근사(CAD)이거나 부품 값이 비어 '후보'까지만 되는 경우 */
  capped?: boolean;
  /** 같은 계열의 다른 분류라 '후보'까지만 되는 경우 */
  classCapped?: boolean;
}

/**
 * 규격 값으로 보유 품번 후보를 좁히는 조건 (CAD 형상으로 본 볼트: 나사 규격 · 길이 · 머리 모양). 값은 사람이 확정한 것이거나,
 * 확정 전이면 CAD 형상 분석이 충분히 확실하게 추정한 것이다(그 결과는 CadPartMatch.estimated 로 표시하는 후보일 뿐이다).
 * 이름이 아니라 속성 값에 걸리는 매칭이다. 클래스는 OPMS 에 등록된 것만 넘긴다(미등록 제안 클래스는 매칭에 쓰지 않는다).
 */
export interface CadPartHint {
  /** 나사 규격 (예: 'M8') */
  threadSize?: string;
  /** 길이 mm */
  length?: number;
  /** 머리 모양 (OPMS headType 값: Hex · HexFlange · Socket · Button · Countersunk) */
  headType?: string;
  /** 확정한 OPMS 클래스 코드 (예: 'SocketHeadBolt') */
  fastenerClass?: string;
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
  /** 형상으로 분류해 사람이 확정한 볼트 클래스 코드(예: 'SocketHeadBolt'). 이름이 볼트가 아니어도 체결 규칙을 고른다 */
  fastenerClass?: string;
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

// ---- OPMS 읽기 (PDM 백엔드가 OPMS Neo4j 를 읽기만 해서 준다. 온톨로지는 OPMS 소유라 PDM 은 쓰지 않는다) ----
/** ok: 읽는 중 · opms_down: OPMS 의 Neo4j 가 꺼졌다 · backend_down: PDM 백엔드가 꺼졌다 · not_configured / auth_failed / no_ontology: 설정 문제 */
export type OpmsState = 'ok' | 'opms_down' | 'backend_down' | 'not_configured' | 'auth_failed' | 'no_ontology';

export interface OpmsStatus {
  state: OpmsState;
  /** 사람이 읽는 이유(연결되지 않았을 때) */
  message?: string;
  ontologyVersion?: string;
  classes?: number;
  parts?: number;
}

/** OPMS 에 등록된 보유 부품 하나 */
export interface OpmsPartInfo {
  partNo: string;
  classCode: string;
  classLabel: string;
  classPathLabels: string[];
  /** OPMS 부품에는 이름이 없다: 분류 이름 + 핵심 속성 */
  label: string;
  values: Record<string, string | number>;
  /** 개념형 값(재질 · 표면처리)의 사람이 읽는 이름 */
  valueLabels: Record<string, string>;
  /** 분류의 속성 이름(한글)과 단위를 붙여 사람이 읽게 만든 속성 목록 (예: 나사 규격 M4 · 길이 15 mm) */
  properties: { key: string; label: string; text: string }[];
}

/** 분류가 요구하는 속성 하나 (OPMS constraints.yaml 의 필수 여부 · 값 범위, properties.yaml 의 관례로 채워지는 값) */
export interface OpmsPropertyRule {
  key: string;
  label: string;
  datatype: 'string' | 'decimal' | 'concept' | string;
  unit?: string;
  required: boolean;
  min?: number;
  max?: number;
  /** 분류가 값을 정해 둔 속성(고정 값). 사람이 입력하지 않는다 */
  fixed?: string;
  /** 원문에 값이 없으면 OPMS 가 관례로 채우는 값 (예: 나사 방향 → 오른나사) */
  omittedDefault?: { code: string; label: string };
  /** 다른 속성 값에서 관례로 정해지는 값 (예: 피치 = 나사 규격의 보통 나사 값) */
  lookupDefault?: { key: string; seriesLabel?: string; values: Record<string, number[]> };
}

/** OPMS 분류의 유효 속성 규칙. 필수 속성 체크리스트가 쓴다 (읽기 전용) */
export interface OpmsClassSpec {
  code: string;
  label: string;
  properties: OpmsPropertyRule[];
}

// ---- 조립 규칙 · 작업표준서 (PDM 소유 규칙집: 저장소의 rules/ YAML 을 백엔드가 읽기 전용으로 내보낸다) ----
// 모든 값에는 출처 등급이 붙는다. manual: 사용설명서(쪽 번호까지) · standard: 공개 표준 참고값(승인 전 사용 금지) · cad: CAD 에서 도출(추정) · unknown: 근거 없음(값을 비워 둔다).
// confirmed 인 것만 확정값처럼 보여도 된다. 나머지(cad · unknown · 추정)는 작업자 화면에서 확정값처럼 보이면 안 된다.
export type RulebookGrade = 'manual' | 'standard' | 'cad' | 'unknown';

export interface RulebookRef {
  /** 화면에 그대로 써도 되는 짧은 근거 표기 (예: '사용설명서(KR) 3.3절 p.49') */
  label: string;
  docTitle?: string;
  pages: number[];
  note?: string;
}

/** 출처가 붙은 항목의 공통 필드 */
export interface RulebookSourced {
  source: RulebookGrade;
  refs: RulebookRef[];
  /** 근거가 없어 값을 비워 둔 곳의 공백 번호 (G-001 …) */
  gapId?: string;
  estimated: boolean;
  approvalRequired: boolean;
  /** 확정값처럼 보여도 되는가 (사용설명서 근거 · 추정 아님 · 값 있음) */
  confirmed: boolean;
}

export type RulebookValue = string | number | boolean | null | (string | number)[];

export interface RulebookParam extends RulebookSourced {
  /** 기계가 읽는 키 (예: torque_nm). 화면 이름은 pages/rules/rulebookUi.tsx 의 paramLabel */
  name: string;
  value: RulebookValue;
  unit?: string;
  condition?: string;
  note?: string;
}

export interface RulebookLookupRow extends RulebookSourced {
  key: string;
  values: Record<string, RulebookValue>;
  note?: string;
}

export interface RulebookCaution extends RulebookSourced {
  /** 경고 · 주의 · 안내 … */
  level: string;
  text: string;
  levelNote?: string;
}

export interface RulebookAppliesTo extends RulebookSourced {
  classes: string[];
  /** OPMS 에 아직 없는 분류(제안) */
  proposedClasses: string[];
  role?: string;
  roleLabel?: string;
  models: string[];
  where: Record<string, RulebookValue>;
}

export interface RulebookRule {
  id: string;
  name: string;
  operation: string;
  operationLabel?: string;
  /** part: 분류가 대상 · role: 분류 없이 역할로만 · product: 제품 · 설치 전반 */
  scope: 'part' | 'role' | 'product';
  /** unreviewed: 초안(검토 전) */
  reviewStatus: string;
  appliesTo: RulebookAppliesTo;
  parameters: RulebookParam[];
  lookup?: { key: string; rows: RulebookLookupRow[] };
  tools: string[];
  cautions: RulebookCaution[];
  note?: string;
  cadInference?: (RulebookSourced & { part: string; quantity?: number; inferred: boolean });
  byGrade: Record<string, number>;
  gapIds: string[];
}

export interface RulebookOperation extends RulebookSourced {
  code: string;
  labelKo: string;
  labelEn?: string;
  definition: string;
  parent?: string;
  opmsCode?: string;
  path: string[];
}

export interface RulebookNotCovered { code: string; labelKo: string; labelEn?: string; reason: string; source: RulebookGrade; gapId?: string }

export interface RulebookTool {
  id: string;
  nameKo: string;
  need: RulebookSourced & { text: string };
  spec: RulebookParam[];
  note?: string;
  gapIds: string[];
}

export interface RulebookGap { id: string; title: string; needs: string; why: string; who: string; blocks: string[] }

export interface WorkStandardStep extends RulebookSourced {
  seq: number;
  operation: string;
  operationLabel?: string;
  rules: string[];
  text: string;
  condition?: string;
  targets: { role: string; roleLabel?: string; quantity?: number; source: RulebookGrade }[];
  orderBinding?: string;
}

export interface WorkStandardCheck extends RulebookSourced { text: string; criterion?: string }

export interface WorkStandardInspection extends RulebookSourced {
  seq: number;
  group: string;
  target: string;
  check: string;
  cycle: { value?: number | null; unit?: string; label?: string };
  cycleNote?: string;
}

export interface WorkStandardEventCheck extends RulebookSourced { event: string; rules: string[]; text: string }

export interface WorkStandardCadPart extends RulebookSourced {
  cadName: string;
  quantity: number;
  classCode?: string;
  kind?: string;
  threadSize?: string;
  lengthMm?: number;
  lengthSource?: RulebookGrade;
  socketSizeMm?: number;
  classBasis?: string;
  note?: string;
}

export interface WorkStandardAssembly { cadName: string; label: string; model?: string; parts: WorkStandardCadPart[] }

export interface WorkStandardSummary {
  id: string;
  title: string;
  models: string[];
  /** procedure: 작업 절차 · structure_only: CAD 구조만(절차는 근거가 없어 비어 있다) */
  kind: 'procedure' | 'structure_only';
  purpose: string;
  reviewStatus: string;
  revision: string;
  rules: string[];
  tools: string[];
  stepCount: number;
  inspectionCount: number;
  assemblyCount: number;
  gapIds: string[];
}

export interface WorkStandard extends WorkStandardSummary {
  /** 표준 시간: 근거가 없어 비어 있다 */
  standardTime: RulebookParam;
  steps: WorkStandardStep[];
  checks: WorkStandardCheck[];
  precautions: string[];
  inspectionItems: WorkStandardInspection[];
  eventChecks: WorkStandardEventCheck[];
  assemblies: WorkStandardAssembly[];
  sourceFiles: string[];
  procedureGap?: string;
  byGrade: Record<string, number>;
}

export interface RulebookFinding { level: 'error' | 'warning'; where: string; message: string }

/** ok: 읽는 중 · invalid: rules/ 에 오류가 있어 내보내지 않는다 · unavailable: 파일을 읽을 수 없다 · backend_down: PDM 백엔드가 꺼졌다 */
export interface RulebookStatus {
  state: 'ok' | 'invalid' | 'unavailable' | 'backend_down';
  message?: string;
  counts?: { operations: number; notCovered: number; tools: number; rules: number; workStandards: number; gaps: number; steps: number; inspectionItems: number };
  byGrade?: Record<string, number>;
  /** invalid 일 때의 오류 목록 */
  errors?: RulebookFinding[];
  warnings?: RulebookFinding[];
  loadedAt?: string;
}

export interface RulebookRuleFilter { classCode?: string; role?: string; operation?: string; model?: string; source?: RulebookGrade; gap?: string; scope?: RulebookRule['scope']; q?: string }
export interface WorkStandardFilter { model?: string; kind?: WorkStandardSummary['kind']; rule?: string; tool?: string; q?: string }

/** 확정한 분류 · 속성으로 적용되는 규칙 찾기. 값이 없는 조건은 '미확인'으로 처리돼 규칙이 적용된다고 단정하지 않는다 */
export interface RuleSelectRequest {
  classCode: string;
  /** 상위 분류 코드 목록(루트부터). 없으면 classCode 정확히 일치만 본다 */
  classPath?: string[];
  attributes?: Record<string, string | number | null>;
  role?: string;
  model?: string;
  includeInapplicable?: boolean;
}

export interface RuleCondition { kind: 'class' | 'role' | 'model' | 'attribute' | 'lookup'; key: string; expected: string; actual?: string; result: 'yes' | 'no' | 'unknown'; message: string }

export interface SelectedRule {
  rule: RulebookRule;
  /** yes: 조건이 모두 확인됨 · unknown: 값을 몰라 단정할 수 없음 · no: 해당 없음 */
  applicable: 'yes' | 'no' | 'unknown';
  matchedConditions: RuleCondition[];
  unknownConditions: RuleCondition[];
  failedConditions: RuleCondition[];
  lookup?: { key: string; status: 'selected' | 'candidates' | 'all' | 'none'; rows: RulebookLookupRow[] };
  /** 값이 비었거나 사용설명서 근거가 아닌(cad · unknown · standard · 추정) 파라미터 이름 */
  unconfirmedParameters: string[];
}

export interface RuleSelectResponse {
  classCode: string;
  role?: string;
  model?: string;
  rules: SelectedRule[];
  counts: { yes: number; unknown: number; no: number };
  note: string;
}

/** 규칙집을 읽지 못했다 (백엔드 꺼짐 · rules/ 검증 오류 · 파일 없음) */
export class RulebookError extends Error {
  constructor(message: string, readonly kind: 'backend_down' | 'invalid' | 'unavailable', readonly errors: RulebookFinding[] = []) {
    super(message);
  }
}

/** 조립 규칙 · 작업표준서를 읽는 길. HTTP 구현에만 있다(없으면 규칙집을 읽지 않는다: PdmApi.rulebook). 읽기 전용이다 */
export interface RulebookSource {
  status(): Promise<RulebookStatus>;
  listRules(filter?: RulebookRuleFilter): Promise<RulebookRule[]>;
  getRule(id: string): Promise<RulebookRule>;
  listOperations(): Promise<{ operations: RulebookOperation[]; notCovered: RulebookNotCovered[] }>;
  listTools(): Promise<RulebookTool[]>;
  listWorkStandards(filter?: WorkStandardFilter): Promise<WorkStandardSummary[]>;
  getWorkStandard(id: string): Promise<WorkStandard>;
  listGaps(): Promise<RulebookGap[]>;
  /** 같은 요청은 한 번만 보낸다(HTTP 구현이 기억한다). 읽지 못하면 RulebookError */
  selectRules(req: RuleSelectRequest): Promise<RuleSelectResponse>;
}

/** OPMS 를 읽는 길. 있으면 분류 · 부품을 OPMS 에서 읽는다(PdmApi.opms) */
export interface OpmsSource {
  status(): Promise<OpmsStatus>;
  getPart(partNo: string): Promise<OpmsPartInfo>;
  /** 분류가 요구하는 속성(필수 여부 · 값 범위 · 관례로 채워지는 값). OPMS 를 못 읽으면 ApiError(503) */
  getClassSpec(code: string): Promise<OpmsClassSpec>;
}

/**
 * 화면이 쓰는 API. 지금은 비어 있는 구현(api/emptyApi.ts)과 백엔드 HTTP 구현(api/httpApi.ts)이 있고, 백엔드 · OPMS 가 연결되면 같은 형태를 HTTP 로 구현해 끼운다.
 * connected 가 false 면 데이터를 읽어 올 곳이 없는 것이다: 화면은 "없음"이 아니라 "OPMS 에 연결되면 표시돼요"라고 말한다.
 */
export interface PdmApi {
  /** 보유 품번 · 규칙 · 제품 데이터를 읽어 올 곳(백엔드 · OPMS)에 연결돼 있는가 */
  readonly connected: boolean;
  /** OPMS 의 분류 · 부품을 읽는 길. HTTP 구현에만 있다(없으면 OPMS 를 읽지 않는다). connected 와 별개다: 제품 · 규칙 · MES 는 OPMS 에 없는 데이터다 */
  readonly opms?: OpmsSource;
  /** 조립 규칙 · 작업표준서(PDM 소유 규칙집)를 읽는 길. HTTP 구현에만 있다 */
  readonly rulebook?: RulebookSource;
  listProducts(): Promise<Product[]>;
  listClasses(): Promise<TaxonomyClass[]>;
  listMaterials(): Promise<Material[]>;

  listItems(query: ItemQuery): Promise<ItemSummary[]>;
  getItem(itemNo: string): Promise<ItemDetail>;
  getBom(revisionId: number, rule: BomRule): Promise<BomNode[]>;
  getWhereUsed(itemId: number): Promise<WhereUsedRow[]>;
  getDocuments(revisionId: number): Promise<DocumentLink[]>;
  getPassages(revisionId: number): Promise<Passage[]>;

  /** hints(부품 이름 → 규격 값: 사람이 확정한 값 또는 CAD 형상 추정 값)가 있으면 이름 매칭에 더해 규격으로도 보유 품번을 찾는다 */
  matchCadParts(names: string[], hints?: Record<string, CadPartHint>): Promise<CadPartMatch[]>;
  /** 같은 규격으로 이미 물어본 결과를 기억해 두는 구현(HTTP)이 그 기억을 비운다. CAD 를 바꾸거나 OPMS 연결이 돌아오면 부른다 */
  clearMatchCache?(): void;
  /** 조립 규칙이 있는 부품만 돌려준다 */
  getAssemblyGuides(parts: AssemblyPartInput[]): Promise<AssemblyGuide[]>;
  listAssemblyRules(): Promise<AssemblyRuleSummary[]>;
  getAssemblyRule(id: string): Promise<AssemblyRuleDetail>;

  /** 제품의 제조 BOM + 작업 표준 묶음을 만든다 (미리보기). MES 로 내보내거나 발행하지 않는다 (삭제됨, 사용자 지시) */
  buildMesPackage(productCode: string, rule: BomRule): Promise<MesPackage>;

  // ---- 설계 변경 영향 분석 (docs/change-impact-design.md 6 · 7장). 변경 건의 id 는 요청 코드(CR-…)다 ----
  /** 설계 변경 API 를 읽어 올 곳(PDM 백엔드)이 있는가. 없으면 화면은 가짜 변경 건 대신 "연결되면 표시돼요"라고 말한다 */
  changesAvailable(): Promise<boolean>;
  listChanges(query?: ChangeQuery): Promise<ChangePage>;
  /** 없으면(또는 읽어 올 곳이 없으면) null */
  getChange(id: string): Promise<ChangeDetail | null>;
  createChange(body: ChangeCreateRequest): Promise<ChangeDetail>;
  addChangeTarget(id: string, body: ChangeTargetIn): Promise<ChangeTargetView>;
  removeChangeTarget(id: string, targetId: number): Promise<void>;
  setChangeScope(id: string, targetId: number, body: ChangeScopesIn): Promise<ChangeScopeView[]>;
  /** 최신(또는 run_id) 영향 분석. 아직 없으면 null */
  getImpact(id: string, runId?: number): Promise<ImpactRunView | null>;
  recomputeImpact(id: string): Promise<ImpactRunView>;
  getImpactGraph(id: string): Promise<ImpactGraphView>;
  setDisposition(id: string, findingId: number, body: DispositionIn): Promise<DispositionView>;
  submitReview(id: string, body: ChangeReviewIn): Promise<ChangeReviewView>;
  /** 요청 접수(지시 만들기) · 지시 제출 · 승인 · 반려. 서버가 상태 · 권한 · 조건을 판정한다(409 CHANGE_STATE_INVALID · DISPOSITION_REQUIRED …) */
  acceptChange(id: string): Promise<ChangeDetail>;
  submitChange(id: string): Promise<ChangeDetail>;
  approveChange(id: string): Promise<ChangeDetail>;
  rejectChange(id: string, body: ChangeRejectIn): Promise<ChangeDetail>;
  /** 온톨로지 버전 변경이 미칠 후보 보고(읽기). 부품 개정을 만들지 않는다. 읽어 올 곳이 없으면 null */
  getOntologyImpact(from?: string, to?: string): Promise<OntologyImpactView | null>;
}

export class ApiError extends Error {
  /** code · details 는 백엔드의 오류 본문({error:{code,details}})이 있을 때만 있다(설계 변경 API) */
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 503, readonly code?: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

// ---------------------------------------------------------------- 설계 변경 영향 분석 (선 형식 snake_case 를 그대로 둔다)
// 원본: backend/src/onto_pdm/contracts.py 의 Change* 모델과 changes/models.py 의 열거. 백엔드는 값이 없는 키를 빼고 보낸다(exclude_none).

export type ChangeOrigin = 'design' | 'quality' | 'supplier' | 'ontology_impact' | 'other';
export type RequestStatus = 'draft' | 'submitted' | 'accepted' | 'rejected' | 'withdrawn';
export type OrderStatus = 'draft' | 'in_review' | 'approved' | 'rejected' | 'implemented' | 'cancelled';
/** replace: 규격이 바뀌어 새 품번 · revise: 같은 품번의 개정 · bom_edit: BOM 줄 편집 · attribute_edit: PDM 소유 수치 변경 */
export type ChangeKind = 'replace' | 'revise' | 'bom_edit' | 'attribute_edit';
export type ChangeApplies = 'new' | 'old';
/** none: 영향 없음(정보) · review: 사람이 확인 · affected: 처분 필요 · blocked: 제안대로면 성립하지 않아 승인할 수 없다 */
export type Severity = 'none' | 'review' | 'affected' | 'blocked';
export type Verdict = 'ok' | 'conditional' | 'no' | 'unknown';
export type FindingKind =
  | 'bom_usage' | 'product' | 'work_order' | 'purchase_order_line' | 'stock_lot' | 'fit_pair' | 'fit_grip' | 'strength_grade' | 'substitute';
export type ScopeClass = 'inside' | 'outside' | 'partial' | 'unknown';
export type ReviewFunction = 'design' | 'purchasing' | 'production';
export type ReviewVerdict = 'approve' | 'reject' | 'comment';
export type DispositionAction =
  | 'continue_old' | 'change_in_progress' | 'cancel_reissue' | 'use_as_is' | 'apply_new'
  | 'receive_and_use' | 'amend' | 'cancel'
  | 'use_up' | 'quarantine' | 'return' | 'scrap'
  | 'block_change' | 'choose_substitute' | 'review_with_design'
  | 'accept_risk' | 'acknowledge' | 'no_action_needed';

export interface ChangeRunSummary { blocked: number; affected: number; review: number; none: number; stale: boolean; partial: boolean }

export interface ChangeSummary {
  code: string; title: string; status: RequestStatus; order_code?: string; order_status?: OrderStatus; product_code?: string;
  origin: ChangeOrigin; requested_by: string; requested_at: string; run_summary?: ChangeRunSummary;
}
export interface ChangePage { items: ChangeSummary[]; total: number; page: number; size: number }
export interface ChangeQuery { status?: RequestStatus; product?: string; q?: string; page?: number; size?: number }

export interface ChangeCreateRequest {
  title: string; reason: string; origin?: ChangeOrigin; before_summary?: string; after_summary?: string; product_code?: string; ontology_impact_id?: number;
}
export interface ChangeScopeIn {
  effective_from?: string; effective_to?: string; site?: string; lot_nos?: string[]; serial_from?: number; serial_to?: number; applies?: ChangeApplies; note?: string;
}
export interface ChangeScopeView extends ChangeScopeIn { id: number; applies: ChangeApplies }
export interface ChangeScopesIn { scopes: ChangeScopeIn[] }
export interface ChangeTargetIn {
  change_kind: ChangeKind; item_no: string; from_revision?: string; to_revision?: string; replacement_item_no?: string; parent_revision?: string;
  before?: Record<string, unknown>; after?: Record<string, unknown>; note?: string;
}
export interface ChangeTargetView extends ChangeTargetIn { id: number; before: Record<string, unknown>; after: Record<string, unknown>; note: string; scopes: ChangeScopeView[] }

export interface FindingBasisView { ontology_version: string; rule_id?: string; as_of: string }
export interface ImpactFindingView {
  id: number; kind: FindingKind; subject_type: string; subject_ref: string; severity: Severity; verdict?: Verdict; reason_code: string; message: string;
  basis: FindingBasisView;
  /** 임시 판정: OPMS 가 판정 API 를 주기 전에 PDM 이 OPMS 규칙으로 계산한 것(기준 미지정) */
  temporary: boolean;
  /** 입력 중에 CAD 추정값이 있다 */
  approximate: boolean;
  inputs: Record<string, unknown>;
  required?: number; actual?: number; gap?: number; scope_class?: ScopeClass; suggested_disposition?: DispositionAction;
}
export interface ImpactRunView {
  id: number; order_code: string; computed_at: string; computed_by: string; input_hash: string; ontology_version: string;
  temporary: boolean;
  /** OPMS 를 못 읽어 적합성을 판정하지 못했다. 이 분석으로는 승인할 수 없다 */
  partial: boolean;
  external_as_of: Record<string, string>;
  /** 분석 뒤 외부 데이터가 바뀌었다: 다시 분석해야 한다 */
  stale: boolean; stale_reasons: string[]; warnings: string[]; summary: ChangeRunSummary; findings: ImpactFindingView[];
}
export interface DispositionIn { action: DispositionAction; reason: string; scope_id?: number }
export interface DispositionView {
  id: number; finding_id: number; finding_kind: FindingKind; action: DispositionAction; reason: string; scope_id?: number;
  decided_by: string; decided_at: string; superseded_by?: number;
}
export interface ChangeReviewIn { function: ReviewFunction; verdict: ReviewVerdict; comment?: string }
export interface ChangeReviewView extends ChangeReviewIn { id: number; run_id: number; reviewer: string; reviewed_at: string; comment: string }
export interface ChangeRejectIn { reason: string }
export interface ChangeOrderView {
  code: string; status: OrderStatus; product_code?: string; approved_by?: string; approved_at?: string; approved_run_id?: number;
}
export interface ChangeDetail {
  code: string; title: string; reason: string; origin: ChangeOrigin; before_summary: string; after_summary: string; status: RequestStatus;
  product_code?: string; requested_by: string; requested_at: string; order?: ChangeOrderView;
  targets: ChangeTargetView[]; latest_run?: ImpactRunView; dispositions: DispositionView[]; reviews: ChangeReviewView[];
}

export type ImpactGraphNodeKind = 'change' | 'item' | 'revision' | 'product' | 'work_order' | 'purchase_order_line' | 'stock_lot' | 'joint';
export type ImpactGraphEdgeKind = 'changes' | 'replaces' | 'contains' | 'uses_bom' | 'orders' | 'stock_of' | 'affects';
export interface ImpactGraphNode { id: string; label: string; kind: ImpactGraphNodeKind; severity?: Severity }
export interface ImpactGraphEdge { source: string; target: string; kind: ImpactGraphEdgeKind }
export interface ImpactGraphView { nodes: ImpactGraphNode[]; edges: ImpactGraphEdge[] }
export interface OntologyImpactView {
  from_version: string; to_version: string; computed_at: string; rules_changed: string[]; parts_flagged: string[]; change_request_code?: string;
}
