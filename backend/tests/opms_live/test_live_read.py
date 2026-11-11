"""실제 OPMS Neo4j 를 읽는 통합 시험. **읽기만 한다**(쓰기 문장은 어댑터가 거부한다). 데이터 값에는 거의 기대하지 않는다.

실행: PDM_NEO4J_URI=bolt://127.0.0.1:7687 PDM_NEO4J_USER=neo4j PDM_NEO4J_PASSWORD=... \\
      .venv/Scripts/python -m pytest -m opms_live tests/opms_live -q
환경 변수가 없으면 건너뛴다. 사용자의 OPMS 데이터에 아무것도 쓰지 않는다.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from onto_pdm.api.app import PREFIX, create_app
from onto_pdm.opms import reader_from_env
from onto_pdm.store import InMemoryPdmStore

pytestmark = [
    pytest.mark.opms_live,
    pytest.mark.skipif(not (os.environ.get("PDM_NEO4J_URI") and os.environ.get("PDM_NEO4J_PASSWORD")), reason="PDM_NEO4J_* 환경 변수가 없다"),
]
B = f"{PREFIX}/opms"


@pytest.fixture(scope="module")
def client():  # type: ignore[no-untyped-def]
    with TestClient(create_app(InMemoryPdmStore(), reader_from_env())) as c:
        yield c


def test_status_reads_the_current_ontology(client: TestClient) -> None:
    s = client.get(f"{B}/status").json()
    assert s["state"] == "ok" and s["ontology_version"] and s["classes"] > 0 and s["parts"] >= 0


def test_classes_have_a_hierarchy(client: TestClient) -> None:
    rows = {c["code"]: c for c in client.get(f"{B}/classes").json()}
    assert rows["Bolt"]["leaf"] is False and rows["Bolt"]["path_labels"][-1] == rows["Bolt"]["label_ko"]
    assert any(c["leaf"] and c["family_root"] == "Bolt" for c in rows.values())
    detail = client.get(f"{B}/classes/Bolt").json()
    assert {"threadSize", "length"} <= {p["key"] for p in detail["properties"]} and detail["key_properties"][0]["blocking"] is True


def test_class_detail_tells_the_required_properties_and_what_opms_fills_by_convention(client: TestClient) -> None:
    """필수 속성 체크리스트가 읽는 것: Bolt 의 필수 속성, 값 범위, 관례로 채워지는 값(나사 방향 · 피치의 값 표). 값이 바뀔 수 있어 모양만 본다."""
    by = {p["key"]: p for p in client.get(f"{B}/classes/Bolt").json()["properties"]}
    required = {k for k, p in by.items() if p["required"]}
    assert {"threadSize", "length"} <= required                                            # 볼트의 필수 속성(나머지는 온톨로지 버전에 따라 늘 수 있다)
    assert by["length"]["min"] is not None                                                 # 값 범위
    if "threadDirection" in by:
        assert by["threadDirection"]["omitted_default"] and by["threadDirection"]["omitted_default_label"]
    if "pitch" in by and by["pitch"]["lookup_default"]:
        lk = by["pitch"]["lookup_default"]
        assert lk["key"] == "threadSize" and lk["values"] and all(isinstance(v, list) and v for v in lk["values"].values())


def test_parts_and_match_return_the_documented_shape(client: TestClient) -> None:
    page = client.get(f"{B}/parts", params={"size": 5}).json()
    assert page["size"] == 5 and page["total"] >= len(page["items"])
    if page["items"]:
        p = page["items"][0]
        assert p["part_no"].startswith("P-") and p["label"] and client.get(f"{B}/parts/{p['part_no']}").json()["part_no"] == p["part_no"]
    res = client.post(f"{B}/match", json={"class_code": "HexBolt", "values": {"threadSize": "M8", "length": 30}}).json()
    assert res["temporary"] is True and res["verdict"] in ("suspected", "none") and res["reason"] in ("ok", "no_candidate")   # CAD 값은 근사라 확정은 없다


def test_reading_does_not_change_opms(client: TestClient) -> None:
    before = client.get(f"{B}/status").json()
    for _ in range(3):
        client.post(f"{B}/match", json={"head_type": "Hex", "values": {"threadSize": "M8"}})
        client.get(f"{B}/parts")
    after = client.get(f"{B}/status").json()
    assert (before["parts"], before["classes"], before["ontology_version"]) == (after["parts"], after["classes"], after["ontology_version"])
