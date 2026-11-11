"""HTTP 라우트 (TestClient). 오류 본문, 사용자 헤더, 쪽 나누기, 등록 요청 흐름."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from onto_pdm.api.app import PREFIX, create_app
from onto_pdm.store import InMemoryPdmStore

KIM_ON = {"X-PDM-User": "kim", "X-PDM-Admin-Mode": "1"}
LEE = {"X-PDM-User": "lee"}


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(InMemoryPdmStore()))


def url(path: str) -> str:
    return f"{PREFIX}{path}"


def test_health_has_contract_version(client: TestClient) -> None:
    assert client.get(url("/health")).json() == {"status": "ok", "contract_version": "1"}
    assert client.get("/api/health").json()["status"] == "ok"


def test_items_page_shape_and_filters(client: TestClient) -> None:
    body = client.get(url("/items"), params={"size": 5}, headers=KIM_ON).json()
    assert set(body) == {"items", "total", "page", "size"} and body["size"] == 5 and len(body["items"]) == 5
    assert body["total"] >= 20
    assert all("item_no" in it and "itemNo" not in it for it in body["items"])           # snake_case
    assembly = next(it for it in client.get(url("/items"), params={"item_type": "assembly", "size": 50}, headers=KIM_ON).json()["items"]
                    if it["item_no"] == "P-00000000100")
    assert "latest_revision" in assembly and "material_iri" not in assembly                   # 값이 없는 필드는 빠진다 (null 아님)

    found = client.get(url("/items"), params={"q": "BLT-0038"}, headers=KIM_ON).json()
    assert [it["item_no"] for it in found["items"]] == ["P-00000000001"]
    assert client.get(url("/items"), params={"item_type": "assembly"}, headers=KIM_ON).json()["total"] > 0
    page2 = client.get(url("/items"), params={"size": 5, "page": 2}, headers=KIM_ON).json()
    assert page2["items"][0]["item_no"] != body["items"][0]["item_no"]


def test_invalid_query_is_the_opms_error_shape(client: TestClient) -> None:
    r = client.get(url("/items"), params={"item_type": "nope"})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "INVALID_REQUEST" and err["details"]["errors"]
    assert client.get(url("/items"), params={"size": 9999}).status_code == 422


def test_visibility_follows_headers(client: TestClient) -> None:
    assert client.get(url("/items/P-00000000150"), headers=LEE).status_code == 200      # 이설계 본인의 작업중 품목
    kim_off = client.get(url("/items/P-00000000150"), headers={"X-PDM-User": "kim"})
    assert kim_off.status_code == 404
    assert kim_off.json() == {"error": {"code": "ITEM_NOT_FOUND", "message": "품목 P-00000000150을(를) 찾을 수 없습니다", "details": None}}
    assert client.get(url("/items/P-00000000150"), headers=KIM_ON).status_code == 200
    assert client.get(url("/items/P-00000000001"), headers={"X-PDM-User": "ghost"}).json()["error"]["code"] == "UNKNOWN_USER"


def test_product_bom_and_documents(client: TestClient) -> None:
    bom = client.get(url("/products/HCR3A/bom"), params={"rule": "released"}, headers=KIM_ON).json()
    assert bom["product"]["code"] == "HCR3A" and bom["revision"]["rev"] == "R01" and bom["rule"] == "released"
    assert bom["nodes"][0]["children"] or bom["nodes"]
    latest = client.get(url("/products/HCR3A/bom"), params={"rule": "latest"}, headers=KIM_ON).json()
    assert latest["revision"]["status"] == "wip"
    assert client.get(url("/products/NOPE/bom")).json()["error"]["code"] == "PRODUCT_NOT_FOUND"
    assert client.get(url("/products/HCR3A/bom"), params={"rule": "bad"}).status_code == 422

    docs = client.get(url("/documents"), params={"revision_id": bom["revision"]["id"]}, headers=KIM_ON).json()
    assert {d["doc_type"] for d in docs} >= {"cad_3d", "spec", "manual"}
    assert client.get(url("/documents")).status_code == 422                               # revision_id 필수


def test_cad_match_and_guides(client: TestClient) -> None:
    m = client.post(url("/cad/match"), json={"names": ["전원 버튼", "기판 나사 M3", "제어 기판"]}, headers=KIM_ON).json()
    assert [(x["status"], x.get("item_no")) for x in m] == [("matched", "P-00000000160"), ("suggested", "P-00000000001"), ("none", None)]
    assert m[0]["class_path"] == ["전기 · 전자", "스위치 · 버튼"] and "item_no" not in m[2]

    g = client.post(url("/assembly/guides"), json={"parts": [
        {"name": "상부 커버", "size": [126, 80, 3]}, {"name": "볼펜 심"}, {"name": "러그", "size": [3, 2.6, 7]}]}).json()
    assert [x["rule_id"] for x in g] == ["SP-CVR-01", "SP-WLD-01"]                         # 규칙이 없는 부품은 빠진다
    assert {"label": "필요 나사 길이", "value": "≥ 7.5 mm (두께 + 1.5 × 지름)"} in g[0]["params"]
    bad = client.post(url("/assembly/guides"), json={"parts": [{"name": "x", "extra": 1}]})
    assert bad.status_code == 422                                                         # extra='forbid'


def test_rules_endpoints(client: TestClient) -> None:
    lst = client.get(url("/rules")).json()
    assert len(lst) == 11 and lst[0]["id"] == "SP-FAS-01" and lst[0]["operation_label"] == "볼트 체결"
    detail = client.get(url("/rules/SP-WLD-01"), headers=KIM_ON).json()
    assert detail["status"] == "draft" and len(detail["table"]["rows"]) == 4
    red = client.get(url("/rules/SP-RED-01"), headers=KIM_ON).json()
    assert {u["item_no"] for u in red["used_by"]} >= {"P-00000000121", "P-00000000131"}  # 보유한 감속기 품목
    assert client.get(url("/rules/SP-NOPE")).status_code == 404
    assert client.get(url("/rules/validate")).status_code == 404                           # 규칙 검증은 삭제됨 (규칙 id 'validate' 는 없다)


def test_openapi_lists_the_routes(client: TestClient) -> None:
    paths = client.get("/openapi.json").json()["paths"]
    for p in ("/items", "/items/{item_no}", "/products/{code}/bom", "/rules", "/rules/{rule_id}", "/assembly/guides", "/cad/match",
              "/documents", "/health"):
        assert url(p) in paths, p
    # 관리 기능은 삭제했다 (사용자 지시)
    for p in ("/bom-sheet/match", "/requests", "/rules/validate"):
        assert url(p) not in paths, p
