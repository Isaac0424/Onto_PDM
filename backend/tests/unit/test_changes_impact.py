"""영향 탐색 엔진 수락 시험 — DB · API 없이 (docs/change-impact-design.md 4 · 9.2, docs/change-impact-ontology.md 6장).

수락 수치: R00 그립 28.5 ≤ 30 · SC-1 피치 불일치 blocked · SC-2 상판 12 mm → 32.5, 2.5 mm 부족 · 후보 P-…15 30.9 / 32.5 ≤ 40 · 결정성 · stale · 추정 낮춤.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

import pytest

from onto_pdm.changes import impact as I
from onto_pdm.changes.fit import PdmTemporaryFitJudge
from onto_pdm.changes.models import ApplicabilityScope, ChangeTarget, ImpactFinding, ImpactRun, WorkOrderBomRef
from onto_pdm.changes.ports import BomLine, ExternalState
from tests.unit import changes_helpers as H
from tests.unit.changes_helpers import (
    BOLT,
    BOT,
    FLANGE_BOLT,
    LATER,
    MODULE,
    NOW,
    NUT,
    NUT_FINE,
    NUT_NO_HEIGHT,
    SET,
    TOP,
    WASHER,
    World,
    brk_m8,
    t_plate,
    t_replace_nut,
)


def analyze(world: World, targets: Sequence[ChangeTarget], scopes: Sequence[ApplicabilityScope] | None = None, *, reader: H.StubReader | None = None) -> ImpactRun:
    parts = H.part_source(reader) if reader is not None else world.parts
    return I.analyze(
        H.order(), targets, bom=world.bom, specs=world.specs, external=world.external, parts=parts, judge=PdmTemporaryFitJudge(parts),
        computed_at=NOW, computed_by="tester", scopes=[H.all_scope()] if scopes is None else scopes,
    )


def of(run: ImpactRun, kind: str) -> list[ImpactFinding]:
    return [f for f in run.findings if f.kind == kind]


def one(run: ImpactRun, kind: str, suffix: str = "") -> ImpactFinding:
    found = [f for f in of(run, kind) if f.subject_ref.endswith(suffix)]
    assert len(found) == 1, [(f.kind, f.subject_ref) for f in run.findings]
    return found[0]


# ---------------------------------------------------------------- ① 기준선 · 사용처 · 외부 객체

def test_baseline_r00_grip_passes_with_margin_1_5() -> None:
    run = analyze(brk_m8(), [t_plate(8.0)])           # 값이 같은 개정 → 판정 입력이 R00 과 같다
    g = one(run, "fit_grip")
    assert (g.verdict, g.severity, g.required, g.actual) == ("ok", "none", 28.5, 30.0)
    assert g.inputs["margin"] == 1.5 and g.temporary is True and g.basis.rule_id == "pdm:grip_length"
    assert g.basis.ontology_version == "0.19.0" and g.basis.as_of == NOW
    assert not run.partial and run.temporary and re.fullmatch(r"[0-9a-f]{64}", run.input_hash)


def test_usage_of_a_nut_is_the_set_and_the_product() -> None:
    run = analyze(brk_m8(), [t_replace_nut()])
    usage = of(run, "bom_usage") + of(run, "product")
    assert len(usage) == 2 and all(f.severity == "none" for f in usage)
    assert one(run, "bom_usage").subject_ref == f"{SET}@R00" and one(run, "product").subject_ref == "BRK-M8"
    assert one(run, "bom_usage").suggested_disposition == "acknowledge"


def test_target_used_nowhere_is_stated_not_silent() -> None:
    run = analyze(brk_m8(), [ChangeTarget(change_kind="attribute_edit", item_no="P-ORPHAN", after={"thickness": 3})])
    assert not of(run, "bom_usage") and not of(run, "product")
    assert any("P-ORPHAN" in w and "쓰이는 곳이 없어요" in w for w in run.warnings)       # 빈 결과와 구별한다


# ---------------------------------------------------------------- ② SC-1: 너트를 가는나사 너트로 교체

def test_sc1_nut_replacement_is_blocked_by_pitch_mismatch() -> None:
    run = analyze(brk_m8(), [t_replace_nut()])
    pair = one(run, "fit_pair", ":bolt-nut")
    assert (pair.verdict, pair.severity, pair.reason_code, pair.basis.rule_id) == ("no", "blocked", "pair_mismatch", "bolt_nut")
    assert pair.temporary and "피치" in pair.message
    grip = one(run, "fit_grip")
    assert (grip.verdict, grip.severity, grip.required) == ("ok", "none", 28.5)                # 새 너트 높이도 6.8
    assert not of(run, "strength_grade")                                                       # A2-70 = A2-70 → finding 없음
    assert not of(run, "substitute")                                                           # 같은 분류 교체는 대체 규칙 대상이 아니다
    assert one(run, "fit_pair", ":nut-washer").severity == "none"
    assert run.findings[0].severity == "blocked"                                               # 가장 심각한 것이 먼저


def test_sc1_old_nut_stock_and_open_po_are_affected() -> None:
    run = analyze(brk_m8(), [t_replace_nut()])
    po, lot = one(run, "purchase_order_line"), one(run, "stock_lot")
    assert (po.severity, po.reason_code, po.scope_class, po.suggested_disposition) == ("affected", "open_po_line", "inside", "amend")
    assert po.subject_ref == "PO-FX-100/10" and po.inputs["qty_open"] == 120 and po.inputs["source_system"] == "fixture"
    assert (lot.severity, lot.reason_code, lot.suggested_disposition) == ("affected", "stock_on_hand", "use_up")
    assert lot.inputs["qty_on_hand"] == 300 and lot.basis.as_of == NOW                         # 외부 행의 as_of 를 근거 시각으로


def test_sc1_work_orders_follow_the_status_table() -> None:
    run = analyze(brk_m8(), [t_replace_nut()])
    wo = {f.subject_ref: f for f in of(run, "work_order")}
    assert set(wo) == {"WO-FX-0001", "WO-FX-0002", "WO-FX-0003"}
    assert (wo["WO-FX-0001"].severity, wo["WO-FX-0001"].reason_code, wo["WO-FX-0001"].suggested_disposition) == ("none", "used_in_completed", "use_as_is")
    assert (wo["WO-FX-0002"].severity, wo["WO-FX-0002"].reason_code, wo["WO-FX-0002"].suggested_disposition) == ("affected", "used_in_progress", "change_in_progress")
    assert (wo["WO-FX-0003"].severity, wo["WO-FX-0003"].reason_code, wo["WO-FX-0003"].suggested_disposition) == ("affected", "used_not_started", "apply_new")
    assert all(f.scope_class == "inside" for f in wo.values())


def test_nut_without_height_gives_unknown_grip_never_a_pass() -> None:
    run = analyze(brk_m8(), [t_replace_nut(NUT_NO_HEIGHT)])
    g = one(run, "fit_grip")
    assert (g.verdict, g.severity, g.reason_code) == ("unknown", "review", "value_missing") and g.inputs["missing"] == ["nutHeight"]
    assert one(run, "fit_pair", ":bolt-nut").verdict == "ok"


# ---------------------------------------------------------------- ④ SC-2: 상판 12 mm

def test_sc2_thicker_plate_is_a_blocked_shortfall_of_2_5() -> None:
    run = analyze(brk_m8(), [t_plate(12.0)])
    g = one(run, "fit_grip")
    assert (g.verdict, g.severity, g.reason_code) == ("no", "blocked", "shortfall")
    assert (g.required, g.actual, g.gap) == (32.5, 30.0, 2.5) and g.suggested_disposition == "block_change"
    assert g.inputs["plates"][0] == {"item_no": TOP, "thickness": 12.0, "inferred": False}
    assert one(run, "product").subject_ref == "BRK-M8" and not of(run, "bom_usage")          # 판은 모듈의 직접 자식이다
    assert not of(run, "purchase_order_line") and not of(run, "stock_lot")                    # 판의 발주 · 재고는 없다
    assert {f.subject_ref for f in of(run, "work_order")} == {"WO-FX-0001", "WO-FX-0002", "WO-FX-0003"}


def test_sc2_finds_a_joint_attached_below_the_changed_assemblys_ancestor() -> None:
    """체결 구성이 모듈이 아니라 체결 세트에 붙어 있어도 가상 전개가 아래로 내려가 찾는다."""
    run = analyze(brk_m8(joint_at=SET), [t_plate(12.0)])
    g = one(run, "fit_grip")
    assert (g.verdict, g.gap) == ("no", 2.5) and g.subject_ref.startswith(f"{SET}#J1")


# ---------------------------------------------------------------- ⑤ 대체 후보 P-…15

@pytest.mark.parametrize("washers,required", [(1, 30.9), (2, 32.5)])
def test_candidate_flange_bolt_passes_length_and_needs_a_human(washers: int, required: float) -> None:
    targets: list[ChangeTarget] = [
        t_plate(12.0),
        ChangeTarget(change_kind="replace", item_no=BOLT, replacement_item_no=FLANGE_BOLT, parent_revision="R00", before_class="HexBolt", after_class="HexFlangeBolt"),
    ]
    if washers == 1:
        targets.append(ChangeTarget(change_kind="bom_edit", item_no=MODULE, parent_revision="R00", after={"washers_per_bolt": 1}))
    run = analyze(brk_m8(), targets)
    g = one(run, "fit_grip")
    assert (g.verdict, g.severity, g.required, g.actual) == ("ok", "none", required, 40.0)    # 길이는 통과(여유 9.1 / 7.5)
    assert g.inputs["margin"] == round(40.0 - required, 6)
    sub = one(run, "substitute")                                                               # 분류가 달라 substitutes 규칙 대상
    assert (sub.verdict, sub.severity, sub.basis.rule_id) == ("conditional", "review", "flange_bolt_for_bolt_washer")
    assert "strengthGrade" in sub.message or "강도 등급" in sub.message
    assert not any(f.severity == "blocked" for f in run.findings)                              # 전체: 차단은 풀리고 사람 확인이 남는다
    assert one(run, "fit_pair", ":bolt-nut").verdict == "ok"                                   # 플랜지볼트도 Bolt 이고 M8 · 1.25 로 너트와 맞는다


# ---------------------------------------------------------------- ⑥ 결정성

def test_same_input_gives_same_findings_order_and_hash() -> None:
    a = analyze(brk_m8(), [t_replace_nut()])
    b = analyze(brk_m8(), [t_replace_nut()])
    assert a.model_dump(mode="json") == b.model_dump(mode="json")
    shuffled = analyze(brk_m8(reverse_external=True), [t_replace_nut()])               # 외부 행 도착 순서가 달라도
    assert [(f.kind, f.subject_ref) for f in shuffled.findings] == [(f.kind, f.subject_ref) for f in a.findings]
    assert shuffled.input_hash == a.input_hash


def test_findings_are_sorted_by_severity_kind_subject() -> None:
    run = analyze(brk_m8(), [t_replace_nut()])
    keys = [(I.SEVERITY_RANK[f.severity], f.kind, f.subject_type, f.subject_ref, f.basis.rule_id or "", f.reason_code) for f in run.findings]
    assert keys == sorted(keys)
    assert I.sort_findings(list(reversed(run.findings))) == list(run.findings)


def test_input_hash_changes_when_an_input_changes() -> None:
    base = analyze(brk_m8(), [t_replace_nut()]).input_hash
    assert analyze(brk_m8(), [t_replace_nut(NUT_NO_HEIGHT)]).input_hash != base
    assert analyze(brk_m8(top_source="cad_estimate"), [t_replace_nut()]).input_hash != base      # 사양 출처
    assert analyze(brk_m8(), [t_replace_nut()], [ApplicabilityScope(site="A")]).input_hash != base   # 범위
    assert analyze(brk_m8(), [t_replace_nut()], reader=H.StubReader("0.20.0")).input_hash != base    # 온톨로지 버전


# ---------------------------------------------------------------- ⑦ stale

def test_stale_when_external_feed_is_newer_or_ontology_or_inputs_change() -> None:
    world = brk_m8()
    run = analyze(world, [t_replace_nut()])
    assert I.stale_reasons(run, external_state=world.external.external_state(), ontology_version="0.19.0", input_hash=run.input_hash) == ()
    assert set(run.external_as_of) == {"work_order", "purchase_order_line", "stock_lot"}

    newer = brk_m8()
    newer.external.lots[0] = newer.external.lots[0].model_copy(update={"as_of": LATER})
    assert I.stale_reasons(run, external_state=newer.external.external_state()) == ("external_feed_newer",)
    assert I.stale_reasons(run, external_state=ExternalState(as_of={"work_order": NOW})) == ()              # 새 값이 없으면 그대로
    assert I.stale_reasons(run, external_state=ExternalState(as_of={"work_order": NOW, "stock_lot": NOW, "purchase_order_line": NOW, "x": NOW})) == ("external_feed_newer",)
    assert I.stale_reasons(run, ontology_version="0.20.0") == ("ontology_changed",)
    changed = analyze(brk_m8(top_source="cad_estimate"), [t_replace_nut()])
    assert I.stale_reasons(run, input_hash=changed.input_hash) == ("input_changed",)
    assert I.stale_reasons(run, external_state=newer.external.external_state(), ontology_version="0.20.0", input_hash=changed.input_hash) \
        == ("external_feed_newer", "ontology_changed", "input_changed")


def test_new_feed_row_changes_the_hash_even_if_as_of_is_equal() -> None:
    a = analyze(brk_m8(), [t_replace_nut()])
    w = brk_m8()
    w.external.lots.append(w.external.lots[0].model_copy(update={"lot_no": "LT-N-02"}))      # 행 수가 달라졌다
    assert analyze(w, [t_replace_nut()]).input_hash != a.input_hash


def test_mark_stale_returns_a_new_run_and_keeps_the_original() -> None:
    run = analyze(brk_m8(), [t_replace_nut()])
    s = I.mark_stale(run, ["external_feed_newer", "external_feed_newer", "ontology_changed"])
    assert s.stale and s.stale_reasons == ("external_feed_newer", "ontology_changed") and not run.stale
    assert I.mark_stale(run, ()) is run


# ---------------------------------------------------------------- ⑧ 추정(inferred)

def test_cad_estimated_plate_thickness_lowers_ok_to_conditional() -> None:
    run = analyze(brk_m8(top_source="cad_estimate"), [t_replace_nut()])
    g = one(run, "fit_grip")
    assert (g.verdict, g.reason_code, g.approximate, g.severity) == ("conditional", "approximate_value", True, "review")
    assert g.inputs["plates"][0]["inferred"] is True


def test_target_can_declare_its_new_value_as_an_estimate() -> None:
    ok = one(analyze(brk_m8(), [t_plate(8.0, spec_source="cad_estimate")]), "fit_grip")
    assert (ok.verdict, ok.approximate) == ("conditional", True)
    no = one(analyze(brk_m8(), [t_plate(12.0, spec_source="cad_estimate")]), "fit_grip")
    assert (no.verdict, no.severity, no.approximate) == ("no", "blocked", True)                # 부족은 추정이어도 그대로


# ---------------------------------------------------------------- 적용 범위

def test_partial_scope_marks_overlapping_work_orders_and_drops_outside_ones() -> None:
    run = analyze(brk_m8(), [t_replace_nut()], [ApplicabilityScope(serial_from=120)])
    wo = {f.subject_ref: f for f in of(run, "work_order")}
    assert set(wo) == {"WO-FX-0003"}                      # 1~50 · 51~100 은 밖이라 영향이 없다
    assert (wo["WO-FX-0003"].scope_class, wo["WO-FX-0003"].severity) == ("partial", "affected")   # 101~150 은 경계를 걸친다
    # 발주 · 재고는 일련번호 값이 없어 범위를 확정할 수 없다 → review(안이라고 가정하지 않는다)
    assert (one(run, "purchase_order_line").scope_class, one(run, "purchase_order_line").severity) == ("unknown", "review")
    assert one(run, "stock_lot").suggested_disposition is None


def test_no_scope_is_undecided_not_everything() -> None:
    run = analyze(brk_m8(), [t_replace_nut()], [])
    wo = {f.subject_ref: f for f in of(run, "work_order")}
    assert wo["WO-FX-0002"].severity == "affected"                                  # 진행 중은 범위를 몰라도 affected
    assert (wo["WO-FX-0001"].severity, wo["WO-FX-0001"].reason_code) == ("review", "scope_unknown")
    assert (wo["WO-FX-0003"].severity, wo["WO-FX-0003"].reason_code) == ("review", "scope_unknown")
    assert all(f.scope_class == "unknown" for f in wo.values()) and all(f.severity == "review" for f in of(run, "stock_lot"))


def test_old_revision_scope_keeps_everything_outside_the_change() -> None:
    run = analyze(brk_m8(), [t_replace_nut()], [ApplicabilityScope(site="A", applies="old")])
    assert not of(run, "work_order") and not of(run, "purchase_order_line") and not of(run, "stock_lot")
    assert of(run, "fit_pair")                                                          # 적합성 판정은 범위와 무관하게 낸다


def test_target_scopes_are_used_like_order_scopes() -> None:
    t = t_replace_nut().model_copy(update={"scopes": (ApplicabilityScope(site="B"),)})
    run = analyze(brk_m8(), [t], [])
    assert not of(run, "work_order")                                                    # 전부 사업장 A → 밖


def test_cancelled_work_orders_have_no_impact() -> None:
    w = brk_m8()
    w.external.wos.append(H.fixture_wo("WO-FX-0009", "cancelled"))
    assert "WO-FX-0009" not in {f.subject_ref for f in of(analyze(w, [t_replace_nut()]), "work_order")}


def test_work_order_matched_by_bom_revision_and_bom_refs() -> None:
    w = brk_m8()
    w.external.wos.append(H.fixture_wo("WO-OTHER-REV", "in_progress", bom_revision="R09"))                       # 다른 개정의 BOM
    w.external.wos.append(H.fixture_wo("WO-BY-REF", "in_progress", product_item_no="OTHER", bom_revision=None,
                                       bom_refs=(WorkOrderBomRef(item_no=NUT, qty_required=4),)))                  # BOM 참조에 대상이 있다
    refs = {f.subject_ref for f in of(analyze(w, [t_replace_nut()]), "work_order")}
    assert "WO-OTHER-REV" not in refs and "WO-BY-REF" in refs


def test_closed_purchase_lines_and_empty_stock_are_not_listed() -> None:
    w = brk_m8()
    w.external.pos[0] = w.external.pos[0].model_copy(update={"qty_received": 200})
    w.external.lots[0] = w.external.lots[0].model_copy(update={"qty_on_hand": 0})
    run = analyze(w, [t_replace_nut()])
    assert not of(run, "purchase_order_line") and not of(run, "stock_lot")


def test_revision_of_a_target_keeps_only_old_revision_stock_and_orders() -> None:
    """개정(같은 품번)에서는 구 개정 · 개정을 모르는 발주 · 재고만 영향이다. 이미 새 개정으로 들어온 것은 영향이 아니다."""
    w = brk_m8()
    w.external.lots.append(w.external.lots[0].model_copy(update={"lot_no": "LT-OLD", "item_no": TOP, "item_rev": "R00"}))
    w.external.lots.append(w.external.lots[0].model_copy(update={"lot_no": "LT-NEW", "item_no": TOP, "item_rev": "R01"}))
    w.external.lots.append(w.external.lots[0].model_copy(update={"lot_no": "LT-UNKNOWN", "item_no": TOP, "item_rev": None}))
    refs = {f.subject_ref for f in of(analyze(w, [t_plate(12.0)]), "stock_lot")}
    assert refs == {"LT-OLD", "LT-UNKNOWN"}


# ---------------------------------------------------------------- OPMS 를 못 읽을 때

def test_opms_down_keeps_usage_and_external_but_marks_run_partial() -> None:
    run = analyze(brk_m8(), [t_replace_nut()], reader=H.DownReader())
    assert run.partial and run.ontology_version == "unknown" and any("OPMS" in w for w in run.warnings)
    fit = of(run, "fit_pair")
    assert [(f.verdict, f.reason_code) for f in fit] == [("unknown", "OPMS_UNAVAILABLE")] and not of(run, "fit_grip")   # 적합성은 unknown(연결 안 됨)
    assert of(run, "work_order") and of(run, "stock_lot") and of(run, "product")                                        # BOM · 외부 영향은 낸다


# ---------------------------------------------------------------- 체결 구성이 BOM 에서 사라졌을 때

def test_joint_part_missing_from_the_after_bom_is_flagged() -> None:
    w = brk_m8()
    w.bom = H.MemBom({(MODULE, "R00"): [BomLine(TOP, 1), BomLine(BOT, 1), BomLine(SET, 1)], (SET, "R00"): [BomLine(BOLT, 4), BomLine(NUT, 4)]}, {MODULE: "BRK-M8"})
    f = one(analyze(w, [t_plate(12.0)]), "fit_pair", ":bom")
    assert (f.severity, f.reason_code) == ("review", "pair_unknown") and f.inputs["missing"] == [WASHER]


# ---------------------------------------------------------------- 가상 BOM 전개 · 개정 비교

def lines(*pairs: tuple[str, float]) -> list[BomLine]:
    return [BomLine(i, q) for i, q in pairs]


def test_virtual_bom_replaces_children_and_edits_quantities_in_memory_only() -> None:
    cur = lines((BOLT, 4), (NUT, 4), (WASHER, 8))
    after = I.virtual_bom(cur, [t_replace_nut(), ChangeTarget(change_kind="bom_edit", item_no=SET, parent_revision="R00", after={"quantities": {WASHER: 4}})], SET)
    assert [(x.item_no, x.quantity) for x in after] == [(BOLT, 4), (NUT_FINE, 4), (WASHER, 4)]
    assert [(x.item_no, x.quantity) for x in cur] == [(BOLT, 4), (NUT, 4), (WASHER, 8)]             # 원본은 그대로
    assert I.virtual_bom(cur, [], SET) == cur


def test_virtual_descendants_walks_down_with_replacements() -> None:
    w = brk_m8()
    assert I.virtual_descendants(w.bom, MODULE, "R00", []) == [TOP, BOT, SET, BOLT, NUT, WASHER]
    assert I.virtual_descendants(w.bom, MODULE, "R00", [t_replace_nut()]) == [TOP, BOT, SET, BOLT, NUT_FINE, WASHER]
    assert I.virtual_descendants(w.bom, "P-LEAF", None, []) == []


def test_compare_lines_and_revision_diff() -> None:
    a, b = lines((BOLT, 4), (NUT, 4), (WASHER, 8)), lines((BOLT, 4), (NUT_FINE, 4), (WASHER, 16))
    diff = I.compare_lines(a, b)
    assert [(d.item_no, d.change, d.qty_a, d.qty_b) for d in diff] == [
        (NUT, "removed", 4, None), (NUT_FINE, "added", None, 4), (WASHER, "quantity_changed", 8, 16)]
    w = brk_m8()
    w.bom = H.MemBom({(SET, "R00"): a, (SET, "R01"): b}, {})
    assert w.bom.compare_revisions(SET, "R00", "R01") == diff and I.compare_lines(a, a) == []


def test_replace_does_not_mutate_inputs() -> None:
    t = t_replace_nut()
    before = t.model_dump(mode="json")
    analyze(brk_m8(), [t])
    assert t.model_dump(mode="json") == before
