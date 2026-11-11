"""변경 저장소(메모리): 코드 · 가시성 · 대상 · 영향 실행 · 처분 · 외부 사본 upsert 규칙."""

from __future__ import annotations

import threading
from datetime import UTC, date, datetime, timedelta

import pytest

from onto_pdm.changes.models import (
    ApplicabilityScope,
    ChangeOrder,
    ChangeRequest,
    ChangeReview,
    ChangeTarget,
    ClampedPart,
    Disposition,
    FasteningJoint,
    FindingBasis,
    ImpactFinding,
    ImpactRun,
    OntologyImpact,
    PurchaseOrderLine,
    RevisionSpec,
    StockLot,
    WorkOrder,
)
from onto_pdm.changes.fixtures import empty_seed
from onto_pdm.changes.store import InMemoryChangeStore
from onto_pdm.errors import ApiException
from onto_pdm.store.base import Session
from onto_pdm.store.memory import InMemoryPdmStore

T0 = datetime(2026, 11, 12, 9, 0, tzinfo=UTC)
HASH = "a" * 64


@pytest.fixture
def store() -> InMemoryChangeStore:
    return InMemoryChangeStore()


@pytest.fixture
def users() -> dict[str, Session]:
    pdm = InMemoryPdmStore(seed=empty_seed())

    def as_user(login: str, admin_mode: bool = False) -> Session:
        u = pdm.find_user(login)
        assert u is not None
        return Session(user=u, admin_mode=admin_mode)

    return {"lee": as_user("lee"), "kim": as_user("kim"), "kim_admin": as_user("kim", True), "choi": as_user("choi")}


def request(code: str = "CR-2026-0001", status: str = "draft", by: str = "lee") -> ChangeRequest:
    return ChangeRequest(code=code, title="t", reason="r", status=status, requested_by=by, requested_at=T0)  # type: ignore[arg-type]


def finding(subject: str = "LT-N-01", severity: str = "affected") -> ImpactFinding:
    return ImpactFinding(kind="stock_lot", subject_type="stock_lot", subject_ref=subject, severity=severity,  # type: ignore[arg-type]
                         reason_code="stock_on_hand", message="재고가 남아 있다", scope_class="inside",
                         basis=FindingBasis(ontology_version="0.19.0", as_of=T0))


def run(order: str = "CO-2026-0001", findings: tuple[ImpactFinding, ...] = ()) -> ImpactRun:
    return ImpactRun(order_code=order, computed_at=T0, computed_by="lee", input_hash=HASH, ontology_version="0.19.0", findings=findings)


def with_order(store: InMemoryChangeStore, status: str = "draft") -> str:
    store.create_request(request(status="accepted"))
    store.create_order(ChangeOrder(code="CO-2026-0001", request_code="CR-2026-0001"))
    return "CO-2026-0001"


# ---------------------------------------------------------------- 코드 · 요청 · 지시

def test_next_code_counts_per_prefix_and_year(store: InMemoryChangeStore) -> None:
    assert store.next_code("CR", 2026) == "CR-2026-0001"
    store.create_request(request("CR-2026-0001"))
    store.create_request(request("CR-2026-0007"))
    assert store.next_code("CR", 2026) == "CR-2026-0008"
    assert store.next_code("CR", 2027) == "CR-2027-0001"
    assert store.next_code("CO", 2026) == "CO-2026-0001"


def test_create_assigns_ids_and_rejects_duplicates(store: InMemoryChangeStore) -> None:
    a = store.create_request(request("CR-2026-0001"))
    b = store.create_request(request("CR-2026-0002"))
    assert (a.id, b.id) == (1, 2)
    with pytest.raises(ValueError):
        store.create_request(request("CR-2026-0001"))


def test_draft_request_is_visible_to_author_and_admin_mode_only(store: InMemoryChangeStore, users: dict[str, Session]) -> None:
    store.create_request(request(status="draft", by="lee"))
    assert store.find_request(users["lee"], "CR-2026-0001").code == "CR-2026-0001"
    assert store.find_request(users["kim_admin"], "CR-2026-0001").code == "CR-2026-0001"
    for who in ("kim", "choi"):                                   # 관리자 역할이어도 모드가 꺼져 있거나 작성자가 아니면 못 본다
        with pytest.raises(ApiException) as e:
            store.find_request(users[who], "CR-2026-0001")
        assert e.value.status == 404 and e.value.code == "CHANGE_NOT_FOUND"
    assert store.list_requests(users["choi"]) == []
    assert [r.code for r in store.list_requests(users["lee"])] == ["CR-2026-0001"]


def test_submitted_request_is_visible_to_everyone(store: InMemoryChangeStore, users: dict[str, Session]) -> None:
    store.create_request(request(status="submitted"))
    assert [r.code for r in store.list_requests(users["choi"])] == ["CR-2026-0001"]


def test_list_requests_filters(store: InMemoryChangeStore, users: dict[str, Session]) -> None:
    store.create_request(request("CR-2026-0001", "submitted").model_copy(update={"product_code": "BRK-M8", "title": "너트 교체"}))
    store.create_request(request("CR-2026-0002", "accepted"))
    s = users["choi"]
    assert [r.code for r in store.list_requests(s, status="accepted")] == ["CR-2026-0002"]
    assert [r.code for r in store.list_requests(s, product_code="BRK-M8")] == ["CR-2026-0001"]
    assert [r.code for r in store.list_requests(s, q="너트")] == ["CR-2026-0001"]


def test_update_request_keeps_id(store: InMemoryChangeStore) -> None:
    a = store.create_request(request())
    b = store.update_request(a.model_copy(update={"status": "submitted"}))
    assert b.id == a.id and b.status == "submitted"
    with pytest.raises(ApiException):
        store.update_request(request("CR-2026-0099"))


def test_order_needs_request_and_is_one_per_request(store: InMemoryChangeStore) -> None:
    with pytest.raises(ApiException):
        store.create_order(ChangeOrder(code="CO-2026-0001", request_code="CR-2026-0001"))
    store.create_request(request(status="accepted"))
    store.create_order(ChangeOrder(code="CO-2026-0001", request_code="CR-2026-0001"))
    with pytest.raises(ValueError):
        store.create_order(ChangeOrder(code="CO-2026-0002", request_code="CR-2026-0001"))
    assert store.get_order_for_request("CR-2026-0001").code == "CO-2026-0001"  # type: ignore[union-attr]


def test_draft_order_follows_the_request_author_visibility(store: InMemoryChangeStore, users: dict[str, Session]) -> None:
    code = with_order(store)
    assert store.find_order(users["lee"], code).code == code
    with pytest.raises(ApiException):
        store.find_order(users["choi"], code)
    store.update_order(store.get_order(code).model_copy(update={"status": "in_review"}))  # type: ignore[union-attr]
    assert store.find_order(users["choi"], code).status == "in_review"


# ---------------------------------------------------------------- 대상 · 범위

def target(item: str = "P-00000000022", **kw: object) -> ChangeTarget:
    return ChangeTarget(change_kind="replace", item_no=item, replacement_item_no="P-00000000023", **kw)  # type: ignore[arg-type]


def test_add_target_assigns_target_and_scope_ids(store: InMemoryChangeStore) -> None:
    code = with_order(store)
    t = store.add_target(code, target(scopes=(ApplicabilityScope(site="S1"), ApplicabilityScope(site="S2"))))
    assert t.id == 1 and [s.id for s in t.scopes] == [1, 2]
    assert store.get_target(code, 1) == t
    with pytest.raises(ValueError):
        store.add_target(code, target())                               # 같은 품목 · 종류 두 번
    assert store.get_target(code, 99) is None
    with pytest.raises(ApiException):
        store.add_target("CO-2026-0099", target())


def test_set_scopes_replaces_and_remove_target(store: InMemoryChangeStore) -> None:
    code = with_order(store)
    t = store.add_target(code, target(scopes=(ApplicabilityScope(site="S1"),)))
    t2 = store.set_scopes(code, t.id, [ApplicabilityScope(serial_from=71, effective_from=date(2026, 12, 1))])  # type: ignore[arg-type]
    assert [(s.serial_from, s.site) for s in t2.scopes] == [(71, None)]
    assert store.remove_target(code, t.id) is True                     # type: ignore[arg-type]
    assert store.remove_target(code, t.id) is False                    # type: ignore[arg-type]
    assert store.list_targets(code) == []
    with pytest.raises(ApiException):
        store.set_scopes(code, 99, [])


def test_reads_are_copies(store: InMemoryChangeStore) -> None:
    code = with_order(store)
    store.add_target(code, ChangeTarget(change_kind="attribute_edit", item_no="BRK-M8-P01", after={"thickness": 12.0}))
    got = store.list_targets(code)[0]
    got.after["thickness"] = 99.0
    assert store.list_targets(code)[0].after == {"thickness": 12.0}


# ---------------------------------------------------------------- 영향 분석 실행 · 처분 · 검토

def test_add_run_assigns_ids_and_get_run_defaults_to_latest(store: InMemoryChangeStore) -> None:
    code = with_order(store)
    r1 = store.add_run(run(findings=(finding("LT-N-01"), finding("LT-N-02"))))
    r2 = store.add_run(run(findings=(finding("LT-N-01"),)))
    assert (r1.id, r2.id) == (1, 2)
    assert [(f.id, f.run_id) for f in r1.findings] == [(1, 1), (2, 1)]
    assert store.get_run(code).id == 2                                 # type: ignore[union-attr]
    assert store.get_run(code, 1).id == 1                              # type: ignore[union-attr]
    assert [r.id for r in store.list_runs(code)] == [1, 2]             # 쌓는다
    assert store.find_finding(code, 2).subject_ref == "LT-N-02"        # type: ignore[union-attr]
    assert store.find_finding(code, 99) is None
    with pytest.raises(ApiException):
        store.add_run(run("CO-2026-0099"))


def test_mark_stale_merges_reasons_without_duplicates(store: InMemoryChangeStore) -> None:
    code = with_order(store)
    assert store.mark_stale(code, ["stock_lot"]) is None               # 분석이 아직 없다
    store.add_run(run())
    store.mark_stale(code, ["stock_lot"])
    got = store.mark_stale(code, ["stock_lot", "scope_changed"])
    assert got is not None and got.stale and got.stale_reasons == ("stock_lot", "scope_changed")
    assert store.get_run(code).stale is True                           # type: ignore[union-attr]


def disposition(finding_id: int, action: str = "quarantine", reason: str = "격리") -> Disposition:
    return Disposition(order_code="CO-2026-0001", finding_id=finding_id, finding_kind="stock_lot", action=action,  # type: ignore[arg-type]
                       reason=reason, decided_by="lee", decided_at=T0)


def test_new_disposition_supersedes_the_previous_one(store: InMemoryChangeStore) -> None:
    code = with_order(store)
    store.add_run(run(findings=(finding(),)))
    first = store.put_disposition(disposition(1, "quarantine"))
    second = store.put_disposition(disposition(1, "use_up", "소진 후 전환"))
    assert [d.action for d in store.list_dispositions(code)] == ["use_up"]
    history = store.list_dispositions(code, include_superseded=True)
    assert [(d.id, d.superseded_by) for d in history] == [(first.id, second.id), (second.id, None)]


def test_disposition_for_unknown_finding_is_404(store: InMemoryChangeStore) -> None:
    with_order(store)
    with pytest.raises(ApiException) as e:
        store.put_disposition(disposition(5))
    assert e.value.status == 404 and e.value.code == "FINDING_NOT_FOUND"


def test_reviews_filter_by_run(store: InMemoryChangeStore) -> None:
    code = with_order(store)
    for run_id, fn in ((1, "design"), (2, "purchasing")):
        store.add_review(ChangeReview(order_code=code, function=fn, run_id=run_id, verdict="approve",  # type: ignore[arg-type]
                                      reviewer="lee", reviewed_at=T0))
    assert [r.function for r in store.list_reviews(code)] == ["design", "purchasing"]
    assert [r.function for r in store.list_reviews(code, run_id=2)] == ["purchasing"]
    with pytest.raises(ApiException):
        store.add_review(ChangeReview(order_code="CO-2026-0099", function="design", run_id=1, verdict="comment",
                                      reviewer="lee", reviewed_at=T0))


# ---------------------------------------------------------------- 사양 · 체결부 · 온톨로지 보고

def test_revision_specs_and_joints(store: InMemoryChangeStore) -> None:
    store.put_revision_spec(RevisionSpec(item_no="BRK-M8-P01", revision="R00", key="thickness", value=8.0))
    store.put_revision_spec(RevisionSpec(item_no="BRK-M8-P01", revision="R00", key="thickness", value=12.0, source="manual"))   # 같은 키는 덮는다
    store.put_revision_spec(RevisionSpec(item_no="BRK-M8-P01", revision="R01", key="thickness", value=12.0))
    assert [s.value for s in store.list_revision_specs("BRK-M8-P01", "R00")] == [12.0]
    assert len(store.list_revision_specs("BRK-M8-P01")) == 2

    joint = FasteningJoint(assembly_item_no="BRK-M8", assembly_revision="R00", name="J1", bolt_item_no="b", nut_item_no="n",
                           washer_item_no="w", bolt_count=4, clamped=(ClampedPart(item_no="p1"),))
    assert store.put_joint(joint).id == 1
    with pytest.raises(ValueError):
        store.put_joint(joint)
    assert [j.name for j in store.list_joints("BRK-M8", "R00")] == ["J1"]
    assert store.list_joints("BRK-M8", "R01") == []


def test_ontology_impact_is_only_a_report(store: InMemoryChangeStore) -> None:
    o = store.add_ontology_impact(OntologyImpact(from_version="0.18.0", to_version="0.19.0", computed_at=T0))
    assert o.id == 1 and store.list_ontology_impacts() == [o]
    assert store.get_request("CR-2026-0001") is None and store.get_order("CO-2026-0001") is None   # 보고를 저장해도 요청 · 지시는 생기지 않는다


# ---------------------------------------------------------------- 외부 읽기 사본

def lot(qty: float = 300, as_of: datetime = T0, no: str = "LT-N-01") -> StockLot:
    return StockLot(source_system="fixture", as_of=as_of, lot_no=no, item_no="P-00000000022", qty_on_hand=qty)


def test_upsert_ignores_older_as_of(store: InMemoryChangeStore) -> None:
    assert store.upsert_stock_lot(lot(300, T0)) == "inserted"
    assert store.upsert_stock_lot(lot(250, T0 + timedelta(hours=1))) == "updated"
    assert store.upsert_stock_lot(lot(999, T0)) == "ignored_older"     # 늦게 도착한 옛 값
    assert store.list_stock_lots()[0].qty_on_hand == 250
    assert store.upsert_stock_lot(lot(240, T0 + timedelta(hours=1))) == "updated"   # 같은 as_of 는 덮는다
    assert store.list_stock_lots()[0].qty_on_hand == 240


def test_upsert_sets_received_at(store: InMemoryChangeStore) -> None:
    store.upsert_stock_lot(lot())
    assert store.list_stock_lots()[0].received_at is not None


def test_work_order_and_po_upserts_and_filters(store: InMemoryChangeStore) -> None:
    for no, status, site in (("WO-1", "completed", "S1"), ("WO-2", "in_progress", "S1"), ("WO-3", "released", "S2")):
        store.upsert_work_order(WorkOrder(source_system="fixture", as_of=T0, wo_no=no, site=site, product_item_no="BRK-M8",
                                          status=status, qty_planned=10))  # type: ignore[arg-type]
    assert [w.wo_no for w in store.list_work_orders(product_item_no="BRK-M8", site="S1")] == ["WO-1", "WO-2"]
    assert [w.wo_no for w in store.list_work_orders(status="released")] == ["WO-3"]
    assert store.get_work_order("WO-2").status == "in_progress"        # type: ignore[union-attr]
    assert store.get_work_order("WO-9") is None

    po = dict(source_system="fixture", as_of=T0, po_no="PO-1", item_no="P-00000000022", qty_ordered=200)
    store.upsert_purchase_order_line(PurchaseOrderLine(line_no=10, qty_received=80, **po))   # type: ignore[arg-type]
    store.upsert_purchase_order_line(PurchaseOrderLine(line_no=20, qty_received=200, **po))  # type: ignore[arg-type]
    assert [p.line_no for p in store.list_purchase_order_lines(item_no="P-00000000022")] == [10, 20]
    assert [p.line_no for p in store.list_purchase_order_lines(only_open=True)] == [10]


def test_external_as_of_is_latest_per_kind(store: InMemoryChangeStore) -> None:
    assert store.external_as_of() == {}
    store.upsert_stock_lot(lot(no="A", as_of=T0))
    store.upsert_stock_lot(lot(no="B", as_of=T0 + timedelta(hours=2)))
    assert store.external_as_of() == {"stock_lot": T0 + timedelta(hours=2)}


def test_reset_clears_everything(store: InMemoryChangeStore) -> None:
    with_order(store)
    store.upsert_stock_lot(lot())
    store.reset()
    assert store.get_request("CR-2026-0001") is None and store.list_stock_lots() == []
    assert store.next_code("CR", 2026) == "CR-2026-0001"


def test_concurrent_upserts_keep_the_newest(store: InMemoryChangeStore) -> None:
    stamps = [T0 + timedelta(minutes=i) for i in range(40)]
    threads = [threading.Thread(target=lambda ts=ts: store.upsert_stock_lot(lot(qty=float(ts.minute), as_of=ts))) for ts in reversed(stamps)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert store.list_stock_lots()[0].as_of == stamps[-1]
