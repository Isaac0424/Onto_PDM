"""FastAPI 앱. 독립 앱이다 — OPMS 코드를 import 하지 않는다 (합성 지점은 backend/README.md 의 "OPMS와 합치기").

prefix 는 /api/v1/pdm. 응답은 snake_case 이고, 값이 없는 필드는 null 이 아니라 **빠진다**(웹의 optional 필드와 같다).
사용자는 헤더로 정한다: X-PDM-User: <login_id>(없으면 첫 사용자), X-PDM-Admin-Mode: 1(관리자 모드). 인증은 아직 없다.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Header, Query, Request

from onto_pdm.contracts import (
    PDM_CONTRACT_VERSION,
    AssemblyGuide,
    AssemblyGuidesRequest,
    AssemblyRuleDetail,
    AssemblyRuleSummary,
    BomNode,
    BomRule,
    CadMatchRequest,
    CadPartMatch,
    DocumentLink,
    Health,
    ItemDetail,
    ItemPage,
    Material,
    Product,
    ProductBom,
    TaxonomyClass,
    User,
    WhereUsedRow,
)
from onto_pdm.api.changes_routes import build_changes_router
from onto_pdm.api.feeds_routes import build_feeds_router
from onto_pdm.api.opms_routes import build_opms_router
from onto_pdm.api.rulebook_routes import build_rulebook_router
from onto_pdm.changes.fixtures import brk_m8 as brk_m8_fixture
from onto_pdm.changes.service import ChangeService
from onto_pdm.changes.store import ChangeStore, InMemoryChangeStore
from onto_pdm.errors import ERROR_RESPONSES, forbidden, install_error_handlers
from onto_pdm.opms import OpmsReader, reader_from_env
from onto_pdm.rulebook import RulebookStore
from onto_pdm.store import InMemoryPdmStore, PdmStore, Session

PREFIX = "/api/v1/pdm"
PAGE_MAX = 100_000
SIZE_MAX = 500


def get_store(request: Request) -> PdmStore:
    return request.app.state.store  # type: ignore[no-any-return]


Store = Annotated[PdmStore, Depends(get_store)]


def get_session(
    store: Store,
    x_pdm_user: Annotated[str | None, Header()] = None,
    x_pdm_admin_mode: Annotated[str | None, Header()] = None,
) -> Session:
    users = store.list_users()
    user = store.find_user(x_pdm_user) if x_pdm_user else (users[0] if users else None)
    if user is None:
        raise forbidden("UNKNOWN_USER", "사용자가 없습니다")
    return Session(user=user, admin_mode=(x_pdm_admin_mode or "").strip() in ("1", "true", "on"))


Ctx = Annotated[Session, Depends(get_session)]

_COMMON = {"responses": ERROR_RESPONSES, "response_model_exclude_none": True}


def build_router() -> APIRouter:
    r = APIRouter(prefix=PREFIX)

    @r.get("/health", response_model=Health, tags=["health"])
    def health() -> Health:
        return Health()

    # ---- 기준 정보 ----
    @r.get("/users", response_model=list[User], tags=["reference"])
    def users(store: Store) -> list[User]:
        return store.list_users()

    @r.get("/products", response_model=list[Product], tags=["reference"], **_COMMON)
    def products(store: Store) -> list[Product]:
        return store.list_products()

    @r.get("/classes", response_model=list[TaxonomyClass], tags=["reference"], **_COMMON)
    def classes(store: Store) -> list[TaxonomyClass]:
        return store.list_classes()

    @r.get("/materials", response_model=list[Material], tags=["reference"], **_COMMON)
    def materials(store: Store) -> list[Material]:
        return store.list_materials()

    # ---- 품목 · BOM · 문서 ----
    @r.get("/items", response_model=ItemPage, tags=["items"], summary="품목 목록(검색 · 거르기)", **_COMMON)
    def items(
        store: Store, s: Ctx,
        q: str | None = None,
        item_type: Annotated[str | None, Query(pattern="^(assembly|part|standard|purchased)$")] = None,
        status: Annotated[str | None, Query(pattern="^(wip|in_review|released|obsolete)$")] = None,
        product_id: int | None = None,
        page: Annotated[int, Query(ge=1, le=PAGE_MAX)] = 1,
        size: Annotated[int, Query(ge=1, le=SIZE_MAX)] = 50,
    ) -> ItemPage:
        rows = store.list_items(s, q=q, item_type=item_type, status=status, product_id=product_id)
        start = (page - 1) * size
        return ItemPage(items=rows[start : start + size], total=len(rows), page=page, size=size)

    @r.get("/items/{item_no}", response_model=ItemDetail, tags=["items"], **_COMMON)
    def item(item_no: str, store: Store, s: Ctx) -> ItemDetail:
        return store.get_item(s, item_no)

    @r.get("/items/{item_id}/where-used", response_model=list[WhereUsedRow], tags=["items"], **_COMMON)
    def where_used(item_id: int, store: Store, s: Ctx) -> list[WhereUsedRow]:
        return store.get_where_used(s, item_id)

    @r.get("/revisions/{revision_id}/bom", response_model=list[BomNode], tags=["bom"], **_COMMON)
    def revision_bom(revision_id: int, store: Store, s: Ctx, rule: BomRule = "released") -> list[BomNode]:
        return store.get_bom(s, revision_id, rule)

    @r.get("/products/{code}/bom", response_model=ProductBom, tags=["bom"], summary="제품의 최상위 조립품과 BOM 트리", **_COMMON)
    def product_bom(code: str, store: Store, s: Ctx, rule: BomRule = "released") -> ProductBom:
        return store.get_product_bom(s, code, rule)

    @r.get("/documents", response_model=list[DocumentLink], tags=["documents"], **_COMMON)
    def documents(store: Store, s: Ctx, revision_id: Annotated[int, Query()]) -> list[DocumentLink]:
        return store.get_documents(s, revision_id)

    # ---- 매칭 · 조립 규칙 ----
    @r.post("/cad/match", response_model=list[CadPartMatch], tags=["matching"], summary="CAD 부품 이름 → 보유 품번", **_COMMON)
    def cad_match(body: CadMatchRequest, store: Store, s: Ctx) -> list[CadPartMatch]:
        return store.match_cad_parts(s, body.names)

    @r.post("/assembly/guides", response_model=list[AssemblyGuide], tags=["rules"], summary="부품별 조립 안내 (규칙이 있는 부품만)", **_COMMON)
    def assembly_guides(body: AssemblyGuidesRequest, store: Store) -> list[AssemblyGuide]:
        return store.get_assembly_guides(body.parts)

    @r.get("/rules", response_model=list[AssemblyRuleSummary], tags=["rules"], **_COMMON)
    def rules(store: Store) -> list[AssemblyRuleSummary]:
        return store.list_assembly_rules()

    @r.get("/rules/{rule_id}", response_model=AssemblyRuleDetail, tags=["rules"], **_COMMON)
    def rule(rule_id: str, store: Store, s: Ctx) -> AssemblyRuleDetail:
        return store.get_assembly_rule(s, rule_id)

    return r


def create_app(
    store: PdmStore | None = None, opms: OpmsReader | None = None, rulebook: RulebookStore | None = None,
    changes: ChangeStore | None = None, env: Mapping[str, str] | None = None,
) -> FastAPI:
    e = os.environ if env is None else env

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        yield
        app.state.opms.close()                                 # OPMS Neo4j 드라이버를 닫는다 (읽기 전용 연결)

    app = FastAPI(
        title="Onto PDM API", version="0.1.0", lifespan=lifespan,
        description=f"CAD · BOM · 사양서 관리, 조립 규칙, 부품 매칭. 계약 버전 {PDM_CONTRACT_VERSION}",
    )
    # 시험 · 시연 픽스처(앱 목 금지): PDM_FIXTURE=brk-m8 일 때만, 그리고 기본 시드와 섞이지 않게 **빈 시드 저장소**에만 올린다.
    fixture_on = brk_m8_fixture.fixture_enabled(e)
    app.state.store = store if store is not None else InMemoryPdmStore(brk_m8_fixture.empty_seed() if fixture_on else None)
    app.state.changes = changes if changes is not None else InMemoryChangeStore()
    if fixture_on and isinstance(app.state.store, InMemoryPdmStore):
        brk_m8_fixture.load_from_env(e, app.state.store, app.state.changes)
    # OPMS 읽기 어댑터: PDM_NEO4J_* 가 있으면 OPMS Neo4j 를 **읽기만** 한다. 없으면 /opms/* 가 503 (OPMS_NOT_CONFIGURED)
    app.state.opms = opms if opms is not None else reader_from_env()
    # 조립 규칙 · 작업표준서: 저장소의 rules/ YAML(PDM_RULES_DIR)을 읽기만 한다. 로드할 때 tools/check_rules.py 로 검증하고 오류면 /rulebook/* 가 503
    app.state.rulebook = rulebook if rulebook is not None else RulebookStore.from_env()
    # 설계 변경 영향 분석: 외부(ERP · MES) 입구는 PDM_FEED_TOKEN 이 있어야 열린다(없으면 403 FEED_NOT_CONFIGURED)
    app.state.change_service = ChangeService(app.state.store, app.state.changes, app.state.opms, feed_token=e.get("PDM_FEED_TOKEN") or None)
    install_error_handlers(app)
    app.include_router(build_router())
    app.include_router(build_opms_router())
    app.include_router(build_rulebook_router())
    app.include_router(build_changes_router())
    app.include_router(build_feeds_router())

    @app.get("/api/health", response_model=Health, tags=["health"])
    def health() -> Health:
        return Health()

    return app


app = create_app()
