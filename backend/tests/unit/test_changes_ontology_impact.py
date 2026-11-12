"""온톨로지 버전 변경 보고(`changes/ontology_impact.py` · `ChangeService.compute_ontology_impact`) 시험.

- 순수 부분(diff · 영향 부품 · 체결부 재판정)은 합성 스냅샷으로, 서비스 부분은 BRK-M8 픽스처 + 버전을 가진 OPMS 대역으로 확인한다.
- **핵심 불변식**: 보고를 만들어도 PDM 개정 수 · 변경 요청 수가 그대로다(F-CHG-10 — 온톨로지 버전은 부품 개정이 아니다).
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

import pytest

from onto_pdm.changes import ontology_impact as oi
from onto_pdm.changes.adapters import system_session
from onto_pdm.changes.models import OntologyImpact
from onto_pdm.changes.ports import PartAttrs
from onto_pdm.contracts import OntologyImpactView
from onto_pdm.errors import ApiException
from onto_pdm.opms import UnconfiguredOpmsReader
from onto_pdm.opms.reader import OntologySnapshot
from tests.unit.changes_api_helpers import LEE, make_world, url
from tests.unit.changes_helpers import BOLT, FLANGE_BOLT, NOW, NUT, NUT_FINE, NUT_NO_HEIGHT, PARTS, WASHER, DownReader, StubReader, joint, ontology_snapshot

OLD, NEW = "0.19.0", "0.20.0"


# ---------------------------------------------------------------- 합성 스냅샷

def _prop(required: bool = False, lo: Any = None, hi: Any = None) -> dict[str, Any]:
    return {"required": required, "min": lo, "max": hi, "severity": {"missing_required": "error"}}


def base_snapshot(version: str = OLD) -> OntologySnapshot:
    """시험용 0.19.0: 분류별 속성 제약을 더한 스냅샷(`changes_helpers` 의 스냅샷에는 없다)."""
    snap = ontology_snapshot(version)
    data = copy.deepcopy(dict(snap.data))
    classes = data["classes"]
    classes["Bolt"]["properties"] = {"length": _prop(True, 3, 300), "pitch": _prop(True)}
    classes["Nut"]["properties"] = {"pitch": _prop(True), "nutHeight": _prop(False)}
    classes["Washer"]["properties"] = {"thickness": _prop(True)}
    data["properties"]["length"] = {"label": {"ko": "길이"}, "datatype": "decimal", "canonical_unit": "mm"}
    return OntologySnapshot(version=version, data=data)


def changed(old: OntologySnapshot, version: str = NEW, mutate: Any = None) -> OntologySnapshot:
    data = copy.deepcopy(dict(old.data))
    data["version"] = version
    if mutate is not None:
        mutate(data)
    return OntologySnapshot(version=version, data=data)


def attrs(*part_nos: str) -> dict[str, PartAttrs]:
    return {no: PartAttrs(part_no=no, class_code=PARTS[no].class_code, values=dict(PARTS[no].values)) for no in part_nos}


ALL = attrs(BOLT, FLANGE_BOLT, NUT, NUT_FINE, NUT_NO_HEIGHT, WASHER)


def items_of(report: OntologyImpact, reason: str | None = None) -> list[tuple[str, str, str | None]]:
    return [(i.subject, i.reason_code, i.ref) for i in report.items if reason is None or i.reason_code == reason]


# ---------------------------------------------------------------- diff (순수)

def test_identical_snapshots_have_no_diff() -> None:
    d = oi.diff_snapshots(base_snapshot(), changed(base_snapshot()))
    assert d.is_empty and d.from_version == OLD and d.to_version == NEW


def test_diff_reports_required_range_class_and_property_changes() -> None:
    def mutate(data: dict[str, Any]) -> None:
        data["classes"]["Nut"]["properties"]["nutHeight"]["required"] = True            # 선택 → 필수
        data["classes"]["Bolt"]["properties"]["length"]["max"] = 35                      # 범위 축소
        data["classes"]["Washer"]["properties"].pop("thickness")                         # 속성 삭제
        data["classes"].pop("HexFlangeBolt")                                             # 분류 삭제
        data["properties"]["length"]["canonical_unit"] = "cm"                            # 정의 변경
    d = oi.diff_snapshots(base_snapshot(), changed(base_snapshot(), mutate=mutate))
    kinds = {(c.class_code, c.prop, c.kind) for c in d.class_prop_changes}
    assert kinds == {("Nut", "nutHeight", "required_on"), ("Bolt", "length", "range_changed"), ("Washer", "thickness", "removed")}
    assert d.classes_removed == ("HexFlangeBolt",) and d.classes_added == ()
    assert d.property_defs_changed == ("length",)
    rng = next(c for c in d.class_prop_changes if c.kind == "range_changed")
    assert (rng.before, rng.after) == ("3 ~ 300", "3 ~ 35")


def test_diff_reports_rule_added_removed_and_changed_but_ignores_message_only_edits() -> None:
    def mutate(data: dict[str, Any]) -> None:
        data["rules"]["bolt_nut"]["spec"]["match"] = ["pitch", "strengthGrade"]          # 변경
        data["rules"]["nut_washer"]["message"] = "문구만 바뀜"                            # 표시용 값은 무시
        data["rules"].pop("bolt_washer")                                                 # 삭제
        data["rules"]["new_fit"] = {"type": "fit_check", "applies_to": "Nut", "spec": {}}  # 추가
    d = oi.diff_snapshots(base_snapshot(), changed(base_snapshot(), mutate=mutate))
    got = {(r.rule_id, r.kind): r for r in d.rule_changes}
    assert set(got) == {("bolt_nut", "changed"), ("bolt_washer", "removed"), ("new_fit", "added")}
    assert got[("bolt_nut", "changed")].fields == ("spec",)
    assert set(got[("bolt_nut", "changed")].classes) == {"Bolt", "Nut"}


def test_diff_is_deterministic_and_sorted() -> None:
    def mutate(data: dict[str, Any]) -> None:
        for r in ("bolt_nut", "bolt_washer", "nut_washer"):
            data["rules"][r]["severity"] = "error"
    a = oi.diff_snapshots(base_snapshot(), changed(base_snapshot(), mutate=mutate))
    b = oi.diff_snapshots(base_snapshot(), changed(base_snapshot(), mutate=mutate))
    assert a == b and [r.rule_id for r in a.rule_changes] == ["bolt_nut", "bolt_washer", "nut_washer"]


# ---------------------------------------------------------------- 영향받는 부품 (순수)

def _report(mutate: Any, parts: Mapping[str, PartAttrs] = ALL, joints: Any = ()) -> OntologyImpact:
    return oi.build_report(base_snapshot(), changed(base_snapshot(), mutate=mutate), parts=parts, joints=joints, computed_at=NOW)


def test_new_required_property_flags_only_parts_without_a_value() -> None:
    r = _report(lambda d: d["classes"]["Nut"]["properties"]["nutHeight"].update(required=True))
    assert items_of(r) == [(NUT_NO_HEIGHT, oi.REASON_REQUIRED_MISSING, "nutHeight")]       # 높이가 있는 너트 · 볼트 · 와셔는 그대로
    assert r.summary.parts_flagged == (NUT_NO_HEIGHT,)
    assert r.items[0].before == "선택" and r.items[0].after == "필수"


def test_narrowed_range_flags_parts_outside_the_new_range_on_subclasses() -> None:
    r = _report(lambda d: d["classes"]["Bolt"]["properties"]["length"].update(max=35))
    assert items_of(r) == [(FLANGE_BOLT, oi.REASON_OUT_OF_RANGE, "length")]               # 하위 분류(HexFlangeBolt)에도 적용, 30 mm 는 범위 안
    assert r.items[0].after == "3 ~ 35"


def test_removed_property_and_removed_class_are_flagged() -> None:
    def mutate(data: dict[str, Any]) -> None:
        data["classes"]["Washer"]["properties"].pop("thickness")
        data["classes"].pop("HexFlangeBolt")
    r = _report(mutate)
    assert (WASHER, oi.REASON_PROPERTY_REMOVED, "thickness") in items_of(r)
    assert (FLANGE_BOLT, oi.REASON_CLASS_REMOVED, "HexFlangeBolt") in items_of(r)
    assert not [i for i in r.items if i.subject == BOLT]


def test_changed_rule_flags_parts_of_both_classes_but_not_the_third() -> None:
    r = _report(lambda d: d["rules"]["bolt_nut"]["spec"].update(match=["pitch", "strengthGrade"]))
    assert r.summary.rules_changed == ("bolt_nut:changed",)
    flagged = {s for s, reason, ref in items_of(r) if reason == oi.REASON_RULE_CHANGED and ref == "bolt_nut"}
    assert flagged == {BOLT, FLANGE_BOLT, NUT, NUT_FINE, NUT_NO_HEIGHT}                   # Bolt · Nut 계열. 와셔는 걸리지 않는다
    assert WASHER not in r.summary.parts_flagged


def test_added_and_removed_rules_use_their_own_reason_codes() -> None:
    def mutate(data: dict[str, Any]) -> None:
        data["rules"].pop("nut_washer")
        data["rules"]["washer_new"] = {"type": "fit_check", "applies_to": "Washer", "spec": {}}
    r = _report(mutate)
    assert (WASHER, oi.REASON_RULE_REMOVED, "nut_washer") in items_of(r)
    assert (WASHER, oi.REASON_RULE_ADDED, "washer_new") in items_of(r)
    assert (NUT, oi.REASON_RULE_REMOVED, "nut_washer") in items_of(r)
    assert set(r.summary.rules_changed) == {"nut_washer:removed", "washer_new:added"}


def test_property_definition_change_flags_only_parts_that_have_the_value() -> None:
    r = _report(lambda d: d["properties"]["length"].update(canonical_unit="cm"))
    assert {s for s, *_ in items_of(r, oi.REASON_PROPERTY_DEFINITION)} == {BOLT, FLANGE_BOLT}


def test_unrelated_change_flags_nothing() -> None:
    r = _report(lambda d: d["properties"]["pitch"].update(label={"ko": "피치(바뀐 이름)"}))        # 표시용 값
    assert r.items == () and r.summary.parts_flagged == () and r.summary.rules_changed == ()


# ---------------------------------------------------------------- 체결부 재판정 (순수)

def test_joint_verdict_is_rejudged_with_both_rule_sets_and_only_changes_are_reported() -> None:
    # 새 버전: 볼트↔너트 짝에 강도 등급도 같아야 한다 → BRK-M8 기준 체결(A2-70 ↔ A4-80)의 짝 판정이 ok → no 로 달라진다
    r = _report(lambda d: d["rules"]["bolt_nut"]["spec"].update(match=["pitch", "strengthGrade"]), joints=[joint()])
    js = [i for i in r.items if i.kind == "joint"]
    assert [(i.subject, i.reason_code, i.ref) for i in js] == [("BRK-M8:J1", oi.REASON_JOINT_VERDICT, "bolt-nut")]   # 와셔 짝 · 강도는 그대로라 빠진다
    assert js[0].before.startswith("ok/") and js[0].after.startswith("no/")
    assert {BOLT, NUT} <= set(r.summary.parts_flagged)                                      # 달라진 체결부의 부품이 후보에 오른다


def test_joint_with_unchanged_rules_is_not_reported() -> None:
    r = _report(lambda d: d["rules"]["bolt_nut"].update(severity="error"), joints=[joint()])        # 판정에 쓰지 않는 값만 바뀜
    assert not [i for i in r.items if i.kind == "joint"]


def test_joint_whose_parts_are_unknown_to_opms_is_skipped() -> None:
    r = _report(lambda d: d["rules"]["bolt_nut"]["spec"].update(match=["pitch", "strengthGrade"]), parts=attrs(BOLT, WASHER), joints=[joint()])
    assert not [i for i in r.items if i.kind == "joint"]


def test_report_is_deterministic_regardless_of_input_order() -> None:
    mutate = lambda d: d["rules"]["bolt_nut"]["spec"].update(match=["pitch", "strengthGrade"])      # noqa: E731
    a = _report(mutate, parts=ALL, joints=[joint()])
    b = _report(mutate, parts=dict(reversed(list(ALL.items()))), joints=[joint()])
    assert a == b


def test_report_requires_two_different_versions() -> None:
    with pytest.raises(ValueError):
        oi.build_report(base_snapshot(), base_snapshot(), parts=ALL, joints=(), computed_at=NOW)


# ---------------------------------------------------------------- 서비스 (BRK-M8 + 버전을 가진 OPMS 대역)

class VersionedReader(StubReader):
    """현재 버전(`NEW`)과, 옛 버전을 `ontology_at` 으로 읽어 주는 OPMS 대역. `history=False` 면 옛 버전을 읽을 수 없는 OPMS(공개 메서드 없음)."""

    def __init__(self, current: OntologySnapshot, history: Mapping[str, OntologySnapshot] | None = None) -> None:
        super().__init__(current.version)
        self._snap = current
        self._history = dict(history or {})

    def ontology_at(self, version: str) -> OntologySnapshot | None:
        return self._history.get(version)

    def set_current(self, snap: OntologySnapshot) -> None:
        self._snap = snap


def _strict_nut_rule(data: dict[str, Any]) -> None:
    data["rules"]["bolt_nut"]["spec"]["match"] = ["pitch", "strengthGrade"]


def _count(w: Any) -> tuple[int, int, int]:
    revisions = len(w.pdm.db["revisions"])
    requests = len(w.changes.list_requests(system_session(), status=None, product_code=None, q=None))
    return revisions, requests, len(w.changes.list_ontology_impacts())


def test_compute_flags_brk_m8_parts_and_joint_without_creating_revisions_or_requests() -> None:
    old = base_snapshot()
    reader = VersionedReader(changed(old, mutate=_strict_nut_rule), {OLD: old})
    w = make_world("base", reader=reader)
    revisions, requests, reports = _count(w)

    view = w.service.compute_ontology_impact(OLD, None)
    OntologyImpactView.model_validate(view.model_dump())
    assert (view.from_version, view.to_version) == (OLD, NEW) and view.rules_changed == ["bolt_nut:changed"]
    assert {BOLT, NUT} <= set(view.parts_flagged) and WASHER not in view.parts_flagged           # BRK-M8 BOM 에 쓰인 부품만
    assert FLANGE_BOLT not in view.parts_flagged and NUT_FINE not in view.parts_flagged           # BOM 에 없는 부품은 후보가 아니다
    joint_items = [i for i in view.items if i.kind == "joint"]
    assert [(i.subject, i.ref, i.reason_code) for i in joint_items] == [("BRK-M8:상·하판 체결", "bolt-nut", oi.REASON_JOINT_VERDICT)]

    # F-CHG-10: 보고만 하나 늘었고 개정 · 변경 요청은 그대로다
    assert _count(w) == (revisions, requests, reports + 1)


def test_compute_is_idempotent_for_the_same_inputs() -> None:
    old = base_snapshot()
    w = make_world("base", reader=VersionedReader(changed(old, mutate=_strict_nut_rule), {OLD: old}))
    a = w.service.compute_ontology_impact(OLD, NEW)
    b = w.service.compute_ontology_impact(OLD, NEW)
    assert a == b


def test_stored_report_is_served_by_the_get_route_with_items() -> None:
    old = base_snapshot()
    w = make_world("base", reader=VersionedReader(changed(old, mutate=_strict_nut_rule), {OLD: old}))
    assert w.client.get(url("/changes/ontology-impact"), headers=LEE).status_code == 404         # 계산 전에는 보고가 없다
    w.service.compute_ontology_impact(OLD, NEW)
    r = w.client.get(url("/changes/ontology-impact"), headers=LEE)
    assert r.status_code == 200
    body = OntologyImpactView.model_validate(r.json())
    assert body.rules_changed == ["bolt_nut:changed"] and any(i.kind == "joint" for i in body.items)
    assert w.client.get(url("/changes/ontology-impact?from=0.18.0"), headers=LEE).status_code == 404


def test_old_version_missing_in_opms_is_404_and_a_seen_snapshot_stands_in() -> None:
    old = base_snapshot()
    reader = VersionedReader(old, history=None)                       # 지금 OPMS 는 옛 버전을 읽어 주지 않는다
    w = make_world("base", reader=reader)
    with pytest.raises(ApiException) as e:
        w.service.compute_ontology_impact(None, None)                  # 비교할 이전 버전도 본 적이 없다
    assert (e.value.status, e.value.code) == (404, "ONTOLOGY_VERSION_NOT_FOUND")
    with pytest.raises(ApiException) as e2:
        w.service.compute_ontology_impact("0.17.0", None)
    assert (e2.value.status, e2.value.code) == (404, "ONTOLOGY_VERSION_NOT_FOUND")

    assert w.service.observe_ontology() == OLD                         # 0.19.0 을 보아 둔다
    reader.set_current(changed(old, mutate=_strict_nut_rule))          # OPMS 가 0.20.0 으로 올라갔다(0.19.0 은 읽을 수 없다)
    view = w.service.compute_ontology_impact(None, None)               # 본 것 중 가장 새로운 다른 버전과 비교
    assert (view.from_version, view.to_version) == (OLD, NEW) and view.rules_changed == ["bolt_nut:changed"]


def test_same_version_is_422() -> None:
    old = base_snapshot()
    w = make_world("base", reader=VersionedReader(old, {OLD: old}))
    with pytest.raises(ApiException) as e:
        w.service.compute_ontology_impact(OLD, OLD)
    assert (e.value.status, e.value.code) == (422, "ONTOLOGY_VERSIONS_EQUAL")


def test_opms_not_configured_and_unreachable_are_503() -> None:
    w = make_world("base", reader=UnconfiguredOpmsReader())
    with pytest.raises(ApiException) as e:
        w.service.compute_ontology_impact(OLD, NEW)
    assert (e.value.status, e.value.code) == (503, "OPMS_NOT_CONFIGURED")
    assert w.client.get(url("/changes/ontology-impact"), headers=LEE).json()["error"]["code"] == "OPMS_NOT_CONFIGURED"

    d = make_world("base", reader=DownReader())
    with pytest.raises(ApiException) as e2:
        d.service.compute_ontology_impact(OLD, NEW)
    assert (e2.value.status, e2.value.code) == (503, "OPMS_UNAVAILABLE")


def test_ontology_impact_module_has_no_write_path_to_stores() -> None:
    """읽기 보고 모듈은 PDM · 변경 저장소에 쓰는 이름을 아예 쓰지 않는다(정적 확인)."""
    import inspect

    src = inspect.getsource(oi).split('"""', 2)[2]                 # 모듈 설명(문장)은 빼고 코드만 본다
    for forbidden in ("create_request", "create_order", "add_target", "ChangeOrder", "ChangeRequest", "ItemRevision", "put_revision", "InMemoryPdmStore"):
        assert forbidden not in src, forbidden
