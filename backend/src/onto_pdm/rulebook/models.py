"""조립 규칙 · 작업표준서(`rules/`)의 응답 · 요청 모델 (snake_case 선 형식). 계약 내보내기(pdm_api.schema.json)에는 아직 넣지 않았다.

모든 값은 **출처 등급**(`source`)을 가진다: manual(사용설명서, 쪽 번호까지) · standard(공개 표준 참고값, 승인 전 사용 금지) · cad(CAD 에서 도출) · unknown(근거 없음).
`unknown` 은 값을 지어내지 않고 `value: null` + `gap_id`(작성이 필요한 공백 번호)로 그대로 내보낸다.
`confirmed` 는 화면이 확정값처럼 보여도 되는가이다 — manual 이고 추정이 아니고 값이 있을 때만 true.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from onto_pdm.contracts import ContractModel

Grade = Literal["manual", "standard", "cad", "unknown"]
Scalar = str | float | int
RulebookState = Literal["ok", "invalid", "unavailable"]


class SourceRef(ContractModel):
    """근거 위치 하나. `label` 은 화면에 그대로 써도 되는 짧은 표기(예: '사용설명서(KR) 3.3절 p.49')."""

    doc: str | None = None
    doc_title: str | None = None
    doc_kind: str | None = None
    sec: str | None = None
    pages: list[int] = Field(default_factory=list)
    node: str | None = None
    standard: str | None = None
    note: str | None = None
    label: str


class Valued(ContractModel):
    """출처가 붙은 항목의 공통 필드."""

    source: Grade
    refs: list[SourceRef] = Field(default_factory=list)
    gap_id: str | None = None
    estimated: bool = False
    approval_required: bool = False
    confirmed: bool


class Param(Valued):
    name: str
    value: Any = None
    unit: str | None = None
    condition: str | None = None
    note: str | None = None


class LookupRow(Valued):
    key: str
    values: dict[str, Any] = Field(default_factory=dict)
    note: str | None = None


class Lookup(ContractModel):
    key: str
    rows: list[LookupRow]


class Caution(Valued):
    level: str
    text: str
    level_note: str | None = None


class AppliesTo(Valued):
    classes: list[str] = Field(default_factory=list)
    proposed_classes: list[str] = Field(default_factory=list)
    role: str | None = None
    role_label: str | None = None
    models: list[str] = Field(default_factory=list)
    where: dict[str, Any] = Field(default_factory=dict)


class CadInference(Valued):
    part: str
    quantity: int | None = None
    inferred: bool = False


class Rule(ContractModel):
    id: str
    name: str
    operation: str
    operation_label: str | None = None
    # part = 분류가 대상 / role = 분류 없이 역할(context.role)로만 대상 / product = 제품 · 설치 전반(분류도 역할도 없다)
    scope: Literal["part", "role", "product"]
    review_status: str
    applies_to: AppliesTo
    parameters: list[Param] = Field(default_factory=list)
    lookup: Lookup | None = None
    tools: list[str] = Field(default_factory=list)
    cautions: list[Caution] = Field(default_factory=list)
    note: str | None = None
    cad_inference: CadInference | None = None
    by_grade: dict[str, int]
    gap_ids: list[str] = Field(default_factory=list)


class Operation(Valued):
    code: str
    label_ko: str
    label_en: str | None = None
    definition: str
    parent: str | None = None
    opms_code: str | None = None
    path: list[str]


class NotCovered(ContractModel):
    code: str
    label_ko: str
    label_en: str | None = None
    reason: str
    source: Grade
    gap_id: str | None = None


class OperationList(ContractModel):
    operations: list[Operation]
    not_covered: list[NotCovered]


class TextValue(Valued):
    text: str


class Tool(ContractModel):
    id: str
    name_ko: str
    need: TextValue
    spec: list[Param] = Field(default_factory=list)
    note: str | None = None
    gap_ids: list[str] = Field(default_factory=list)


class Gap(ContractModel):
    id: str
    title: str
    needs: str
    why: str
    who: str
    blocks: list[str] = Field(default_factory=list)


class StepTarget(ContractModel):
    role: str
    role_label: str | None = None
    quantity: int | None = None
    source: Grade


class Step(Valued):
    seq: int
    operation: str
    operation_label: str | None = None
    rules: list[str] = Field(default_factory=list)
    text: str
    condition: str | None = None
    targets: list[StepTarget] = Field(default_factory=list)
    order_binding: str | None = None


class Check(Valued):
    text: str
    criterion: str | None = None


class Cycle(ContractModel):
    value: float | int | None = None
    unit: str | None = None
    label: str | None = None


class InspectionItem(Valued):
    seq: int
    group: str
    target: str
    check: str
    cycle: Cycle
    cycle_note: str | None = None


class EventCheck(Valued):
    event: str
    rules: list[str] = Field(default_factory=list)
    text: str


class CadPart(Valued):
    cad_name: str
    quantity: int
    class_code: str | None = None
    kind: str | None = None
    thread_size: str | None = None
    length_mm: float | None = None
    length_source: Grade | None = None
    socket_size_mm: float | None = None
    class_basis: str | None = None
    note: str | None = None


class CadAssembly(ContractModel):
    cad_name: str
    label: str
    model: str | None = None
    parts: list[CadPart]


class WorkStandardSummary(ContractModel):
    id: str
    title: str
    models: list[str]
    kind: Literal["procedure", "structure_only"]
    purpose: str
    review_status: str
    revision: str
    rules: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    step_count: int
    inspection_count: int
    assembly_count: int
    gap_ids: list[str] = Field(default_factory=list)


class WorkStandard(WorkStandardSummary):
    standard_time: Param
    steps: list[Step] = Field(default_factory=list)
    checks: list[Check] = Field(default_factory=list)
    precautions: list[str] = Field(default_factory=list)
    inspection_items: list[InspectionItem] = Field(default_factory=list)
    event_checks: list[EventCheck] = Field(default_factory=list)
    assemblies: list[CadAssembly] = Field(default_factory=list)
    source_files: list[str] = Field(default_factory=list)
    procedure_gap: str | None = None
    by_grade: dict[str, int]


# ---------------------------------------------------------------- 상태
class Finding(ContractModel):
    level: Literal["error", "warning"]
    where: str
    message: str


class Validation(ContractModel):
    """로드할 때 돌린 검증 결과. tool='check_rules' 는 tools/check_rules.py, 'minimal' 은 그 도구가 없어 로더가 한 최소 검사다."""

    tool: Literal["check_rules", "minimal"]
    errors: list[Finding] = Field(default_factory=list)
    warnings: list[Finding] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class RulebookCounts(ContractModel):
    operations: int
    not_covered: int
    tools: int
    rules: int
    work_standards: int
    gaps: int
    steps: int
    inspection_items: int


class RulebookStatus(ContractModel):
    """켜져 있지 않아도 200 으로 답하고 state 로 이유를 말한다(웹이 '규칙 데이터 없음'을 구분해 보인다)."""

    state: RulebookState
    message: str | None = None
    rules_dir: str
    loaded_at: str | None = None
    counts: RulebookCounts | None = None
    by_grade: dict[str, int] | None = None
    validation: Validation | None = None


# ---------------------------------------------------------------- 규칙 고르기
class SelectRequest(ContractModel):
    """확정한 분류와 속성으로 적용되는 규칙 찾기. 값이 없는 것은 '미확인'으로 처리한다(단정하지 않는다)."""

    class_code: str = Field(min_length=1, max_length=128)
    # 상위 분류 목록(OPMS 분류 경로 — 읽기 어댑터의 /opms/classes 가 준다). 없으면 class_code 정확히 일치만 본다
    class_path: list[str] = Field(default_factory=list, max_length=32)
    attributes: dict[str, Scalar | None] = Field(default_factory=dict)
    role: str | None = Field(default=None, max_length=64)
    model: str | None = Field(default=None, max_length=64)
    # 제품 코드(예: HCR12A, HCR-12A). 로봇 모델로 읽을 수 있으면 model 로 쓴다
    product: str | None = Field(default=None, max_length=64)
    include_inapplicable: bool = False


class ConditionResult(ContractModel):
    kind: Literal["class", "role", "model", "attribute", "lookup"]
    key: str
    expected: str
    actual: str | None = None
    result: Literal["yes", "no", "unknown"]
    message: str


class LookupResolution(ContractModel):
    """규칙의 표(lookup)에서 요청에 맞는 행. selected=키(모델)로 하나로 정해짐 · candidates=요청 속성과 맞는 행 여럿(키를 알면 정해짐) · all=키와 속성이 무관하여 전체 · none=맞는 행이 없다."""

    key: str
    status: Literal["selected", "candidates", "all", "none"]
    rows: list[LookupRow]


class SelectedRule(ContractModel):
    rule: Rule
    applicable: Literal["yes", "no", "unknown"]
    matched_conditions: list[ConditionResult] = Field(default_factory=list)
    unknown_conditions: list[ConditionResult] = Field(default_factory=list)
    failed_conditions: list[ConditionResult] = Field(default_factory=list)
    lookup: LookupResolution | None = None
    # 값이 비었거나 사용설명서 근거가 아닌(cad · unknown · standard · 추정) 파라미터 이름 — 작업자 화면에서 확정값처럼 보이면 안 된다
    unconfirmed_parameters: list[str] = Field(default_factory=list)


class SelectCounts(ContractModel):
    yes: int
    unknown: int
    no: int


class SelectResponse(ContractModel):
    class_code: str
    role: str | None = None
    model: str | None = None
    rules: list[SelectedRule]
    counts: SelectCounts
    note: str
