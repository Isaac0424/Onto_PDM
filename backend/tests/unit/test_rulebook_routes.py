"""조립 규칙 · 작업표준 라우트(`/api/v1/pdm/rulebook/*`)와 규칙 고르기(select). 실제 rules/ 로 돈다(Neo4j · OPMS 없이)."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from onto_pdm.api.app import PREFIX
from tests.unit.rulebook_fixtures import B, client

BOLT_PATH = ["MechanicalPart", "Fastener", "Bolt"]


@pytest.fixture(scope="module")
def c() -> TestClient:
    return client()


def ids(rows: list[dict[str, Any]]) -> list[str]:
    return [r["id"] for r in rows]


def select(c: TestClient, **body: Any) -> dict[str, Any]:
    r = c.post(f"{B}/select", json=body)
    assert r.status_code == 200, r.text
    return r.json()  # type: ignore[no-any-return]


def verdicts(res: dict[str, Any]) -> dict[str, str]:
    return {s["rule"]["id"]: s["applicable"] for s in res["rules"]}


# ---------------------------------------------------------------- 상태 · 목록
def test_status_counts_and_validation(c: TestClient) -> None:
    body = c.get(f"{B}/status").json()
    assert body["state"] == "ok"
    assert body["counts"] == {"operations": 18, "not_covered": 4, "tools": 3, "rules": 23, "work_standards": 10, "gaps": 19, "steps": 31, "inspection_items": 8}
    assert set(body["by_grade"]) == {"manual", "standard", "cad", "unknown"} and body["by_grade"]["unknown"] == 19
    assert body["validation"]["tool"] == "check_rules" and body["validation"]["errors"] == []


def test_rules_list_returns_all_with_provenance(c: TestClient) -> None:
    rows = c.get(f"{B}/rules").json()
    assert len(rows) == 23 and ids(rows)[0] == "AR-FAS-001"
    r = {x["id"]: x for x in rows}["AR-FAS-002"]
    torque = {p["name"]: p for p in r["parameters"]}["torque_nm"]
    # 근거 없는 값은 빠지지 않고 null + 공백 번호로 나간다
    assert torque["value"] is None and torque["source"] == "unknown" and torque["gap_id"] == "G-003" and torque["confirmed"] is False
    assert "value" in torque
    assert r["review_status"] == "unreviewed" and r["scope"] == "part" and r["operation_label"]


def test_rule_detail_and_404(c: TestClient) -> None:
    r = c.get(f"{B}/rules/AR-FAS-001").json()
    rows = {x["key"]: x for x in r["lookup"]["rows"]}
    assert rows["HCR-3A"]["values"]["torque_nm"] == 30 and rows["HCR-5A"]["values"]["torque_nm"] == 45 and rows["HCR-12A"]["values"]["torque_nm"] == 140
    assert rows["HCR-12A"]["refs"][0]["pages"] == [49] and rows["HCR-12A"]["confirmed"] is True
    assert any(x["level"] == "경고" and x["refs"][0]["pages"] == [49] for x in r["cautions"])
    miss = c.get(f"{B}/rules/AR-NOPE-999")
    assert miss.status_code == 404 and miss.json()["error"]["code"] == "RULE_NOT_FOUND"


@pytest.mark.parametrize("params,expected", [
    ({"class_code": "SocketHeadBolt"}, ["AR-FAS-006"]),
    ({"class_code": "FlatWasher"}, ["AR-FAS-005"]),
    ({"role": "robot_base_mount"}, ["AR-FAS-001", "AR-FAS-003", "AR-LOC-001"]),
    ({"gap": "G-003"}, ["AR-FAS-002"]),
    ({"operation": "PinLocating"}, ["AR-LOC-001"]),
    ({"scope": "role"}, ["AR-CFG-002", "AR-CON-004", "AR-FAS-003", "AR-LOC-001"]),
    ({"q": "시리얼"}, ["AR-CFG-003"]),
])
def test_rules_filters(c: TestClient, params: dict[str, str], expected: list[str]) -> None:
    assert sorted(ids(c.get(f"{B}/rules", params=params).json())) == sorted(expected)             # 목록은 rules.yaml 의 순서


def test_rules_filter_by_model_and_source(c: TestClient) -> None:
    only_12a = set(ids(c.get(f"{B}/rules", params={"model": "HCR-12A"}).json()))
    assert "AR-CFG-003" in only_12a and "AR-FAS-003" not in only_12a                  # 커버는 3A · 5A 에만, 시리얼 일치는 12A 에만
    unknown = ids(c.get(f"{B}/rules", params={"source": "unknown"}).json())
    assert unknown == ["AR-FAS-002", "AR-FAS-004", "AR-FAS-005", "AR-FAS-006"]
    assert c.get(f"{B}/rules", params={"source": "nope"}).status_code == 422


def test_operations_and_not_covered(c: TestClient) -> None:
    body = c.get(f"{B}/operations").json()
    ops = {o["code"]: o for o in body["operations"]}
    assert len(ops) == 18 and ops["BoltFastening"]["path"][-1] == "BoltFastening" and ops["BoltFastening"]["opms_code"]
    nc = {n["code"]: n for n in body["not_covered"]}
    assert set(nc) == {"Welding", "PressFit", "ControllerAssembly", "ZeroPointAdjustment"} and nc["Welding"]["gap_id"] == "G-014"


def test_tools_keep_empty_specs_empty(c: TestClient) -> None:
    tools = {t["id"]: t for t in c.get(f"{B}/tools").json()}
    assert set(tools) == {"TL-TORQUE", "TL-HEXKEY", "TL-VACUUM"}
    spec = {p["name"]: p for p in tools["TL-TORQUE"]["spec"]}["torque_range"]
    assert spec["value"] is None and spec["gap_id"] == "G-007" and tools["TL-HEXKEY"]["need"]["confirmed"] is False


def test_work_standards_list_filters_and_detail(c: TestClient) -> None:
    rows = c.get(f"{B}/work-standards").json()
    assert len(rows) == 10 and "steps" not in rows[0] and rows[0]["step_count"] >= 0
    assert ids(c.get(f"{B}/work-standards", params={"kind": "structure_only"}).json()) == ["WS-HCR12A-ASM-01", "WS-HCR3A5A-ASM-01"]
    assert "WS-HCR-INS-02" in ids(c.get(f"{B}/work-standards", params={"rule": "AR-FAS-001"}).json())
    assert ids(c.get(f"{B}/work-standards", params={"tool": "TL-VACUUM"}).json()) == ["WS-HCR-MNT-03"]
    d = c.get(f"{B}/work-standards/WS-HCR-INS-02").json()
    assert [s["seq"] for s in d["steps"]] == [1, 2, 3, 4, 5] and d["standard_time"]["value"] is None and d["standard_time"]["gap_id"] == "G-006"
    base = d["steps"][2]
    assert base["targets"][0]["role"] == "robot_base_mount" and base["targets"][0]["quantity"] == 4 and base["refs"][0]["pages"] == [49]
    assert any(ch["refs"] for ch in d["checks"])
    insp = c.get(f"{B}/work-standards/WS-HCR-MNT-01").json()["inspection_items"]
    assert len(insp) == 8 and insp[0]["cycle"] == {"value": 1, "unit": "일", "label": "매일"} and insp[5]["cycle_note"]
    asm = c.get(f"{B}/work-standards/WS-HCR12A-ASM-01").json()
    assert asm["steps"] == [] and asm["procedure_gap"] == "G-005" and asm["assemblies"][0]["parts"][0]["source"] == "cad"
    m4 = [p for a in asm["assemblies"] for p in a["parts"] if p["cad_name"] == "BOLT-M4"]
    assert m4 and all(p["length_mm"] is None and p["length_source"] == "unknown" for p in m4)   # 길이를 지어내지 않는다
    assert c.get(f"{B}/work-standards/WS-NOPE").status_code == 404


def test_gaps(c: TestClient) -> None:
    rows = {g["id"]: g for g in c.get(f"{B}/gaps").json()}
    assert len(rows) == 19 and rows["G-001"]["blocks"] == ["AR-FAS-006"] and rows["G-006"]["who"]


# ---------------------------------------------------------------- select
def test_select_socket_head_bolt_m4_without_role_is_unknown_not_applied(c: TestClient) -> None:
    res = select(c, class_code="SocketHeadBolt", class_path=[*BOLT_PATH, "SocketHeadBolt"], attributes={"threadSize": "M4", "length": 15})
    v = verdicts(res)
    assert v["AR-FAS-006"] == "unknown"                                               # 커버 볼트 규칙: 역할을 알아야 정해진다
    assert v["AR-SAF-001"] == "yes"                                                   # 조립된 볼트는 분해하지 않는다(상위 분류 Bolt)
    sel = {s["rule"]["id"]: s for s in res["rules"]}["AR-FAS-006"]
    assert [x["kind"] for x in sel["unknown_conditions"]] == ["role"]
    assert any(m["kind"] == "attribute" and "threadSize" in m["key"] for m in sel["matched_conditions"])  # M3 · M4 조건은 맞았다
    assert set(sel["unconfirmed_parameters"]) == {"torque_nm", "sequence"}
    # 규격이 다른 로봇 고정(M6 · M8 · M12)·접지(M4×10)·툴 고정(M6)·컨트롤러(M14) 규칙은 제외
    assert "AR-FAS-001" not in v and "AR-FAS-002" not in v and "AR-FAS-004" not in v and "AR-FAS-005" not in v
    assert res["counts"] == {"yes": 1, "unknown": 1, "no": 4} and "단정하지 않습니다" in res["note"]


def test_select_with_role_and_model_applies_the_cover_bolt_rule_with_unconfirmed_values(c: TestClient) -> None:
    res = select(c, class_code="SocketHeadBolt", class_path=[*BOLT_PATH, "SocketHeadBolt"], attributes={"threadSize": "M4"}, role="arm_assembly_bolt", model="HCR-12A")
    sel = {s["rule"]["id"]: s for s in res["rules"]}["AR-FAS-006"]
    assert sel["applicable"] == "yes" and sel["unknown_conditions"] == []
    torque = {p["name"]: p for p in sel["rule"]["parameters"]}["torque_nm"]
    assert torque["value"] is None and torque["confirmed"] is False and torque["gap_id"] == "G-001"
    assert sel["rule"]["applies_to"]["confirmed"] is False and sel["rule"]["applies_to"]["source"] == "cad"


def test_select_base_mount_m6_30nm_only_for_hcr_3a(c: TestClient) -> None:
    base = dict(class_code="HexBolt", class_path=BOLT_PATH, role="robot_base_mount", attributes={"threadSize": "M6", "length": 15})
    ok = select(c, **base, model="HCR-3A")
    sel = {s["rule"]["id"]: s for s in ok["rules"]}["AR-FAS-001"]
    assert sel["applicable"] == "yes" and sel["lookup"]["status"] == "selected"
    row = sel["lookup"]["rows"][0]
    assert row["key"] == "HCR-3A" and row["values"]["torque_nm"] == 30 and row["confirmed"] is True and row["refs"][0]["label"] == "사용설명서(KR) 3.3절 p.49"
    assert verdicts(ok)["AR-FAS-003"] == "yes" and verdicts(ok)["AR-LOC-001"] == "yes"       # 3A 는 볼트 커버 · 위치 결정 핀 규칙도 해당

    # 5A 의 로봇 고정 볼트는 M8(45 N·m) — M6 볼트는 해당 없음(제외)
    five = select(c, **base, model="HCR-5A")
    assert "AR-FAS-001" not in verdicts(five)
    shown = select(c, **base, model="HCR-5A", include_inapplicable=True)
    failed = {s["rule"]["id"]: s for s in shown["rules"]}["AR-FAS-001"]
    assert failed["applicable"] == "no" and any(f["kind"] == "lookup" for f in failed["failed_conditions"])
    # 12A 는 볼트 커버 규칙(3A · 5A 에만)이 제외된다
    assert "AR-FAS-003" not in verdicts(select(c, **base, model="HCR-12A"))


def test_select_without_model_narrows_the_lookup_to_candidate_rows(c: TestClient) -> None:
    def base_mount(size: str) -> dict[str, Any]:
        res = select(c, class_code="HexBolt", class_path=BOLT_PATH, role="robot_base_mount", attributes={"threadSize": size})
        return {s["rule"]["id"]: s for s in res["rules"]}

    m6 = base_mount("M6")["AR-FAS-001"]
    assert m6["applicable"] == "unknown" and m6["lookup"]["status"] == "candidates"
    assert [r["key"] for r in m6["lookup"]["rows"]] == ["HCR-3A"] and m6["lookup"]["rows"][0]["values"]["torque_nm"] == 30
    assert any("모델을 알면" in u["message"] for u in m6["unknown_conditions"])
    assert [r["key"] for r in base_mount("M8")["AR-FAS-001"]["lookup"]["rows"]] == ["HCR-5A"]
    assert [r["key"] for r in base_mount("M12")["AR-FAS-001"]["lookup"]["rows"]] == ["HCR-12A"]
    assert "AR-FAS-001" not in base_mount("M5")                                       # 어떤 모델의 로봇 고정 볼트도 아니다


def test_select_with_no_attributes_leaves_everything_unknown(c: TestClient) -> None:
    res = select(c, class_code="SocketHeadBolt", class_path=[*BOLT_PATH, "SocketHeadBolt"])
    sel = {s["rule"]["id"]: s for s in res["rules"]}
    assert sel["AR-FAS-006"]["applicable"] == "unknown"
    assert {u["kind"] for u in sel["AR-FAS-006"]["unknown_conditions"]} == {"role", "attribute"}      # 역할도 나사 규격도 모른다
    # 값이 없는 것은 단정하지 않는다: 접지 라인(M4×10)도 '아니오'가 아니라 '모름'
    assert verdicts(res)["AR-FAS-002"] == "unknown"


def test_select_class_matches_exactly_without_class_path_and_through_ancestors_with_it(c: TestClient) -> None:
    exact = select(c, class_code="HexBolt")
    assert "AR-SAF-001" not in verdicts(exact)                                         # 대상은 Bolt — class_path 없이는 HexBolt 로 정확히 일치하지 않는다
    with_path = select(c, class_code="HexBolt", class_path=BOLT_PATH)
    assert verdicts(with_path)["AR-SAF-001"] == "yes"
    hit = {s["rule"]["id"]: s for s in with_path["rules"]}["AR-SAF-001"]["matched_conditions"][0]
    assert hit["kind"] == "class" and "상위 분류 Bolt" in hit["message"]
    no = select(c, class_code="HexBolt", include_inapplicable=True)
    failed = {s["rule"]["id"]: s for s in no["rules"]}["AR-SAF-001"]["failed_conditions"][0]
    assert "class_path" in failed["message"]


def test_select_role_only_rules_need_the_role_and_product_rules_are_never_selected(c: TestClient) -> None:
    without = verdicts(select(c, class_code="HexBolt", class_path=BOLT_PATH, attributes={"threadSize": "M6"}))
    assert "AR-LOC-001" not in without and "AR-CON-004" not in without
    assert not any(k.startswith(("AR-SIT", "AR-MNT")) for k in without)
    with_role = verdicts(select(c, class_code="HexBolt", class_path=BOLT_PATH, role="tool_mount", attributes={"threadSize": "M6"}, model="HCR-5A"))
    assert with_role["AR-CON-004"] == "yes" and with_role["AR-CFG-002"] == "yes" and with_role["AR-FAS-004"] == "yes"   # 툴 고정 M6
    assert "AR-LOC-001" not in with_role                                               # 다른 역할(로봇 고정)


def test_select_controller_washer_combo_and_min_length(c: TestClient) -> None:
    yes = select(c, class_code="FlatWasher", class_path=["MechanicalPart", "Fastener", "Washer", "FlatWasher"], role="controller_mount")
    assert verdicts(yes)["AR-FAS-005"] in ("yes", "unknown")
    short = select(c, class_code="HexBolt", class_path=BOLT_PATH, role="controller_mount", attributes={"threadSize": "M14", "length": 30}, include_inapplicable=True)
    sel = {s["rule"]["id"]: s for s in short["rules"]}["AR-FAS-005"]
    assert sel["applicable"] == "no" and any("length_mm" in f["key"] for f in sel["failed_conditions"])      # M14 45 mm 이상
    ok = select(c, class_code="HexBolt", class_path=BOLT_PATH, role="controller_mount", attributes={"threadSize": "M14", "length": "50 mm"})
    assert verdicts(ok)["AR-FAS-005"] == "yes"                                         # 문자열 "50 mm" 도 숫자로 읽는다


def test_select_reads_product_codes_and_ignores_unreadable_models(c: TestClient) -> None:
    base = dict(class_code="HexBolt", class_path=BOLT_PATH, role="robot_base_mount", attributes={"threadSize": "M12", "length": 25})
    for product in ("HCR12A", "hcr-12a", "HCR 12A"):
        res = select(c, **base, product=product)
        assert res["model"] == "HCR-12A" and verdicts(res)["AR-FAS-001"] == "yes", product
    odd = select(c, **base, product="ACME-9000")
    assert odd["model"] is None and verdicts(odd)["AR-FAS-001"] == "unknown"           # 읽을 수 없는 제품은 미확인(단정 안 함)


def test_select_validates_the_request(c: TestClient) -> None:
    assert c.post(f"{B}/select", json={"class_code": ""}).status_code == 422
    assert c.post(f"{B}/select", json={}).status_code == 422
    assert c.post(f"{B}/select", json={"class_code": "Bolt", "nope": 1}).status_code == 422


# ---------------------------------------------------------------- 계약 · 읽기 전용 · 기존 라우트와 공존
def test_openapi_lists_the_rulebook_paths_and_they_are_read_only(c: TestClient) -> None:
    paths = c.get("/openapi.json").json()["paths"]
    mine = {p: set(m) for p, m in paths.items() if p.startswith(f"{PREFIX}/rulebook")}
    assert set(mine) == {f"{B}{x}" for x in ("/status", "/rules", "/rules/{rule_id}", "/operations", "/tools", "/work-standards",
                                              "/work-standards/{work_standard_id}", "/gaps", "/select")}
    writes = {p: m for p, m in mine.items() if m - {"get"}}
    assert writes == {f"{B}/select": {"post"}}                                         # 쓰는 경로는 없다 — select 는 계산만 한다


def test_write_methods_are_not_routed(c: TestClient) -> None:
    for method in ("put", "patch", "delete"):
        assert getattr(c, method)(f"{B}/rules/AR-FAS-001").status_code == 405
    assert c.post(f"{B}/rules", json={}).status_code == 405
    assert c.post(f"{B}/reload").status_code in (404, 405)


def test_old_in_memory_rules_routes_are_untouched(c: TestClient) -> None:
    # 삭제하지 않은 옛 임시 데이터의 /rules 는 새 /rulebook/rules 와 이름이 겹치지 않는다
    assert c.get(f"{PREFIX}/health").status_code == 200
    r = c.get(f"{PREFIX}/rules")
    assert r.status_code == 200 and isinstance(r.json(), list)
