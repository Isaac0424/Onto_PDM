"""변경 영향 분석의 저장소 경계와 메모리 구현. 근거: docs/change-impact-design.md 2.1 · 3 · 6.5.

- `PdmStore`(store/base.py)에는 메서드를 더하지 않고 `ChangeStore` 를 따로 둔다. 역전개 · BOM 은 기존 `PdmStore` 를 그대로 쓴다.
- **저장만 한다.** 승인(새 개정 발행)과 영향 탐색은 service · impact 의 몫이다.
- 사용자(`Session`)를 받는 메서드는 가시성 규칙을 적용한다: 승인 전(요청 `draft` · 지시 `draft`) 변경은 작성자와 관리자 모드만 본다.
  `Session` 이 없는 메서드는 서비스 · 엔진(시스템)이 쓰는 것이라 가시성을 보지 않는다.
- 작성자는 `User.login_id` 와 `ChangeRequest.requested_by` 문자열로 비교한다.
- 모델은 값 객체(frozen)다. 저장소는 id 를 붙인 새 모델을 만들어 보관하고, 읽을 때 깊은 복사본을 돌려준다.
- 외부(ERP · MES) 읽기 사본은 `as_of` 가 더 오래된 값으로 덮어쓰지 않는다(design 6.5 "feed 늦은 값 무시").
"""

from __future__ import annotations

import threading
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Literal, Protocol, TypeVar

from onto_pdm.changes.models import (
    ApplicabilityScope,
    ChangeErrorCode,
    ChangeOrder,
    ChangeRequest,
    ChangeReview,
    ChangeTarget,
    Disposition,
    FasteningJoint,
    ImpactFinding,
    ImpactRun,
    OntologyImpact,
    PurchaseOrderLine,
    RevisionSpec,
    StockLot,
    WorkOrder,
)
from onto_pdm.errors import not_found
from onto_pdm.store.base import Session

UpsertResult = Literal["inserted", "updated", "ignored_older"]
ExternalKind = Literal["work_order", "purchase_order_line", "stock_lot"]

_M = TypeVar("_M", WorkOrder, PurchaseOrderLine, StockLot)


class ChangeStore(Protocol):
    # ---------- 코드 · 요청 · 지시 ----------
    def next_code(self, prefix: Literal["CR", "CO"], year: int) -> str: ...
    def create_request(self, req: ChangeRequest) -> ChangeRequest: ...
    def get_request(self, code: str) -> ChangeRequest | None: ...
    def find_request(self, s: Session, code: str) -> ChangeRequest: ...
    def list_requests(self, s: Session, *, status: str | None = None, product_code: str | None = None,
                      q: str | None = None) -> list[ChangeRequest]: ...
    def update_request(self, req: ChangeRequest) -> ChangeRequest: ...
    def create_order(self, order: ChangeOrder) -> ChangeOrder: ...
    def get_order(self, code: str) -> ChangeOrder | None: ...
    def get_order_for_request(self, request_code: str) -> ChangeOrder | None: ...
    def find_order(self, s: Session, code: str) -> ChangeOrder: ...
    def update_order(self, order: ChangeOrder) -> ChangeOrder: ...

    # ---------- 대상 · 적용 범위 ----------
    def add_target(self, order_code: str, target: ChangeTarget) -> ChangeTarget: ...
    def list_targets(self, order_code: str) -> list[ChangeTarget]: ...
    def get_target(self, order_code: str, target_id: int) -> ChangeTarget | None: ...
    def remove_target(self, order_code: str, target_id: int) -> bool: ...
    def set_scopes(self, order_code: str, target_id: int, scopes: Sequence[ApplicabilityScope]) -> ChangeTarget: ...

    # ---------- 영향 분석 실행 · 발견 ----------
    def add_run(self, run: ImpactRun) -> ImpactRun: ...
    def get_run(self, order_code: str, run_id: int | None = None) -> ImpactRun | None: ...
    def list_runs(self, order_code: str) -> list[ImpactRun]: ...
    def mark_stale(self, order_code: str, reasons: Sequence[str]) -> ImpactRun | None: ...
    def find_finding(self, order_code: str, finding_id: int) -> ImpactFinding | None: ...

    # ---------- 처분 · 검토 ----------
    def put_disposition(self, d: Disposition) -> Disposition: ...
    def list_dispositions(self, order_code: str, *, include_superseded: bool = False) -> list[Disposition]: ...
    def add_review(self, r: ChangeReview) -> ChangeReview: ...
    def list_reviews(self, order_code: str, *, run_id: int | None = None) -> list[ChangeReview]: ...

    # ---------- 온톨로지 변경 보고 · 개정별 사양 · 체결 구성 ----------
    def add_ontology_impact(self, o: OntologyImpact) -> OntologyImpact: ...
    def list_ontology_impacts(self) -> list[OntologyImpact]: ...
    def put_revision_spec(self, spec: RevisionSpec) -> RevisionSpec: ...
    def list_revision_specs(self, item_no: str, revision: str | None = None) -> list[RevisionSpec]: ...
    def put_joint(self, joint: FasteningJoint) -> FasteningJoint: ...
    def list_joints(self, assembly_item_no: str, assembly_revision: str | None = None) -> list[FasteningJoint]: ...

    # ---------- 외부(ERP · MES) 읽기 사본 ----------
    def upsert_work_order(self, wo: WorkOrder) -> UpsertResult: ...
    def upsert_purchase_order_line(self, line: PurchaseOrderLine) -> UpsertResult: ...
    def upsert_stock_lot(self, lot: StockLot) -> UpsertResult: ...
    def get_work_order(self, wo_no: str) -> WorkOrder | None: ...
    def list_work_orders(self, *, product_item_no: str | None = None, status: str | None = None,
                         site: str | None = None) -> list[WorkOrder]: ...
    def list_purchase_order_lines(self, *, item_no: str | None = None, only_open: bool = False) -> list[PurchaseOrderLine]: ...
    def list_stock_lots(self, *, item_no: str | None = None, site: str | None = None) -> list[StockLot]: ...
    def external_as_of(self) -> dict[ExternalKind, datetime]: ...


def _author_or_admin(s: Session, author: str) -> bool:
    return s.is_admin or s.user.login_id == author


class InMemoryChangeStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.reset()

    def reset(self) -> None:
        with self._lock:
            self._requests: dict[str, ChangeRequest] = {}
            self._orders: dict[str, ChangeOrder] = {}
            self._targets: dict[str, list[ChangeTarget]] = {}          # order_code -> 대상
            self._runs: dict[str, list[ImpactRun]] = {}                # order_code -> 실행(쌓는다)
            self._dispositions: dict[str, list[Disposition]] = {}
            self._reviews: dict[str, list[ChangeReview]] = {}
            self._ontology_impacts: list[OntologyImpact] = []
            self._specs: dict[tuple[str, str, str], RevisionSpec] = {}
            self._joints: list[FasteningJoint] = []
            self._work_orders: dict[str, WorkOrder] = {}
            self._po_lines: dict[tuple[str, int], PurchaseOrderLine] = {}
            self._stock_lots: dict[str, StockLot] = {}
            self._seq: dict[str, int] = {}

    def _next_id(self, name: str) -> int:
        self._seq[name] = self._seq.get(name, 0) + 1
        return self._seq[name]

    # ---------- 가시성 ----------

    def _can_see_request(self, s: Session, req: ChangeRequest) -> bool:
        return req.status != "draft" or _author_or_admin(s, req.requested_by)

    def _can_see_order(self, s: Session, order: ChangeOrder) -> bool:
        req = self._requests.get(order.request_code)
        author = req.requested_by if req else ""
        return order.status != "draft" or _author_or_admin(s, author)

    # ---------- 코드 · 요청 · 지시 ----------

    def next_code(self, prefix: Literal["CR", "CO"], year: int) -> str:
        with self._lock:
            used = self._requests if prefix == "CR" else self._orders
            head = f"{prefix}-{year}-"
            nums = [int(c.rsplit("-", 1)[1]) for c in used if c.startswith(head)]
            return f"{head}{(max(nums) if nums else 0) + 1:04d}"

    def create_request(self, req: ChangeRequest) -> ChangeRequest:
        with self._lock:
            if req.code in self._requests:
                raise ValueError(f"변경 요청 코드 {req.code} 가 이미 있습니다")
            saved = req.model_copy(update={"id": self._next_id("request")})
            self._requests[saved.code] = saved
            return saved.model_copy(deep=True)

    def get_request(self, code: str) -> ChangeRequest | None:
        with self._lock:
            r = self._requests.get(code)
            return r.model_copy(deep=True) if r else None

    def find_request(self, s: Session, code: str) -> ChangeRequest:
        with self._lock:
            r = self._requests.get(code)
            if r is None or not self._can_see_request(s, r):
                raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"변경 요청 {code}을(를) 찾을 수 없습니다")
            return r.model_copy(deep=True)

    def list_requests(self, s: Session, *, status: str | None = None, product_code: str | None = None,
                      q: str | None = None) -> list[ChangeRequest]:
        with self._lock:
            needle = (q or "").strip().lower()
            rows = [r for r in self._requests.values() if self._can_see_request(s, r)]
            if status:
                rows = [r for r in rows if r.status == status]
            if product_code:
                rows = [r for r in rows if r.product_code == product_code]
            if needle:
                rows = [r for r in rows if needle in f"{r.code} {r.title} {r.reason}".lower()]
            return [r.model_copy(deep=True) for r in sorted(rows, key=lambda r: r.code)]

    def update_request(self, req: ChangeRequest) -> ChangeRequest:
        with self._lock:
            old = self._requests.get(req.code)
            if old is None:
                raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"변경 요청 {req.code}을(를) 찾을 수 없습니다")
            saved = req.model_copy(update={"id": old.id})
            self._requests[saved.code] = saved
            return saved.model_copy(deep=True)

    def create_order(self, order: ChangeOrder) -> ChangeOrder:
        with self._lock:
            if order.code in self._orders:
                raise ValueError(f"변경 지시 코드 {order.code} 가 이미 있습니다")
            if order.request_code not in self._requests:
                raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"변경 요청 {order.request_code}을(를) 찾을 수 없습니다")
            if self.get_order_for_request(order.request_code) is not None:
                raise ValueError(f"변경 요청 {order.request_code} 에는 이미 지시가 있습니다(요청 1 : 지시 1)")
            saved = order.model_copy(update={"id": self._next_id("order")})
            self._orders[saved.code] = saved
            self._targets[saved.code] = []
            return saved.model_copy(deep=True)

    def get_order(self, code: str) -> ChangeOrder | None:
        with self._lock:
            o = self._orders.get(code)
            return o.model_copy(deep=True) if o else None

    def get_order_for_request(self, request_code: str) -> ChangeOrder | None:
        with self._lock:
            o = next((x for x in self._orders.values() if x.request_code == request_code), None)
            return o.model_copy(deep=True) if o else None

    def find_order(self, s: Session, code: str) -> ChangeOrder:
        with self._lock:
            o = self._orders.get(code)
            if o is None or not self._can_see_order(s, o):
                raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"변경 지시 {code}을(를) 찾을 수 없습니다")
            return o.model_copy(deep=True)

    def update_order(self, order: ChangeOrder) -> ChangeOrder:
        with self._lock:
            old = self._orders.get(order.code)
            if old is None:
                raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"변경 지시 {order.code}을(를) 찾을 수 없습니다")
            saved = order.model_copy(update={"id": old.id})
            self._orders[saved.code] = saved
            return saved.model_copy(deep=True)

    # ---------- 대상 · 적용 범위 ----------

    def _order_targets(self, order_code: str) -> list[ChangeTarget]:
        if order_code not in self._orders:
            raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"변경 지시 {order_code}을(를) 찾을 수 없습니다")
        return self._targets.setdefault(order_code, [])

    def _with_scope_ids(self, scopes: Sequence[ApplicabilityScope]) -> tuple[ApplicabilityScope, ...]:
        return tuple(sc.model_copy(update={"id": self._next_id("scope")}) for sc in scopes)

    def add_target(self, order_code: str, target: ChangeTarget) -> ChangeTarget:
        with self._lock:
            rows = self._order_targets(order_code)
            key = (target.item_no, target.change_kind, target.to_revision, target.replacement_item_no)
            if any((t.item_no, t.change_kind, t.to_revision, t.replacement_item_no) == key for t in rows):
                raise ValueError("같은 품목 · 종류의 대상을 한 지시에서 두 번 잡을 수 없습니다")
            saved = target.model_copy(update={"id": self._next_id("target"), "scopes": self._with_scope_ids(target.scopes)})
            rows.append(saved)
            return saved.model_copy(deep=True)

    def list_targets(self, order_code: str) -> list[ChangeTarget]:
        with self._lock:
            return [t.model_copy(deep=True) for t in self._order_targets(order_code)]

    def get_target(self, order_code: str, target_id: int) -> ChangeTarget | None:
        with self._lock:
            t = next((x for x in self._order_targets(order_code) if x.id == target_id), None)
            return t.model_copy(deep=True) if t else None

    def remove_target(self, order_code: str, target_id: int) -> bool:
        with self._lock:
            rows = self._order_targets(order_code)
            kept = [t for t in rows if t.id != target_id]
            removed = len(kept) != len(rows)
            self._targets[order_code] = kept
            return removed

    def set_scopes(self, order_code: str, target_id: int, scopes: Sequence[ApplicabilityScope]) -> ChangeTarget:
        with self._lock:
            rows = self._order_targets(order_code)
            for i, t in enumerate(rows):
                if t.id == target_id:
                    rows[i] = t.model_copy(update={"scopes": self._with_scope_ids(scopes)})
                    return rows[i].model_copy(deep=True)
            raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"대상 {target_id}을(를) 찾을 수 없습니다")

    # ---------- 영향 분석 실행 · 발견 ----------

    def add_run(self, run: ImpactRun) -> ImpactRun:
        with self._lock:
            if run.order_code not in self._orders:
                raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"변경 지시 {run.order_code}을(를) 찾을 수 없습니다")
            run_id = self._next_id("run")
            findings = tuple(f.model_copy(update={"id": self._next_id("finding"), "run_id": run_id}) for f in run.findings)
            saved = run.model_copy(update={"id": run_id, "findings": findings})
            self._runs.setdefault(run.order_code, []).append(saved)
            return saved.model_copy(deep=True)

    def get_run(self, order_code: str, run_id: int | None = None) -> ImpactRun | None:
        with self._lock:
            runs = self._runs.get(order_code, [])
            if run_id is None:
                r = runs[-1] if runs else None
            else:
                r = next((x for x in runs if x.id == run_id), None)
            return r.model_copy(deep=True) if r else None

    def list_runs(self, order_code: str) -> list[ImpactRun]:
        with self._lock:
            return [r.model_copy(deep=True) for r in self._runs.get(order_code, [])]

    def mark_stale(self, order_code: str, reasons: Sequence[str]) -> ImpactRun | None:
        """최신 분석을 낡음(stale)으로 표시한다. 외부 데이터가 새로 오거나 대상 · 범위가 바뀔 때 service 가 부른다."""
        with self._lock:
            runs = self._runs.get(order_code, [])
            if not runs:
                return None
            last = runs[-1]
            merged = tuple(dict.fromkeys([*last.stale_reasons, *reasons]))
            runs[-1] = last.model_copy(update={"stale": True, "stale_reasons": merged})
            return runs[-1].model_copy(deep=True)

    def find_finding(self, order_code: str, finding_id: int) -> ImpactFinding | None:
        with self._lock:
            for run in self._runs.get(order_code, []):
                for f in run.findings:
                    if f.id == finding_id:
                        return f.model_copy(deep=True)
            return None

    # ---------- 처분 · 검토 ----------

    def put_disposition(self, d: Disposition) -> Disposition:
        """한 영향(finding)에는 유효한 처분이 하나다. 새로 정하면 이전 처분은 이력으로 남고 `superseded_by` 가 붙는다."""
        with self._lock:
            if self.find_finding(d.order_code, d.finding_id) is None:
                raise not_found("FINDING_NOT_FOUND", f"영향 {d.finding_id}을(를) 찾을 수 없습니다")
            rows = self._dispositions.setdefault(d.order_code, [])
            saved = d.model_copy(update={"id": self._next_id("disposition"), "superseded_by": None})
            for i, old in enumerate(rows):
                if old.finding_id == d.finding_id and old.superseded_by is None:
                    rows[i] = old.model_copy(update={"superseded_by": saved.id})
            rows.append(saved)
            return saved.model_copy(deep=True)

    def list_dispositions(self, order_code: str, *, include_superseded: bool = False) -> list[Disposition]:
        with self._lock:
            rows = self._dispositions.get(order_code, [])
            return [d.model_copy(deep=True) for d in rows if include_superseded or d.superseded_by is None]

    def add_review(self, r: ChangeReview) -> ChangeReview:
        with self._lock:
            if r.order_code not in self._orders:
                raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"변경 지시 {r.order_code}을(를) 찾을 수 없습니다")
            saved = r.model_copy(update={"id": self._next_id("review")})
            self._reviews.setdefault(r.order_code, []).append(saved)
            return saved.model_copy(deep=True)

    def list_reviews(self, order_code: str, *, run_id: int | None = None) -> list[ChangeReview]:
        with self._lock:
            rows = self._reviews.get(order_code, [])
            return [r.model_copy(deep=True) for r in rows if run_id is None or r.run_id == run_id]

    # ---------- 온톨로지 변경 보고 · 개정별 사양 · 체결 구성 ----------

    def add_ontology_impact(self, o: OntologyImpact) -> OntologyImpact:
        with self._lock:
            saved = o.model_copy(update={"id": self._next_id("ontology_impact")})
            self._ontology_impacts.append(saved)
            return saved.model_copy(deep=True)

    def list_ontology_impacts(self) -> list[OntologyImpact]:
        with self._lock:
            return [o.model_copy(deep=True) for o in self._ontology_impacts]

    def put_revision_spec(self, spec: RevisionSpec) -> RevisionSpec:
        with self._lock:
            self._specs[(spec.item_no, spec.revision, spec.key)] = spec
            return spec.model_copy(deep=True)

    def list_revision_specs(self, item_no: str, revision: str | None = None) -> list[RevisionSpec]:
        with self._lock:
            return [s.model_copy(deep=True) for (i, r, _), s in sorted(self._specs.items())
                    if i == item_no and (revision is None or r == revision)]

    def put_joint(self, joint: FasteningJoint) -> FasteningJoint:
        with self._lock:
            same = [j for j in self._joints
                    if (j.assembly_item_no, j.assembly_revision, j.name) == (joint.assembly_item_no, joint.assembly_revision, joint.name)]
            if same:
                raise ValueError(f"체결부 {joint.name} 이(가) 이미 있습니다")
            saved = joint.model_copy(update={"id": self._next_id("joint")})
            self._joints.append(saved)
            return saved.model_copy(deep=True)

    def list_joints(self, assembly_item_no: str, assembly_revision: str | None = None) -> list[FasteningJoint]:
        with self._lock:
            return [j.model_copy(deep=True) for j in self._joints
                    if j.assembly_item_no == assembly_item_no and (assembly_revision is None or j.assembly_revision == assembly_revision)]

    # ---------- 외부(ERP · MES) 읽기 사본 ----------

    def _upsert(self, table: dict, key: object, row: _M) -> UpsertResult:  # type: ignore[type-arg]
        old = table.get(key)
        if old is not None and old.as_of > row.as_of:
            return "ignored_older"
        table[key] = row.model_copy(update={"received_at": row.received_at or datetime.now(UTC)})
        return "inserted" if old is None else "updated"

    def upsert_work_order(self, wo: WorkOrder) -> UpsertResult:
        with self._lock:
            return self._upsert(self._work_orders, wo.wo_no, wo)

    def upsert_purchase_order_line(self, line: PurchaseOrderLine) -> UpsertResult:
        with self._lock:
            return self._upsert(self._po_lines, (line.po_no, line.line_no), line)

    def upsert_stock_lot(self, lot: StockLot) -> UpsertResult:
        with self._lock:
            return self._upsert(self._stock_lots, lot.lot_no, lot)

    def get_work_order(self, wo_no: str) -> WorkOrder | None:
        with self._lock:
            w = self._work_orders.get(wo_no)
            return w.model_copy(deep=True) if w else None

    def list_work_orders(self, *, product_item_no: str | None = None, status: str | None = None,
                         site: str | None = None) -> list[WorkOrder]:
        with self._lock:
            rows = [w for w in self._work_orders.values()
                    if (product_item_no is None or w.product_item_no == product_item_no)
                    and (status is None or w.status == status) and (site is None or w.site == site)]
            return [w.model_copy(deep=True) for w in sorted(rows, key=lambda w: w.wo_no)]

    def list_purchase_order_lines(self, *, item_no: str | None = None, only_open: bool = False) -> list[PurchaseOrderLine]:
        with self._lock:
            rows = [p for p in self._po_lines.values()
                    if (item_no is None or p.item_no == item_no) and (not only_open or p.qty_open > 0)]
            return [p.model_copy(deep=True) for p in sorted(rows, key=lambda p: (p.po_no, p.line_no))]

    def list_stock_lots(self, *, item_no: str | None = None, site: str | None = None) -> list[StockLot]:
        with self._lock:
            rows = [x for x in self._stock_lots.values()
                    if (item_no is None or x.item_no == item_no) and (site is None or x.site == site)]
            return [x.model_copy(deep=True) for x in sorted(rows, key=lambda x: x.lot_no)]

    def external_as_of(self) -> dict[ExternalKind, datetime]:
        """종류별로 가장 최근에 받은 `as_of`. `ImpactRun.external_as_of` 에 넣고, 이보다 새 값이 오면 분석이 낡은(stale) 것이다."""
        with self._lock:
            out: dict[ExternalKind, datetime] = {}
            for kind, rows in (("work_order", self._work_orders.values()), ("purchase_order_line", self._po_lines.values()),
                               ("stock_lot", self._stock_lots.values())):
                stamps = [r.as_of for r in rows]
                if stamps:
                    out[kind] = max(stamps)  # type: ignore[index]
            return out


__all__ = ["ChangeStore", "InMemoryChangeStore", "UpsertResult", "ExternalKind"]
