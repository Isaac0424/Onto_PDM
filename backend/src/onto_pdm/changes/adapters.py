"""영향 탐색 엔진 Protocol(`ports.py`)의 저장소 구현. 엔진은 이 어댑터를 통해서만 PDM · 외부 사본 · OPMS 를 읽는다.

- `PdmBomSource` — 기존 `PdmStore`(역전개 · BOM)를 **시스템 세션**으로 읽는다. 사용자 가시성은 라우트가 이미 거른다(영향 분석은 지시 단위로 돌아가고
  작성자가 본 데이터와 무관하게 같은 결과여야 하기 때문에 결정성을 위해 시스템 관점으로 읽는다).
- `ChangeExternalSource` · `ChangeSpecSource` — `ChangeStore`(작업지시 · 발주 · 재고 · 체결 구성 · 개정별 사양).
- OPMS 값은 `ports.ReaderPartSource(OpmsReader)` 가 맡는다(OPMS 를 못 읽으면 `OpmsUnavailable` → 엔진의 partial 경로).
"""

from __future__ import annotations

from collections.abc import Collection, Sequence

from onto_pdm.changes.impact import compare_lines
from onto_pdm.changes.models import FasteningJoint, PurchaseOrderLine, RevisionSpec, StockLot, WorkOrder
from onto_pdm.changes.ports import BomDiffLine, BomLine, ExternalState, UsageRow
from onto_pdm.changes.store import ChangeStore
from onto_pdm.contracts import Revision, User
from onto_pdm.errors import ApiException
from onto_pdm.store.base import PdmStore, Session

_SYSTEM = Session(user=User(id=0, login_id="system", name="system", role="admin"), admin_mode=True)


def system_session() -> Session:
    """작성자와 무관하게 모든 승인 · 작업중 리비전을 보는 시스템 세션(영향 탐색 · 승인 발행 전용)."""
    return _SYSTEM


class PdmBomSource:
    """`BomSource`: 기존 `PdmStore` 의 역전개와 BOM 전개 위에 얹는다."""

    def __init__(self, store: PdmStore) -> None:
        self._store = store
        self._products: dict[str, str] | None = None

    # ---- 내부 ----
    def _product_of_root(self, item_no: str) -> str | None:
        if self._products is None:
            self._products = {p.root_item_no: p.code for p in self._store.list_products()}
        return self._products.get(item_no)

    def revisions(self, item_no: str) -> list[Revision]:
        try:
            return list(self._store.get_item(_SYSTEM, item_no).revisions)      # 최신이 앞
        except ApiException as e:
            if e.status == 404:
                return []
            raise

    def current_revision(self, item_no: str) -> Revision | None:
        """현재 승인본: 폐기되지 않은 released 중 가장 최신. 승인본이 없으면 None."""
        released = [r for r in self.revisions(item_no) if r.status == "released"]
        return max(released, key=lambda r: r.rev_seq) if released else None

    def revision(self, item_no: str, rev: str | None) -> Revision | None:
        if rev is None:
            return self.current_revision(item_no)
        return next((r for r in self.revisions(item_no) if r.rev == rev), None)

    # ---- BomSource ----
    def where_used(self, item_no: str) -> Sequence[UsageRow]:
        try:
            detail = self._store.get_item(_SYSTEM, item_no)
        except ApiException as e:
            if e.status == 404:
                return []
            raise
        rows = self._store.get_where_used(_SYSTEM, detail.id)
        out: list[UsageRow] = []
        stack: list[tuple[str, float]] = []            # 깊이별 (상위 품번, 그 줄 수량). 저장소의 역전개는 깊이 우선 순서다
        for w in rows:
            del stack[w.depth - 1:]
            stack.append((w.parent.item_no, w.quantity))
            qty = 1.0
            for _, q in stack:
                qty *= q
            out.append(UsageRow(
                item_no=w.parent.item_no, revision=w.parent_revision.rev, depth=w.depth,
                path=(item_no, *(no for no, _ in stack)), quantity=qty,
                product_code=self._product_of_root(w.parent.item_no), name=w.parent.name_ko or w.parent.name))
        return out

    def bom_lines(self, item_no: str, revision: str | None = None) -> Sequence[BomLine]:
        rev = self.revision(item_no, revision)
        if rev is None:
            return []
        nodes = self._store.get_bom(_SYSTEM, rev.id, "released")
        return [BomLine(item_no=n.item.item_no, quantity=n.quantity, find_no=n.find_no) for n in nodes]

    def compare_revisions(self, item_no: str, rev_a: str, rev_b: str) -> Sequence[BomDiffLine]:
        return compare_lines(self.bom_lines(item_no, rev_a), self.bom_lines(item_no, rev_b))


class ChangeExternalSource:
    """`ExternalSource`: ERP · MES 읽기 사본(`ChangeStore`)."""

    def __init__(self, changes: ChangeStore) -> None:
        self._changes = changes

    def work_orders(self, item_nos: Collection[str]) -> Sequence[WorkOrder]:
        wanted = set(item_nos)
        return [w for w in self._changes.list_work_orders()
                if w.product_item_no in wanted or any(ref.item_no in wanted for ref in w.bom_refs)]

    def purchase_order_lines(self, item_no: str) -> Sequence[PurchaseOrderLine]:
        return self._changes.list_purchase_order_lines(item_no=item_no)

    def stock_lots(self, item_no: str) -> Sequence[StockLot]:
        return self._changes.list_stock_lots(item_no=item_no)

    def external_state(self) -> ExternalState:
        counts = {
            "work_order": len(self._changes.list_work_orders()),
            "purchase_order_line": len(self._changes.list_purchase_order_lines()),
            "stock_lot": len(self._changes.list_stock_lots()),
        }
        return ExternalState(as_of=dict(self._changes.external_as_of()), counts={k: v for k, v in counts.items() if v})


class ChangeSpecSource:
    """`SpecSource`: 체결 구성과 개정별 PDM 소유 수치. `revision=None` 은 그 품목의 현재 승인본이다."""

    def __init__(self, changes: ChangeStore, bom: PdmBomSource) -> None:
        self._changes = changes
        self._bom = bom

    def _rev_label(self, item_no: str, revision: str | None) -> str | None:
        if revision is not None:
            return revision
        cur = self._bom.current_revision(item_no)
        return cur.rev if cur else None

    def joints_for(self, assembly_item_no: str, assembly_revision: str | None = None) -> Sequence[FasteningJoint]:
        label = self._rev_label(assembly_item_no, assembly_revision)
        if label is None:
            return []
        return self._changes.list_joints(assembly_item_no, label)

    def spec_value(self, item_no: str, key: str, revision: str | None = None) -> RevisionSpec | None:
        label = self._rev_label(item_no, revision)
        if label is None:
            return None
        return next((s for s in self._changes.list_revision_specs(item_no, label) if s.key == key), None)


__all__ = ["system_session", "PdmBomSource", "ChangeExternalSource", "ChangeSpecSource"]
