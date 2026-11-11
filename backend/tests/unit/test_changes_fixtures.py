"""BRK-M8 픽스처: 기준선 구조 · 변형 3벌 · 앱 목 금지(환경변수로만 로드) · 충돌 거부."""

from __future__ import annotations

import pytest

from onto_pdm.changes.fixtures import (
    BOLT,
    FIXTURE_AS_OF,
    FLANGE_BOLT,
    ITEM_MODULE,
    ITEM_SET,
    ITEM_TOP,
    NUT,
    NUT_FINE,
    OPMS_PARTS,
    PRODUCT_CODE,
    WASHER,
    FixtureConflict,
    empty_seed,
    fixture_enabled,
    load_brk_m8,
    load_from_env,
    opms_part_values,
)
from onto_pdm.changes.store import InMemoryChangeStore
from onto_pdm.errors import ApiException
from onto_pdm.store.base import Session
from onto_pdm.store.memory import InMemoryPdmStore


def make() -> tuple[InMemoryPdmStore, InMemoryChangeStore, Session]:
    pdm = InMemoryPdmStore(seed=empty_seed())
    user = pdm.find_user("choi")                                  # 승인자. 관리자 모드가 꺼져도 승인본은 보인다
    assert user is not None
    return pdm, InMemoryChangeStore(), Session(user=user)


# ---------------------------------------------------------------- 기준선 (R00)

def test_where_used_from_nut_reaches_set_then_module() -> None:
    pdm, ch, s = make()
    load_brk_m8(pdm, ch, "base")
    nut_id = pdm.get_item(s, NUT).id
    rows = pdm.get_where_used(s, nut_id)
    assert [(r.depth, r.parent.item_no, r.quantity) for r in rows] == [(1, ITEM_SET, 4), (2, ITEM_MODULE, 1)]
    assert all(r.parent_revision.rev == "R00" and r.parent_revision.status == "released" for r in rows)


def test_baseline_bom_quantities_are_4_4_8_and_plates_once() -> None:
    pdm, ch, s = make()
    load_brk_m8(pdm, ch)
    bom = pdm.get_product_bom(s, PRODUCT_CODE, "released")
    assert bom.root_item.item_no == ITEM_MODULE and bom.revision is not None and bom.revision.rev == "R00"
    top = {n.item.item_no: n for n in bom.nodes}
    assert set(top) == {ITEM_TOP, "BRK-M8-P02", ITEM_SET}
    assert top[ITEM_TOP].quantity == 1 and top["BRK-M8-P02"].quantity == 1
    kids = {n.item.item_no: (n.quantity, n.total_quantity) for n in top[ITEM_SET].children}
    assert kids == {BOLT: (4, 4), NUT: (4, 4), WASHER: (8, 8)}


def test_only_opms_backed_items_are_marked_registered() -> None:
    pdm, ch, s = make()
    load_brk_m8(pdm, ch)
    reg = {i.item_no: i.attributes["OPMS"] for i in pdm.list_items(s)}
    assert reg == {BOLT: "등록", NUT: "등록", WASHER: "등록", ITEM_MODULE: "미등록", ITEM_TOP: "미등록",
                   "BRK-M8-P02": "미등록", ITEM_SET: "미등록"}


def test_plate_thickness_and_joint_give_the_documented_grip_numbers() -> None:
    """PRD 8장 그립 길이 28.5 · SC-2 32.5 를 픽스처 값에서 다시 계산한다(엔진 없이, 값이 문서와 같은지만 본다)."""
    pdm, ch, _ = make()
    load_brk_m8(pdm, ch)
    plates = {s.item_no: s.value for i in (ITEM_TOP, "BRK-M8-P02") for s in ch.list_revision_specs(i, "R00")}
    assert plates == {ITEM_TOP: 8.0, "BRK-M8-P02": 8.0}
    (joint,) = ch.list_joints(ITEM_MODULE, "R00")
    assert (joint.bolt_count, joint.washers_per_bolt) == (4, 2)
    assert [c.item_no for c in joint.clamped] == [ITEM_TOP, "BRK-M8-P02"]
    nut, washer, bolt = OPMS_PARTS[NUT]["attrs"], OPMS_PARTS[WASHER]["attrs"], OPMS_PARTS[BOLT]["attrs"]
    required = sum(plates.values()) + joint.washers_per_bolt * washer["thickness"] + nut["nutHeight"] + 2 * bolt["pitch"]
    assert required == pytest.approx(28.5) and bolt["length"] - required == pytest.approx(1.5)
    assert required + 4 == pytest.approx(32.5)                    # 상판 8 → 12


def test_external_rows_are_all_fixture_with_as_of() -> None:
    pdm, ch, _ = make()
    load_brk_m8(pdm, ch)
    wos, pos, lots = ch.list_work_orders(), ch.list_purchase_order_lines(), ch.list_stock_lots()
    assert [(w.wo_no, w.status, w.serial_from, w.serial_to) for w in wos] == [
        ("WO-FX-0001", "completed", 1, 50), ("WO-FX-0002", "in_progress", 51, 80), ("WO-FX-0003", "released", 81, 120)]
    assert [(p.po_no, p.line_no, p.qty_open) for p in pos] == [("PO-FX-100", 10, 120), ("PO-FX-100", 20, 500)]
    assert [(x.lot_no, x.item_no, x.qty_on_hand) for x in lots] == [("LT-N-01", NUT, 300), ("LT-N-02", NUT, 40)]
    for row in (*wos, *pos, *lots):
        assert row.source_system == "fixture" and row.is_fixture and row.as_of == FIXTURE_AS_OF
    assert ch.external_as_of() == {"work_order": FIXTURE_AS_OF, "purchase_order_line": FIXTURE_AS_OF, "stock_lot": FIXTURE_AS_OF}


def test_base_has_no_change_requests() -> None:
    pdm, ch, s = make()
    load_brk_m8(pdm, ch, "base")
    assert ch.list_requests(s) == []


# ---------------------------------------------------------------- 변형

def test_sc1_adds_the_fine_thread_nut_and_a_replace_request() -> None:
    pdm, ch, s = make()
    load_brk_m8(pdm, ch, "sc1")
    assert pdm.get_item(s, NUT_FINE).item_no == NUT_FINE          # 후보 품목. BOM 에는 아직 없다
    assert NUT_FINE not in {n.item.item_no for top in pdm.get_product_bom(s, PRODUCT_CODE, "released").nodes for n in top.children}
    (req,) = ch.list_requests(s)
    assert req.code == "CR-2026-0001" and req.status == "accepted" and req.product_code == PRODUCT_CODE
    order = ch.get_order_for_request(req.code)
    assert order is not None and order.code == "CO-2026-0001" and order.status == "draft"
    (t,) = ch.list_targets(order.code)
    assert (t.change_kind, t.item_no, t.replacement_item_no, t.from_revision, t.parent_revision) == ("replace", NUT, NUT_FINE, "R00", "R00")
    assert len(t.scopes) == 1 and t.scopes[0].applies == "new"    # 범위 전체
    assert opms_part_values(NUT_FINE)["attrs"]["pitch"] == 1.0 and opms_part_values(BOLT)["attrs"]["pitch"] == 1.25


def test_sc2_adds_the_flange_bolt_and_a_thickness_revision_request() -> None:
    pdm, ch, s = make()
    load_brk_m8(pdm, ch, "sc2")
    assert pdm.get_item(s, FLANGE_BOLT).item_no == FLANGE_BOLT
    with pytest.raises(ApiException):
        pdm.get_item(s, NUT_FINE)                                 # sc1 후보는 sc2 에 없다
    (req,) = ch.list_requests(s)
    order = ch.get_order_for_request(req.code)
    assert order is not None
    (t,) = ch.list_targets(order.code)
    assert (t.change_kind, t.item_no, t.from_revision, t.to_revision) == ("revise", ITEM_TOP, "R00", "R01")
    assert (t.before, t.after) == ({"thickness": 8.0}, {"thickness": 12.0})
    assert [(sc.site, sc.serial_from, sc.applies) for sc in t.scopes] == [("S1", 71, "new"), ("S2", 71, "new")]
    assert opms_part_values(FLANGE_BOLT)["attrs"]["length"] == 40.0


def test_unknown_variant_is_rejected() -> None:
    pdm, ch, _ = make()
    with pytest.raises(ValueError):
        load_brk_m8(pdm, ch, "sc9")                               # type: ignore[arg-type]
    assert pdm.db["items"] == [] and ch.list_work_orders() == []


# ---------------------------------------------------------------- 앱 목 금지: 환경변수로만 로드

def test_fixture_enabled_only_for_the_named_env_value() -> None:
    assert fixture_enabled({}) is False
    assert fixture_enabled({"PDM_FIXTURE": ""}) is False
    assert fixture_enabled({"PDM_FIXTURE": "other"}) is False
    assert fixture_enabled({"PDM_FIXTURE": "brk-m8"}) is True
    assert fixture_enabled({"PDM_FIXTURE": " BRK-M8:SC1 "}) is True


def test_load_from_env_loads_nothing_by_default() -> None:
    pdm, ch, s = make()
    assert load_from_env({}, pdm, ch) is None
    assert pdm.db["items"] == [] and pdm.db["products"] == []
    assert ch.list_requests(s) == [] and ch.list_work_orders() == [] and ch.list_stock_lots() == []


def test_load_from_env_loads_the_requested_variant() -> None:
    pdm, ch, s = make()
    assert load_from_env({"PDM_FIXTURE": "brk-m8"}, pdm, ch) == "base"
    assert ch.list_requests(s) == []
    pdm2, ch2, s2 = make()
    assert load_from_env({"PDM_FIXTURE": "brk-m8:sc2"}, pdm2, ch2) == "sc2"
    assert [r.code for r in ch2.list_requests(s2)] == ["CR-2026-0002"]


# ---------------------------------------------------------------- 충돌

def test_loading_twice_is_rejected_and_changes_nothing_more() -> None:
    pdm, ch, _ = make()
    load_brk_m8(pdm, ch)
    n_items, n_wo = len(pdm.db["items"]), len(ch.list_work_orders())
    with pytest.raises(FixtureConflict):
        load_brk_m8(pdm, ch)
    assert len(pdm.db["items"]) == n_items and len(ch.list_work_orders()) == n_wo


def test_default_seed_store_conflicts_on_the_same_part_numbers() -> None:
    """기본 시드(seed.json)에도 P-00000000001 이 있다(다른 부품). 덮어쓰지 않고 거부한다."""
    pdm = InMemoryPdmStore()
    before = len(pdm.db["items"])
    with pytest.raises(FixtureConflict, match="P-00000000001"):
        load_brk_m8(pdm, InMemoryChangeStore())
    assert len(pdm.db["items"]) == before


def test_opms_part_values_returns_a_copy() -> None:
    v = opms_part_values(NUT)
    assert v["class"] == "HexNut" and v["attrs"]["nutHeight"] == 6.8
    v["attrs"]["nutHeight"] = 0
    assert OPMS_PARTS[NUT]["attrs"]["nutHeight"] == 6.8
    with pytest.raises(KeyError):
        opms_part_values("P-99999999999")
