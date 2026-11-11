"""외부(ERP · MES) 읽기 사본 입구 (`/api/v1/pdm/feeds/*`). 근거: docs/change-impact-design.md 6.5.

- PDM 은 받아 두기만 한다. ERP · MES 에는 아무것도 쓰지 않는다.
- 인증이 아직 없어 임시 보호로 헤더 `X-PDM-Feed-Token` 을 설정(`PDM_FEED_TOKEN`)과 비교한다. 설정이 없으면 403 `FEED_NOT_CONFIGURED`.
- 한 요청에서 일부 행만 실패해도 나머지는 적용한다. 늦은 `as_of` 는 무시(`ignored_stale`), 모르는 품번 · 잘못된 행은 `rejected`.
- 형식은 **임시**다(실제 ERP · MES 전송 방식 미정, design 10.3-9).
"""

from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Request

from onto_pdm.changes.models import ChangeErrorCode
from onto_pdm.changes.service import ChangeService
from onto_pdm.contracts import FeedResult, PurchaseOrderLineFeedIn, StockLotFeedIn, WorkOrderFeedIn
from onto_pdm.errors import ERROR_RESPONSES, forbidden

PREFIX = "/api/v1/pdm"   # app.py 의 PREFIX 와 같다
_COMMON = {"responses": ERROR_RESPONSES}


def _service(request: Request, x_pdm_feed_token: Annotated[str | None, Header()] = None) -> ChangeService:
    svc: ChangeService = request.app.state.change_service
    if not svc.feed_token:
        raise forbidden(ChangeErrorCode.FEED_NOT_CONFIGURED, "외부 입력 토큰이 설정되지 않았어요(PDM_FEED_TOKEN). 입구가 닫혀 있어요")
    if x_pdm_feed_token is None or not hmac.compare_digest(x_pdm_feed_token.encode(), svc.feed_token.encode()):
        raise forbidden(ChangeErrorCode.FORBIDDEN, "외부 입력 토큰이 맞지 않아요")
    return svc


Svc = Annotated[ChangeService, Depends(_service)]


def build_feeds_router() -> APIRouter:
    r = APIRouter(prefix=f"{PREFIX}/feeds", tags=["feeds"])

    @r.post("/work-orders", response_model=FeedResult, summary="작업지시 읽기 사본 받기", **_COMMON)
    def work_orders(body: WorkOrderFeedIn, svc: Svc) -> FeedResult:
        return svc.feed_work_orders(body)

    @r.post("/purchase-order-lines", response_model=FeedResult, summary="발주 항목 읽기 사본 받기", **_COMMON)
    def purchase_order_lines(body: PurchaseOrderLineFeedIn, svc: Svc) -> FeedResult:
        return svc.feed_purchase_order_lines(body)

    @r.post("/stock-lots", response_model=FeedResult, summary="재고 로트 읽기 사본 받기", **_COMMON)
    def stock_lots(body: StockLotFeedIn, svc: Svc) -> FeedResult:
        return svc.feed_stock_lots(body)

    return r
