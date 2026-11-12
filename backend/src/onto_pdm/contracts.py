"""웹이 쓰는 API 계약(web/src/api/types.ts)의 Python 쪽 원본. 선(wire) 형식은 OPMS 관례인 snake_case 다.

- 웹 `PdmApi`(camelCase)와 이름이 1:1 로 대응한다 (loginId ↔ login_id). HTTP 클라이언트가 변환한다.
- 계약 버전은 OPMS 와 따로 센다. 필드를 바꾸면 올리고, 새 모델만 더하는 것은 올리지 않는다.
- `onto-pdm contracts export` 가 contracts/pdm_api.schema.json 과 examples/*.json 을 만든다.
"""

from __future__ import annotations

from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict

from onto_pdm.changes.models import (
    Applies, ChangeKind, ChangeOrigin, DispositionAction, FindingKind, OrderStatus, PurchaseOrderStatus, RequestStatus,
    ReviewFunction, ReviewVerdict, ScopeClass, Severity, SourceSystem, StockLotStatus, Verdict, WorkOrderStatus,
)

PDM_CONTRACT_VERSION = "1"


class ContractModel(BaseModel):
    """OPMS `registry.contracts.ContractModel` 과 같은 설정."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_serialization_defaults_required=True,
        validate_by_name=True,
        validate_by_alias=True,
        serialize_by_alias=True,
    )


T = TypeVar("T")


class Page(ContractModel, Generic[T]):
    """OPMS 의 Page[T] 와 같다: items · total · page · size."""

    items: list[T]
    total: int
    page: int
    size: int


class ErrorBody(ContractModel):
    code: str
    message: str
    details: dict[str, Any] | None = None


class ApiError(ContractModel):
    """오류 본문 {"error": {"code", "message", "details"}} — OPMS 와 같은 모양."""

    error: ErrorBody


class Health(ContractModel):
    status: Literal["ok"] = "ok"
    contract_version: Literal["1"] = PDM_CONTRACT_VERSION


# ---------------------------------------------------------------- 사용자 · 제품 · 분류

ItemType = Literal["assembly", "part", "standard", "purchased"]
RevisionStatus = Literal["wip", "in_review", "released", "obsolete"]
BomRule = Literal["released", "latest"]
UserRole = Literal["admin", "approver", "engineer", "viewer"]


class User(ContractModel):
    id: int
    login_id: str
    name: str
    role: UserRole


class Product(ContractModel):
    id: int
    code: str
    name: str
    description: str | None = None
    root_item_no: str


class TaxonomyClass(ContractModel):
    iri: str  # cls:C0101
    code: str  # C0101
    label_ko: str
    label_en: str | None = None
    parent_iri: str | None = None
    kind: Literal["part", "material"]


class Material(ContractModel):
    iri: str  # mat:M000001
    name: str  # SUS304
    aliases: list[str]
    class_iri: str
    density: float | None = None  # g/cm³


# ---------------------------------------------------------------- 품목 · 리비전 · BOM


class Revision(ContractModel):
    id: int
    item_id: int
    rev: str
    rev_seq: int
    status: RevisionStatus
    change_note: str | None = None
    released_at: str | None = None
    created_by: int
    created_at: str


class Identifier(ContractModel):
    scheme: Literal["legacy", "erp", "mes", "supplier", "customer", "drawing", "cad_name"]
    value: str


class InventoryRow(ContractModel):
    source: Literal["ERP", "MES"]
    site: str
    location: str
    qty_on_hand: float
    qty_allocated: float
    unit: str
    as_of: str


class ItemSummary(ContractModel):
    """목록 · 상세에 쓰는 품목 + 리비전 요약 (item_current 뷰)."""

    id: int
    item_no: str
    name: str
    name_ko: str | None = None
    item_type: ItemType
    unit: str
    class_iri: str | None = None
    material_iri: str | None = None
    attributes: dict[str, str | float | int]
    mass_kg: float | None = None
    mass_source: Literal["cad_mass", "cad_estimate", "measured"] | None = None
    created_by: int
    latest_revision: Revision | None = None
    released_revision: Revision | None = None


class ItemDetail(ItemSummary):
    revisions: list[Revision]  # 이 사용자에게 보이는 리비전만, 최신이 앞
    identifiers: list[Identifier]
    inventory: list[InventoryRow]
    products: list[Product]  # 이 품목을 쓰는 제품 (역전개)


class ItemPage(Page[ItemSummary]):
    pass


class BomNode(ContractModel):
    line_id: int
    depth: int
    find_no: int | None = None
    quantity: float
    total_quantity: float  # 루트 1개당
    item: ItemSummary
    revision: Revision | None = None  # 규칙으로 고른 자식 리비전
    children: list[BomNode]


class ProductBom(ContractModel):
    """GET /products/{code}/bom — 제품의 최상위 조립품과 BOM 트리 (웹 제품 연결 화면이 한 번에 쓴다)."""

    product: Product
    root_item: ItemSummary
    revision: Revision | None = None
    rule: BomRule
    nodes: list[BomNode]


class WhereUsedRow(ContractModel):
    depth: int
    parent: ItemSummary
    parent_revision: Revision
    quantity: float


# ---------------------------------------------------------------- 문서


DocType = Literal["cad_3d", "drawing", "spec", "manual", "bom_sheet", "other"]
LinkStatus = Literal["suggested", "confirmed", "rejected"]
MatchMethod = Literal["manual", "filename", "step_product", "bom_import", "text_search", "ai"]


class DocumentLink(ContractModel):
    document_id: int
    doc_no: str
    title: str
    doc_type: DocType
    link_type: Literal["cad_model", "drawing", "spec", "manual", "reference"]
    rev: str  # 표시할 리비전
    pinned: bool  # true: 리비전 고정, false: 최신 승인본 따라감
    file_name: str | None = None
    file_url: str | None = None
    match_method: MatchMethod
    confidence: float | None = None
    status: LinkStatus


# ---------------------------------------------------------------- 매칭 (CAD 부품 이름 → 보유 품번)


class CadMatchRequest(ContractModel):
    names: list[str]


class CadPartMatch(ContractModel):
    """CAD 부품 이름 → 보유 품번 매칭 (docs/pdm-design.md 6장)."""

    name: str
    status: Literal["matched", "suggested", "none"]
    item_no: str | None = None
    item_name: str | None = None
    method: Literal["exact", "alias", "cad_name", "normalized", "fuzzy"] | None = None
    score: float | None = None
    class_iri: str | None = None
    class_label: str | None = None
    class_path: list[str] | None = None  # 루트부터 분류까지의 이름


# ---------------------------------------------------------------- 조립 규칙


AssemblyOperation = Literal["fasten", "weld", "press_fit", "mount", "insert", "cover"]


class AssemblyPartInput(ContractModel):
    name: str
    size: tuple[float, float, float] | None = None  # CAD 크기 (x, y, z) mm
    class_name: str | None = None
    attributes: dict[str, str | float | int] | None = None


class AssemblyGuidesRequest(ContractModel):
    parts: list[AssemblyPartInput]


class GuideParam(ContractModel):
    label: str
    value: str
    ok: bool | None = None


class AssemblyGuide(ContractModel):
    part_name: str
    rule_id: str
    rule_name: str
    operation: AssemblyOperation
    operation_label: str
    title: str
    caption: str  # 아래 자막 한 줄
    params: list[GuideParam]
    cautions: list[str]
    tools: list[str]
    source: str


class LabeledValue(ContractModel):
    label: str
    value: str


class AssemblyRuleSummary(ContractModel):
    id: str
    name: str
    operation: AssemblyOperation
    operation_label: str
    applies_to: list[str]
    key_values: list[LabeledValue]
    caution_count: int
    tool_count: int
    status: Literal["approved", "draft"]
    source: str


class RuleTable(ContractModel):
    title: str
    columns: list[str]
    rows: list[list[str]]


class RuleUsedBy(ContractModel):
    item_no: str
    name: str


class AssemblyRuleDetail(AssemblyRuleSummary):
    description: str
    conditions: list[str]
    parameters: list[LabeledValue]
    table: RuleTable | None = None
    cautions: list[str]
    tools: list[str]
    used_by: list[RuleUsedBy]


# ---------------------------------------------------------------- 작업 표준 묶음 (구 MES 발행 묶음, PRD 6.6)


class MesBomLine(ContractModel):
    seq: int
    level: int  # 최상위 조립품 = 0
    item_no: str
    name: str
    quantity: float  # 부모 1개당
    total_quantity: float  # 최상위 1개당
    step: int | None = None
    rule_ids: list[str]


class MesStepPart(ContractModel):
    item_no: str
    name: str
    quantity: float


class MesWorkStep(ContractModel):
    step: int
    title: str
    operation_label: str | None = None
    parts: list[MesStepPart]
    rule_ids: list[str]
    params: list[LabeledValue]
    cautions: list[str]
    tools: list[str]


class MesDocument(ContractModel):
    doc_no: str
    title: str
    doc_type: DocType
    rev: str


class MesPackage(ContractModel):
    product_code: str
    product_name: str
    root_item_no: str
    revision: str
    rule: BomRule
    generated_at: str
    bom: list[MesBomLine]
    steps: list[MesWorkStep]
    documents: list[MesDocument]
    warnings: list[str]


# ---------------------------------------------------------------- 설계 변경 영향 분석 (docs/change-impact-design.md 6장)
#
# 새 모델만 더하므로 계약 버전은 올리지 않는다. 시각은 ISO 8601 문자열(기존 계약과 같다). 열거 값은 changes.models 가 원본이다.


class ChangeRunSummary(ContractModel):
    """목록의 영향 요약. 심각도별 개수와 낡음 표시."""

    blocked: int
    affected: int
    review: int
    none: int
    stale: bool
    partial: bool


class ChangeSummary(ContractModel):
    code: str
    title: str
    status: RequestStatus
    order_code: str | None = None
    order_status: OrderStatus | None = None
    product_code: str | None = None
    origin: ChangeOrigin
    requested_by: str
    requested_at: str
    run_summary: ChangeRunSummary | None = None


class ChangePage(Page[ChangeSummary]):
    pass


class ChangeCreateRequest(ContractModel):
    """POST /changes."""

    title: str
    reason: str
    origin: ChangeOrigin = "design"
    before_summary: str = ""
    after_summary: str = ""
    product_code: str | None = None
    ontology_impact_id: int | None = None


class ChangeScopeIn(ContractModel):
    effective_from: str | None = None       # YYYY-MM-DD
    effective_to: str | None = None
    site: str | None = None
    lot_nos: list[str] | None = None
    serial_from: int | None = None
    serial_to: int | None = None
    applies: Applies = "new"
    note: str | None = None


class ChangeScopeView(ChangeScopeIn):
    id: int


class ChangeScopesIn(ContractModel):
    """PUT /changes/{id}/targets/{tid}/scope."""

    scopes: list[ChangeScopeIn]


class ChangeTargetIn(ContractModel):
    """POST /changes/{id}/targets. 종류별 필수 값은 ChangeTarget 도메인 모델이 검사한다."""

    change_kind: ChangeKind
    item_no: str
    from_revision: str | None = None
    to_revision: str | None = None
    replacement_item_no: str | None = None
    parent_revision: str | None = None
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    note: str = ""


class ChangeTargetView(ChangeTargetIn):
    id: int
    scopes: list[ChangeScopeView]


class FindingBasisView(ContractModel):
    ontology_version: str
    rule_id: str | None = None
    as_of: str


class ImpactFindingView(ContractModel):
    id: int
    kind: FindingKind
    subject_type: str
    subject_ref: str
    severity: Severity
    verdict: Verdict | None = None
    reason_code: str
    message: str
    basis: FindingBasisView
    temporary: bool
    approximate: bool
    inputs: dict[str, Any]
    required: float | None = None
    actual: float | None = None
    gap: float | None = None
    scope_class: ScopeClass | None = None
    suggested_disposition: DispositionAction | None = None


class ImpactRunView(ContractModel):
    """POST/GET /changes/{id}/impact. OPMS 를 못 읽으면 200 + partial=true 로 알린다(문제 없음으로 읽히면 안 된다)."""

    id: int
    order_code: str
    computed_at: str
    computed_by: str
    input_hash: str
    ontology_version: str
    temporary: bool
    partial: bool
    external_as_of: dict[str, str]
    stale: bool
    stale_reasons: list[str]
    warnings: list[str]
    summary: ChangeRunSummary
    findings: list[ImpactFindingView]


class DispositionIn(ContractModel):
    """PUT /changes/{id}/dispositions/{finding_id}."""

    action: DispositionAction
    reason: str
    scope_id: int | None = None


class DispositionView(ContractModel):
    id: int
    finding_id: int
    finding_kind: FindingKind
    action: DispositionAction
    reason: str
    scope_id: int | None = None
    decided_by: str
    decided_at: str
    superseded_by: int | None = None


class ChangeReviewIn(ContractModel):
    function: ReviewFunction
    verdict: ReviewVerdict
    comment: str = ""


class ChangeReviewView(ChangeReviewIn):
    id: int
    run_id: int
    reviewer: str
    reviewed_at: str


class ChangeRejectIn(ContractModel):
    """POST /changes/{id}/reject. 사유는 필수."""

    reason: str


class ChangeOrderView(ContractModel):
    code: str
    status: OrderStatus
    product_code: str | None = None
    approved_by: str | None = None
    approved_at: str | None = None
    approved_run_id: int | None = None


class ChangeDetail(ContractModel):
    """GET /changes/{id}: 요청 · 지시 · 대상 · 범위 · 최신 분석 · 처분 · 검토."""

    code: str
    title: str
    reason: str
    origin: ChangeOrigin
    before_summary: str
    after_summary: str
    status: RequestStatus
    product_code: str | None = None
    requested_by: str
    requested_at: str
    order: ChangeOrderView | None = None
    targets: list[ChangeTargetView]
    latest_run: ImpactRunView | None = None
    dispositions: list[DispositionView]
    reviews: list[ChangeReviewView]


class ChangeExport(ContractModel):
    """GET /changes/{id}/export: 승인된 지시의 내보내기. ERP · MES 에 쓰지 않는다(F-CHG-8). 판단 당시의 근거를 같이 싣는다."""

    code: str
    order_code: str
    title: str
    approved_by: str
    approved_at: str
    ontology_version: str
    temporary: bool
    targets: list[ChangeTargetView]
    findings: list[ImpactFindingView]
    dispositions: list[DispositionView]


class ImpactGraphNode(ContractModel):
    id: str
    label: str
    kind: Literal["change", "item", "revision", "product", "work_order", "purchase_order_line", "stock_lot", "joint"]
    severity: Severity | None = None


class ImpactGraphEdge(ContractModel):
    source: str
    target: str
    kind: Literal["changes", "replaces", "contains", "uses_bom", "orders", "stock_of", "affects"]


class ImpactGraphView(ContractModel):
    """GET /changes/{id}/impact/graph. 3D 영향 그래프와 목록 대안의 입력."""

    nodes: list[ImpactGraphNode]
    edges: list[ImpactGraphEdge]


class OntologyImpactItemView(ContractModel):
    """보고의 한 줄. 어느 품번 · 체결부가 왜 후보인지(이유 코드, 바뀌기 전 · 후 값). 처분이나 개정을 가리키지 않는다."""

    kind: Literal["part", "joint"]
    subject: str
    reason_code: str
    ref: str | None = None
    before: str | None = None
    after: str | None = None
    message: str = ""


class OntologyImpactView(ContractModel):
    """GET /changes/ontology-impact. 읽기 보고다. 부품 개정이나 변경 지시를 만들지 않는다(F-CHG-10)."""

    from_version: str
    to_version: str
    computed_at: str
    rules_changed: list[str]
    parts_flagged: list[str]
    items: list[OntologyImpactItemView] = []
    change_request_code: str | None = None


# --- 외부 입력(feed). 형식은 임시다(실제 ERP · MES 전송 방식 미정, design 10.3-9).


class WorkOrderBomRefIn(ContractModel):
    item_no: str
    rev: str | None = None
    qty_required: float
    qty_issued: float = 0


class WorkOrderFeedRow(ContractModel):
    wo_no: str
    site: str | None = None
    product_item_no: str
    bom_revision: str | None = None
    process_rev: str | None = None
    status: WorkOrderStatus
    qty_planned: float
    qty_done: float = 0
    lot_no: str | None = None
    serial_from: int | None = None
    serial_to: int | None = None
    start_date: str | None = None
    due_date: str | None = None
    as_of: str
    bom_refs: list[WorkOrderBomRefIn] = []


class PurchaseOrderLineFeedRow(ContractModel):
    po_no: str
    line_no: int
    item_no: str
    item_rev: str | None = None
    qty_ordered: float
    qty_received: float = 0
    due_date: str | None = None
    supplier: str | None = None
    site: str | None = None
    status: PurchaseOrderStatus = "open"
    as_of: str


class StockLotFeedRow(ContractModel):
    lot_no: str
    item_no: str
    item_rev: str | None = None
    site: str | None = None
    location: str | None = None
    qty_on_hand: float
    qty_allocated: float = 0
    status: StockLotStatus = "available"
    as_of: str


class WorkOrderFeedIn(ContractModel):
    """POST /feeds/work-orders."""

    source_system: SourceSystem
    rows: list[WorkOrderFeedRow]


class PurchaseOrderLineFeedIn(ContractModel):
    """POST /feeds/purchase-order-lines."""

    source_system: SourceSystem
    rows: list[PurchaseOrderLineFeedRow]


class StockLotFeedIn(ContractModel):
    """POST /feeds/stock-lots."""

    source_system: SourceSystem
    rows: list[StockLotFeedRow]


class FeedRejectedRow(ContractModel):
    row: int
    code: str


class FeedResult(ContractModel):
    """일부 행만 실패해도 나머지는 적용한다. 늦은 as_of 는 무시(ignored_stale), 모르는 품번은 rejected."""

    applied: int
    ignored_stale: int
    rejected: list[FeedRejectedRow]


# ---------------------------------------------------------------- 계약 목록 (export 가 읽는다)

REQUEST_MODELS: tuple[type[ContractModel], ...] = (
    CadMatchRequest,
    AssemblyGuidesRequest,
    ChangeCreateRequest,
    ChangeTargetIn,
    ChangeScopesIn,
    DispositionIn,
    ChangeReviewIn,
    ChangeRejectIn,
    WorkOrderFeedIn,
    PurchaseOrderLineFeedIn,
    StockLotFeedIn,
)

RESPONSE_MODELS: tuple[type[ContractModel], ...] = (
    Health,
    ApiError,
    User,
    Product,
    TaxonomyClass,
    Material,
    ItemSummary,
    ItemDetail,
    ItemPage,
    BomNode,
    ProductBom,
    WhereUsedRow,
    DocumentLink,
    CadPartMatch,
    AssemblyGuide,
    AssemblyRuleSummary,
    AssemblyRuleDetail,
    MesPackage,
    ChangeSummary,
    ChangePage,
    ChangeDetail,
    ChangeTargetView,
    ChangeScopeView,
    ImpactRunView,
    ImpactFindingView,
    DispositionView,
    ChangeReviewView,
    ChangeExport,
    ImpactGraphView,
    OntologyImpactItemView,
    OntologyImpactView,
    FeedResult,
)
