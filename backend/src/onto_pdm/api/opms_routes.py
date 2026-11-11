"""OPMS 읽기 라우트 (`/api/v1/pdm/opms/*`). 분류 · 부품 · 매칭. 모두 읽기 전용이고, OPMS 를 못 읽으면 503 이다.

`/status` 는 예외로 켜져 있지 않아도 200 으로 답하고 state 로 이유를 말한다(웹이 '연결 안 됨'을 구분해 보이려고).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request

from onto_pdm.errors import ERROR_RESPONSES, not_found
from onto_pdm.opms import OpmsReader, OpmsUnavailable
from onto_pdm.opms.matching import match
from onto_pdm.opms.models import OpmsClass, OpmsClassDetail, OpmsMatchRequest, OpmsMatchResult, OpmsPart, OpmsPartPage, OpmsStatus
from onto_pdm.opms.ontology import Ontology

PREFIX = "/api/v1/pdm"   # app.py 의 PREFIX 와 같다 (app.py 가 이 모듈을 가져오므로 되가져오지 않는다)

_STATE = {
    "OPMS_NOT_CONFIGURED": "not_configured",
    "OPMS_AUTH_FAILED": "auth_failed",
    "OPMS_NO_ONTOLOGY": "no_ontology",
    "OPMS_UNAVAILABLE": "opms_down",
}
# 값이 없으면 null 로 보낸다(빠뜨리지 않는다): 매칭의 hit=null 은 "비교에서 뺐다"는 뜻이라 없는 것과 달라서다
_COMMON = {"responses": {**ERROR_RESPONSES, 503: {"description": "OPMS 를 읽을 수 없음"}}}


def _reader(request: Request) -> OpmsReader:
    return request.app.state.opms  # type: ignore[no-any-return]


def _onto(reader: OpmsReader) -> Ontology:
    return Ontology(reader.ontology())


def build_opms_router() -> APIRouter:
    r = APIRouter(prefix=f"{PREFIX}/opms", tags=["opms"])

    @r.get("/status", response_model=OpmsStatus, summary="OPMS 읽기 연결 상태")
    def status(request: Request) -> OpmsStatus:
        reader = _reader(request)
        try:
            snap = reader.ontology()
            counts = reader.counts()
        except OpmsUnavailable as e:
            return OpmsStatus(state=_STATE.get(e.code, "opms_down"), message=str(e))  # type: ignore[arg-type]
        return OpmsStatus(state="ok", ontology_version=snap.version, classes=counts["classes"], parts=counts["parts"])

    @r.get("/classes", response_model=list[OpmsClass], summary="OPMS 분류 목록 (계층은 path · parent)", **_COMMON)
    def classes(request: Request) -> list[OpmsClass]:
        onto = _onto(_reader(request))
        return [onto.to_class(c) for c in onto.class_codes()]

    @r.get("/classes/{code}", response_model=OpmsClassDetail, summary="분류 하나: 유효 속성 · 핵심 속성 · 고정 값", **_COMMON)
    def class_detail(code: str, request: Request) -> OpmsClassDetail:
        onto = _onto(_reader(request))
        if not onto.has_class(code):
            raise not_found("CLASS_NOT_FOUND", f"OPMS 분류 {code}을(를) 찾을 수 없습니다")
        return onto.to_class_detail(code)

    @r.get("/parts", response_model=OpmsPartPage, summary="OPMS 부품 목록", **_COMMON)
    def parts(
        request: Request,
        class_code: str | None = None,
        q: str | None = None,
        page: Annotated[int, Query(ge=1, le=100_000)] = 1,
        size: Annotated[int, Query(ge=1, le=200)] = 50,
    ) -> OpmsPartPage:
        reader = _reader(request)
        onto = _onto(reader)
        rows = [onto.to_part(p) for p in reader.parts([class_code] if class_code else None)]
        if q:
            needle = q.strip().lower()
            rows = [p for p in rows if needle in p.part_no.lower() or needle in p.label.lower()]
        start = (page - 1) * size
        return OpmsPartPage(items=rows[start : start + size], total=len(rows), page=page, size=size)

    @r.get("/parts/{part_no}", response_model=OpmsPart, summary="OPMS 부품 하나", **_COMMON)
    def part(part_no: str, request: Request) -> OpmsPart:
        reader = _reader(request)
        raw = reader.part(part_no)
        if raw is None:
            raise not_found("PART_NOT_FOUND", f"OPMS 부품 {part_no}을(를) 찾을 수 없습니다")
        return _onto(reader).to_part(raw)

    @r.post("/match", response_model=OpmsMatchResult, summary="확정한 값으로 OPMS 부품 후보 찾기 (임시 판정)", **_COMMON)
    def match_parts(body: OpmsMatchRequest, request: Request) -> OpmsMatchResult:
        reader = _reader(request)
        return match(_onto(reader), reader, body)

    return r
