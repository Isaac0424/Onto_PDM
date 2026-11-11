"""설계 변경 영향 분석의 도메인 모델 · 상태 전이 · 개정/교체 판별 · 계약 (docs/change-impact-*.md)."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from typing import Any, get_args

import pytest
from pydantic import ValidationError

from onto_pdm import contract_export
from onto_pdm import contracts as C
from onto_pdm.changes import models as M

KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 11, 12, 9, 0, tzinfo=KST)


def finding(**over: Any) -> M.ImpactFinding:
    base: dict[str, Any] = dict(
        kind="fit_grip", subject_type="item", subject_ref="P-00000000001", severity="blocked", verdict="no",
        reason_code="shortfall", message="필요 길이 32.5 mm, 볼트 30 mm — 2.5 mm 부족",
        basis=M.FindingBasis(ontology_version="0.19.0", rule_id="pdm:grip_length", as_of=NOW),
        temporary=True, required=32.5, actual=30, gap=2.5,
    )
    return M.ImpactFinding(**{**base, **over})


# ---------------------------------------------------------------- 상태 전이

def test_request_transitions() -> None:
    ok = [("draft", "submitted"), ("draft", "withdrawn"), ("submitted", "accepted"), ("submitted", "rejected"), ("submitted", "withdrawn")]
    for a, b in ok:
        assert M.can_transition("request", a, b), (a, b)
    for a, b in [("draft", "accepted"), ("accepted", "withdrawn"), ("rejected", "submitted"), ("withdrawn", "draft"), ("submitted", "draft")]:
        assert not M.can_transition("request", a, b), (a, b)


def test_order_transitions() -> None:
    for a, b in [("draft", "in_review"), ("in_review", "approved"), ("in_review", "rejected"), ("in_review", "draft"),
                 ("approved", "implemented"), ("draft", "cancelled"), ("in_review", "cancelled")]:
        assert M.can_transition("order", a, b), (a, b)
    for a, b in [("draft", "approved"), ("approved", "draft"), ("approved", "cancelled"), ("implemented", "draft"), ("rejected", "in_review")]:
        assert not M.can_transition("order", a, b), (a, b)


def test_transition_tables_are_closed() -> None:
    """표에 없는 상태 · 모르는 기계는 False 이고, 열거 값과 표가 일치한다."""
    assert not M.can_transition("order", "nope", "draft")
    assert not M.can_transition("nope", "draft", "submitted")  # type: ignore[arg-type]
    assert set(M.REQUEST_TRANSITIONS) == set(get_args(M.RequestStatus))
    assert set(M.ORDER_TRANSITIONS) == set(get_args(M.OrderStatus))
    for table in (M.REQUEST_TRANSITIONS, M.ORDER_TRANSITIONS):
        assert all(nexts <= set(table) for nexts in table.values())
    assert M.allowed_next("order", "approved") == {"implemented"}


def test_every_transition_has_an_actor_rule() -> None:
    """허용된 모든 전이에는 역할 규칙이 있다(승인은 approver · admin, 철회 · 취소는 작성자 또는 admin)."""
    for machine, table in (("request", M.REQUEST_TRANSITIONS), ("order", M.ORDER_TRANSITIONS)):
        for a, nexts in table.items():
            for b in nexts:
                assert (machine, a, b) in M.TRANSITION_ROLES or (machine, a, b) in M.AUTHOR_OR_ADMIN, (machine, a, b)
    assert M.TRANSITION_ROLES[("order", "in_review", "approved")] == {"approver", "admin"}
    assert "engineer" not in M.TRANSITION_ROLES[("order", "in_review", "approved")]


# ---------------------------------------------------------------- 개정 vs 교체 (SC-3)

BOLT = {"threadSize": "M8", "length": 30.0, "pitch": 1.25, "material": "SUS304", "strengthGrade": "A2-70"}


def test_classify_same_spec_is_revise() -> None:
    """도면 · 공차 · 검사 조건만 바뀌면 같은 품번의 개정이다. 30 과 30.0 은 같은 값이다."""
    assert M.classify_change_kind(BOLT, {**BOLT, "length": 30}, "HexBolt", "HexBolt") == "revise"
    assert M.classify_change_kind(BOLT, {**BOLT, "drawing": "D-02", "tolerance": "h7"}, "HexBolt", "HexBolt") == "revise"
    assert M.classify_change_kind({}, {}, None, None) == "revise"


@pytest.mark.parametrize("key,value", [
    ("threadSize", "M10"), ("length", 35.0), ("pitch", 1.0), ("material", "SUS316"), ("strengthGrade", "A4-80"),
])
def test_classify_identity_attribute_change_is_replace(key: str, value: Any) -> None:
    after = {**BOLT, key: value}
    assert M.classify_change_kind(BOLT, after, "HexBolt", "HexBolt") == "replace"
    assert M.identity_changes(BOLT, after, "HexBolt", "HexBolt") == [key]


def test_classify_class_change_is_replace() -> None:
    """육각볼트 → 플랜지볼트는 다른 분류라 속성이 같아도 교체다."""
    assert M.classify_change_kind(BOLT, BOLT, "HexBolt", "HexFlangeBolt") == "replace"
    assert M.identity_changes(BOLT, BOLT, "HexBolt", "HexFlangeBolt") == ["class"]


def test_classify_one_sided_identity_value_is_replace() -> None:
    """한쪽에만 값이 있으면 같다고 단정할 근거가 없다 — 규격 변경을 개정으로 잘못 부르는 쪽이 위험하다."""
    assert M.classify_change_kind(BOLT, {k: v for k, v in BOLT.items() if k != "pitch"}, "HexBolt", "HexBolt") == "replace"
    assert M.classify_change_kind({}, {"material": "SUS304"}) == "replace"


def test_identity_keys_are_the_agreed_five() -> None:
    assert M.IDENTITY_KEYS == ("threadSize", "length", "pitch", "material", "strengthGrade")


# ---------------------------------------------------------------- 변경 대상 (F-CHG-10 가드 포함)

def test_target_kinds_are_the_four_and_ontology_is_not_one() -> None:
    assert set(get_args(M.ChangeKind)) == {"replace", "revise", "bom_edit", "attribute_edit"}
    with pytest.raises(ValidationError):
        M.ChangeTarget(change_kind="ontology", item_no="P-00000000001")  # type: ignore[arg-type]


def test_target_requirements_by_kind() -> None:
    M.ChangeTarget(change_kind="replace", item_no="P-00000000022", replacement_item_no="P-00000000023", parent_revision="R00")
    M.ChangeTarget(change_kind="attribute_edit", item_no="BRK-TOP", after={"thickness": 12})
    M.ChangeTarget(change_kind="bom_edit", item_no="BRK-SET", parent_revision="R00", after={"quantity": 4})
    M.ChangeTarget(change_kind="revise", item_no="P-00000000001", to_revision="R01", before=BOLT, after={**BOLT, "tolerance": "h7"})
    bad: list[dict[str, Any]] = [
        dict(change_kind="replace", item_no="A"),                                              # 새 품번 없음
        dict(change_kind="replace", item_no="A", replacement_item_no="A"),                     # 같은 품번
        dict(change_kind="attribute_edit", item_no="A"),                                       # 바뀔 값 없음
        dict(change_kind="bom_edit", item_no="A"),                                             # 조립품 개정 없음
        dict(change_kind="revise", item_no="A"),                                               # 새 개정 없음
        dict(change_kind="attribute_edit", item_no="A", after={"thickness": 1}, replacement_item_no="B"),
    ]
    for kwargs in bad:
        with pytest.raises(ValidationError):
            M.ChangeTarget(**kwargs)


def test_revise_that_changes_spec_is_rejected_with_the_error_code() -> None:
    """개정(revise)으로 규격을 바꾸려 하면 REVISION_CHANGES_IDENTITY — 교체로 등록해야 한다."""
    with pytest.raises(ValidationError) as e:
        M.ChangeTarget(change_kind="revise", item_no="P-00000000001", to_revision="R01", before=BOLT, after={**BOLT, "length": 35.0})
    assert M.ChangeErrorCode.REVISION_CHANGES_IDENTITY in str(e.value) and "length" in str(e.value)


# ---------------------------------------------------------------- 적용 범위

def test_scope_validation() -> None:
    M.ApplicabilityScope(effective_from=date(2026, 12, 1), serial_from=120, applies="new")
    M.ApplicabilityScope(effective_from=date(2026, 12, 1), effective_to=date(2026, 12, 1), lot_nos=("L1", "L2"), site="PLANT-1")
    for bad in (
        dict(effective_from=date(2026, 12, 2), effective_to=date(2026, 12, 1)),
        dict(serial_from=120, serial_to=119),
        dict(serial_from=-1),
        dict(lot_nos=()),
        dict(lot_nos=("L1", "L1")),
        dict(lot_nos=("",)),
        dict(site=""),
        dict(applies="both"),
    ):
        with pytest.raises(ValidationError):
            M.ApplicabilityScope(**bad)


def test_scope_is_immutable() -> None:
    s = M.ApplicabilityScope(serial_from=1)
    with pytest.raises(ValidationError):
        s.serial_from = 2  # type: ignore[misc]


# ---------------------------------------------------------------- 요청 · 지시

def test_request_and_order_validation() -> None:
    kw: dict[str, Any] = dict(code="CR-2026-0001", title="상판 두께 8 → 12 mm", reason="체결 강성", requested_by="kim", requested_at=NOW)
    r = M.ChangeRequest(**kw)
    assert r.status == "draft" and r.origin == "design"
    for bad in (dict(code="CR-26-1"), dict(title=""), dict(reason=""), dict(requested_by=""), dict(origin="ontology_impact"),
                dict(requested_at=datetime(2026, 11, 12))):                      # 시각대 없는 시각
        with pytest.raises(ValidationError):
            M.ChangeRequest(**{**kw, **bad})
    M.ChangeRequest(**{**kw, "origin": "ontology_impact", "ontology_impact_id": 3})

    M.ChangeOrder(code="CO-2026-0001", request_code="CR-2026-0001")
    with pytest.raises(ValidationError):   # 승인됐는데 승인 정보가 없다
        M.ChangeOrder(code="CO-2026-0001", request_code="CR-2026-0001", status="approved")
    with pytest.raises(ValidationError):   # 승인 전인데 승인 정보가 있다
        M.ChangeOrder(code="CO-2026-0001", request_code="CR-2026-0001", status="in_review", approved_by="lee", approved_at=NOW, approved_run_id=1)
    M.ChangeOrder(code="CO-2026-0001", request_code="CR-2026-0001", status="approved", approved_by="lee", approved_at=NOW, approved_run_id=1)


# ---------------------------------------------------------------- 영향 발견 · 처분 · 검토

def test_finding_basis_is_required_and_consistent() -> None:
    f = finding()
    assert f.basis.ontology_version == "0.19.0" and f.temporary and f.verdict == "no"
    with pytest.raises(ValidationError):
        finding(basis=M.FindingBasis(ontology_version="", as_of=NOW))
    with pytest.raises(ValidationError):                       # 사용처 finding 에는 적합성 verdict 가 없다
        finding(kind="bom_usage", verdict="ok", suggested_disposition=None)
    with pytest.raises(ValidationError):                       # scope_class 는 외부 객체에만
        finding(scope_class="inside")
    with pytest.raises(ValidationError):                       # 대상 종류에 없는 제안 처분
        finding(suggested_disposition="quarantine")
    with pytest.raises(ValidationError):
        finding(severity="critical")
    with pytest.raises(ValidationError):
        finding(gap=float("inf"))
    stock = finding(kind="stock_lot", verdict=None, severity="affected", scope_class="inside", suggested_disposition="quarantine",
                    reason_code="stock_on_hand", subject_type="stock_lot", subject_ref="LT-N-01", required=None, actual=None, gap=None, temporary=False)
    assert stock.scope_class == "inside"


def test_severity_rules() -> None:
    assert sorted(M.SEVERITY_RANK, key=M.SEVERITY_RANK.__getitem__) == ["blocked", "affected", "review", "none"]
    assert set(M.SEVERITY_RANK) == set(get_args(M.Severity))
    assert M.blocks_approval("blocked") and not M.blocks_approval("affected")
    assert M.requires_disposition("affected") and not M.requires_disposition("review") and not M.requires_disposition("none")


def test_disposition_choices_per_target_kind() -> None:
    assert set(M.ALLOWED_ACTIONS) == set(get_args(M.FindingKind))
    all_actions = set(get_args(M.DispositionAction))
    assert set().union(*M.ALLOWED_ACTIONS.values()) <= all_actions
    assert M.is_action_allowed("work_order", "change_in_progress") and M.is_action_allowed("stock_lot", "quarantine")
    assert M.is_action_allowed("purchase_order_line", "amend") and M.is_action_allowed("fit_pair", "choose_substitute")
    assert not M.is_action_allowed("stock_lot", "cancel") and not M.is_action_allowed("work_order", "quarantine")
    assert not M.is_action_allowed("bom_usage", "scrap") and not M.is_action_allowed("nope", "acknowledge")
    # 모든 종류는 사람이 '조치 필요 없음'으로 닫을 수 있다(review 를 닫는 길)
    assert all("no_action_needed" in a for a in M.ALLOWED_ACTIONS.values())


def test_disposition_validation() -> None:
    kw: dict[str, Any] = dict(order_code="CO-2026-0001", finding_id=2, finding_kind="stock_lot", action="quarantine",
                              reason="재고 300개는 새 개정 적용 전까지 격리", decided_by="park", decided_at=NOW)
    assert M.Disposition(**kw).action == "quarantine"
    for bad in (dict(action="cancel"), dict(reason=" "), dict(reason=""), dict(decided_by=""), dict(decided_at=datetime(2026, 11, 12))):
        with pytest.raises(ValidationError):
            M.Disposition(**{**kw, **bad})


def test_review_and_run() -> None:
    M.ChangeReview(order_code="CO-2026-0001", function="production", run_id=1, verdict="approve", reviewer="han", reviewed_at=NOW)
    with pytest.raises(ValidationError):
        M.ChangeReview(order_code="CO-2026-0001", function="finance", run_id=1, verdict="approve", reviewer="han", reviewed_at=NOW)  # type: ignore[arg-type]
    run: dict[str, Any] = dict(order_code="CO-2026-0001", computed_at=NOW, computed_by="kim", input_hash="a" * 64, ontology_version="0.19.0")
    r = M.ImpactRun(**run, findings=(finding(),), external_as_of={"stock_lot": NOW})
    assert not r.stale and not r.partial
    for bad in (dict(input_hash="abc"), dict(input_hash="A" * 64), dict(stale_reasons=("외부 데이터 갱신",)), dict(external_as_of={"stock_lot": datetime(2026, 1, 1)})):
        with pytest.raises(ValidationError):
            M.ImpactRun(**{**run, **bad})
    assert M.ImpactRun(**run, stale=True, stale_reasons=("외부 데이터 갱신",)).stale


def test_ontology_impact_is_a_report_not_a_revision() -> None:
    """온톨로지 버전은 부품 개정이 아니다(F-CHG-10): 이 모델에는 개정 · 대상 · 처분 필드가 없다."""
    oi = M.OntologyImpact(from_version="0.18.0", to_version="0.19.0", computed_at=NOW,
                          summary=M.OntologyImpactSummary(rules_changed=("bolt_length_vs_hole_depth",), parts_flagged=("P-00000000001",)))
    fields = set(M.OntologyImpact.model_fields)
    assert not any(w in f for f in fields for w in ("revision", "target", "disposition", "order"))
    assert oi.change_request_code is None
    with pytest.raises(ValidationError):
        M.OntologyImpact(from_version="0.19.0", to_version="0.19.0", computed_at=NOW)


# ---------------------------------------------------------------- 개정별 사양 · 체결 구성

def test_revision_spec_and_joint() -> None:
    spec = M.RevisionSpec(item_no="BRK-TOP", revision="R00", key="thickness", value=8, source="cad_estimate")
    assert spec.inferred and not M.RevisionSpec(item_no="BRK-TOP", revision="R00", key="thickness", value=8, source="drawing").inferred
    for bad in (dict(value=0), dict(value=-1), dict(value=float("nan")), dict(key="두께"), dict(source="guess")):
        with pytest.raises(ValidationError):
            M.RevisionSpec(**{"item_no": "BRK-TOP", "revision": "R00", "key": "thickness", "value": 8, **bad})

    j = M.FasteningJoint(assembly_item_no="BRK-M8", assembly_revision="R00", name="상·하판 체결", bolt_item_no="P-00000000001",
                         nut_item_no="P-00000000022", washer_item_no="P-00000000025", bolt_count=4,
                         clamped=(M.ClampedPart(item_no="BRK-TOP"), M.ClampedPart(item_no="BRK-BOTTOM")))
    assert j.washers_per_bolt == 2 and [c.item_no for c in j.clamped] == ["BRK-TOP", "BRK-BOTTOM"]
    base = j.model_dump()
    for bad in (dict(bolt_count=0), dict(clamped=()), dict(washer_item_no=None), dict(washers_per_bolt=5)):
        with pytest.raises(ValidationError):
            M.FasteningJoint(**{**base, **bad})
    assert M.FasteningJoint(**{**base, "washer_item_no": None, "washers_per_bolt": 0}).washer_item_no is None


# ---------------------------------------------------------------- 외부 읽기 사본

def test_external_copies_require_source_and_as_of() -> None:
    kw: dict[str, Any] = dict(lot_no="LT-N-01", item_no="P-00000000022", qty_on_hand=300)
    lot = M.StockLot(**kw, source_system="fixture", as_of=NOW)
    assert lot.is_fixture and not M.StockLot(**kw, source_system="ERP", as_of=NOW).is_fixture
    with pytest.raises(ValidationError):
        M.StockLot(**kw, as_of=NOW)                                   # source_system 없음
    with pytest.raises(ValidationError):
        M.StockLot(**kw, source_system="fixture")                     # as_of 없음
    with pytest.raises(ValidationError):
        M.StockLot(**kw, source_system="fixture", as_of=datetime(2026, 11, 12))
    with pytest.raises(ValidationError):
        M.StockLot(**kw, source_system="SAP", as_of=NOW)              # type: ignore[arg-type]
    with pytest.raises(ValidationError):
        M.StockLot(**{**kw, "qty_on_hand": -1}, source_system="fixture", as_of=NOW)


def test_work_order_and_purchase_order_line() -> None:
    wo: dict[str, Any] = dict(wo_no="WO-FX-0001", product_item_no="BRK-M8", status="in_progress", qty_planned=10, source_system="fixture", as_of=NOW)
    M.WorkOrder(**wo, serial_from=71, serial_to=120, bom_refs=(M.WorkOrderBomRef(item_no="P-00000000022", revision="R00", qty_required=40),))
    for bad in (dict(serial_from=120, serial_to=71), dict(status="done"), dict(qty_planned=-1),
                dict(start_date=date(2026, 12, 2), due_date=date(2026, 12, 1))):
        with pytest.raises(ValidationError):
            M.WorkOrder(**{**wo, **bad})
    po = M.PurchaseOrderLine(po_no="PO-FX-100", line_no=10, item_no="P-00000000022", qty_ordered=200, qty_received=80, source_system="fixture", as_of=NOW)
    assert po.qty_open == 120
    assert M.PurchaseOrderLine(po_no="PO-FX-100", line_no=11, item_no="P-1", qty_ordered=10, qty_received=12, source_system="ERP", as_of=NOW).qty_open == 0
    with pytest.raises(ValidationError):
        M.PurchaseOrderLine(po_no="PO-FX-100", line_no=0, item_no="P-1", qty_ordered=1, source_system="ERP", as_of=NOW)


def test_error_codes_are_one_set_of_unique_constants() -> None:
    codes = {k: v for k, v in vars(M.ChangeErrorCode).items() if k.isupper()}
    assert all(k == v for k, v in codes.items())                       # 이름과 값이 같다
    assert {"DISPOSITION_REQUIRED", "BLOCKED_FINDINGS", "IMPACT_STALE", "IMPACT_PARTIAL", "REVISION_CHANGES_IDENTITY", "SCOPE_REQUIRED",
            "SCOPE_OVERLAP", "REVIEW_REQUIRED", "ONTOLOGY_NOT_A_TARGET", "FEED_NOT_CONFIGURED"} <= set(codes)


# ---------------------------------------------------------------- 계약 (contracts.py)

NEW_RESPONSE = {"ChangeSummary", "ChangePage", "ChangeDetail", "ChangeTargetView", "ChangeScopeView", "ImpactRunView", "ImpactFindingView",
                "DispositionView", "ChangeReviewView", "ChangeExport", "ImpactGraphView", "OntologyImpactView", "FeedResult"}
NEW_REQUEST = {"ChangeCreateRequest", "ChangeTargetIn", "ChangeScopesIn", "DispositionIn", "ChangeReviewIn", "ChangeRejectIn",
               "WorkOrderFeedIn", "PurchaseOrderLineFeedIn", "StockLotFeedIn"}


def test_schema_has_the_change_contracts_and_version_is_unchanged() -> None:
    schema = json.loads((contract_export.CONTRACTS_DIR / contract_export.SCHEMA_FILE).read_text(encoding="utf-8"))
    assert NEW_RESPONSE | NEW_REQUEST <= set(schema["properties"])
    assert schema["x-contract-version"] == C.PDM_CONTRACT_VERSION == "1"        # 새 모델만 더했으므로 올리지 않는다
    assert "ontology" not in schema["$defs"]["ChangeTargetIn"]["properties"]["change_kind"]["enum"]
    assert schema["$defs"]["ImpactFindingView"]["properties"]["severity"]["enum"] == ["none", "review", "affected", "blocked"]
    # 선(wire) 형식은 snake_case
    assert "run_summary" in schema["$defs"]["ChangeSummary"]["properties"] and "runSummary" not in schema["$defs"]["ChangeSummary"]["properties"]


def test_contract_enums_come_from_the_domain() -> None:
    def args(model: type, field: str) -> set[str]:
        ann = model.model_fields[field].annotation
        inner = [a for a in get_args(ann) if a is not type(None)]
        return set(get_args(inner[0])) if inner and get_args(inner[0]) else set(get_args(ann))

    assert args(C.ImpactFindingView, "severity") == set(get_args(M.Severity))
    assert args(C.ImpactFindingView, "kind") == set(get_args(M.FindingKind))
    assert args(C.DispositionIn, "action") == set(get_args(M.DispositionAction))
    assert args(C.ChangeTargetIn, "change_kind") == set(get_args(M.ChangeKind))
    assert args(C.ChangeReviewIn, "function") == set(get_args(M.ReviewFunction))
    assert args(C.WorkOrderFeedIn, "source_system") == set(get_args(M.SourceSystem))
    assert args(C.ChangeSummary, "status") == set(get_args(M.RequestStatus))


def test_contract_views_are_subsets_of_the_domain() -> None:
    """계약 필드 이름은 도메인과 같은 말이다(번역이 필요 없는 것은 이름이 같다)."""
    assert set(C.ImpactFindingView.model_fields) - {"id"} <= set(M.ImpactFinding.model_fields)
    assert set(C.DispositionView.model_fields) - {"id"} <= set(M.Disposition.model_fields)
    assert set(C.ChangeReviewView.model_fields) - {"id"} <= set(M.ChangeReview.model_fields) | {"reviewer"}
    assert set(C.ChangeTargetIn.model_fields) <= set(M.ChangeTarget.model_fields)
    assert set(C.WorkOrderFeedRow.model_fields) - {"rev"} <= set(M.WorkOrder.model_fields) | {"rev"}


def test_contract_round_trip_and_extra_fields_rejected() -> None:
    examples = {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in (contract_export.CONTRACTS_DIR / "examples").glob("*.json")}
    by_name = contract_export.model_by_name()
    for name in ("ImpactRunView.sc2_grip_blocked", "ChangeSummary.sc2", "ChangeTargetIn.sc2_attribute_edit", "StockLotFeedIn.fixture", "ApiError.disposition_required"):
        payload = examples[name]
        model = by_name[name.split(".")[0]]
        assert model.model_validate(json.loads(json.dumps(payload))).model_dump(mode="json", exclude_none=True) == payload, name
    with pytest.raises(ValidationError):
        C.DispositionIn.model_validate({"action": "quarantine", "reason": "x", "reasn": "오타"})
    with pytest.raises(ValidationError):
        C.DispositionIn.model_validate({"action": "scrap_everything", "reason": "x"})


def test_example_matches_the_design_numbers() -> None:
    """SC-2 예시: 필요 32.5 mm, 볼트 30 mm, 2.5 mm 부족이 blocked 다."""
    run = C.ImpactRunView.model_validate(json.loads((contract_export.CONTRACTS_DIR / "examples" / "ImpactRunView.sc2_grip_blocked.json").read_text(encoding="utf-8")))
    grip = run.findings[0]
    assert (grip.required, grip.actual, grip.gap, grip.severity, grip.verdict) == (32.5, 30, 2.5, "blocked", "no")
    assert grip.basis.ontology_version == "0.19.0" and run.temporary and run.summary.blocked == 1
