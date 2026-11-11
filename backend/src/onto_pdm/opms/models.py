"""OPMS 읽기 API 의 응답 · 요청 모델 (snake_case 선 형식). 계약 내보내기(pdm_api.schema.json)에는 아직 넣지 않았다."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from onto_pdm.contracts import ContractModel

Scalar = str | float | int
OpmsState = Literal["ok", "opms_down", "not_configured", "auth_failed", "no_ontology"]


class OpmsStatus(ContractModel):
    """OPMS 읽기 연결 상태. 켜져 있지 않아도 200 으로 답하고 state 로 이유를 말한다(웹이 '연결 안 됨'을 보인다)."""

    state: OpmsState
    message: str | None = None
    ontology_version: str | None = None
    classes: int | None = None
    parts: int | None = None


class OpmsLookupDefault(ContractModel):
    """다른 속성 값에서 관례로 정해지는 값 (예: 피치 = 나사 규격의 보통 나사 값). OPMS 의 properties.<속성>.lookup 의 기본 열만 옮긴 것이다."""

    key: str
    series: str | None = None
    series_label: str | None = None
    # 나사 규격 → 기본 열의 값 (예: M4 → [0.7]). 기본 열이 없으면 비어 있다
    values: dict[str, list[float]] = Field(default_factory=dict)


class OpmsPropertySpec(ContractModel):
    key: str
    label_ko: str
    label_en: str | None = None
    datatype: str
    unit: str | None = None
    scheme: str | None = None
    required: bool = False
    min: float | None = None
    max: float | None = None
    fixed: str | None = None
    # 원문에 값이 없으면 OPMS 가 관례로 채우는 개념 코드와 그 이름 (예: 나사 방향 → RightHand · 오른나사)
    omitted_default: str | None = None
    omitted_default_label: str | None = None
    lookup_default: OpmsLookupDefault | None = None


class OpmsKeyProperty(ContractModel):
    prop: str
    label_ko: str
    blocking: bool = False
    weight: float = 1.0
    tolerance: float | None = None
    tolerance_type: str | None = None


class OpmsClass(ContractModel):
    code: str
    label_ko: str
    label_en: str | None = None
    definition: str | None = None
    parent: str | None = None
    leaf: bool
    path: list[str]
    path_labels: list[str]
    family_root: str | None = None
    head_type: str | None = None
    head_type_source: Literal["ontology", "pdm_temporary"] | None = None


class OpmsClassDetail(OpmsClass):
    properties: list[OpmsPropertySpec]
    key_properties: list[OpmsKeyProperty]
    distinguishing: list[str]


class OpmsPart(ContractModel):
    part_no: str
    class_code: str
    class_label: str
    class_path_labels: list[str]
    # OPMS 부품에는 이름이 없다: 분류 · 핵심 속성으로 만든 표시 이름
    label: str
    values: dict[str, Scalar]
    value_labels: dict[str, str]


class OpmsPartPage(ContractModel):
    items: list[OpmsPart]
    total: int
    page: int
    size: int


class OpmsMatchRequest(ContractModel):
    """CAD 에서 읽고 사람이 확정한 값으로 OPMS 부품 후보를 찾는다 (임시 구현: OPMS 의 match API 가 열리면 교체)."""

    class_code: str | None = None
    head_type: str | None = None
    values: Annotated[dict[str, Scalar], Field(max_length=30)]
    approximate: bool = True
    limit: Annotated[int, Field(ge=1, le=50)] | None = None


class OpmsMatchProp(ContractModel):
    prop_key: str
    label: str
    hit: bool | None
    doc_display: str | None = None
    part_display: str | None = None


class OpmsMatchCandidate(ContractModel):
    part_no: str
    class_code: str
    class_label: str
    class_path_labels: list[str]
    label: str
    verdict: Literal["confirmed", "suspected"]
    score: float
    capped: bool
    class_capped: bool
    via: Literal["key_props"] = "key_props"
    matched: list[OpmsMatchProp]


class OpmsMatchResult(ContractModel):
    verdict: Literal["confirmed", "suspected", "none"]
    reason: Literal["ok", "no_values", "no_candidate", "unknown_class"]
    candidates: list[OpmsMatchCandidate]
    ontology_version: str
    # 이 판정은 OPMS 가 준 것이 아니라 PDM 이 OPMS 의 dedupe 방식을 따라 임시로 계산한 것이다
    temporary: Literal[True] = True
    note: str | None = None
