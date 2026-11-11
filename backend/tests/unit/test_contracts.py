"""계약 생성물(JSON Schema · 예시)이 최신이고, 예시가 계약을 벗어나지 않는지 본다."""

from __future__ import annotations

import json

from onto_pdm import contract_export
from onto_pdm.contracts import PDM_CONTRACT_VERSION, RESPONSE_MODELS, ItemPage, ItemSummary, Page, PartRequestPayload


def test_committed_contracts_are_up_to_date() -> None:
    assert contract_export.stale() == [], "`onto-pdm contracts export` 로 다시 만드세요"


def test_schema_has_every_contract_model_and_version() -> None:
    schema = json.loads((contract_export.CONTRACTS_DIR / contract_export.SCHEMA_FILE).read_text(encoding="utf-8"))
    assert schema["x-contract-version"] == PDM_CONTRACT_VERSION == "1"
    names = set(schema["properties"])
    assert {m.__name__ for m in RESPONSE_MODELS} <= names
    assert {"CadMatchRequest", "AssemblyGuidesRequest", "BomSheetMatchRequest", "PartRequestPayload"} <= names
    # 선(wire) 형식은 snake_case
    detail = schema["$defs"]["ItemDetail"]["properties"]
    assert "item_no" in detail and "latest_revision" in detail and "itemNo" not in detail


def test_every_example_reads_back_as_its_model() -> None:
    by_name = contract_export.model_by_name()
    examples = list((contract_export.CONTRACTS_DIR / "examples").glob("*.json"))
    assert len(examples) >= 10
    for path in examples:
        model_name = path.stem.split(".")[0]
        model = by_name[model_name]
        payload = json.loads(path.read_text(encoding="utf-8"))
        again = model.model_validate(payload)                           # 계약을 벗어나면(필드 추가 · 오타) 여기서 실패한다
        assert again.model_dump(mode="json", exclude_none=True) == payload, path.name


def test_extra_fields_are_rejected() -> None:
    """OPMS 계약과 같은 extra='forbid': 모르는 필드는 오타일 가능성이 높아 받지 않는다."""
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        PartRequestPayload.model_validate({"name": "x", "nmae": "oops"})


def test_page_is_the_opms_shape() -> None:
    page = ItemPage(items=[], total=0, page=1, size=50)
    assert page.model_dump() == {"items": [], "total": 0, "page": 1, "size": 50}
    assert issubclass(ItemPage, Page) and ItemSummary
