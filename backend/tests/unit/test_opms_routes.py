"""OPMS 읽기 라우트: 분류 · 부품 · 매칭(임시 판정) · 연결 상태. 가짜 OPMS(opms_fixtures)로, Neo4j 없이 돈다."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from onto_pdm.api.app import PREFIX, create_app
from onto_pdm.opms import errors
from onto_pdm.opms.reader import UnconfiguredOpmsReader
from onto_pdm.store import InMemoryPdmStore
from tests.unit.opms_fixtures import FakeOpms

B = f"{PREFIX}/opms"


def client(opms: object | None = None) -> TestClient:
    return TestClient(create_app(InMemoryPdmStore(), opms or FakeOpms()))  # type: ignore[arg-type]


def post_match(c: TestClient, **body: object) -> dict:
    r = c.post(f"{B}/match", json=body)
    assert r.status_code == 200, r.text
    return r.json()  # type: ignore[no-any-return]


# ---------------------------------------------------------------- 연결 상태
def test_status_ok_reports_version_and_counts() -> None:
    assert client().get(f"{B}/status").json() == {"state": "ok", "message": None, "ontology_version": "0.15.0", "classes": 9, "parts": 9}


@pytest.mark.parametrize("err,state", [
    (errors.unreachable("ServiceUnavailable"), "opms_down"),
    (errors.auth_failed(), "auth_failed"),
    (errors.no_ontology(), "no_ontology"),
    (errors.not_configured(), "not_configured"),
])
def test_status_answers_200_with_the_reason_when_opms_is_down(err: errors.OpmsUnavailable, state: str) -> None:
    r = client(FakeOpms(down=err)).get(f"{B}/status")
    assert r.status_code == 200 and r.json()["state"] == state and "OPMS" in r.json()["message"]


def test_status_when_not_configured_at_all() -> None:
    r = client(UnconfiguredOpmsReader()).get(f"{B}/status").json()
    assert r["state"] == "not_configured" and "PDM_NEO4J_URI" in r["message"]


@pytest.mark.parametrize("path", ["/classes", "/classes/HexBolt", "/parts", "/parts/P-00000000001"])
def test_reads_answer_503_with_a_korean_message_when_opms_is_down(path: str) -> None:
    r = client(FakeOpms(down=errors.unreachable("ServiceUnavailable"))).get(f"{B}{path}")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "OPMS_UNAVAILABLE" and "연결하지 못했습니다" in r.json()["error"]["message"]


def test_match_answers_503_when_opms_is_down() -> None:
    r = client(FakeOpms(down=errors.auth_failed())).post(f"{B}/match", json={"values": {"threadSize": "M8"}})
    assert r.status_code == 503 and r.json()["error"]["code"] == "OPMS_AUTH_FAILED"


def test_the_app_boots_without_neo4j_settings_and_says_so() -> None:
    r = client(UnconfiguredOpmsReader()).get(f"{B}/classes")
    assert r.status_code == 503 and r.json()["error"]["code"] == "OPMS_NOT_CONFIGURED"


# ---------------------------------------------------------------- 분류
def test_classes_list_has_hierarchy_and_head_types() -> None:
    rows = {c["code"]: c for c in client().get(f"{B}/classes").json()}
    assert len(rows) == 9
    assert rows["HexBolt"]["path_labels"] == ["기계 부품", "체결 부품", "볼트", "육각볼트"] and rows["HexBolt"]["parent"] == "Bolt"
    assert rows["Bolt"]["leaf"] is False and rows["HexBolt"]["leaf"] is True
    assert (rows["SocketHeadBolt"]["head_type"], rows["SocketHeadBolt"]["head_type_source"]) == ("Socket", "pdm_temporary")   # OPMS 에 headType 이 생기기 전의 임시 표
    assert rows["Nut"]["head_type"] is None


def test_head_type_comes_from_the_ontology_when_opms_fixes_it() -> None:
    rows = {c["code"]: c for c in client(FakeOpms(head_fixed=True)).get(f"{B}/classes").json()}
    assert (rows["HexBolt"]["head_type"], rows["HexBolt"]["head_type_source"]) == ("Hex", "ontology")
    assert rows["HexFlangeBolt"]["head_type_source"] == "pdm_temporary"                       # 고정이 없는 클래스는 임시 표


def test_class_detail_has_effective_properties_and_key_properties() -> None:
    d = client().get(f"{B}/classes/SocketHeadBolt").json()
    by = {p["key"]: p for p in d["properties"]}
    assert by["socketSize"]["required"] is True and by["socketSize"]["min"] == 1.5 and by["socketSize"]["unit"] == "mm"
    assert by["material"]["datatype"] == "concept" and by["material"]["scheme"] == "material"
    assert [k["prop"] for k in d["key_properties"]] == ["threadSize", "length", "material", "surfaceTreatment", "pitch"]
    assert d["key_properties"][0]["blocking"] is True and d["key_properties"][1]["tolerance"] == 0.2


def test_class_detail_tells_which_required_values_opms_fills_by_convention() -> None:
    """필수 속성 체크리스트가 '비어 있다'고 세지 않을 값: 나사 방향(omitted_default) · 피치(값 표의 기본 열)."""
    by = {p["key"]: p for p in client().get(f"{B}/classes/SocketHeadBolt").json()["properties"]}
    assert (by["threadDirection"]["omitted_default"], by["threadDirection"]["omitted_default_label"]) == ("RightHand", "오른나사")
    lk = by["pitch"]["lookup_default"]
    assert (lk["key"], lk["series"], lk["series_label"]) == ("threadSize", "Coarse", "보통 나사")
    assert lk["values"] == {"M3": [0.5], "M4": [0.7], "M8": [1.25]}                       # 기본 열(보통 나사)만, 가는 나사 값은 싣지 않는다
    assert by["material"]["omitted_default"] is None and by["material"]["lookup_default"] is None
    assert by["length"]["required"] is True and by["length"]["min"] == 3.0                 # 값 범위(min)
    assert by["strengthGrade"]["required"] is True and "strengthGrade" not in {p["key"] for p in client().get(f"{B}/classes/HexBolt").json()["properties"]}


def test_unknown_class_is_404() -> None:
    r = client().get(f"{B}/classes/Nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "CLASS_NOT_FOUND"


# ---------------------------------------------------------------- 부품
def test_parts_list_filters_pages_and_labels() -> None:
    c = client()
    body = c.get(f"{B}/parts", params={"class_code": "SocketHeadBolt"}).json()
    assert body["total"] == 4 and [p["part_no"] for p in body["items"]] == ["P-00000000046", "P-00000000047", "P-00000000048", "P-00000000049"]
    assert body["items"][1]["label"] == "육각구멍붙이볼트 M4 · 10 mm · SCM435"                   # OPMS 부품에는 이름이 없어 분류 · 핵심 속성으로 만든다
    assert body["items"][1]["value_labels"] == {"material": "SCM435", "surfaceTreatment": "아연도금"}   # 개념 값은 라벨로
    paged = c.get(f"{B}/parts", params={"size": 3, "page": 3}).json()
    assert paged["total"] == 9 and len(paged["items"]) == 3
    assert [p["part_no"] for p in c.get(f"{B}/parts", params={"q": "m10"}).json()["items"]] == ["P-00000000002"]


def test_part_detail_and_404() -> None:
    c = client()
    p = c.get(f"{B}/parts/P-00000000003").json()
    assert p["class_code"] == "HexFlangeBolt" and p["values"]["flangeDiameter"] == 17.0 and p["class_path_labels"][-1] == "육각플랜지볼트"
    r = c.get(f"{B}/parts/P-99999999999")
    assert r.status_code == 404 and r.json()["error"]["code"] == "PART_NOT_FOUND"


# ---------------------------------------------------------------- 매칭 (임시 판정)
def test_match_by_socket_class_finds_same_spec_and_is_at_most_suspected_for_cad_values() -> None:
    res = post_match(client(), class_code="SocketHeadBolt", head_type="Socket", values={"threadSize": "M4", "length": 15})
    assert res["temporary"] is True and res["ontology_version"] == "0.15.0" and "임시 판정" in res["note"]
    assert (res["verdict"], res["reason"]) == ("suspected", "ok")                            # CAD 값은 근사라 후보까지만 (OPMS capped 규칙)
    assert [c["part_no"] for c in res["candidates"]] == ["P-00000000048", "P-00000000049"]   # M4 × 15 만 (M3 은 막는 속성 불일치로 후보 밖)
    top = res["candidates"][0]
    assert top["score"] == 1.0 and top["capped"] is True and top["class_capped"] is False
    hits = {m["prop_key"]: m["hit"] for m in top["matched"]}
    assert hits == {"threadSize": True, "length": True, "material": None, "surfaceTreatment": None, "pitch": None}   # 값이 없는 속성은 비교에서 뺀다 (hit=null)
    assert top["matched"][0]["doc_display"] == "M4" and top["matched"][1]["part_display"] == "15 mm"


def test_match_never_confirms_cad_approximate_values_but_confirms_full_exact_values() -> None:
    full = {"threadSize": "M4", "length": 10, "material": "SCM435", "surfaceTreatment": "ZincPlated", "pitch": 0.7}
    approx = post_match(client(), class_code="SocketHeadBolt", values=full)                  # approximate 기본값 true
    assert approx["verdict"] == "suspected" and approx["candidates"][0]["capped"] is True
    exact = post_match(client(), class_code="SocketHeadBolt", approximate=False, values=full)
    assert exact["verdict"] == "confirmed" and exact["candidates"][0]["part_no"] == "P-00000000047" and exact["candidates"][0]["capped"] is False


def test_match_incomplete_part_is_capped_even_with_exact_values() -> None:
    full = {"threadSize": "M4", "length": 15, "material": "SCM435", "surfaceTreatment": "ZincPlated", "pitch": 0.7}
    res = post_match(client(), class_code="SocketHeadBolt", approximate=False, values=full)
    by = {c["part_no"]: c for c in res["candidates"]}
    assert by["P-00000000049"]["verdict"] == "suspected" and by["P-00000000049"]["capped"] is True      # 부품에 피치가 없다 (OPMS KAN-112)


def test_match_length_within_tolerance_counts_as_same() -> None:
    res = post_match(client(), class_code="SocketHeadBolt", values={"threadSize": "M4", "length": 15.2})
    assert {c["part_no"] for c in res["candidates"]} == {"P-00000000048", "P-00000000049"} and all(c["score"] == 1.0 for c in res["candidates"])
    far = post_match(client(), class_code="SocketHeadBolt", values={"threadSize": "M4", "length": 15.3})
    assert all(c["score"] < 1.0 for c in far["candidates"]) or far["candidates"] == []             # 허용오차 0.2 mm 밖은 일치가 아니다


def test_match_other_head_types_are_not_candidates_even_with_the_same_spec() -> None:
    res = post_match(client(), class_code="HexBolt", head_type="Hex", values={"threadSize": "M8", "length": 30})
    assert [c["part_no"] for c in res["candidates"]] == ["P-00000000001"]                      # 같은 M8×30 인 플랜지볼트(P-3)는 머리가 달라 후보가 아니다
    sock = post_match(client(), class_code="SocketHeadBolt", values={"threadSize": "M8", "length": 30})
    assert sock["verdict"] == "none" and sock["reason"] == "no_candidate"


def test_match_by_head_type_only_when_class_is_unknown() -> None:
    res = post_match(client(), head_type="Hex", values={"threadSize": "m8", "length": 30})     # 'm8' 도 M8 로 정규화한다
    assert [c["part_no"] for c in res["candidates"]] == ["P-00000000001"] and res["candidates"][0]["class_capped"] is False


def test_match_head_type_with_no_opms_class_finds_nothing_and_says_why() -> None:
    res = post_match(client(), head_type="Button", values={"threadSize": "M4", "length": 10})
    assert (res["verdict"], res["reason"], res["candidates"]) == ("none", "no_candidate", [])
    assert "Button" in res["note"] and "분류가 없습니다" in res["note"]


def test_match_without_class_or_head_uses_classes_that_have_all_given_properties() -> None:
    res = post_match(client(), values={"threadSize": "M8", "length": 30})                     # 길이가 있는 것은 볼트 계열뿐이라 너트는 후보가 아니다
    assert {c["class_code"] for c in res["candidates"]} == {"HexBolt", "HexFlangeBolt", "WingBolt"}
    nut = post_match(client(), values={"threadSize": "M8"})
    assert "HexNut" in {c["class_code"] for c in nut["candidates"]}


def test_match_flange_class_only_finds_flange_heads_and_a_headless_class_scans_its_family() -> None:
    flange = post_match(client(), class_code="HexFlangeBolt", values={"threadSize": "M8", "length": 30})
    assert [c["part_no"] for c in flange["candidates"]] == ["P-00000000003"] and flange["candidates"][0]["class_capped"] is False
    # 머리 모양이 정해지지 않은 분류(나비볼트)는 머리로 거르지 않아 계열 전체가 후보이고, 다른 분류의 후보는 의심까지만(class_capped)
    wing = post_match(client(), class_code="WingBolt", approximate=False,
                      values={"threadSize": "M8", "length": 30, "material": "SUS304", "surfaceTreatment": "ZincPlated", "pitch": 1.25})
    by = {c["part_no"]: c for c in wing["candidates"]}
    assert by["P-00000000001"]["class_capped"] is True and by["P-00000000001"]["score"] == 1.0 and by["P-00000000001"]["verdict"] == "suspected"
    assert by["P-00000000061"]["class_capped"] is False and by["P-00000000061"]["score"] == 0.8     # 표면처리가 달라 4/5


def test_match_edge_cases() -> None:
    c = client()
    assert post_match(c, values={"threadSize": "스무"})["reason"] == "no_values"                # 규격으로 읽을 수 없는 값은 버린다
    assert post_match(c, values={})["reason"] == "no_values"
    unknown = post_match(c, class_code="ButtonHeadBolt", values={"threadSize": "M4"})
    assert (unknown["verdict"], unknown["reason"]) == ("none", "unknown_class") and "ButtonHeadBolt" in unknown["note"]
    bad = c.post(f"{B}/match", json={"class_code": "Bolt", "values": {"threadSize": "M4"}})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_REQUEST"         # 리프 분류만
    assert c.post(f"{B}/match", json={"values": {"threadSize": "M4"}, "limit": 0}).status_code == 422
    assert len(post_match(c, class_code="SocketHeadBolt", values={"threadSize": "M4"}, limit=1)["candidates"]) == 1


def test_match_uses_the_blocking_property_to_limit_what_it_reads() -> None:
    fake = FakeOpms()
    post_match(client(fake), class_code="SocketHeadBolt", values={"threadSize": "M4", "length": 15})
    parts_calls = [c for c in fake.calls if c[0] == "parts"]
    assert parts_calls == [("parts", (["SocketHeadBolt"], {"threadSize": "M4"}))]               # 클래스 · 나사 규격으로 좁혀 읽는다 (OPMS blocking_key)


def test_match_is_read_only_and_never_calls_anything_but_reads() -> None:
    fake = FakeOpms()
    post_match(client(fake), class_code="SocketHeadBolt", values={"threadSize": "M4"})
    assert {name for name, _ in fake.calls} <= {"ontology", "parts"}


def test_app_closes_the_reader_on_shutdown() -> None:
    fake = FakeOpms()
    with TestClient(create_app(InMemoryPdmStore(), fake)) as c:                                # type: ignore[arg-type]
        assert c.get(f"{B}/status").status_code == 200
    assert fake.closed is True
