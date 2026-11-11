"""체결 적합성 판정: 짝 · 그립 길이 · 강도등급 · 대체, OPMS 규칙 명세 읽기 (docs/change-impact-design.md 4.4 · 5.2)."""

from __future__ import annotations

import pytest

from onto_pdm.changes import fit as F
from onto_pdm.changes.fit import JointInput, PartRef, PlateInput, PdmTemporaryFitJudge
from onto_pdm.opms import mates
from onto_pdm.opms.reader import OntologySnapshot
from tests.unit.changes_helpers import (
    BOLT,
    FLANGE_BOLT,
    NUT,
    NUT_FINE,
    NUT_NO_HEIGHT,
    WASHER,
    StubReader,
    ontology_snapshot,
    part_source,
)

PLATES = (PlateInput("TOP", 8.0), PlateInput("BOT", 8.0))


def grip(plates: tuple[PlateInput, ...] = PLATES, **over: float | None) -> F.FitResult:
    args: dict[str, float | None] = dict(washer_thickness=1.6, nut_height=6.8, pitch=1.25, bolt_length=30.0)
    args.update(over)
    return F.judge_grip(plates=plates, washers=2, **args)       # type: ignore[arg-type]


def judge() -> PdmTemporaryFitJudge:
    return PdmTemporaryFitJudge(part_source())


def ref(part_no: str, reader: StubReader | None = None) -> PartRef:
    return PartRef(part_no, part_source(reader).part_attrs(part_no))


# ---------------------------------------------------------------- OPMS 규칙 명세 읽기

def test_mates_rules_read_from_snapshot() -> None:
    rules = {r.rule_id: r for r in mates.mates_rules(ontology_snapshot())}
    assert sorted(rules) == ["bolt_nut", "bolt_washer", "nut_washer"]        # mates_with 유형만, 규칙 id 순
    bn = rules["bolt_nut"]
    assert (bn.left_class, bn.right_class, bn.blocking, bn.match) == ("Bolt", "Nut", ("threadSize",), ("pitch",))
    assert bn.prefer == ("material", "surfaceTreatment")                       # relations.matesWith.pairs 에서
    assert rules["bolt_washer"].match == () and rules["nut_washer"].prefer == ()


def test_substitute_rules_read_from_snapshot() -> None:
    [r] = mates.substitute_rules(ontology_snapshot())
    assert (r.rule_id, r.replaced_class, r.replacement_class) == ("flange_bolt_for_bolt_washer", "HexBolt", "HexFlangeBolt")
    assert r.same == ("threadSize", "pitch", "length") and r.absorbs == ("FlatWasher",)


def test_rules_tolerate_missing_or_list_shape() -> None:
    assert mates.mates_rules(OntologySnapshot("0.1", {})) == []
    listed = OntologySnapshot("0.1", {"rules": [{"id": "r1", "type": "mates_with", "applies_to": "Bolt", "spec": {"with": "Nut", "blocking": ["threadSize", "x"], "match": []}}]})
    [r] = mates.mates_rules(listed)
    assert r.rule_id == "r1" and r.blocking == ("threadSize", "x")


def test_class_is_a_and_version() -> None:
    snap = ontology_snapshot("0.19.0")
    assert mates.class_is_a(snap, "HexBolt", "Bolt") and mates.class_is_a(snap, "HexBolt", "HexBolt")
    assert not mates.class_is_a(snap, "HexBolt", "Nut")
    assert mates.class_is_a(snap, "Unknown", "Unknown") and not mates.class_is_a(snap, "Unknown", "Bolt")
    assert mates.ontology_version(snap) == "0.19.0"
    assert mates.prop_label(snap, "pitch") == "피치" and mates.prop_label(snap, "nope") == "nope"


# ---------------------------------------------------------------- 그립 길이

def test_grip_r00_passes_with_margin_1_5() -> None:
    r = grip()
    assert (r.verdict, r.severity, r.reason_code) == ("ok", "none", "grip_ok")
    assert r.required == 28.5 and r.actual == 30.0 and r.inputs["margin"] == 1.5
    assert r.rule_id == "pdm:grip_length" and r.temporary is True        # OPMS 규칙이 아닌 PDM 참고 판정
    assert F.grip_required_length([8, 8], 1.6, 2, 6.8, 1.25) == 28.5


def test_grip_sc2_thicker_plate_fails_by_2_5() -> None:
    r = grip((PlateInput("TOP", 12.0), PlateInput("BOT", 8.0)))
    assert (r.verdict, r.severity, r.reason_code) == ("no", "blocked", "shortfall")
    assert r.required == 32.5 and r.gap == 2.5 and r.actual == 30.0
    assert r.suggested_disposition == "block_change"


@pytest.mark.parametrize("length,verdict,reason,severity", [
    (29.5, "ok", "grip_ok", "none"),                 # margin 1.0 = warn_within 경계 → ok
    (29.49, "conditional", "thin_margin", "review"),  # margin 0.99
    (28.5, "conditional", "thin_margin", "review"),   # margin 0.0 = 경계 → conditional (shortfall 이 아니다)
    (28.49, "no", "shortfall", "blocked"),            # margin -0.01
    (40.0, "ok", "grip_ok", "none"),                  # 너무 긴 경우는 판정하지 않는다
])
def test_grip_boundaries(length: float, verdict: str, reason: str, severity: str) -> None:
    r = grip(bolt_length=length)
    assert (r.verdict, r.reason_code, r.severity) == (verdict, reason, severity), r.inputs


def test_grip_float_noise_does_not_flip_the_boundary() -> None:
    """부동소수 오차(0.1+0.2 류)로 경계 판정이 뒤집히지 않는다."""
    r = F.judge_grip(plates=(PlateInput("A", 0.1), PlateInput("B", 0.2)), washer_thickness=0.1, washers=1, nut_height=0.3, pitch=0.2, bolt_length=1.1)
    assert r.required == 1.1 and r.verdict == "conditional" and r.inputs["margin"] == 0.0


@pytest.mark.parametrize("over,missing", [
    ({"nut_height": None}, "nutHeight"),
    ({"pitch": None}, "pitch"),
    ({"bolt_length": None}, "length"),
    ({"washer_thickness": None}, "thickness@washer"),
])
def test_grip_missing_input_is_unknown_not_pass(over: dict[str, None], missing: str) -> None:
    r = grip(**over)
    assert (r.verdict, r.severity, r.reason_code) == ("unknown", "review", "value_missing")
    assert missing in r.inputs["missing"] and r.required is None


def test_grip_missing_plate_thickness_names_the_plate() -> None:
    r = grip((PlateInput("TOP", None), PlateInput("BOT", 8.0)))
    assert r.verdict == "unknown" and r.inputs["missing"] == ["thickness@TOP"]


def test_grip_without_washers_does_not_need_washer_thickness() -> None:
    r = F.judge_grip(plates=PLATES, washer_thickness=None, washers=0, nut_height=6.8, pitch=1.25, bolt_length=30.0)
    assert r.verdict == "ok" and r.required == 25.3


def test_grip_inferred_plate_lowers_ok_to_conditional_but_not_no() -> None:
    ok = grip((PlateInput("TOP", 8.0, inferred=True), PlateInput("BOT", 8.0)))
    assert (ok.verdict, ok.reason_code, ok.approximate) == ("conditional", "approximate_value", True)
    assert ok.severity == "review" and "실물" in ok.message
    no = grip((PlateInput("TOP", 12.0, inferred=True), PlateInput("BOT", 8.0)))
    assert (no.verdict, no.severity, no.approximate) == ("no", "blocked", True)           # 추정이어도 부족은 그대로
    thin = grip((PlateInput("TOP", 8.0, inferred=True), PlateInput("BOT", 8.0)), bolt_length=29.0)
    assert thin.reason_code == "thin_margin"                                                # 이미 conditional 이면 그대로


# ---------------------------------------------------------------- 짝

def test_pair_bolt_nut_fits_and_is_always_temporary() -> None:
    r = judge().judge_pair(ref(BOLT), ref(NUT))
    assert (r.kind, r.verdict, r.severity, r.reason_code, r.rule_id) == ("fit_pair", "ok", "none", "pair_fits", "bolt_nut")
    assert r.temporary is True and r.subject_suffix == "bolt-nut"
    # 재질 · 도금이 다른 것은 안내만(짝 성립에 영향 없음)
    assert r.inputs["prefer_differs"] == ["material", "surfaceTreatment"]


def test_pair_mismatch_on_fine_thread_pitch() -> None:
    r = judge().judge_pair(ref(BOLT), ref(NUT_FINE))
    assert (r.verdict, r.severity, r.reason_code, r.rule_id) == ("no", "blocked", "pair_mismatch", "bolt_nut")
    assert "피치" in r.message and "1.25" in r.message and "1" in r.message
    assert r.inputs["differs"] == ["pitch"] and r.suggested_disposition == "block_change"


def test_pair_unrelated_when_thread_size_differs() -> None:
    reader = StubReader()
    from onto_pdm.opms.reader import RawPart
    reader._parts["P-M10-NUT"] = RawPart("P-M10-NUT", "HexNut", {"threadSize": "M10", "pitch": 1.5})
    r = judge().judge_pair(ref(BOLT), PartRef("P-M10-NUT", part_source(reader).part_attrs("P-M10-NUT")))
    assert (r.verdict, r.severity, r.reason_code) == ("no", "blocked", "pair_unrelated")


def test_pair_is_symmetric_in_argument_order() -> None:
    a, b = judge().judge_pair(ref(BOLT), ref(NUT_FINE)), judge().judge_pair(ref(NUT_FINE), ref(BOLT))
    assert (a.verdict, a.reason_code, a.rule_id) == (b.verdict, b.reason_code, b.rule_id)


def test_pair_unknown_when_match_value_missing() -> None:
    reader = StubReader()
    from onto_pdm.opms.reader import RawPart
    reader._parts["P-NO-PITCH"] = RawPart("P-NO-PITCH", "HexNut", {"threadSize": "M8"})
    r = judge().judge_pair(ref(BOLT), PartRef("P-NO-PITCH", part_source(reader).part_attrs("P-NO-PITCH")))
    assert (r.verdict, r.severity, r.reason_code) == ("unknown", "review", "pair_unknown")        # 값이 없으면 추측하지 않는다
    assert r.inputs["missing"] == ["pitch"]


def test_pair_mismatch_wins_over_missing_value() -> None:
    """한 속성이 다르다는 것이 확정이면 다른 속성이 비어 있어도 mismatch 다(OPMS 와 같은 순서: 다름 > 모름)."""
    from onto_pdm.changes.ports import PartAttrs
    left = PartRef("B", PartAttrs("B", "HexBolt", {"threadSize": "M8", "pitch": 1.25}))
    right = PartRef("N", PartAttrs("N", "HexNut", {"threadSize": "M8", "pitch": 1.0, "threadDirection": "LeftHand"}))
    assert judge().judge_pair(left, right).reason_code == "pair_mismatch"


def test_pair_part_not_found_in_opms_is_unknown() -> None:
    r = judge().judge_pair(ref(BOLT), PartRef("P-GHOST", None))
    assert (r.verdict, r.reason_code, r.rule_id) == ("unknown", "pair_unknown", None)
    assert r.inputs["missing_parts"] == ["P-GHOST"]


def test_pair_without_rule_is_unknown_no_rule() -> None:
    r = judge().judge_pair(ref(BOLT), ref(FLANGE_BOLT))      # 볼트 ↔ 볼트
    assert (r.verdict, r.reason_code, r.rule_id) == ("unknown", "no_rule", None)


def test_washer_pairs_only_need_thread_size() -> None:
    j = judge()
    bw, nw = j.judge_pair(ref(BOLT), ref(WASHER)), j.judge_pair(ref(NUT), ref(WASHER))
    assert (bw.verdict, bw.rule_id, bw.subject_suffix) == ("ok", "bolt_washer", "bolt-washer")
    assert (nw.verdict, nw.rule_id, nw.subject_suffix) == ("ok", "nut_washer", "nut-washer")


# ---------------------------------------------------------------- 강도등급

def test_strength_same_grade_makes_no_finding_different_needs_a_human() -> None:
    j = judge()
    assert j.judge_strength(ref(BOLT), ref(NUT_FINE)) is None                   # A2-70 = A2-70
    r = j.judge_strength(ref(BOLT), ref(NUT))                                    # A2-70 ↔ A4-80
    assert r is not None and (r.kind, r.verdict, r.severity, r.reason_code) == ("strength_grade", "unknown", "review", "strength_differs")
    assert "순서 비교" in r.message and r.rule_id == "pdm:strength_grade"


def test_strength_missing_value_is_review() -> None:
    from onto_pdm.changes.ports import PartAttrs
    r = judge().judge_strength(PartRef("B", PartAttrs("B", "HexBolt", {})), ref(NUT))
    assert r is not None and r.reason_code == "value_missing" and r.severity == "review"


# ---------------------------------------------------------------- 체결부 한 곳

def joint_of(bolt: str = BOLT, nut: str = NUT, washer: str | None = WASHER, plates: tuple[PlateInput, ...] = PLATES, washers: int = 2) -> JointInput:
    return JointInput("BRK-M8", "J1", ref(bolt), ref(nut), ref(washer) if washer else None, washers, plates)


def test_joint_baseline_has_pairs_grip_and_one_strength_review() -> None:
    results = judge().judge_joint(joint_of())
    by = {r.subject_suffix: r for r in results}
    assert list(by) == ["bolt-nut", "bolt-washer", "nut-washer", "grip", "strength"]
    assert [r.severity for r in results] == ["none", "none", "none", "none", "review"]      # 기준선: 볼트 A2-70 ↔ 너트 A4-80 은 사람이 확인
    assert by["grip"].required == 28.5 and all(r.temporary for r in results)


def test_joint_sc1_blocked_pair_but_grip_ok() -> None:
    results = {r.subject_suffix: r for r in judge().judge_joint(joint_of(nut=NUT_FINE))}
    assert (results["bolt-nut"].verdict, results["bolt-nut"].severity) == ("no", "blocked")
    assert results["grip"].verdict == "ok" and results["grip"].required == 28.5
    assert "strength" not in results                                                        # A2-70 = A2-70


def test_joint_nut_without_height_gives_unknown_grip() -> None:
    results = {r.subject_suffix: r for r in judge().judge_joint(joint_of(nut=NUT_NO_HEIGHT))}
    assert (results["grip"].verdict, results["grip"].reason_code) == ("unknown", "value_missing")
    assert results["grip"].inputs["missing"] == ["nutHeight"]


def test_joint_without_washer_skips_washer_pairs() -> None:
    results = judge().judge_joint(joint_of(washer=None, washers=0))
    assert [r.subject_suffix for r in results] == ["bolt-nut", "grip", "strength"]
    assert next(r for r in results if r.subject_suffix == "grip").required == 25.3


# ---------------------------------------------------------------- 대체

def test_substitute_flange_bolt_is_conditional_review() -> None:
    r = judge().judge_substitute(ref(BOLT), ref(FLANGE_BOLT))
    assert r is not None and (r.kind, r.verdict, r.severity, r.reason_code, r.rule_id) == ("substitute", "conditional", "review", "substitute_conditional", "flange_bolt_for_bolt_washer")
    assert r.inputs["same_differs"] == ["length"]                                            # 길이 30 → 40 은 규칙상 같아야 하는 값
    assert r.inputs["confirm_differs"] == ["material", "surfaceTreatment", "strengthGrade"]
    assert r.inputs["absorbs"] == ["FlatWasher"] and "순서 비교 불가" in r.message and r.temporary is True


def test_substitute_none_when_same_class_or_no_rule_or_missing_part() -> None:
    j = judge()
    assert j.judge_substitute(ref(NUT), ref(NUT_FINE)) is None            # 같은 분류
    assert j.judge_substitute(ref(NUT), ref(WASHER)) is None              # 규칙 없는 조합
    assert j.judge_substitute(ref(BOLT), PartRef("P-GHOST", None)) is None


def test_severity_for_follows_the_table() -> None:
    assert [F.severity_for(v) for v in ("ok", "conditional", "unknown", "no")] == ["none", "review", "review", "blocked"]
