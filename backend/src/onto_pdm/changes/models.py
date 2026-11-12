"""변경 영향 분석의 도메인 모델 · 열거 · 상태 전이 · 개정/교체 판별.

근거: docs/change-impact-design.md 3 · 4.5 · 4.7 · 6장, docs/change-impact-ontology.md 3 · 5 · 7장.

- 영향 발견(`ImpactFinding`)과 처분(`Disposition`)은 분리한다. 영향이 있다는 것이 변경해야 한다는 뜻은 아니다.
- 온톨로지 버전은 부품 개정이 아니다. `OntologyImpact` 는 읽기 보고이고 개정 · 대상 필드를 갖지 않는다(F-CHG-10).
- 외부(ERP · MES) 객체는 읽기 사본이라 `source_system` 과 `as_of` 가 필수다.
- 엔진 로직(그립 길이 · 범위 겹침 · 영향 탐색)은 여기에 없다. 여기는 값의 모양과 규칙 표만 둔다.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import date
from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

# ---------------------------------------------------------------- 열거

ChangeOrigin = Literal["design", "quality", "supplier", "ontology_impact", "other"]
RequestStatus = Literal["draft", "submitted", "accepted", "rejected", "withdrawn"]
OrderStatus = Literal["draft", "in_review", "approved", "rejected", "implemented", "cancelled"]
ChangeKind = Literal["replace", "revise", "bom_edit", "attribute_edit"]
Applies = Literal["new", "old"]
Severity = Literal["none", "review", "affected", "blocked"]
Verdict = Literal["ok", "conditional", "no", "unknown"]
FindingKind = Literal[
    "bom_usage", "product", "work_order", "purchase_order_line", "stock_lot",
    "fit_pair", "fit_grip", "strength_grade", "substitute",
]
ScopeClass = Literal["inside", "outside", "partial", "unknown"]
ReviewFunction = Literal["design", "purchasing", "production"]
ReviewVerdict = Literal["approve", "reject", "comment"]
SourceSystem = Literal["ERP", "MES", "fixture"]
WorkOrderStatus = Literal["planned", "released", "in_progress", "completed", "closed", "cancelled"]
PurchaseOrderStatus = Literal["open", "partial", "closed"]
StockLotStatus = Literal["available", "quarantine", "hold"]
SpecSource = Literal["drawing", "opms", "cad_estimate", "manual"]
DispositionAction = Literal[
    # 작업지시
    "continue_old", "change_in_progress", "cancel_reissue", "use_as_is", "apply_new",
    # 발주 항목
    "receive_and_use", "amend", "cancel",
    # 재고 로트
    "use_up", "quarantine", "return", "scrap",
    # 적합성 finding
    "block_change", "choose_substitute", "review_with_design",
    # 공통
    "accept_risk", "acknowledge", "no_action_needed",
]

FIT_KINDS: frozenset[str] = frozenset({"fit_pair", "fit_grip", "strength_grade", "substitute"})
EXTERNAL_KINDS: frozenset[str] = frozenset({"work_order", "purchase_order_line", "stock_lot"})

# 4.7 처분 선택지: finding 종류별로 고를 수 있는 값. 선택지는 PDM 안의 결정 기록이고 ERP · MES 에 쓰지 않는다.
ALLOWED_ACTIONS: Mapping[str, frozenset[str]] = {
    "work_order": frozenset({"continue_old", "change_in_progress", "cancel_reissue", "use_as_is", "apply_new", "no_action_needed"}),
    "purchase_order_line": frozenset({"receive_and_use", "amend", "cancel", "accept_risk", "no_action_needed"}),
    "stock_lot": frozenset({"use_up", "quarantine", "return", "scrap", "accept_risk", "no_action_needed"}),
    **{k: frozenset({"block_change", "choose_substitute", "review_with_design", "accept_risk", "no_action_needed"}) for k in FIT_KINDS},
    "bom_usage": frozenset({"acknowledge", "no_action_needed"}),
    "product": frozenset({"acknowledge", "no_action_needed"}),
}


def is_action_allowed(finding_kind: str, action: str) -> bool:
    """대상 종류에 없는 선택지는 `DISPOSITION_INVALID`(422)다. `accept_risk` 를 `blocked` 에 쓸 수 있는지는 정책(design 10.3-2)이라 여기서 정하지 않는다."""
    return action in ALLOWED_ACTIONS.get(finding_kind, frozenset())


# 4.5 심각도: 막는다 / 처분이 있어야 한다 / 사람이 확인한다. blocked 가 남으면 승인할 수 없다(기본, 10.3-2).
SEVERITY_RANK: Mapping[str, int] = {"blocked": 0, "affected": 1, "review": 2, "none": 3}   # 정렬: 심각한 것이 먼저
SEVERITIES_BLOCKING_APPROVAL: frozenset[str] = frozenset({"blocked"})
SEVERITIES_NEEDING_DISPOSITION: frozenset[str] = frozenset({"affected"})   # review 는 no_action_needed 로 닫을 수 있다


def requires_disposition(severity: str) -> bool:
    return severity in SEVERITIES_NEEDING_DISPOSITION


def blocks_approval(severity: str) -> bool:
    return severity in SEVERITIES_BLOCKING_APPROVAL


# 이유 코드. OPMS 이유 코드는 그대로(OPMS contracts.py:1769-1877), PDM 고유는 ontology 3.3. 목록에 없는 값도 받는다(자유 문자열).
OPMS_REASON_CODES: tuple[str, ...] = (
    "shortfall", "thin_margin", "value_missing", "value_unreadable", "approximate_value", "unit_unconvertible", "no_rule",
)
PDM_REASON_CODES: tuple[str, ...] = (
    "pair_mismatch", "pair_unknown", "pair_unrelated", "strength_differs", "substitute_conditional",
    "used_in_completed", "used_in_progress", "open_po_line", "stock_on_hand", "scope_unknown", "OPMS_UNAVAILABLE",
)


class ChangeErrorCode:
    """API 오류 코드(design 6장). 한 곳에서만 정의한다. 기존 `errors.py` 의 ApiException 에 그대로 넣는다."""

    CHANGE_NOT_FOUND = "CHANGE_NOT_FOUND"
    ITEM_NOT_FOUND = "ITEM_NOT_FOUND"
    TARGET_NOT_RELEASED = "TARGET_NOT_RELEASED"
    REVISION_CHANGES_IDENTITY = "REVISION_CHANGES_IDENTITY"       # 422 규격이 바뀌면 새 품번(교체)이다
    ONTOLOGY_NOT_A_TARGET = "ONTOLOGY_NOT_A_TARGET"               # 400 온톨로지는 변경 대상이 아니다(F-CHG-10)
    CHANGE_STATE_INVALID = "CHANGE_STATE_INVALID"
    SCOPE_INVALID = "SCOPE_INVALID"                               # 422
    SCOPE_OVERLAP = "SCOPE_OVERLAP"
    SCOPE_REQUIRED = "SCOPE_REQUIRED"                             # 범위가 없으면 '전체 · 즉시'가 아니라 미정이다
    IMPACT_NOT_COMPUTED = "IMPACT_NOT_COMPUTED"
    IMPACT_STALE = "IMPACT_STALE"                                 # design 6.2 · 6.3 의 이름. (지시문의 STALE_IMPACT 와 같은 뜻)
    IMPACT_PARTIAL = "IMPACT_PARTIAL"                             # OPMS 를 못 읽은 분석으로는 승인할 수 없다
    DISPOSITION_INVALID = "DISPOSITION_INVALID"                   # 422 대상 종류에 없는 선택지
    DISPOSITION_REQUIRED = "DISPOSITION_REQUIRED"                 # details.finding_ids
    REVIEW_REQUIRED = "REVIEW_REQUIRED"                           # details.functions
    BLOCKED_FINDINGS = "BLOCKED_FINDINGS"                         # blocked 영향이 남아 있다
    CHANGE_NOT_APPROVED = "CHANGE_NOT_APPROVED"
    OPMS_NOT_CONFIGURED = "OPMS_NOT_CONFIGURED"
    FEED_NOT_CONFIGURED = "FEED_NOT_CONFIGURED"
    FORBIDDEN = "FORBIDDEN"


# ---------------------------------------------------------------- 기반

class _Model(BaseModel):
    """값처럼 쓰는 불변 모델. 상태를 바꿀 때는 `model_copy(update=...)` 로 새로 만든다."""

    model_config = ConfigDict(extra="forbid", frozen=True, validate_assignment=False)


_KEY = r"^[A-Za-z][A-Za-z0-9_]*$"
_CODE_CR = r"^CR-\d{4}-\d{4}$"
_CODE_CO = r"^CO-\d{4}-\d{4}$"


def _finite(v: float) -> float:
    if not math.isfinite(v):
        raise ValueError("유한한 숫자여야 합니다")
    return v


# ---------------------------------------------------------------- 개정 vs 교체 (ontology 5장 · design 10.3-10)

# OPMS 가 품번을 가르는 식별 속성. 하나라도 다르면 다른 부품(새 품번)이다.
IDENTITY_KEYS: tuple[str, ...] = ("threadSize", "length", "pitch", "material", "strengthGrade")


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return math.isclose(float(a), float(b), rel_tol=0, abs_tol=1e-9)
    if isinstance(a, str) and isinstance(b, str):
        return a.strip() == b.strip()
    return a == b


def identity_changes(
    before_attrs: Mapping[str, Any], after_attrs: Mapping[str, Any],
    before_class: str | None = None, after_class: str | None = None,
) -> list[str]:
    """식별 속성과 분류 중 달라진 것의 이름. 한쪽에만 값이 있어도 다른 것으로 본다(같다고 단정할 근거가 없으므로, 규격 변경을 개정으로 잘못 부르는 쪽이 위험하다)."""
    out: list[str] = []
    for key in IDENTITY_KEYS:
        in_b, in_a = key in before_attrs, key in after_attrs
        if in_b != in_a or (in_b and not _same(before_attrs[key], after_attrs[key])):
            out.append(key)
    if (before_class or None) != (after_class or None):
        out.append("class")
    return out


def classify_change_kind(
    before_attrs: Mapping[str, Any], after_attrs: Mapping[str, Any],
    before_class: str | None = None, after_class: str | None = None,
) -> Literal["replace", "revise"]:
    """규격(식별 속성 · 분류)이 바뀌면 새 품번 = `replace`, 같은 품번 안의 값(도면 · 공차 · 검사 조건)이면 `revise`."""
    return "replace" if identity_changes(before_attrs, after_attrs, before_class, after_class) else "revise"


# ---------------------------------------------------------------- 상태 전이 (design 6.4)

REQUEST_TRANSITIONS: Mapping[str, frozenset[str]] = {
    "draft": frozenset({"submitted", "withdrawn"}),
    "submitted": frozenset({"accepted", "rejected", "withdrawn"}),
    "accepted": frozenset(),
    "rejected": frozenset(),
    "withdrawn": frozenset(),
}
ORDER_TRANSITIONS: Mapping[str, frozenset[str]] = {
    "draft": frozenset({"in_review", "cancelled"}),
    "in_review": frozenset({"approved", "rejected", "draft", "cancelled"}),
    "approved": frozenset({"implemented"}),     # 새 개정 승인까지 한 트랜잭션(design 6.3)
    "rejected": frozenset(),
    "implemented": frozenset(),
    "cancelled": frozenset(),
}
_MACHINES: Mapping[str, Mapping[str, frozenset[str]]] = {"request": REQUEST_TRANSITIONS, "order": ORDER_TRANSITIONS}

# 누가 하는가(기존 role 4종, 6.4). `작성자`는 역할이 아니라 요청자 본인 조건이라 서비스가 따로 본다.
TRANSITION_ROLES: Mapping[tuple[str, str, str], frozenset[str]] = {
    ("request", "draft", "submitted"): frozenset({"engineer", "admin"}),
    ("request", "submitted", "accepted"): frozenset({"approver", "admin"}),
    ("request", "submitted", "rejected"): frozenset({"approver", "admin"}),
    ("order", "draft", "in_review"): frozenset({"engineer", "admin"}),
    ("order", "in_review", "approved"): frozenset({"approver", "admin"}),
    ("order", "approved", "implemented"): frozenset({"approver", "admin"}),
    ("order", "in_review", "rejected"): frozenset({"approver", "admin"}),
    ("order", "in_review", "draft"): frozenset({"approver", "admin"}),
}
AUTHOR_OR_ADMIN: frozenset[tuple[str, str, str]] = frozenset({
    ("request", "draft", "withdrawn"), ("request", "submitted", "withdrawn"),
    ("order", "draft", "cancelled"), ("order", "in_review", "cancelled"),
})


def can_transition(machine: Literal["request", "order"], from_status: str, to_status: str) -> bool:
    """요청(`request`) 또는 지시(`order`)의 상태 전이가 허용되는가. 모르는 상태는 False."""
    table = _MACHINES.get(machine)
    return bool(table) and to_status in table.get(from_status, frozenset())


def allowed_next(machine: Literal["request", "order"], from_status: str) -> frozenset[str]:
    return _MACHINES[machine].get(from_status, frozenset())


# ---------------------------------------------------------------- 적용 범위 (ontology 3.5 · design 3.2)

class ApplicabilityScope(_Model):
    """어디에 새 개정을 적용하나(유효일 · 사업장 · 생산 로트 · 제품 일련번호). 겹침 판정은 엔진(`scope.py`) 몫이다."""

    id: int | None = None
    effective_from: date | None = None
    effective_to: date | None = None
    site: str | None = Field(default=None, min_length=1)             # None = 전체
    lot_nos: tuple[str, ...] | None = None                            # None = 전체. 목록으로 시작(design 10.3-4)
    serial_from: int | None = Field(default=None, ge=0)
    serial_to: int | None = Field(default=None, ge=0)
    applies: Applies = "new"                                          # new = 새 개정을 쓰는 범위, old = 기존 개정을 계속 쓰는 범위
    note: str | None = None

    @field_validator("lot_nos")
    @classmethod
    def _lots(cls, v: tuple[str, ...] | None) -> tuple[str, ...] | None:
        if v is not None:
            if not v:
                raise ValueError("lot_nos 를 지정하면 하나 이상이어야 합니다(전체는 None)")
            if any(not s.strip() for s in v) or len(set(v)) != len(v):
                raise ValueError("로트 번호는 비어 있지 않고 중복이 없어야 합니다")
        return v

    @model_validator(mode="after")
    def _ranges(self) -> ApplicabilityScope:
        if self.effective_from and self.effective_to and self.effective_to < self.effective_from:
            raise ValueError("effective_to 가 effective_from 보다 앞입니다")
        if self.serial_from is not None and self.serial_to is not None and self.serial_to < self.serial_from:
            raise ValueError("serial_to 가 serial_from 보다 작습니다")
        return self


# ---------------------------------------------------------------- 변경 요청 · 지시 · 대상

class ChangeRequest(_Model):
    """왜 바꾸나. 코드 `CR-2026-0001`."""

    id: int | None = None
    code: str = Field(pattern=_CODE_CR)
    title: str = Field(min_length=1)
    reason: str = Field(min_length=1)
    origin: ChangeOrigin = "design"
    ontology_impact_id: int | None = None
    before_summary: str = ""
    after_summary: str = ""
    status: RequestStatus = "draft"
    product_code: str | None = None
    requested_by: str = Field(min_length=1)
    requested_at: AwareDatetime

    @model_validator(mode="after")
    def _ontology_origin(self) -> ChangeRequest:
        if self.origin == "ontology_impact" and self.ontology_impact_id is None:
            raise ValueError("origin 이 ontology_impact 이면 ontology_impact_id 가 필요합니다")
        return self


class ChangeOrder(_Model):
    """어떻게 반영하나. 요청이 accepted 일 때 1건을 연다. 코드 `CO-2026-0001`."""

    id: int | None = None
    code: str = Field(pattern=_CODE_CO)
    request_code: str = Field(pattern=_CODE_CR)
    product_code: str | None = None
    status: OrderStatus = "draft"
    approved_by: str | None = None
    approved_at: AwareDatetime | None = None
    approved_run_id: int | None = None     # 승인 때 본 영향 분석 실행(F-CHG-11)

    @model_validator(mode="after")
    def _approval_fields(self) -> ChangeOrder:
        approved = self.status in ("approved", "implemented")
        if approved and not (self.approved_by and self.approved_at and self.approved_run_id is not None):
            raise ValueError("승인된 지시는 approved_by · approved_at · approved_run_id 가 있어야 합니다")
        if not approved and (self.approved_by or self.approved_at):
            raise ValueError("승인되지 않은 지시에는 승인 정보를 둘 수 없습니다")
        return self


class ChangeTarget(_Model):
    """바꾸려는 한 가지. `ontology` 종류는 없다(온톨로지 변경은 `OntologyImpact` 보고로만, F-CHG-10)."""

    id: int | None = None
    change_kind: ChangeKind
    item_no: str = Field(min_length=1)                          # 대상 품목(교체면 이전 품목)
    from_revision: str | None = None                            # 현재 승인본 개정(`R00`)
    to_revision: str | None = None                              # 새로 만들 개정(`R01`). 승인 전에는 작업중이다
    replacement_item_no: str | None = None                      # replace 만. 새 품번
    parent_revision: str | None = None                          # replace · bom_edit: 줄이 들어 있는 조립품 개정
    before: dict[str, Any] = Field(default_factory=dict)
    after: dict[str, Any] = Field(default_factory=dict)
    before_class: str | None = None
    after_class: str | None = None
    note: str = ""
    scopes: tuple[ApplicabilityScope, ...] = ()

    @model_validator(mode="after")
    def _by_kind(self) -> ChangeTarget:
        k = self.change_kind
        if k == "replace":
            if not self.replacement_item_no:
                raise ValueError("replace 는 replacement_item_no(새 품번)가 필요합니다")
            if self.replacement_item_no == self.item_no:
                raise ValueError("replacement_item_no 가 item_no 와 같습니다")
        elif self.replacement_item_no:
            raise ValueError(f"{k} 에는 replacement_item_no 를 둘 수 없습니다")
        if k == "revise":
            if not self.to_revision:
                raise ValueError("revise 는 to_revision(새 개정)이 필요합니다")
            changed = identity_changes(self.before, self.after, self.before_class, self.after_class)
            if changed:
                raise ValueError(
                    f"{ChangeErrorCode.REVISION_CHANGES_IDENTITY}: 규격이 바뀌면 새 품번이에요 — 교체로 등록하세요 ({', '.join(changed)})")
        if k == "bom_edit" and not self.parent_revision:
            raise ValueError("bom_edit 는 parent_revision(조립품 개정)이 필요합니다")
        if k == "attribute_edit" and not self.after:
            raise ValueError("attribute_edit 는 after(바뀔 값)가 필요합니다")
        return self


# ---------------------------------------------------------------- 영향 분석 · 처분 · 검토

class FindingBasis(_Model):
    """판단 시점 스냅샷: 어느 온톨로지 버전 · 규칙 · 시각의 값으로 나왔나(F-CHG-11)."""

    ontology_version: str = Field(min_length=1)
    rule_id: str | None = None                  # OPMS 규칙 id(`bolt_nut`). PDM 참고 판정이면 `pdm:grip_length`
    as_of: AwareDatetime                        # 계산한 시각. 외부 사본이면 그 `as_of`


class ImpactFinding(_Model):
    """영향이 있다는 탐지. **변경해야 한다는 뜻이 아니다.** 처분(`Disposition`)이 따로 있다."""

    id: int | None = None
    run_id: int | None = None
    kind: FindingKind
    subject_type: str = Field(min_length=1)                       # item · revision · work_order · purchase_order_line · stock_lot …
    subject_ref: str = Field(min_length=1)                        # item_no · wo_no …
    severity: Severity
    verdict: Verdict | None = None                                # 적합성 판정일 때만
    reason_code: str = Field(pattern=_KEY)
    message: str = Field(min_length=1)
    basis: FindingBasis
    temporary: bool = False                                       # OPMS 서버 판정이 아니라 PDM 임시 계산인가
    approximate: bool = False                                     # 입력 중 CAD 추정값이 있었는가
    inputs: dict[str, Any] = Field(default_factory=dict)          # 계산에 쓴 값 전부 · 단위 · 출처
    required: float | None = None
    actual: float | None = None
    gap: float | None = None
    scope_class: ScopeClass | None = None                         # 외부 객체와 적용 범위의 관계
    suggested_disposition: DispositionAction | None = None        # 기본 제안(결정이 아니다)

    @model_validator(mode="after")
    def _consistent(self) -> ImpactFinding:
        if self.verdict is not None and self.kind not in FIT_KINDS:
            raise ValueError("verdict 는 적합성 finding(fit_pair · fit_grip · strength_grade · substitute)에만 둡니다")
        if self.scope_class is not None and self.kind not in EXTERNAL_KINDS:
            raise ValueError("scope_class 는 외부 객체 finding 에만 둡니다")
        if self.suggested_disposition is not None and not is_action_allowed(self.kind, self.suggested_disposition):
            raise ValueError(f"{self.kind} 에는 {self.suggested_disposition} 처분이 없습니다")
        for name in ("required", "actual", "gap"):
            v = getattr(self, name)
            if v is not None:
                _finite(v)
        return self


class ImpactRun(_Model):
    """한 번의 영향 분석(판단 시점 스냅샷의 머리). 지우지 않고 쌓는다."""

    id: int | None = None
    order_code: str = Field(pattern=_CODE_CO)
    computed_at: AwareDatetime
    computed_by: str = Field(min_length=1)
    input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")           # 입력의 정규화 JSON sha256. 같은 입력 → 같은 해시(design 4.6)
    ontology_version: str = Field(min_length=1)
    temporary: bool = False
    partial: bool = False                                         # OPMS 를 못 읽어 적합성을 판정하지 못한 분석 — 승인할 수 없다
    external_as_of: dict[str, AwareDatetime] = Field(default_factory=dict)   # {"work_order": ts, "purchase_order_line": ts, "stock_lot": ts}
    stale: bool = False
    stale_reasons: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    findings: tuple[ImpactFinding, ...] = ()

    @model_validator(mode="after")
    def _stale(self) -> ImpactRun:
        if self.stale_reasons and not self.stale:
            raise ValueError("stale_reasons 가 있으면 stale 이어야 합니다")
        return self


class Disposition(_Model):
    """처분 = **사람의 결정**. 대상 종류별 선택지는 `ALLOWED_ACTIONS`."""

    id: int | None = None
    order_code: str = Field(pattern=_CODE_CO)
    finding_id: int
    finding_kind: FindingKind
    action: DispositionAction
    reason: str = Field(min_length=1)
    scope_id: int | None = None
    decided_by: str = Field(min_length=1)
    decided_at: AwareDatetime
    superseded_by: int | None = None      # 재계산으로 finding 이 새로 생기면 이전 처분은 이력으로 남는다

    @field_validator("reason")
    @classmethod
    def _reason_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("처분 사유가 비어 있습니다")
        return v

    @model_validator(mode="after")
    def _allowed(self) -> Disposition:
        if not is_action_allowed(self.finding_kind, self.action):
            raise ValueError(f"{ChangeErrorCode.DISPOSITION_INVALID}: {self.finding_kind} 에는 {self.action} 처분이 없습니다")
        return self


class ChangeReview(_Model):
    """설계 · 구매 · 생산 검토(역할별 의견). 어느 분석을 보고 한 검토인지 `run_id` 로 묶는다. 분석이 stale 이 되면 무효."""

    id: int | None = None
    order_code: str = Field(pattern=_CODE_CO)
    function: ReviewFunction
    run_id: int
    verdict: ReviewVerdict
    comment: str = ""
    reviewer: str = Field(min_length=1)
    reviewed_at: AwareDatetime


class OntologyImpactItem(_Model):
    """보고의 한 줄: 어느 품번 · 체결부가 왜 후보로 올랐는지(이유 코드와 바뀌기 전 · 후 값). 읽기 결과이고 어떤 처분 · 개정도 가리키지 않는다."""

    kind: Literal["part", "joint"]
    subject: str = Field(min_length=1)                   # 품번(part) 또는 체결부 이름(joint)
    reason_code: str = Field(min_length=1)                # ontology_impact.REASON_CODES
    ref: str | None = None                                # 규칙 id · 속성 키 · 분류 코드 …
    before: str | None = None
    after: str | None = None
    message: str = ""


class OntologyImpactSummary(_Model):
    rules_changed: tuple[str, ...] = ()
    parts_flagged: tuple[str, ...] = ()


class OntologyImpact(_Model):
    """온톨로지 버전 변경이 기존 부품 · 체결에 미칠 후보 **보고**(읽기 결과). 부품 개정이나 변경 지시를 만들지 않는다(F-CHG-10).

    그래서 이 모델에는 개정 · 대상 필드가 없다. 요청이 열렸을 때만 `change_request_code` 로 연결한다.
    """

    id: int | None = None
    from_version: str = Field(min_length=1)
    to_version: str = Field(min_length=1)
    computed_at: AwareDatetime
    summary: OntologyImpactSummary = OntologyImpactSummary()
    items: tuple[OntologyImpactItem, ...] = ()
    change_request_code: str | None = Field(default=None, pattern=_CODE_CR)

    @model_validator(mode="after")
    def _differs(self) -> OntologyImpact:
        if self.from_version == self.to_version:
            raise ValueError("from_version 과 to_version 이 같습니다")
        return self


# ---------------------------------------------------------------- 개정별 사양 · 체결 구성 (design 3.3)

class RevisionSpec(_Model):
    """개정별 PDM 소유 수치(판 두께 등). OPMS 가 값을 갖는 품목(볼트 · 너트 · 와셔)은 복사하지 않고 `OF_PART` 로 읽는다."""

    item_no: str = Field(min_length=1)
    revision: str = Field(min_length=1)
    key: str = Field(pattern=_KEY)                       # thickness · nutHeight · outerDiameter …
    value: float = Field(gt=0)
    unit: str = Field(default="mm", min_length=1)
    source: SpecSource = "manual"

    @field_validator("value")
    @classmethod
    def _v(cls, v: float) -> float:
        return _finite(v)

    @property
    def inferred(self) -> bool:
        """CAD 추정값이면 판정을 한 단계 낮춘다(fit-check-plan 결정)."""
        return self.source == "cad_estimate"


class ClampedPart(_Model):
    item_no: str = Field(min_length=1)
    thickness_key: str = Field(default="thickness", pattern=_KEY)


class FasteningJoint(_Model):
    """한 체결부의 구성. 제품 조립품 개정에 붙는다. 첫 판은 사람이 입력한다(design 10.3-7)."""

    id: int | None = None
    assembly_item_no: str = Field(min_length=1)
    assembly_revision: str = Field(min_length=1)
    name: str = Field(min_length=1)
    bolt_item_no: str = Field(min_length=1)
    nut_item_no: str = Field(min_length=1)
    washer_item_no: str | None = None
    washers_per_bolt: int = Field(default=2, ge=0, le=4)
    bolt_count: int = Field(ge=1)
    clamped: tuple[ClampedPart, ...] = Field(min_length=1)       # 순서 포함

    @model_validator(mode="after")
    def _washers(self) -> FasteningJoint:
        if self.washer_item_no is None and self.washers_per_bolt:
            raise ValueError("washer_item_no 가 없으면 washers_per_bolt 는 0 이어야 합니다")
        return self


# ---------------------------------------------------------------- 외부 읽기 사본 (design 3.5 · ontology 3.8)

class _External(_Model):
    """ERP · MES 소유. PDM 은 받아 두기만 한다. 모든 행에 출처와 기준 시각이 붙는다."""

    source_system: SourceSystem
    as_of: AwareDatetime
    received_at: AwareDatetime | None = None

    @property
    def is_fixture(self) -> bool:
        """시험 · 시연 픽스처. 화면에 '픽스처' 배지를 붙이고 `pub.*` 로 내보내지 않는다(앱 목 금지 지시 2026-11-11)."""
        return self.source_system == "fixture"


class WorkOrderBomRef(_Model):
    item_no: str = Field(min_length=1)
    revision: str | None = None
    qty_required: float = Field(ge=0)
    qty_issued: float = Field(default=0, ge=0)


class WorkOrder(_External):
    wo_no: str = Field(min_length=1)
    site: str | None = None
    product_item_no: str = Field(min_length=1)
    bom_revision: str | None = None                    # 적용 BOM = 조립품 개정
    process_rev: str | None = None                     # 공정 개정(MES 값 그대로 읽기만)
    status: WorkOrderStatus
    qty_planned: float = Field(ge=0)
    qty_done: float = Field(default=0, ge=0)
    lot_no: str | None = None
    serial_from: int | None = Field(default=None, ge=0)
    serial_to: int | None = Field(default=None, ge=0)
    start_date: date | None = None
    due_date: date | None = None
    bom_refs: tuple[WorkOrderBomRef, ...] = ()

    @model_validator(mode="after")
    def _serials(self) -> WorkOrder:
        if self.serial_from is not None and self.serial_to is not None and self.serial_to < self.serial_from:
            raise ValueError("serial_to 가 serial_from 보다 작습니다")
        if self.start_date and self.due_date and self.due_date < self.start_date:
            raise ValueError("due_date 가 start_date 보다 앞입니다")
        return self


class PurchaseOrderLine(_External):
    po_no: str = Field(min_length=1)
    line_no: int = Field(ge=1)
    item_no: str = Field(min_length=1)
    item_rev: str | None = None                        # 발주 때의 개정
    qty_ordered: float = Field(ge=0)
    qty_received: float = Field(default=0, ge=0)
    due_date: date | None = None
    supplier: str | None = None
    site: str | None = None
    status: PurchaseOrderStatus = "open"

    @property
    def qty_open(self) -> float:
        """미입고 수량. 초과 입고는 0."""
        return max(0.0, self.qty_ordered - self.qty_received)


class StockLot(_External):
    """로트 단위 재고. 기존 `inventory_balance`(품목 · 사업장 · 위치 합계)는 그대로 두고, 합계가 맞아야 한다는 불변식은 두지 않는다."""

    lot_no: str = Field(min_length=1)
    item_no: str = Field(min_length=1)
    item_rev: str | None = None
    site: str | None = None
    location: str | None = None
    qty_on_hand: float = Field(ge=0)
    qty_allocated: float = Field(default=0, ge=0)
    status: StockLotStatus = "available"


__all__ = [
    # 열거
    "ChangeOrigin", "RequestStatus", "OrderStatus", "ChangeKind", "Applies", "Severity", "Verdict", "FindingKind",
    "ScopeClass", "ReviewFunction", "ReviewVerdict", "SourceSystem", "WorkOrderStatus", "PurchaseOrderStatus",
    "StockLotStatus", "SpecSource", "DispositionAction",
    # 규칙 표 · 상수
    "FIT_KINDS", "EXTERNAL_KINDS", "ALLOWED_ACTIONS", "is_action_allowed", "SEVERITY_RANK",
    "SEVERITIES_BLOCKING_APPROVAL", "SEVERITIES_NEEDING_DISPOSITION", "requires_disposition", "blocks_approval",
    "OPMS_REASON_CODES", "PDM_REASON_CODES", "ChangeErrorCode", "IDENTITY_KEYS",
    "REQUEST_TRANSITIONS", "ORDER_TRANSITIONS", "TRANSITION_ROLES", "AUTHOR_OR_ADMIN", "can_transition", "allowed_next",
    # 함수
    "identity_changes", "classify_change_kind",
    # 모델
    "ApplicabilityScope", "ChangeRequest", "ChangeOrder", "ChangeTarget", "FindingBasis", "ImpactFinding", "ImpactRun",
    "Disposition", "ChangeReview", "OntologyImpactItem", "OntologyImpactSummary", "OntologyImpact", "RevisionSpec", "ClampedPart",
    "FasteningJoint", "WorkOrderBomRef", "WorkOrder", "PurchaseOrderLine", "StockLot",
]
