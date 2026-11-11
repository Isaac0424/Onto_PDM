"""변경 라우트(TestClient): 웹(`web/src/api/changesApi.ts`)이 기대하는 모양 · 오류 본문 · 가시성 · 계약 왕복."""

from __future__ import annotations

from onto_pdm.contracts import ChangeDetail, ChangePage, ChangeScopeView, ImpactGraphView, ImpactRunView
from onto_pdm.opms import UnconfiguredOpmsReader
from tests.unit.changes_api_helpers import CHOI, KIM, LEE, SC1, SC2, findings, make_world, run_impact, url


def test_list_is_a_page_and_size_one_probe_works() -> None:
    w = make_world("sc2")
    body = w.client.get(url("/changes"), params={"size": 1}, headers=LEE).json()
    assert set(body) == {"items", "total", "page", "size"} and body["size"] == 1                 # 존재 확인용 GET /changes?size=1
    item = body["items"][0]
    assert item["code"] == SC2 and item["order_code"] == "CO-2026-0002" and item["order_status"] == "draft"
    assert "run_summary" not in item                                                               # 분석 전에는 요약이 빠진다(null 아님)
    ChangePage.model_validate(body)
    run_impact(w, SC2)
    summary = w.client.get(url("/changes"), headers=LEE).json()["items"][0]["run_summary"]
    assert set(summary) == {"blocked", "affected", "review", "none", "stale", "partial"} and summary["blocked"] == 1


def test_list_filters_and_empty_store_without_fixture() -> None:
    w = make_world("sc2")
    assert w.client.get(url("/changes"), params={"status": "rejected"}, headers=LEE).json()["total"] == 0
    assert w.client.get(url("/changes"), params={"q": "상판"}, headers=LEE).json()["total"] == 1
    assert w.client.get(url("/changes"), params={"product": "BRK-M8"}, headers=LEE).json()["total"] == 1
    empty = make_world(None)
    assert empty.client.get(url("/changes"), headers=LEE).json() == {"items": [], "total": 0, "page": 1, "size": 50}


def test_unknown_change_is_the_error_shape() -> None:
    w = make_world("sc2")
    r = w.client.get(url("/changes/CR-2026-9999"), headers=LEE)
    assert r.status_code == 404 and r.json()["error"]["code"] == "CHANGE_NOT_FOUND" and set(r.json()["error"]) >= {"code", "message"}
    assert w.client.get(url("/changes/CO-2026-0002"), headers=LEE).json()["code"] == SC2          # 지시 코드로도 읽는다
    bad = w.client.get(url("/changes"), params={"size": 0}, headers=LEE)
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_REQUEST"


def test_impact_before_it_is_computed_is_404_and_the_detail_has_no_latest_run() -> None:
    w = make_world("sc2")
    r = w.client.get(url(f"/changes/{SC2}/impact"), headers=LEE)
    assert r.status_code == 404 and r.json()["error"]["code"] == "IMPACT_NOT_COMPUTED"
    assert w.client.get(url(f"/changes/{SC2}/impact/graph"), headers=LEE).json()["error"]["code"] == "IMPACT_NOT_COMPUTED"
    detail = w.client.get(url(f"/changes/{SC2}"), headers=LEE).json()
    assert "latest_run" not in detail and len(detail["targets"]) == 1 and detail["order"]["status"] == "draft"
    ChangeDetail.model_validate(detail)


def test_impact_view_snapshot_fields_and_roundtrip() -> None:
    w = make_world("sc2")
    run = run_impact(w, SC2)
    ImpactRunView.model_validate(run)                                         # 계약 왕복
    assert run["partial"] is False and run["temporary"] is True and run["ontology_version"] == "0.19.0"
    assert run["summary"] == {"blocked": 1, "affected": 1, "review": 1, "none": 4, "stale": False, "partial": False}
    grip = findings(run, kind="fit_grip")[0]
    assert grip["severity"] == "blocked" and grip["verdict"] == "no" and grip["reason_code"] == "shortfall"
    assert (grip["required"], grip["actual"], grip["gap"]) == (32.5, 30.0, 2.5) and grip["temporary"] is True
    assert grip["basis"]["ontology_version"] == "0.19.0" and grip["basis"]["as_of"]               # 판단 시점 스냅샷
    assert run["external_as_of"].keys() == {"work_order", "purchase_order_line", "stock_lot"}
    assert w.client.get(url(f"/changes/{SC2}/impact"), headers=LEE).json()["id"] == run["id"]
    assert w.client.get(url(f"/changes/{SC2}/impact"), params={"run_id": run["id"]}, headers=LEE).status_code == 200
    again = run_impact(w, SC2)                                                  # 같은 입력 → 같은 해시, 분석은 쌓인다
    assert again["input_hash"] == run["input_hash"] and again["id"] != run["id"]


def test_graph_has_change_target_usage_and_affected_objects() -> None:
    w = make_world("sc2")
    run_impact(w, SC2)
    g = w.client.get(url(f"/changes/{SC2}/impact/graph"), headers=LEE).json()
    ImpactGraphView.model_validate(g)
    kinds = {n["id"]: n["kind"] for n in g["nodes"]}
    assert kinds[f"change:CO-2026-0002"] == "change" and kinds["item:BRK-M8-P01"] == "item"
    assert kinds["work_order:WO-FX-0003"] == "work_order"
    sev = {n["id"]: n.get("severity") for n in g["nodes"]}
    assert sev["work_order:WO-FX-0003"] == "affected" and any(v == "blocked" for v in sev.values())
    assert {"source": "change:CO-2026-0002", "target": "item:BRK-M8-P01", "kind": "changes"} in g["edges"]


def test_target_and_scope_endpoints() -> None:
    w = make_world("sc2")
    t = w.client.post(url(f"/changes/{SC2}/targets"), headers=LEE, json={"change_kind": "attribute_edit", "item_no": "BRK-M8-P02", "after": {"thickness": 10}})
    assert t.status_code == 201 and t.json()["scopes"] == []
    tid = t.json()["id"]
    sc = w.client.put(url(f"/changes/{SC2}/targets/{tid}/scope"), headers=LEE, json={"scopes": [{"site": "S1", "lot_nos": ["LOT-1"]}]})
    assert sc.status_code == 200 and [ChangeScopeView.model_validate(x).site for x in sc.json()] == ["S1"]
    assert w.client.delete(url(f"/changes/{SC2}/targets/{tid}"), headers=LEE).status_code == 204
    assert w.client.delete(url(f"/changes/{SC2}/targets/{tid}"), headers=LEE).json()["error"]["code"] == "CHANGE_NOT_FOUND"
    bad = w.client.post(url(f"/changes/{SC2}/targets"), headers=LEE, json={"change_kind": "ontology", "item_no": "BRK-M8-P02"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_REQUEST"                 # 온톨로지는 변경 대상이 아니다(F-CHG-10)


def test_viewer_cannot_write_but_can_read() -> None:
    w = make_world("sc2")
    as_viewer = w.pdm.db["users"]
    as_viewer.append({"id": 9, "login_id": "park", "name": "박조회", "role": "viewer"})
    park = {"X-PDM-User": "park", "X-PDM-Admin-Mode": "1"}
    assert w.client.get(url("/changes"), headers=park).status_code == 200
    r = w.client.post(url("/changes"), headers=park, json={"title": "x", "reason": "y"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "FORBIDDEN"
    assert w.client.post(url(f"/changes/{SC2}/impact"), headers=park).status_code == 403


def test_new_changes_are_drafts_visible_to_the_author_and_admin_mode_only() -> None:
    w = make_world(None)
    r = w.client.post(url("/changes"), headers=LEE, json={"title": "새 요청", "reason": "이유", "before_summary": "이전", "after_summary": "이후"})
    assert r.status_code == 201
    code = r.json()["code"]
    assert code == "CR-2026-0001" and r.json()["status"] == "draft" and r.json()["order"]["status"] == "draft"
    assert w.client.get(url("/changes"), headers=CHOI).json()["total"] == 0                       # 승인자도 관리자 모드가 아니면 못 본다
    assert w.client.get(url(f"/changes/{code}"), headers=CHOI).status_code == 404
    assert w.client.get(url("/changes"), headers=KIM).json()["total"] == 1
    assert w.client.post(url("/changes"), headers=LEE, json={"title": "x"}).status_code == 422       # reason 이 빠졌다


def test_ontology_impact_is_a_read_only_report() -> None:
    w = make_world("sc2")
    r = w.client.get(url("/changes/ontology-impact"), params={"from": "0.18.0", "to": "0.19.0"}, headers=LEE)
    assert r.status_code == 404 and r.json()["error"]["code"] == "ONTOLOGY_IMPACT_NOT_FOUND"       # 보고가 없다(개정 · 지시를 만들지 않는다)
    assert [x for x in w.changes.list_ontology_impacts()] == [] and w.changes.get_order("CO-2026-0002").status == "draft"
    down = make_world("sc2", reader=UnconfiguredOpmsReader())
    r = down.client.get(url("/changes/ontology-impact"), headers=LEE)
    assert r.status_code == 503 and r.json()["error"]["code"] == "OPMS_NOT_CONFIGURED"


def test_export_needs_an_approved_change() -> None:
    w = make_world("sc2")
    r = w.client.get(url(f"/changes/{SC2}/export"), headers=LEE)
    assert r.status_code == 409 and r.json()["error"]["code"] == "CHANGE_NOT_APPROVED"
    assert SC1 not in [c["code"] for c in w.client.get(url("/changes"), headers=LEE).json()["items"]]
