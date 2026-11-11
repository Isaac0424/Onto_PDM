"""수락 시험(design 9.2): SC-1 너트 교체 · SC-2 상판 두께 + 부분 범위 · SC-3 개정 vs 교체 · OPMS 미연결 · stale · 계약 왕복.

요청 → 영향 분석 → 처분 → 검토 → 승인(새 개정)까지 **HTTP 로** 확인한다. 수치(그립 28.5 / 32.5, 피치 1.25 ≠ 1.0, 부족 2.5)는 문서와 같다.
OPMS 값은 개발 DB 와 같은 모양의 읽기 대역(`StubReader`)이고, 모든 외부 행은 `source_system='fixture'` 다.
"""

from __future__ import annotations

from onto_pdm.changes.fixtures import BOLT, FLANGE_BOLT, ITEM_MODULE, ITEM_SET, ITEM_TOP, NUT, NUT_FINE
from onto_pdm.contracts import ChangeDetail, ChangeExport, ImpactRunView
from onto_pdm.opms import UnconfiguredOpmsReader
from tests.unit.changes_helpers import StubReader
from tests.unit.changes_api_helpers import (
    CHOI,
    LEE,
    SC1,
    SC2,
    decide_all_affected,
    findings,
    make_world,
    revisions,
    run_impact,
    url,
)

REVIEWS = ((LEE, "design"), (CHOI, "purchasing"), (CHOI, "production"))


def _review_all(w, code: str) -> None:        # type: ignore[no-untyped-def]
    for who, fn in REVIEWS:
        assert w.client.post(url(f"/changes/{code}/reviews"), headers=who, json={"function": fn, "verdict": "approve"}).status_code == 201


# ------------------------------------------------------------------ SC-1: 너트 P-…22 → P-…23(피치 1.0): 짝이 맞지 않는다


def test_sc1_pair_mismatch_blocks_approval_and_changes_nothing() -> None:
    w = make_world("sc1")
    run = run_impact(w, SC1)
    ImpactRunView.model_validate(run)
    assert run["summary"] == {"blocked": 1, "affected": 5, "review": 0, "none": 6, "stale": False, "partial": False}

    pair = next(f for f in findings(run, kind="fit_pair") if f["reason_code"] == "pair_mismatch")
    assert pair["severity"] == "blocked" and pair["verdict"] == "no" and pair["temporary"] is True
    assert pair["basis"]["rule_id"] == "bolt_nut" and pair["basis"]["ontology_version"] == "0.19.0"
    assert pair["inputs"]                                                                   # 판단에 쓴 값이 남는다(F-CHG-11)
    grip = findings(run, kind="fit_grip")[0]                                                 # 새 너트 높이 6.8 → 그립은 통과
    assert (grip["verdict"], grip["severity"], grip["required"], grip["actual"]) == ("ok", "none", 28.5, 30.0)
    assert not findings(run, kind="strength_grade")                                          # A2-70 = A2-70 → 따로 볼 것이 없다
    assert {f["kind"] for f in findings(run, severity="none")} >= {"bom_usage", "product", "work_order"}
    # 영향 ≠ 변경: 구 너트의 발주(미입고 120)와 재고 로트 둘이 처분 대상으로 나온다
    assert {f["subject_ref"] for f in findings(run, severity="affected")} == {"PO-FX-100/10", "LT-N-01", "LT-N-02", "WO-FX-0002", "WO-FX-0003"}

    # 승인 시도: blocked 가 남아 있으면 거부(처분을 다 정해도 풀리지 않는다)
    assert w.client.post(url(f"/changes/{SC1}/submit"), headers=LEE).status_code == 200
    r = w.client.post(url(f"/changes/{SC1}/approve"), headers=CHOI)
    assert r.status_code == 409 and r.json()["error"]["code"] == "BLOCKED_FINDINGS"
    assert r.json()["error"]["details"]["finding_ids"] == [pair["id"]]
    risk = w.client.put(url(f"/changes/{SC1}/dispositions/{pair['id']}"), headers=LEE, json={"action": "accept_risk", "reason": "그냥 쓴다"})
    assert risk.status_code == 422 and risk.json()["error"]["code"] == "DISPOSITION_INVALID"
    assert revisions(w, NUT) == [("R00", "released")] and revisions(w, ITEM_SET) == [("R00", "released")]    # 아무 개정도 만들어지지 않았다


# ------------------------------------------------------------------ SC-2: 상판 8 → 12 mm: 그립 부족 → 후보를 대상에 더하고 다시 분석 → 승인


def test_sc2_grip_shortfall_then_candidate_then_partial_scope_approval() -> None:
    w = make_world("sc2")
    first = run_impact(w, SC2)
    grip = findings(first, kind="fit_grip")[0]
    assert (grip["severity"], grip["verdict"], grip["reason_code"]) == ("blocked", "no", "shortfall")
    assert (grip["required"], grip["actual"], grip["gap"]) == (32.5, 30.0, 2.5)                    # 필요 32.5 mm · 볼트 30 mm · 2.5 mm 부족
    wo = {f["subject_ref"]: f for f in findings(first, kind="work_order") if f["severity"] != "none"}
    assert wo["WO-FX-0003"]["scope_class"] == "inside" and "WO-FX-0002" not in wo                    # 범위(2026-12-01 이후 · #71~)를 보고 거른다

    # 후보(플랜지볼트 M8×40)를 같은 지시의 대상으로 더한다 → 입력이 바뀌었으니 이전 분석은 낡았다
    t = w.client.post(url(f"/changes/{SC2}/targets"), headers=LEE, json={
        "change_kind": "replace", "item_no": BOLT, "replacement_item_no": FLANGE_BOLT, "parent_revision": "R00", "note": "플랜지볼트로 교체"}).json()
    w.client.put(url(f"/changes/{SC2}/targets/{t['id']}/scope"), headers=LEE, json={"scopes": [
        {"site": "S1", "serial_from": 71, "effective_from": "2026-12-01"}, {"site": "S2", "serial_from": 71, "effective_from": "2026-12-01"}]})
    assert w.client.get(url(f"/changes/{SC2}"), headers=LEE).json()["latest_run"]["stale_reasons"] == ["input_changed"]
    assert w.client.post(url(f"/changes/{SC2}/submit"), headers=LEE).json()["error"]["code"] == "IMPACT_STALE"

    second = run_impact(w, SC2)
    assert second["summary"]["blocked"] == 0 and second["id"] != first["id"]
    sub = findings(second, kind="substitute")[0]                                                     # 분류가 달라 대체 규칙을 거친다 → 사람이 확인
    assert (sub["severity"], sub["reason_code"]) == ("review", "substitute_conditional")
    grip2 = findings(second, kind="fit_grip")[0]
    assert grip2["verdict"] == "ok" and grip2["actual"] == 40.0 and grip2["required"] == 32.5          # 길이 40 mm ≥ 32.5 mm

    # 처분 없이는 승인할 수 없다 → 처분 → 검토 없이는 승인할 수 없다 → 승인
    assert w.client.post(url(f"/changes/{SC2}/submit"), headers=LEE).status_code == 200
    r = w.client.post(url(f"/changes/{SC2}/approve"), headers=CHOI)
    assert r.status_code == 409 and r.json()["error"]["code"] == "DISPOSITION_REQUIRED"
    assert r.json()["error"]["details"]["finding_ids"] == [f["id"] for f in findings(second, severity="affected")]
    decide_all_affected(w, SC2, second)
    r = w.client.post(url(f"/changes/{SC2}/approve"), headers=CHOI)
    assert r.status_code == 409 and r.json()["error"]["code"] == "REVIEW_REQUIRED"
    assert r.json()["error"]["details"]["functions"] == ["design", "production"]                     # 발주 영향은 review 라 구매 검토는 필요 없다
    for who, fn in ((LEE, "design"), (CHOI, "production")):
        w.client.post(url(f"/changes/{SC2}/reviews"), headers=who, json={"function": fn, "verdict": "approve"})
    done = w.client.post(url(f"/changes/{SC2}/approve"), headers=CHOI)
    assert done.status_code == 200
    detail = ChangeDetail.model_validate(done.json())
    assert detail.order is not None and detail.order.status == "implemented" and detail.order.approved_by == "choi"
    assert detail.order.approved_run_id == second["id"]                                              # 승인 때 본 분석이 남는다

    # 부분 범위라 이전 개정은 폐기되지 않고, 새 개정이 함께 released
    for item in (ITEM_TOP, ITEM_SET, ITEM_MODULE):
        assert revisions(w, item) == [("R01", "released"), ("R00", "released")], item
    exported = w.client.get(url(f"/changes/{SC2}/export"), headers=LEE).json()
    ChangeExport.model_validate(exported)
    assert exported["approved_by"] == "choi" and exported["ontology_version"] == "0.19.0" and exported["temporary"] is True
    assert {d["action"] for d in exported["dispositions"]} >= {"apply_new"} and len(exported["findings"]) == len(second["findings"])


# ------------------------------------------------------------------ SC-3: 같은 품번 안의 개정 vs 규격이 바뀌는 교체


def test_sc3_revision_versus_replacement() -> None:
    w = make_world("base")
    code = w.client.post(url("/changes"), headers=LEE, json={"title": "볼트 변경", "reason": "검토"}).json()["code"]
    add = lambda body: w.client.post(url(f"/changes/{code}/targets"), headers=LEE, json=body)           # noqa: E731
    for before, after in (({"length": 30}, {"length": 35}), ({"material": "SUS304"}, {"material": "SUS316"}),
                          ({"strengthGrade": "A2-70"}, {"strengthGrade": "A4-80"}), ({"threadSize": "M8"}, {"threadSize": "M10"})):
        r = add({"change_kind": "revise", "item_no": BOLT, "before": before, "after": after})
        assert r.status_code == 422 and r.json()["error"]["code"] == "REVISION_CHANGES_IDENTITY", (before, after)
        assert list(after)[0] in r.json()["error"]["details"]["changed"]
    ok = add({"change_kind": "revise", "item_no": BOLT, "before": {}, "after": {"inspection": "A-2"}})      # 규격이 아닌 값(검사 조건 등)은 개정
    assert ok.status_code == 201 and ok.json()["to_revision"] == "R01"
    assert w.client.get(url(f"/changes/{code}"), headers=LEE).json()["targets"][0]["change_kind"] == "revise"
    swap = add({"change_kind": "replace", "item_no": NUT, "replacement_item_no": NUT})                    # 같은 품번으로의 교체는 교체가 아니다
    assert swap.status_code == 422


# ------------------------------------------------------------------ OPMS 미연결 · 온톨로지 변경 · stale


def test_without_opms_the_analysis_is_partial_unknown_and_cannot_be_approved() -> None:
    w = make_world("sc2", reader=UnconfiguredOpmsReader())
    run = run_impact(w, SC2)
    assert run["partial"] is True and run["ontology_version"] == "unknown" and run["warnings"]
    fit = findings(run, kind="fit_pair")
    assert fit and all(f["reason_code"] == "OPMS_UNAVAILABLE" and f["verdict"] == "unknown" and f["severity"] == "review" for f in fit)
    assert not findings(run, kind="fit_grip")                                                          # '문제 없음'으로 읽히는 판정을 만들지 않는다
    assert findings(run, kind="work_order")                                                            # OPMS 와 무관한 영향(작업지시 · 사용처)은 그대로 나온다
    assert w.client.get(url("/changes"), headers=LEE).json()["items"][0]["run_summary"]["partial"] is True
    decide_all_affected(w, SC2, run)
    assert w.client.post(url(f"/changes/{SC2}/submit"), headers=LEE).status_code == 200
    _review_all(w, SC2)
    r = w.client.post(url(f"/changes/{SC2}/approve"), headers=CHOI)
    assert r.status_code == 409 and r.json()["error"]["code"] == "IMPACT_PARTIAL"
    assert revisions(w, ITEM_TOP) == [("R00", "released")]


def test_new_ontology_version_makes_the_analysis_stale_and_it_is_not_a_part_revision() -> None:
    w = make_world("sc2")
    run_impact(w, SC2)
    w.service._opms = StubReader("0.20.0")                                                            # OPMS 가 새 온톨로지 버전을 적용했다
    run = w.client.get(url(f"/changes/{SC2}"), headers=LEE).json()["latest_run"]
    assert run["stale"] is True and "ontology_changed" in run["stale_reasons"]
    assert w.client.post(url(f"/changes/{SC2}/submit"), headers=LEE).json()["error"]["code"] == "IMPACT_STALE"
    assert run_impact(w, SC2)["ontology_version"] == "0.20.0"                                          # 다시 계산하면 새 버전을 근거로 남긴다
    # 온톨로지 버전이 바뀌어도 부품 개정은 생기지 않는다(F-CHG-10)
    assert revisions(w, ITEM_TOP) == [("R00", "released")] and revisions(w, BOLT) == [("R00", "released")]


def test_a_part_missing_from_opms_is_unknown_never_ok() -> None:
    """OPMS 에 없는 품번(교체 후보 `P-…23` 이 읽기 대역에서 빠진 경우)은 '맞음'이 아니라 **모르는 것**으로 두고 사람에게 넘긴다."""
    reader = StubReader()
    reader._parts.pop(NUT_FINE)
    w = make_world("sc1", reader=reader)
    run = run_impact(w, SC1)
    assert run["partial"] is False and run["summary"]["blocked"] == 0                                  # OPMS 는 읽혔고, 그 품번만 없다
    unknown = [f for f in run["findings"] if f["kind"] in ("fit_pair", "fit_grip", "strength_grade") and f["verdict"] == "unknown"]
    assert {f["reason_code"] for f in unknown} == {"pair_unknown", "value_missing"}
    assert all(f["severity"] == "review" for f in unknown) and len(unknown) == 4
    assert not [f for f in findings(run, kind="fit_pair") if f["verdict"] == "ok" and NUT_FINE in f["subject_ref"]]
