"""FastAPI 앱. 독립 앱이다 — OPMS 코드를 import 하지 않는다 (합성 지점은 backend/README.md 의 "OPMS와 합치기").

prefix 는 /api/v1/pdm. 응답은 snake_case 이고, 값이 없는 필드는 null 이 아니라 **빠진다**(웹의 optional 필드와 같다).
사용자는 헤더로 정한다: X-PDM-User: <login_id>(없으면 첫 사용자), X-PDM-Admin-Mode: 1(관리자 모드). 인증은 아직 없다.
"""

from __future__ import annotations

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
    BomSheetMatch,
    BomSheetMatchRequest,
    CadMatchRequest,
    CadPartMatch,
    DocumentLink,
    Health,
    ItemDetail,
    ItemPage,
    Material,
    PartRequest,
    PartRequestPayload,
    Product,
    ProductBom,
    RuleIssue,
    TaxonomyClass,
    User,
    WhereUsedRow,
)
from onto_pdm.errors import ERROR_RESPONSES, forbidden, install_error_handlers
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

    @r.post("/bom-sheet/match", response_model=list[BomSheetMatch], tags=["matching"], summary="BOM 시트 줄 → 보유 품번", **_COMMON)
    def bom_sheet_match(body: BomSheetMatchRequest, store: Store, s: Ctx) -> list[BomSheetMatch]:
        return store.match_bom_sheet(s, body.rows)

    @r.post("/assembly/guides", response_model=list[AssemblyGuide], tags=["rules"], summary="부품별 조립 안내 (규칙이 있는 부품만)", **_COMMON)
    def assembly_guides(body: AssemblyGuidesRequest, store: Store) -> list[AssemblyGuide]:
        return store.get_assembly_guides(body.parts)

    @r.get("/rules", response_model=list[AssemblyRuleSummary], tags=["rules"], **_COMMON)
    def rules(store: Store) -> list[AssemblyRuleSummary]:
        return store.list_assembly_rules()

    @r.get("/rules/validate", response_model=list[RuleIssue], tags=["rules"], summary="규칙 검증(기본 검사)", **_COMMON)
    def rules_validate(store: Store) -> list[RuleIssue]:
        return store.validate_assembly_rules()

    @r.get("/rules/{rule_id}", response_model=AssemblyRuleDetail, tags=["rules"], **_COMMON)
    def rule(rule_id: str, store: Store, s: Ctx) -> AssemblyRuleDetail:
        return store.get_assembly_rule(s, rule_id)

    # ---- 등록 요청 ----
    @r.get("/requests", response_model=list[PartRequest], tags=["requests"], **_COMMON)
    def requests_(store: Store, s: Ctx, scope: Annotated[str, Query(pattern="^(mine|all)$")] = "mine") -> list[PartRequest]:
        return store.list_part_requests(s, scope)

    @r.get("/requests/{request_id}", response_model=PartRequest, tags=["requests"], **_COMMON)
    def request_(request_id: int, store: Store, s: Ctx) -> PartRequest:
        return store.get_part_request(s, request_id)

    @r.post("/requests", response_model=PartRequest, status_code=201, tags=["requests"], summary="등록 요청 임시저장(새로 만들기)", **_COMMON)
    def request_create(body: PartRequestPayload, store: Store, s: Ctx) -> PartRequest:
        return store.save_part_request(s, None, body)

    @r.put("/requests/{request_id}", response_model=PartRequest, tags=["requests"], summary="임시저장 고치기", **_COMMON)
    def request_save(request_id: int, body: PartRequestPayload, store: Store, s: Ctx) -> PartRequest:
        return store.save_part_request(s, request_id, body)

    @r.post("/requests/{request_id}/submit", response_model=PartRequest, status_code=200, tags=["requests"],
            summary="제출: 중복 후보가 붙는다", **_COMMON)
    def request_submit(request_id: int, store: Store, s: Ctx) -> PartRequest:
        return store.submit_part_request(s, request_id)

    return r


def create_app(store: PdmStore | None = None) -> FastAPI:
    app = FastAPI(
        title="Onto PDM API", version="0.1.0",
        description=f"CAD · BOM · 사양서 관리, 조립 규칙, 부품 매칭. 계약 버전 {PDM_CONTRACT_VERSION}",
    )
    app.state.store = store if store is not None else InMemoryPdmStore()
    install_error_handlers(app)
    app.include_router(build_router())

    @app.get("/api/health", response_model=Health, tags=["health"])
    def health() -> Health:
        return Health()

    return app


app = create_app()
