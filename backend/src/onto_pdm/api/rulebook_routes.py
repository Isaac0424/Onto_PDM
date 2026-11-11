"""조립 규칙 · 작업표준서 읽기 라우트 (`/api/v1/pdm/rulebook/*`). 정본은 저장소의 `rules/` YAML 이고 이 API 는 **읽기 전용**이다(쓰기 경로 없음).

`/status` 는 예외로 규칙이 읽히지 않아도 200 으로 답하고 state 로 이유를 말한다(ok · invalid · unavailable).
나머지는 규칙을 읽지 못하면 503 이다: `RULEBOOK_INVALID`(검증 오류 목록 포함) · `RULEBOOK_UNAVAILABLE`(파일 없음 · 읽기 실패).
값이 없는 항목(source: unknown)은 `value: null` + `gap_id` 로 그대로 나간다 — 빠뜨리거나 지어내지 않는다.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request

from onto_pdm.errors import ERROR_RESPONSES, ApiException, not_found
from onto_pdm.rulebook.build import Rulebook
from onto_pdm.rulebook.models import (
    Gap,
    OperationList,
    Rule,
    RulebookStatus,
    SelectRequest,
    SelectResponse,
    Tool,
    WorkStandard,
    WorkStandardSummary,
)
from onto_pdm.rulebook.select import select_rules
from onto_pdm.rulebook.store import RulebookStore

PREFIX = "/api/v1/pdm"   # app.py 의 PREFIX 와 같다 (app.py 가 이 모듈을 가져오므로 되가져오지 않는다)
_ERRORS_MAX = 100
_COMMON = {"responses": {**ERROR_RESPONSES, 503: {"description": "rules/ 를 읽을 수 없음 (RULEBOOK_INVALID · RULEBOOK_UNAVAILABLE)"}}}
Grade = Literal["manual", "standard", "cad", "unknown"]


def _store(request: Request) -> RulebookStore:
    return request.app.state.rulebook  # type: ignore[no-any-return]


def _book(request: Request) -> Rulebook:
    snap = _store(request).snapshot()
    if snap.state == "ok" and snap.book is not None:
        return snap.book
    if snap.state == "invalid" and snap.validation is not None:
        errors = snap.validation.errors
        raise ApiException(
            503, "RULEBOOK_INVALID", f"조립 규칙 · 작업표준(rules/)에 오류가 {len(errors)}건 있어 내보내지 않습니다. 고친 뒤 다시 요청하세요",
            details={"errors": [{"where": e.where, "message": e.message} for e in errors[:_ERRORS_MAX]], "total": len(errors)},
        )
    raise ApiException(503, "RULEBOOK_UNAVAILABLE", snap.message or "조립 규칙 · 작업표준(rules/)을 읽을 수 없습니다")


def _match(needle: str | None, *texts: str | None) -> bool:
    if not needle:
        return True
    n = needle.strip().lower()
    return any(n in (t or "").lower() for t in texts)


def build_rulebook_router() -> APIRouter:
    r = APIRouter(prefix=f"{PREFIX}/rulebook", tags=["rulebook"])

    @r.get("/status", response_model=RulebookStatus, summary="조립 규칙 · 작업표준 적재 상태 · 개수 · 출처 등급별 값 · 검증 결과")
    def status(request: Request) -> RulebookStatus:
        return _store(request).status()

    @r.get("/rules", response_model=list[Rule], summary="조립 규칙 목록 (필터)", **_COMMON)
    def rules(
        request: Request,
        class_code: Annotated[str | None, Query(description="규칙의 대상 분류(classes · proposed_classes)에 이 코드가 있는 것")] = None,
        role: str | None = None,
        operation: str | None = None,
        model: Annotated[str | None, Query(description="로봇 모델(HCR-3A …). 모델 제한이 없는 규칙도 포함")] = None,
        source: Annotated[Grade | None, Query(description="이 출처 등급의 값을 하나라도 가진 규칙")] = None,
        gap: Annotated[str | None, Query(description="이 공백(G-0xx)과 이어진 규칙")] = None,
        scope: Literal["part", "role", "product"] | None = None,
        q: str | None = None,
    ) -> list[Rule]:
        book = _book(request)
        out: list[Rule] = []
        for rule in book.rules.values():
            ap = rule.applies_to
            if class_code and class_code not in (*ap.classes, *ap.proposed_classes):
                continue
            if role and ap.role != role:
                continue
            if operation and rule.operation != operation:
                continue
            if model and ap.models and model not in ap.models:
                continue
            if source and rule.by_grade.get(source, 0) == 0:
                continue
            if gap and gap not in rule.gap_ids:
                continue
            if scope and rule.scope != scope:
                continue
            if not _match(q, rule.id, rule.name, rule.note, rule.operation_label, ap.role_label, *(c.text for c in rule.cautions)):
                continue
            out.append(rule)
        return out

    @r.get("/rules/{rule_id}", response_model=Rule, summary="조립 규칙 하나", **_COMMON)
    def rule(rule_id: str, request: Request) -> Rule:
        found = _book(request).rules.get(rule_id)
        if found is None:
            raise not_found("RULE_NOT_FOUND", f"조립 규칙 {rule_id}을(를) 찾을 수 없습니다")
        return found

    @r.get("/operations", response_model=OperationList, summary="공정 어휘 트리와, 근거가 없어 만들지 않은 공정", **_COMMON)
    def operations(request: Request) -> OperationList:
        book = _book(request)
        return OperationList(operations=list(book.operations.values()), not_covered=list(book.not_covered.values()))

    @r.get("/tools", response_model=list[Tool], summary="공구 목록 (규격이 비어 있는 곳은 gap)", **_COMMON)
    def tools(request: Request) -> list[Tool]:
        return list(_book(request).tools.values())

    @r.get("/work-standards", response_model=list[WorkStandardSummary], summary="작업표준서 목록 (필터)", **_COMMON)
    def work_standards(
        request: Request,
        model: str | None = None,
        kind: Literal["procedure", "structure_only"] | None = None,
        rule_id: Annotated[str | None, Query(alias="rule", description="이 규칙을 쓰는 작업표준서")] = None,
        tool: str | None = None,
        q: str | None = None,
    ) -> list[WorkStandardSummary]:
        book = _book(request)
        out: list[WorkStandardSummary] = []
        for ws in book.work_standards.values():
            if model and model not in ws.models:
                continue
            if kind and ws.kind != kind:
                continue
            if rule_id and rule_id not in ws.rules:
                continue
            if tool and tool not in ws.tools:
                continue
            if not _match(q, ws.id, ws.title, ws.purpose, *(s.text for s in ws.steps)):
                continue
            out.append(book.summary_of(ws))
        return out

    @r.get("/work-standards/{work_standard_id}", response_model=WorkStandard, summary="작업표준서 하나 (단계 · 점검 항목 · 근거)", **_COMMON)
    def work_standard(work_standard_id: str, request: Request) -> WorkStandard:
        found = _book(request).work_standards.get(work_standard_id)
        if found is None:
            raise not_found("WORK_STANDARD_NOT_FOUND", f"작업표준서 {work_standard_id}을(를) 찾을 수 없습니다")
        return found

    @r.get("/gaps", response_model=list[Gap], summary="작성이 필요한 공백(근거가 없어 값을 비워 둔 곳)", **_COMMON)
    def gaps(request: Request) -> list[Gap]:
        return list(_book(request).gaps.values())

    @r.post("/select", response_model=SelectResponse, summary="확정한 분류 · 속성으로 적용되는 규칙 고르기 (값이 없는 조건은 미확인)", **_COMMON)
    def select(body: SelectRequest, request: Request) -> SelectResponse:
        return select_rules(_book(request), body)

    return r
