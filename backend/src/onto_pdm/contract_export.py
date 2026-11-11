"""contracts/pdm_api.schema.json 과 contracts/examples/*.json 을 만든다 (`onto-pdm contracts export`).

OPMS 의 contract_export 와 같은 방식이다. 시험(tests/unit/test_contracts.py)이 커밋된 생성물이 최신인지 지킨다.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic.json_schema import GenerateJsonSchema, models_json_schema

from onto_pdm.contract_examples import examples
from onto_pdm.contracts import PDM_CONTRACT_VERSION, REQUEST_MODELS, RESPONSE_MODELS, ContractModel

BACKEND_ROOT = Path(__file__).resolve().parents[2]
CONTRACTS_DIR = BACKEND_ROOT / "contracts"
SCHEMA_FILE = "pdm_api.schema.json"


class _NoFieldTitles(GenerateJsonSchema):
    """필드마다 title 이 붙으면 json-schema-to-typescript 가 필드마다 타입 별칭을 만든다. 모델 title 만 남긴다."""

    def field_title_should_be_set(self, schema: Any) -> bool:
        return False


def build_schema() -> dict[str, Any]:
    keys = [(m, "validation") for m in REQUEST_MODELS] + [(m, "serialization") for m in RESPONSE_MODELS]
    refs, top = models_json_schema(keys, ref_template="#/$defs/{model}", schema_generator=_NoFieldTitles)  # type: ignore[arg-type]
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "OntoPdmApi",
        "x-contract-version": PDM_CONTRACT_VERSION,
        "type": "object",
        "properties": {model.__name__: refs[(model, mode)] for model, mode in keys},
        "additionalProperties": False,
        "$defs": _drop_null_defaults(top["$defs"]),
    }


def _drop_null_defaults(node: Any) -> Any:
    """`X | None = None` 의 `default: null` 을 지운다 (타입과 기본값이 어긋나지 않게)."""
    if isinstance(node, list):
        return [_drop_null_defaults(x) for x in node]
    if not isinstance(node, dict):
        return node
    out = {k: _drop_null_defaults(v) for k, v in node.items()}
    return out


def model_by_name() -> dict[str, type[ContractModel]]:
    return {m.__name__: m for m in (*REQUEST_MODELS, *RESPONSE_MODELS)}


def render() -> dict[str, str]:
    """상대 경로 → 파일 내용. 쓰기와 최신 확인이 같은 문자열을 쓴다."""
    out = {SCHEMA_FILE: json.dumps(build_schema(), ensure_ascii=False, indent=2) + "\n"}
    for name, payload in examples().items():
        out[f"examples/{name}.json"] = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    return out


def write() -> list[Path]:
    written: list[Path] = []
    files = render()
    examples_dir = CONTRACTS_DIR / "examples"
    examples_dir.mkdir(parents=True, exist_ok=True)
    for stale in examples_dir.glob("*.json"):
        if f"examples/{stale.name}" not in files:
            stale.unlink()
    for rel, text in files.items():
        path = CONTRACTS_DIR / rel
        path.write_text(text, encoding="utf-8", newline="\n")
        written.append(path)
    return written


def stale() -> list[str]:
    """커밋된 생성물이 지금 계약과 다른 파일 이름들."""
    out: list[str] = []
    for rel, text in render().items():
        path = CONTRACTS_DIR / rel
        if not path.exists() or path.read_text(encoding="utf-8") != text:
            out.append(rel)
    examples_dir = CONTRACTS_DIR / "examples"
    if examples_dir.exists():
        known = {f"examples/{p.name}" for p in examples_dir.glob("*.json")}
        out += sorted(known - set(render()))
    return out
