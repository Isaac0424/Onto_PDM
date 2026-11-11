"""웹이 쓰는 API 계약(web/src/api/types.ts)의 Python 쪽 원본. 선(wire) 형식은 OPMS 관례인 snake_case 다.

- 웹 `PdmApi`(camelCase)와 이름이 1:1 로 대응한다 (loginId ↔ login_id). HTTP 클라이언트가 변환한다.
- 계약 버전은 OPMS 와 따로 센다. 필드를 바꾸면 올리고, 새 모델만 더하는 것은 올리지 않는다.
- `onto-pdm contracts export` 가 contracts/pdm_api.schema.json 과 examples/*.json 을 만든다.
"""

from __future__ import annotations

from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict

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


# ---------------------------------------------------------------- 등록 요청 · 매칭


RequestStatus = Literal["draft", "submitted", "approved", "rejected", "cancelled"]


class PartRequestPayload(ContractModel):
    name: str | None = None
    name_ko: str | None = None
    item_type: ItemType | None = None
    unit: str | None = None
    class_iri: str | None = None
    material_iri: str | None = None
    aliases: list[Identifier] | None = None
    note: str | None = None


class DuplicateCandidate(ContractModel):
    item_no: str
    name: str
    method: Literal["exact", "alias", "cad_name", "normalized", "fuzzy"]
    score: float


class PartRequest(ContractModel):
    id: int
    source_system: Literal["PDM", "PLM", "AGENT"]
    status: RequestStatus
    payload: PartRequestPayload
    class_proposal_id: int | None = None
    duplicate_check: list[DuplicateCandidate] | None = None
    issued_item_no: str | None = None
    requested_by: int
    reviewed_by: int | None = None
    review_note: str | None = None
    created_at: str
    updated_at: str


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


class RuleIssue(ContractModel):
    severity: Literal["error", "warning"]
    rule_id: str | None = None
    code: Literal["overlap", "missing_value", "no_source", "empty_table", "no_scope", "no_caution", "unused"]
    message: str


# ---------------------------------------------------------------- MES 발행 (PRD 6.6)


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


class MesPublication(ContractModel):
    id: int
    product_code: str
    revision: str
    rule: BomRule
    status: Literal["pending", "sent", "failed"]
    created_at: str
    sent_at: str | None = None
    error: str | None = None
    bom_lines: int
    steps: int


# ---------------------------------------------------------------- BOM 시트(csv) 가져오기


class BomSheetRowInput(ContractModel):
    line: int
    item_no: str | None = None
    name: str | None = None
    quantity: float
    find_no: int | None = None


class BomSheetMatchRequest(ContractModel):
    rows: list[BomSheetRowInput]


class BomSheetMatch(ContractModel):
    line: int
    status: Literal["matched", "suggested", "none"]
    item_no: str | None = None
    item_name: str | None = None
    reason: str  # 왜 이렇게 판단했나 (사람이 읽는 한 줄)


# ---------------------------------------------------------------- 계약 목록 (export 가 읽는다)

REQUEST_MODELS: tuple[type[ContractModel], ...] = (
    CadMatchRequest,
    AssemblyGuidesRequest,
    BomSheetMatchRequest,
    PartRequestPayload,
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
    PartRequest,
    CadPartMatch,
    AssemblyGuide,
    AssemblyRuleSummary,
    AssemblyRuleDetail,
    RuleIssue,
    MesPackage,
    MesPublication,
    BomSheetMatch,
)
