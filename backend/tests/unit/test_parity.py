"""Python 구현이 웹의 목 API(web/src/api/mock)와 **같은 결과**를 내는지 비교한다.

tests/fixtures/parity.json 은 `node backend/scripts/export_fixtures.mjs` 가 목 API 를 실제로 돌려 만든 것이다 (대표 입력 179건: 매칭 ·
규칙 안내 · 규칙 상세 · 품목 목록 · 품목 상세 · BOM · 문서 · 사용처 · 등록 요청 중복 후보, 사용자 3가지 조합).
웹의 규칙이나 목 API 가 바뀌면 스크립트를 다시 돌려 이 시험이 알려 주는 차이를 Python 쪽에 반영한다.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from onto_pdm.contracts import AssemblyPartInput, BomSheetRowInput, PartRequestPayload
from onto_pdm.errors import ApiException
from onto_pdm.store import InMemoryPdmStore, Session
from onto_pdm.store.memory import _snake_keys

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "parity.json"
CASES: list[dict[str, Any]] = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]

SESSIONS = {"admin": ("kim", True), "admin_off": ("kim", False), "engineer": ("lee", False)}


def dump(v: Any) -> Any:
    if isinstance(v, list):
        return [dump(x) for x in v]
    return v.model_dump(mode="json", exclude_none=True) if hasattr(v, "model_dump") else v


def run(store: InMemoryPdmStore, s: Session, op: str, inp: Any) -> Any:
    if op == "matchCadParts":
        return store.match_cad_parts(s, inp)
    if op == "getAssemblyGuides":
        return store.get_assembly_guides([AssemblyPartInput(**_snake_keys(p)) for p in inp])
    if op == "listAssemblyRules":
        return store.list_assembly_rules()
    if op == "validateAssemblyRules":
        return store.validate_assembly_rules()
    if op == "getAssemblyRule":
        return store.get_assembly_rule(s, inp)
    if op == "listItems":
        return store.list_items(s, q=inp.get("q"), item_type=inp.get("itemType"), status=inp.get("status"), product_id=inp.get("productId"))
    if op == "getItem":
        return store.get_item(s, inp)
    if op == "getBom":
        return store.get_bom(s, inp["rev"], inp["rule"])
    if op == "getDocuments":
        return store.get_documents(s, inp)
    if op == "getWhereUsed":
        return store.get_where_used(s, inp)
    if op == "listPartRequests":
        return store.list_part_requests(s, inp)
    if op == "submitDuplicateCheck":
        saved = store.save_part_request(s, None, PartRequestPayload(**_snake_keys(inp)))
        sent = store.submit_part_request(s, saved.id)
        return {"status": sent.status, "source_system": sent.source_system, "duplicate_check": dump(sent.duplicate_check)}
    raise AssertionError(f"알 수 없는 시험 항목: {op}")


def sessions_of(who: str, store: InMemoryPdmStore) -> Session:
    login, admin_mode = SESSIONS[who]
    return Session(user=store.find_user(login), admin_mode=admin_mode)  # type: ignore[arg-type]


def replay() -> list[tuple[dict[str, Any], Any]]:
    """사용자 조합마다 새 저장소를 만들고, 웹에서 돌린 순서 그대로 다시 돌린다 (등록 요청은 앞 항목의 영향을 받는다)."""
    out: list[tuple[dict[str, Any], Any]] = []
    stores = {who: InMemoryPdmStore() for who in SESSIONS}
    for case in CASES:
        store = stores[case["who"]]
        s = sessions_of(case["who"], store)
        try:
            got: Any = dump(run(store, s, case["op"], case["input"]))
        except ApiException as e:
            got = {"error": {"status": e.status, "message": str(e)}}
        out.append((case, got))
    return out


RESULTS = replay()


def label(case: dict[str, Any]) -> str:
    inp = json.dumps(case["input"], ensure_ascii=False)
    return f'{case["who"]}:{case["op"]}:{inp[:60]}'


@pytest.mark.parametrize(("case", "got"), RESULTS, ids=[label(c) for c, _ in RESULTS])
def test_same_result_as_web_mock(case: dict[str, Any], got: Any) -> None:
    result = case["result"]
    if "error" in result:
        assert got == {"error": result["error"]}
        return
    assert "error" not in got, got
    assert got == _snake_keys(result["ok"])


def test_fixture_covers_what_it_claims() -> None:
    ops = {c["op"] for c in CASES}
    assert ops >= {"matchCadParts", "getAssemblyGuides", "listAssemblyRules", "validateAssemblyRules", "getAssemblyRule", "listItems", "getItem", "getBom",
                   "getDocuments", "getWhereUsed", "listPartRequests", "submitDuplicateCheck"}
    assert len(CASES) >= 150
    assert {c["who"] for c in CASES} == set(SESSIONS)


def test_bom_sheet_is_not_part_of_the_web_fixture() -> None:
    """BOM 시트 매칭은 웹 쪽 구현(별도 작업)과 규칙이 완전히 같음을 아직 보장하지 않는다 — 여기서는 모양만 본다."""
    store = InMemoryPdmStore()
    s = sessions_of("admin", store)
    out = store.match_bom_sheet(s, [BomSheetRowInput(line=1, item_no="P-00000000001", quantity=4)])
    assert out[0].status == "matched"
