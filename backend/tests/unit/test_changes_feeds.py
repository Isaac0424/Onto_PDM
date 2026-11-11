"""외부(ERP · MES) 읽기 사본 입구: 토큰 · 행별 결과 · 늦은 as_of 무시 · stale 표시 · 픽스처 환경변수(앱 목 금지)."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from onto_pdm.api.app import create_app
from onto_pdm.changes.fixtures import BOLT, FIXTURE_AS_OF, ITEM_MODULE, NUT
from tests.unit.changes_api_helpers import LEE, SC2, TOKEN, make_world, run_impact, url

HDR = {"X-PDM-Feed-Token": TOKEN}
NEWER = "2026-11-13T09:00:00+09:00"
OLDER = "2026-11-11T09:00:00+09:00"


def _lot(lot_no: str = "LT-N-09", item_no: str = NUT, as_of: str = NEWER, **over: Any) -> dict[str, Any]:
    return {"lot_no": lot_no, "item_no": item_no, "qty_on_hand": 25, "site": "S1", "as_of": as_of, **over}


def test_feed_is_closed_without_a_configured_token() -> None:
    w = make_world("base", token=None)
    r = w.client.post(url("/feeds/stock-lots"), headers=HDR, json={"source_system": "ERP", "rows": [_lot()]})
    assert r.status_code == 403 and r.json()["error"]["code"] == "FEED_NOT_CONFIGURED"


def test_feed_requires_the_right_token() -> None:
    w = make_world("base")
    body = {"source_system": "ERP", "rows": [_lot()]}
    assert w.client.post(url("/feeds/stock-lots"), json=body).json()["error"]["code"] == "FORBIDDEN"
    assert w.client.post(url("/feeds/stock-lots"), headers={"X-PDM-Feed-Token": "nope"}, json=body).status_code == 403
    assert w.client.post(url("/feeds/stock-lots"), headers=HDR, json=body).status_code == 200


def test_stock_lot_feed_applies_ignores_old_and_rejects_bad_rows() -> None:
    w = make_world("base")
    rows = [
        _lot("LT-N-01", as_of=OLDER, qty_on_hand=999),                       # 이미 더 새 값이 있다 → 무시
        _lot("LT-N-09"),                                                     # 새 행
        _lot("LT-X", item_no="NOPE"),                                        # 모르는 품번
        _lot("LT-BAD", as_of="어제"),                                        # 시각 형식 오류(계약은 문자열이라 행에서 걸린다)
        _lot("LT-NAIVE", as_of="2026-11-13T09:00:00"),                       # 시간대 없는 시각은 받지 않는다
    ]
    r = w.client.post(url("/feeds/stock-lots"), headers=HDR, json={"source_system": "ERP", "rows": rows})
    assert r.status_code == 200
    assert r.json() == {"applied": 1, "ignored_stale": 1, "rejected": [
        {"row": 2, "code": "ITEM_NOT_FOUND"}, {"row": 3, "code": "INVALID_ROW"}, {"row": 4, "code": "INVALID_ROW"}]}
    assert next(x for x in w.changes.list_stock_lots(item_no=NUT) if x.lot_no == "LT-N-01").qty_on_hand == 300     # 늦은 값이 덮지 못했다
    assert {x.lot_no for x in w.changes.list_stock_lots(item_no=NUT)} >= {"LT-N-01", "LT-N-09"}
    assert w.changes.get_work_order("WO-FX-0001") is not None                                                  # 다른 표는 그대로


def test_work_order_and_purchase_order_feeds() -> None:
    w = make_world("base")
    wo = {"wo_no": "WO-NEW-1", "site": "S1", "product_item_no": ITEM_MODULE, "bom_revision": "R00", "status": "planned", "qty_planned": 10,
          "lot_no": "LOT-NEW", "serial_from": 121, "serial_to": 130, "start_date": "2026-12-20", "as_of": NEWER,
          "bom_refs": [{"item_no": NUT, "rev": "R00", "qty_required": 40}]}
    r = w.client.post(url("/feeds/work-orders"), headers=HDR, json={"source_system": "MES", "rows": [wo, {**wo, "wo_no": "WO-BAD", "status": "weird"}]})
    # 상태 열거가 계약에 있어 한 행이라도 틀리면 요청 전체가 422 이다(계약 검증은 행 단위가 아니다)
    assert r.status_code == 422 and r.json()["error"]["code"] == "INVALID_REQUEST"
    ok = w.client.post(url("/feeds/work-orders"), headers=HDR, json={"source_system": "MES", "rows": [wo]})
    assert ok.json() == {"applied": 1, "ignored_stale": 0, "rejected": []}
    got = w.changes.get_work_order("WO-NEW-1")
    assert got is not None and got.source_system == "MES" and got.bom_refs[0].item_no == NUT and got.serial_to == 130
    po = {"po_no": "PO-NEW", "line_no": 1, "item_no": BOLT, "qty_ordered": 50, "qty_received": 10, "due_date": "2026-12-30", "as_of": NEWER}
    r = w.client.post(url("/feeds/purchase-order-lines"), headers=HDR, json={"source_system": "ERP", "rows": [po]})
    assert r.json()["applied"] == 1 and w.changes.list_purchase_order_lines(item_no=BOLT, only_open=True)[-1].qty_open == 40


def test_feed_marks_the_open_analysis_stale() -> None:
    w = make_world("sc2")
    run_impact(w, SC2)
    assert w.client.get(url(f"/changes/{SC2}"), headers=LEE).json()["latest_run"]["stale"] is False
    w.client.post(url("/feeds/stock-lots"), headers=HDR, json={"source_system": "ERP", "rows": [_lot(as_of=NEWER)]})
    run = w.client.get(url(f"/changes/{SC2}"), headers=LEE).json()["latest_run"]
    assert run["stale"] is True and "external_feed_newer" in run["stale_reasons"]
    assert w.client.post(url(f"/changes/{SC2}/submit"), headers=LEE).json()["error"]["code"] == "IMPACT_STALE"
    assert run_impact(w, SC2)["stale"] is False                                        # 다시 계산하면 새 기준 시각으로 풀린다


# ------------------------------------------------------------------ 픽스처는 환경변수가 있을 때만 (앱 목 금지)


def test_no_fixture_data_without_the_environment_variable() -> None:
    client = TestClient(create_app(env={}))
    assert client.get(url("/changes")).json()["total"] == 0
    assert all(p["code"] != "BRK-M8" for p in client.get(url("/products")).json())


def test_fixture_loads_into_an_empty_seed_store_only_when_enabled() -> None:
    client = TestClient(create_app(env={"PDM_FIXTURE": "brk-m8:sc2"}))
    assert [p["code"] for p in client.get(url("/products")).json()] == ["BRK-M8"]            # 기본 시드(다른 품번들)와 섞이지 않는다
    page = client.get(url("/changes")).json()
    assert [c["code"] for c in page["items"]] == [SC2]
    assert FIXTURE_AS_OF.year == 2026
