"""OPMS 를 읽을 수 없을 때의 오류. 웹은 503 + 코드로 '연결 안 됨'을 구분해 보인다."""

from __future__ import annotations

from typing import Any

from onto_pdm.errors import ApiException


class OpmsUnavailable(ApiException):
    """OPMS Neo4j 에 닿지 못했거나 설정이 없다 (503)."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(503, code, message, details)


def not_configured() -> OpmsUnavailable:
    return OpmsUnavailable(
        "OPMS_NOT_CONFIGURED",
        "OPMS 읽기 설정이 없습니다. 백엔드를 켤 때 PDM_NEO4J_URI · PDM_NEO4J_USER · PDM_NEO4J_PASSWORD 를 지정하세요.",
    )


def unreachable(detail: str) -> OpmsUnavailable:
    return OpmsUnavailable("OPMS_UNAVAILABLE", f"OPMS 의 Neo4j 에 연결하지 못했습니다 ({detail}). OPMS 가 켜져 있는지 확인하세요.")


def auth_failed() -> OpmsUnavailable:
    return OpmsUnavailable("OPMS_AUTH_FAILED", "OPMS 의 Neo4j 가 계정을 받아들이지 않았습니다. PDM_NEO4J_USER · PDM_NEO4J_PASSWORD 를 확인하세요.")


def no_ontology() -> OpmsUnavailable:
    return OpmsUnavailable("OPMS_NO_ONTOLOGY", "OPMS 에 적용된 온톨로지 버전이 없습니다. OPMS 에서 `registry ontology sync` 가 한 번 돌아야 합니다.")
