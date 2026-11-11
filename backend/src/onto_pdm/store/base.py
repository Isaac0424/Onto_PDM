"""저장소 계층의 경계. 라우트는 이 Protocol 에만 의존한다 (OPMS 원칙 9: 라우트가 저장소 구현을 import 하지 않는다).

지금 구현은 InMemoryPdmStore(시드 데이터)이고, 같은 의미의 PostgreSQL 구현은 db/schema.sql 위에 나중에 붙는다 (docs/backend-plan.md).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from onto_pdm.contracts import (
    AssemblyGuide,
    AssemblyPartInput,
    AssemblyRuleDetail,
    AssemblyRuleSummary,
    BomNode,
    BomRule,
    CadPartMatch,
    DocumentLink,
    ItemDetail,
    ItemSummary,
    Material,
    Product,
    ProductBom,
    TaxonomyClass,
    User,
    WhereUsedRow,
)


@dataclass(frozen=True)
class Session:
    """요청한 사람. 관리자 역할(admin · approver)이어도 관리자 모드를 켜야 관리자로 본다."""

    user: User
    admin_mode: bool = False

    @property
    def is_admin(self) -> bool:
        return self.admin_mode and self.user.role in ("admin", "approver")


class PdmStore(Protocol):
    def list_users(self) -> list[User]: ...
    def find_user(self, login_id: str) -> User | None: ...
    def list_products(self) -> list[Product]: ...
    def list_classes(self) -> list[TaxonomyClass]: ...
    def list_materials(self) -> list[Material]: ...

    def list_items(self, s: Session, *, q: str | None = None, item_type: str | None = None, status: str | None = None,
                   product_id: int | None = None) -> list[ItemSummary]: ...
    def get_item(self, s: Session, item_no: str) -> ItemDetail: ...
    def get_bom(self, s: Session, revision_id: int, rule: BomRule) -> list[BomNode]: ...
    def get_product_bom(self, s: Session, code: str, rule: BomRule) -> ProductBom: ...
    def get_where_used(self, s: Session, item_id: int) -> list[WhereUsedRow]: ...
    def get_documents(self, s: Session, revision_id: int) -> list[DocumentLink]: ...

    def match_cad_parts(self, s: Session, names: list[str]) -> list[CadPartMatch]: ...
    def get_assembly_guides(self, parts: list[AssemblyPartInput]) -> list[AssemblyGuide]: ...
    def list_assembly_rules(self) -> list[AssemblyRuleSummary]: ...
    def get_assembly_rule(self, s: Session, rule_id: str) -> AssemblyRuleDetail: ...

    def export_publication(self, code: str) -> dict[str, Any]:
        """제품 하나의 **승인본**(released · obsolete 리비전)과 그 BOM · 별칭 · 재료를 그래프 발행용으로 내보낸다.

        사용자와 무관하다(발행은 시스템 작업이다). 작업중 · 검토중 리비전은 절대 들어가지 않는다.
        키는 snake_case: product, items, revisions, lines, current, identifiers, materials. docs/backend-plan.md 의 outbox 자리다.
        """
        ...
