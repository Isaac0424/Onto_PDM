"""설계 변경 영향 분석 라우트 (`/api/v1/pdm/changes/*`). 근거: docs/change-impact-design.md 6장.

- `{id}` 는 요청 코드(`CR-2026-0001`)다. 지시 코드(`CO-…`)도 받는다.
- 사용자는 기존과 같이 헤더 `X-PDM-User` · `X-PDM-Admin-Mode` 로 정한다(인증은 아직 없다). 승인 전 건은 작성자 · 관리자 모드만 본다.
- 오류 본문은 `{error:{code,message,details}}`(`errors.ApiException`)이다.
- 이 모듈은 `app.py` 가 가져오므로 `app.py` 를 되가져오지 않는다(세션 의존성은 같은 규칙으로 여기서 다시 만든다).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request, Response

from onto_pdm.changes.service import ChangeService
from onto_pdm.contracts import (
    ChangeCreateRequest,
    ChangeDetail,
    ChangeExport,
    ChangePage,
    ChangeRejectIn,
    ChangeReviewIn,
    ChangeReviewView,
    ChangeScopesIn,
    ChangeScopeView,
    ChangeTargetIn,
    ChangeTargetView,
    DispositionIn,
    DispositionView,
    ImpactGraphView,
    ImpactRunView,
    OntologyImpactView,
)
from onto_pdm.errors import ERROR_RESPONSES, forbidden
from onto_pdm.store import PdmStore, Session

PREFIX = "/api/v1/pdm"   # app.py 의 PREFIX 와 같다
_COMMON = {"responses": {**ERROR_RESPONSES, 503: {"description": "OPMS 를 읽을 수 없음"}}, "response_model_exclude_none": True}
SIZE_MAX = 500


def _service(request: Request) -> ChangeService:
    return request.app.state.change_service  # type: ignore[no-any-return]


def _session(
    request: Request,
    x_pdm_user: Annotated[str | None, Header()] = None,
    x_pdm_admin_mode: Annotated[str | None, Header()] = None,
) -> Session:
    store: PdmStore = request.app.state.store
    users = store.list_users()
    user = store.find_user(x_pdm_user) if x_pdm_user else (users[0] if users else None)
    if user is None:
        raise forbidden("UNKNOWN_USER", "사용자가 없습니다")
    return Session(user=user, admin_mode=(x_pdm_admin_mode or "").strip() in ("1", "true", "on"))


Svc = Annotated[ChangeService, Depends(_service)]
Ctx = Annotated[Session, Depends(_session)]


def build_changes_router() -> APIRouter:
    r = APIRouter(prefix=f"{PREFIX}/changes", tags=["changes"])

    # ---- 목록 · 만들기 ----
    @r.get("", response_model=ChangePage, summary="변경 요청 목록(상태 · 제품 · 검색)", **_COMMON)
    def list_changes(
        svc: Svc, s: Ctx, status: str | None = None, product: str | None = None, q: str | None = None,
        page: Annotated[int, Query(ge=1, le=100_000)] = 1, size: Annotated[int, Query(ge=1, le=SIZE_MAX)] = 50,
    ) -> ChangePage:
        return svc.list_changes(s, status=status, product=product, q=q, page=page, size=size)

    @r.post("", response_model=ChangeDetail, status_code=201, summary="변경 요청 만들기(요청 + 빈 지시)", **_COMMON)
    def create_change(body: ChangeCreateRequest, svc: Svc, s: Ctx) -> ChangeDetail:
        return svc.create_change(s, body)

    # 고정 경로는 `/{id}` 보다 앞에 둔다
    @r.get("/ontology-impact", response_model=OntologyImpactView, summary="온톨로지 버전 변경 보고(읽기 전용, 부품 개정을 만들지 않는다)", **_COMMON)
    def ontology_impact(svc: Svc, from_: Annotated[str | None, Query(alias="from")] = None, to: str | None = None) -> OntologyImpactView:
        return svc.ontology_impact(from_, to)

    # ---- 상세 · 대상 · 적용 범위 ----
    @r.get("/{code}", response_model=ChangeDetail, summary="변경 하나: 요청 · 지시 · 대상 · 최신 분석 · 처분 · 검토", **_COMMON)
    def get_change(code: str, svc: Svc, s: Ctx) -> ChangeDetail:
        return svc.get_detail(s, code)

    @r.post("/{code}/targets", response_model=ChangeTargetView, status_code=201, summary="변경 대상 추가", **_COMMON)
    def add_target(code: str, body: ChangeTargetIn, svc: Svc, s: Ctx) -> ChangeTargetView:
        return svc.add_target(s, code, body)

    @r.delete("/{code}/targets/{target_id}", status_code=204, summary="변경 대상 지우기", **_COMMON)
    def remove_target(code: str, target_id: int, svc: Svc, s: Ctx) -> Response:
        svc.remove_target(s, code, target_id)
        return Response(status_code=204)

    @r.put("/{code}/targets/{target_id}/scope", response_model=list[ChangeScopeView], summary="대상의 적용 범위 정하기", **_COMMON)
    def set_scope(code: str, target_id: int, body: ChangeScopesIn, svc: Svc, s: Ctx) -> list[ChangeScopeView]:
        return svc.set_scope(s, code, target_id, body)

    # ---- 영향 분석 · 처분 · 검토 ----
    @r.post("/{code}/impact", response_model=ImpactRunView, summary="영향 분석 실행(재계산). OPMS 를 못 읽으면 200 + partial", **_COMMON)
    def run_impact(code: str, svc: Svc, s: Ctx) -> ImpactRunView:
        return svc.run_impact(s, code)

    @r.get("/{code}/impact", response_model=ImpactRunView, summary="최신(또는 지정) 영향 분석", **_COMMON)
    def get_impact(code: str, svc: Svc, s: Ctx, run_id: int | None = None) -> ImpactRunView:
        return svc.get_impact(s, code, run_id)

    @r.get("/{code}/impact/graph", response_model=ImpactGraphView, summary="영향 그래프(3D · 목록 입력)", **_COMMON)
    def impact_graph(code: str, svc: Svc, s: Ctx) -> ImpactGraphView:
        return svc.impact_graph(s, code)

    @r.put("/{code}/dispositions/{finding_id}", response_model=DispositionView, summary="영향 하나의 처분 정하기(사람의 결정)", **_COMMON)
    def put_disposition(code: str, finding_id: int, body: DispositionIn, svc: Svc, s: Ctx) -> DispositionView:
        return svc.put_disposition(s, code, finding_id, body)

    @r.post("/{code}/reviews", response_model=ChangeReviewView, status_code=201, summary="설계 · 구매 · 생산 검토", **_COMMON)
    def add_review(code: str, body: ChangeReviewIn, svc: Svc, s: Ctx) -> ChangeReviewView:
        return svc.add_review(s, code, body)

    # ---- 접수 · 제출 · 승인 · 반려 · 내보내기 ----
    @r.post("/{code}/accept", response_model=ChangeDetail, summary="요청 접수", **_COMMON)
    def accept(code: str, svc: Svc, s: Ctx) -> ChangeDetail:
        return svc.accept(s, code)

    @r.post("/{code}/submit", response_model=ChangeDetail, summary="지시를 검토에 올리기", **_COMMON)
    def submit(code: str, svc: Svc, s: Ctx) -> ChangeDetail:
        return svc.submit(s, code)

    @r.post("/{code}/approve", response_model=ChangeDetail, summary="승인(새 개정 발행). blocked 가 남으면 거부", **_COMMON)
    def approve(code: str, svc: Svc, s: Ctx) -> ChangeDetail:
        return svc.approve(s, code)

    @r.post("/{code}/reject", response_model=ChangeDetail, summary="반려(사유 필수)", **_COMMON)
    def reject(code: str, body: ChangeRejectIn, svc: Svc, s: Ctx) -> ChangeDetail:
        return svc.reject(s, code, body)

    @r.get("/{code}/export", response_model=ChangeExport, summary="승인된 변경 내보내기(ERP · MES 에 쓰지 않는다)", **_COMMON)
    def export(code: str, svc: Svc, s: Ctx) -> ChangeExport:
        return svc.export(s, code)

    return r
