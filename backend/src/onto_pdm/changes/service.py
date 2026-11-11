"""변경 영향 분석 서비스: 요청 · 대상 · 범위 · 영향 분석 · 처분 · 검토 · 제출 · 승인 · 반려 · 내보내기 · 외부 feed.

근거: docs/change-impact-design.md 6장(API · 상태 전이 · 권한) · 3.6(승인 흐름) · 4.6(stale), docs/change-impact-ontology.md 6 · 7장.

- **메모리 저장소 위의 구현**이다(`InMemoryPdmStore` + `InMemoryChangeStore`). 같은 의미의 PG 구현은 `db/changes.sql` 의 `approve_change_order` 가 맡는다.
- 영향 탐색 · 판정은 엔진(`impact.py` · `fit.py`)이 하고 이 서비스는 **저장 · 상태 전이 · 승인 발행**만 한다. 엔진은 부수 효과가 없다.
- 영향이 있다는 것(finding)과 변경해야 한다는 것(처분)은 다르다. 처분은 사람이 `PUT dispositions` 로 정하고 **자동으로 정하지 않는다**.
- 승인은 `blocked` 가 남아 있으면 거부하고(기본 정책), `affected` 마다 처분이 있어야 한다. 승인되면 **새 개정을 발행**한다: 승인본은 고치지 않는다.
- ERP · MES 에는 쓰지 않는다. 처분 결과는 `export` 로 내보내기만 한다(F-CHG-8).
"""

from __future__ import annotations

import re
import threading
from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

from pydantic import ValidationError

from onto_pdm.changes import dispositions as dispo
from onto_pdm.changes import impact as impact_mod
from onto_pdm.changes import scope as scope_mod
from onto_pdm.changes.adapters import ChangeExternalSource, ChangeSpecSource, PdmBomSource, system_session
from onto_pdm.changes.fit import PdmTemporaryFitJudge
from onto_pdm.changes.models import (
    IDENTITY_KEYS,
    TRANSITION_ROLES,
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
    PurchaseOrderLine,
    ReviewFunction,
    RevisionSpec,
    StockLot,
    WorkOrder,
    WorkOrderBomRef,
    can_transition,
    identity_changes,
)
from onto_pdm.changes.ports import ReaderPartSource
from onto_pdm.changes.store import ChangeStore
from onto_pdm.contracts import (
    ChangeCreateRequest,
    ChangeDetail,
    ChangeExport,
    ChangeOrderView,
    ChangePage,
    ChangeRejectIn,
    ChangeReviewIn,
    ChangeReviewView,
    ChangeRunSummary,
    ChangeScopeIn,
    ChangeScopesIn,
    ChangeScopeView,
    ChangeSummary,
    ChangeTargetIn,
    ChangeTargetView,
    DispositionIn,
    DispositionView,
    FeedRejectedRow,
    FeedResult,
    FindingBasisView,
    ImpactFindingView,
    ImpactGraphEdge,
    ImpactGraphNode,
    ImpactGraphView,
    ImpactRunView,
    OntologyImpactView,
    PurchaseOrderLineFeedIn,
    StockLotFeedIn,
    WorkOrderFeedIn,
)
from onto_pdm.errors import ApiException, forbidden, not_found
from onto_pdm.opms.reader import OpmsReader
from onto_pdm.store.base import PdmStore, Session
from onto_pdm.store.memory import InMemoryPdmStore

# 구조 변경이 있는 제품에 쓰는 새 개정 번호: R00 → R01
_REV = re.compile(r"^R(\d+)$")
_WRITERS = frozenset({"engineer", "approver", "admin"})             # viewer 는 조회만
_PRIVILEGED = frozenset({"approver", "admin"})


def _bad(status: int, code: str, message: str, details: dict[str, Any] | None = None) -> ApiException:
    return ApiException(status, code, message, details)


def _next_rev(label: str | None, taken: Sequence[str] = ()) -> str:
    """R00 → R01. 이미 있는 번호는 건너뛴다. 형식을 모르면 그 뒤에 -1 을 붙인다."""
    m = _REV.match(label or "R00")
    n = int(m.group(1)) + 1 if m else 1
    while f"R{n:02d}" in taken:
        n += 1
    return f"R{n:02d}"


def _iso(d: datetime | date | None) -> str | None:
    return d.isoformat() if d is not None else None


def _is_full(sc: ApplicabilityScope) -> bool:
    """사업장 · 로트 · 일련번호 · 유효일 어느 것도 제한하지 않는 '전체' 적용 범위."""
    return (sc.applies == "new" and sc.effective_from is None and sc.effective_to is None and sc.site is None
            and sc.lot_nos is None and sc.serial_from is None and sc.serial_to is None)


class ChangeService:
    def __init__(self, pdm: PdmStore, changes: ChangeStore, opms: OpmsReader, *, clock: Callable[[], datetime] | None = None,
                 feed_token: str | None = None) -> None:
        self._pdm = pdm
        self._changes = changes
        self._opms = opms
        self._clock = clock or (lambda: datetime.now(UTC))
        self.feed_token = feed_token                   # 비어 있으면 feed 라우트는 403 FEED_NOT_CONFIGURED
        self._lock = threading.RLock()
        self.audit: list[dict[str, Any]] = []          # 감사 기록(메모리 수준). PG 에서는 audit_log 트리거가 한다
        self._revision_scopes: dict[tuple[str, str], tuple[ApplicabilityScope, ...]] = {}   # 부분 적용 개정의 적용 범위

    # ------------------------------------------------------------------ 공통

    def _now(self) -> datetime:
        return self._clock()

    def _log(self, s: Session | None, action: str, **fields: Any) -> None:
        self.audit.append({"at": self._now().isoformat(), "by": s.user.login_id if s else "system", "action": action, **fields})

    @staticmethod
    def _need_role(s: Session, roles: frozenset[str], what: str) -> None:
        if s.user.role not in roles:
            raise forbidden(ChangeErrorCode.FORBIDDEN, f"{what} 권한이 없어요 (역할 {s.user.role})")

    def _bom(self) -> PdmBomSource:
        return PdmBomSource(self._pdm)

    def _resolve(self, s: Session, code: str) -> tuple[ChangeRequest, ChangeOrder]:
        """`{id}` 는 요청 코드(CR-…)이고 지시 코드(CO-…)도 받는다. 승인 전 건은 작성자 · 관리자 모드만 본다."""
        req_code = code
        if code.startswith("CO-"):
            order = self._changes.get_order(code)
            if order is None:
                raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"변경 {code}을(를) 찾을 수 없습니다")
            req_code = order.request_code
        req = self._changes.find_request(s, req_code)
        order = self._changes.get_order_for_request(req.code)
        if order is None:
            raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"변경 {code}의 지시를 찾을 수 없습니다")
        return req, order

    def _require_author_or_admin(self, s: Session, req: ChangeRequest) -> None:
        if not (s.is_admin or s.user.login_id == req.requested_by or s.user.role in _PRIVILEGED):
            raise forbidden(ChangeErrorCode.FORBIDDEN, "작성자나 관리자만 할 수 있어요")

    @staticmethod
    def _state(order: ChangeOrder, *allowed: str) -> None:
        if order.status not in allowed:
            raise _bad(409, ChangeErrorCode.CHANGE_STATE_INVALID, f"지금 상태({order.status})에서는 할 수 없어요",
                       {"status": order.status, "allowed": list(allowed)})

    # ------------------------------------------------------------------ 요청 · 목록 · 상세

    def create_change(self, s: Session, body: ChangeCreateRequest) -> ChangeDetail:
        self._need_role(s, _WRITERS, "변경 요청을 만들")
        if body.product_code and all(p.code != body.product_code for p in self._pdm.list_products()):
            raise not_found("PRODUCT_NOT_FOUND", f"제품 {body.product_code}을(를) 찾을 수 없습니다")
        year = self._now().year
        with self._lock:
            try:
                req = self._changes.create_request(ChangeRequest(
                    code=self._changes.next_code("CR", year), title=body.title.strip(), reason=body.reason.strip(), origin=body.origin,
                    ontology_impact_id=body.ontology_impact_id, before_summary=body.before_summary, after_summary=body.after_summary,
                    product_code=body.product_code, requested_by=s.user.login_id, requested_at=self._now()))
            except ValidationError as e:
                raise _invalid(e) from e
            order = self._changes.create_order(ChangeOrder(code=self._changes.next_code("CO", year), request_code=req.code,
                                                           product_code=req.product_code))
        self._log(s, "change.create", request=req.code, order=order.code)
        return self.get_detail(s, req.code)

    def list_changes(self, s: Session, *, status: str | None, product: str | None, q: str | None, page: int, size: int) -> ChangePage:
        rows = self._changes.list_requests(s, status=status, product_code=product, q=q)
        start = (page - 1) * size
        items = [self._summary(r) for r in rows[start:start + size]]
        return ChangePage(items=items, total=len(rows), page=page, size=size)

    def _summary(self, req: ChangeRequest) -> ChangeSummary:
        order = self._changes.get_order_for_request(req.code)
        run = self._refresh_stale(order.code) if order else None
        return ChangeSummary(
            code=req.code, title=req.title, status=req.status, order_code=order.code if order else None,
            order_status=order.status if order else None, product_code=req.product_code, origin=req.origin,
            requested_by=req.requested_by, requested_at=req.requested_at.isoformat(), run_summary=_run_summary(run) if run else None)

    def get_detail(self, s: Session, code: str) -> ChangeDetail:
        req, order = self._resolve(s, code)
        run = self._refresh_stale(order.code)
        return ChangeDetail(
            code=req.code, title=req.title, reason=req.reason, origin=req.origin, before_summary=req.before_summary,
            after_summary=req.after_summary, status=req.status, product_code=req.product_code, requested_by=req.requested_by,
            requested_at=req.requested_at.isoformat(), order=_order_view(order),
            targets=[_target_view(t) for t in self._changes.list_targets(order.code)],
            latest_run=_run_view(run) if run else None,
            dispositions=[_disposition_view(d) for d in self._changes.list_dispositions(order.code, include_superseded=True)],
            reviews=[_review_view(r) for r in self._changes.list_reviews(order.code)])

    # ------------------------------------------------------------------ 대상 · 적용 범위

    def add_target(self, s: Session, code: str, body: ChangeTargetIn) -> ChangeTargetView:
        self._need_role(s, _WRITERS, "대상을 추가할")
        req, order = self._resolve(s, code)
        self._require_author_or_admin(s, req)
        self._state(order, "draft")
        bom = self._bom()

        item_no = body.item_no
        current = bom.current_revision(item_no)
        from_rev = body.from_revision or (current.rev if current else None)
        if not bom.revisions(item_no):
            raise not_found(ChangeErrorCode.ITEM_NOT_FOUND, f"품목 {item_no}을(를) 찾을 수 없습니다")
        base = bom.revision(item_no, from_rev)
        if base is None or base.status != "released":
            raise _bad(409, ChangeErrorCode.TARGET_NOT_RELEASED, f"{item_no} 의 승인된 개정이 없어요 (from_revision={from_rev})", {"item_no": item_no})
        if body.replacement_item_no and not bom.revisions(body.replacement_item_no):
            raise not_found(ChangeErrorCode.ITEM_NOT_FOUND, f"교체 품목 {body.replacement_item_no}을(를) 찾을 수 없습니다")

        to_rev = body.to_revision
        if body.change_kind in ("revise", "attribute_edit") and not to_rev:
            to_rev = _next_rev(from_rev, [r.rev for r in bom.revisions(item_no)])
        parent_rev = body.parent_revision or (from_rev if body.change_kind == "bom_edit" else None)
        if body.change_kind == "attribute_edit" and (clash := identity_changes(body.before, body.after)):
            raise _bad(422, ChangeErrorCode.REVISION_CHANGES_IDENTITY, f"규격이 바뀌면 새 품번이에요 — 교체로 등록하세요 ({', '.join(clash)})",
                       {"changed": clash})
        try:
            target = ChangeTarget(
                change_kind=body.change_kind, item_no=item_no, from_revision=from_rev, to_revision=to_rev,
                replacement_item_no=body.replacement_item_no, parent_revision=parent_rev, before=dict(body.before),
                after=dict(body.after), note=body.note)
        except ValidationError as e:
            if ChangeErrorCode.REVISION_CHANGES_IDENTITY in str(e):
                changed = identity_changes(body.before, body.after)
                raise _bad(422, ChangeErrorCode.REVISION_CHANGES_IDENTITY,
                           f"규격이 바뀌면 새 품번이에요 — 교체로 등록하세요 ({', '.join(changed)})", {"changed": changed}) from e
            raise _invalid(e) from e
        try:
            saved = self._changes.add_target(order.code, target)
        except ValueError as e:
            raise _bad(409, ChangeErrorCode.CHANGE_STATE_INVALID, str(e)) from e
        self._mark_input_changed(order.code)
        self._log(s, "change.target.add", order=order.code, target=saved.id, item_no=saved.item_no, kind=saved.change_kind)
        return _target_view(saved)

    def remove_target(self, s: Session, code: str, target_id: int) -> None:
        self._need_role(s, _WRITERS, "대상을 지울")
        req, order = self._resolve(s, code)
        self._require_author_or_admin(s, req)
        self._state(order, "draft")
        if not self._changes.remove_target(order.code, target_id):
            raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"대상 {target_id}을(를) 찾을 수 없습니다")
        self._mark_input_changed(order.code)
        self._log(s, "change.target.remove", order=order.code, target=target_id)

    def set_scope(self, s: Session, code: str, target_id: int, body: ChangeScopesIn) -> list[ChangeScopeView]:
        self._need_role(s, _WRITERS, "적용 범위를 정할")
        req, order = self._resolve(s, code)
        self._require_author_or_admin(s, req)
        self._state(order, "draft")
        scopes: list[ApplicabilityScope] = []
        for i, sc in enumerate(body.scopes):
            try:
                scopes.append(_scope_from(sc))
            except (ValidationError, ValueError) as e:
                raise _bad(422, ChangeErrorCode.SCOPE_INVALID, f"적용 범위 {i + 1}번이 올바르지 않아요: {_first_message(e)}", {"index": i}) from e
        pairs = scope_mod.find_overlaps(scopes)
        if pairs:
            raise _bad(409, ChangeErrorCode.SCOPE_OVERLAP, "같은 종류의 적용 범위가 서로 겹쳐요", {"pairs": [list(p) for p in pairs]})
        if self._changes.get_target(order.code, target_id) is None:
            raise not_found(ChangeErrorCode.CHANGE_NOT_FOUND, f"대상 {target_id}을(를) 찾을 수 없습니다")
        saved = self._changes.set_scopes(order.code, target_id, scopes)
        self._mark_input_changed(order.code)
        self._log(s, "change.scope.set", order=order.code, target=target_id, count=len(scopes))
        return [_scope_view(x) for x in saved.scopes]

    # ------------------------------------------------------------------ 영향 분석 · stale

    def _part_source(self) -> ReaderPartSource:
        return ReaderPartSource(self._opms)         # 분석 한 번에 스냅샷 한 번(같은 온톨로지 버전)

    def run_impact(self, s: Session, code: str) -> ImpactRunView:
        self._need_role(s, _WRITERS, "영향 분석을 실행할")
        _, order = self._resolve(s, code)
        self._state(order, "draft", "in_review")
        targets = self._changes.list_targets(order.code)
        if not targets:
            raise _bad(409, ChangeErrorCode.CHANGE_STATE_INVALID, "대상이 없어요. 대상을 먼저 추가하세요")
        bom = self._bom()
        parts = self._part_source()
        run = impact_mod.analyze(
            order, targets, bom=bom, specs=ChangeSpecSource(self._changes, bom), external=ChangeExternalSource(self._changes),
            parts=parts, judge=PdmTemporaryFitJudge(parts), computed_at=self._now(), computed_by=s.user.login_id)
        saved = self._changes.add_run(run)
        self._log(s, "change.impact.run", order=order.code, run=saved.id, partial=saved.partial, findings=len(saved.findings))
        return _run_view(saved)

    def get_impact(self, s: Session, code: str, run_id: int | None = None) -> ImpactRunView:
        _, order = self._resolve(s, code)
        run = self._refresh_stale(order.code) if run_id is None else self._changes.get_run(order.code, run_id)
        if run is None:
            raise not_found(ChangeErrorCode.IMPACT_NOT_COMPUTED, "영향 분석을 아직 실행하지 않았어요")
        return _run_view(run)

    def _mark_input_changed(self, order_code: str) -> None:
        self._changes.mark_stale(order_code, ["input_changed"])

    def _refresh_stale(self, order_code: str) -> ImpactRun | None:
        """최신 분석이 낡았는지 본다: 외부 feed 가 더 새로 왔나 · OPMS 온톨로지 버전이 바뀌었나(OPMS 를 읽을 수 있을 때만). 낡았으면 표시한다."""
        run = self._changes.get_run(order_code)
        if run is None:
            return None
        order = self._changes.get_order(order_code)
        if order is None or order.status not in ("draft", "in_review"):
            return run                                     # 승인 · 반려된 지시의 분석은 판단 당시 그대로 남긴다
        version: str | None = None
        try:
            version = self._part_source().ontology_version()
        except ApiException:
            version = None                                 # OPMS 를 못 읽으면 이 항목은 보지 않는다
        reasons = impact_mod.stale_reasons(run, external_state=ChangeExternalSource(self._changes).external_state(), ontology_version=version)
        if reasons and not run.stale or (reasons and set(reasons) - set(run.stale_reasons)):
            return self._changes.mark_stale(order_code, reasons) or run
        return run

    def refresh_open_orders(self) -> None:
        """외부 feed 가 들어온 뒤 열린 지시의 최신 분석을 낡음으로 표시한다(design 4.6)."""
        for req in self._changes.list_requests(system_session()):
            order = self._changes.get_order_for_request(req.code)
            if order is not None:
                self._refresh_stale(order.code)

    # ------------------------------------------------------------------ 처분 · 검토

    def put_disposition(self, s: Session, code: str, finding_id: int, body: DispositionIn) -> DispositionView:
        self._need_role(s, _WRITERS, "처분을 정할")
        _, order = self._resolve(s, code)
        self._state(order, "draft", "in_review")
        run = self._refresh_stale(order.code)
        if run is None:
            raise _bad(409, ChangeErrorCode.IMPACT_NOT_COMPUTED, "영향 분석을 먼저 실행하세요")
        finding = next((f for f in run.findings if f.id == finding_id), None)
        if finding is None:
            raise not_found("FINDING_NOT_FOUND", f"최신 영향 분석에 영향 {finding_id}이(가) 없어요. 분석을 다시 실행했다면 새 영향에 처분을 정하세요")
        if run.stale:
            raise _bad(409, ChangeErrorCode.IMPACT_STALE, "영향 분석이 낡았어요. 다시 계산한 뒤 처분을 정하세요", {"stale_reasons": list(run.stale_reasons)})
        dispo.validate_disposition(finding, body.action, body.reason)
        try:
            saved = self._changes.put_disposition(Disposition(
                order_code=order.code, finding_id=finding_id, finding_kind=finding.kind, action=body.action, reason=body.reason.strip(),
                scope_id=body.scope_id, decided_by=s.user.login_id, decided_at=self._now()))
        except ValidationError as e:
            raise _invalid(e) from e
        self._log(s, "change.disposition", order=order.code, finding=finding_id, choice=body.action)
        return _disposition_view(saved)

    @staticmethod
    def _can_review(s: Session, function: ReviewFunction) -> bool:
        """`app_user_function`(설계 · 구매 · 생산 자격) 표가 아직 없어 역할로 갈음한다: 설계는 viewer 를 뺀 모두, 구매 · 생산은 승인자 · 관리자."""
        if function == "design":
            return s.user.role in _WRITERS
        return s.user.role in _PRIVILEGED

    def add_review(self, s: Session, code: str, body: ChangeReviewIn) -> ChangeReviewView:
        _, order = self._resolve(s, code)
        if not self._can_review(s, body.function):
            raise forbidden(ChangeErrorCode.FORBIDDEN, f"{body.function} 검토 자격이 없어요 (역할 {s.user.role})")
        self._state(order, "in_review")
        run = self._refresh_stale(order.code)
        if run is None or run.id is None:
            raise _bad(409, ChangeErrorCode.IMPACT_NOT_COMPUTED, "영향 분석을 먼저 실행하세요")
        if run.stale:
            raise _bad(409, ChangeErrorCode.IMPACT_STALE, "영향 분석이 낡았어요. 다시 계산한 뒤 검토하세요", {"stale_reasons": list(run.stale_reasons)})
        saved = self._changes.add_review(ChangeReview(
            order_code=order.code, function=body.function, run_id=run.id, verdict=body.verdict, comment=body.comment,
            reviewer=s.user.login_id, reviewed_at=self._now()))
        self._log(s, "change.review", order=order.code, function=body.function, verdict=body.verdict, run=run.id)
        return _review_view(saved)

    # ------------------------------------------------------------------ 요청 접수 · 제출 · 승인 · 반려

    def accept(self, s: Session, code: str) -> ChangeDetail:
        """요청 `draft/submitted → accepted`. 승인자 · 관리자만(design 6.4). 작성자는 `submit` 으로 지시를 검토에 올린다."""
        self._need_role(s, _PRIVILEGED, "요청을 접수할")
        req, _ = self._resolve(s, code)
        if req.status == "draft":
            req = self._changes.update_request(req.model_copy(update={"status": "submitted"}))
        if not can_transition("request", req.status, "accepted"):
            raise _bad(409, ChangeErrorCode.CHANGE_STATE_INVALID, f"요청 상태({req.status})에서는 접수할 수 없어요")
        self._changes.update_request(req.model_copy(update={"status": "accepted"}))
        self._log(s, "change.accept", request=req.code)
        return self.get_detail(s, req.code)

    def submit(self, s: Session, code: str) -> ChangeDetail:
        if s.user.role not in TRANSITION_ROLES[("order", "draft", "in_review")]:
            raise forbidden(ChangeErrorCode.FORBIDDEN, f"검토에 올릴 권한이 없어요 (역할 {s.user.role})")
        req, order = self._resolve(s, code)
        self._state(order, "draft")
        targets = self._changes.list_targets(order.code)
        if not targets:
            raise _bad(409, ChangeErrorCode.CHANGE_STATE_INVALID, "대상이 하나 이상 있어야 해요")
        no_scope = [t.id for t in targets if not t.scopes]
        if no_scope:
            raise _bad(409, ChangeErrorCode.SCOPE_REQUIRED, "적용 범위가 없는 대상이 있어요. 범위가 없으면 '전체'가 아니라 미정이에요", {"target_ids": no_scope})
        run = self._refresh_stale(order.code)
        if run is None:
            raise _bad(409, ChangeErrorCode.IMPACT_NOT_COMPUTED, "영향 분석을 먼저 실행하세요")
        if run.stale:
            raise _bad(409, ChangeErrorCode.IMPACT_STALE, "영향 분석이 낡았어요. 다시 계산하세요", {"stale_reasons": list(run.stale_reasons)})
        self._changes.update_order(order.model_copy(update={"status": "in_review"}))
        if req.status == "draft":
            self._changes.update_request(req.model_copy(update={"status": "submitted"}))
        self._log(s, "change.submit", order=order.code)
        return self.get_detail(s, req.code)

    def _required_functions(self, run: ImpactRun) -> list[ReviewFunction]:
        need: set[ReviewFunction] = {"design"}
        for f in run.findings:
            if f.severity not in ("affected", "blocked"):
                continue
            if f.kind in ("purchase_order_line", "stock_lot"):
                need.add("purchasing")
            elif f.kind == "work_order":
                need.add("production")
        return sorted(need)

    def approve(self, s: Session, code: str) -> ChangeDetail:
        if s.user.role not in TRANSITION_ROLES[("order", "in_review", "approved")]:
            raise forbidden(ChangeErrorCode.FORBIDDEN, f"승인 권한이 없어요 (역할 {s.user.role})")
        req, order = self._resolve(s, code)
        self._state(order, "in_review")
        targets = self._changes.list_targets(order.code)
        if not targets or any(not t.scopes for t in targets):
            raise _bad(409, ChangeErrorCode.SCOPE_REQUIRED, "적용 범위가 없는 대상이 있어요")
        run = self._refresh_stale(order.code)
        if run is None or run.id is None:
            raise _bad(409, ChangeErrorCode.IMPACT_NOT_COMPUTED, "영향 분석을 먼저 실행하세요")
        problems = dispo.check_approvable(
            run, self._changes.list_dispositions(order.code), is_latest_run=True, required_functions=self._required_functions(run),
            reviews=self._changes.list_reviews(order.code, run_id=run.id))
        dispo.raise_if_not_approvable(problems)
        now = self._now()
        with self._lock:
            issued = self._issue_revisions(s, order, targets)
            approved = order.model_copy(update={"status": "implemented", "approved_by": s.user.login_id, "approved_at": now,
                                                "approved_run_id": run.id})
            self._changes.update_order(approved)
            self._changes.update_request(req.model_copy(update={"status": "accepted"}))
        self._log(s, "change.approve", order=order.code, run=run.id, revisions=issued)
        return self.get_detail(s, req.code)

    def reject(self, s: Session, code: str, body: ChangeRejectIn) -> ChangeDetail:
        if s.user.role not in TRANSITION_ROLES[("order", "in_review", "rejected")]:
            raise forbidden(ChangeErrorCode.FORBIDDEN, f"반려 권한이 없어요 (역할 {s.user.role})")
        req, order = self._resolve(s, code)
        self._state(order, "in_review")
        if not body.reason.strip():
            raise _bad(422, "INVALID_REQUEST", "반려 사유가 비어 있어요")
        run = self._changes.get_run(order.code)
        if run is not None and run.id is not None:                    # 사유를 검토 이력에 남긴다(어느 분석을 보고 반려했는지)
            self._changes.add_review(ChangeReview(order_code=order.code, function="design", run_id=run.id, verdict="reject",
                                                  comment=body.reason.strip(), reviewer=s.user.login_id, reviewed_at=self._now()))
        self._changes.update_order(order.model_copy(update={"status": "rejected"}))
        self._changes.update_request(req.model_copy(update={"status": "rejected"}))
        self._log(s, "change.reject", order=order.code, reason=body.reason.strip())
        return self.get_detail(s, req.code)

    # ------------------------------------------------------------------ 승인 발행: 새 개정

    def _issue_revisions(self, s: Session, order: ChangeOrder, targets: Sequence[ChangeTarget]) -> list[str]:
        """승인된 변경을 새 개정으로 발행한다. 승인본은 고치지 않는다(새 개정만 만들고, 전체 범위일 때만 이전 개정을 폐기한다)."""
        pdm = self._pdm
        if not isinstance(pdm, InMemoryPdmStore):
            raise _bad(503, "PDM_STORE_READ_ONLY", "이 저장소는 새 개정을 발행할 수 없어요")
        bom = self._bom()

        @dataclass
        class Plan:
            item_no: str
            from_rev: str | None
            to_rev: str | None = None
            specs: dict[str, tuple[float, str]] = field(default_factory=dict)
            replace: dict[str, str] = field(default_factory=dict)
            quantities: dict[str, float] = field(default_factory=dict)
            joint: dict[str, int] = field(default_factory=dict)
            scopes: list[ApplicabilityScope] = field(default_factory=list)
            notes: list[str] = field(default_factory=list)

        plans: dict[str, Plan] = {}

        def plan_for(item_no: str, from_rev: str | None) -> Plan:
            if item_no not in plans:
                plans[item_no] = Plan(item_no=item_no, from_rev=from_rev)
            return plans[item_no]

        for t in targets:
            touched: list[Plan] = []
            if t.change_kind in ("revise", "attribute_edit"):
                p = plan_for(t.item_no, t.from_revision)
                p.to_rev = t.to_revision or p.to_rev
                src = str(t.after.get("spec_source") or "manual")
                p.specs.update({k: (float(v), src) for k, v in t.after.items()
                                if k != "spec_source" and isinstance(v, int | float) and not isinstance(v, bool)})
                touched.append(p)
            elif t.change_kind == "bom_edit":
                p = plan_for(t.item_no, t.parent_revision or t.from_revision)
                p.quantities.update({str(k): float(v) for k, v in (t.after.get("quantities") or {}).items()})
                p.joint.update({k: int(t.after[k]) for k in ("washers_per_bolt", "bolt_count") if isinstance(t.after.get(k), int)})
                touched.append(p)
            else:                                                       # replace: 줄이 들어 있는 조립품(직접 부모)과 체결 구성을 가진 조상
                new_no = t.replacement_item_no or t.item_no
                for row in bom.where_used(t.item_no):
                    holds_joint = any(t.item_no in (j.bolt_item_no, j.nut_item_no, j.washer_item_no)
                                      for j in self._changes.list_joints(row.item_no, row.revision))
                    if row.depth == 1 and t.parent_revision and row.revision != t.parent_revision:
                        continue
                    if row.depth == 1 or holds_joint:
                        p = plan_for(row.item_no, row.revision)
                        p.replace[t.item_no] = new_no
                        touched.append(p)
            for p in touched:
                p.scopes.extend(x for x in t.scopes if x not in p.scopes)
                if t.note and t.note not in p.notes:
                    p.notes.append(t.note)

        issued: list[str] = []
        with pdm._lock:                                                  # noqa: SLF001 — PdmStore Protocol 에 쓰기가 없다
            db = pdm.db
            item_no_of = {i["id"]: i["item_no"] for i in db["items"]}
            id_of = {no: iid for iid, no in item_no_of.items()}
            line_seq = max((ln["id"] for ln in db["bom_lines"]), default=0)
            rev_seq_id = max((r["id"] for r in db["revisions"]), default=0)
            now = self._now().isoformat()
            for p in plans.values():
                item_id = id_of.get(p.item_no)
                if item_id is None:
                    continue
                rows = sorted((r for r in db["revisions"] if r["item_id"] == item_id), key=lambda r: r["rev_seq"])
                base = next((r for r in rows if r["rev"] == p.from_rev), None) if p.from_rev else next(
                    (r for r in reversed(rows) if r["status"] == "released"), None)
                if base is None:
                    continue
                label = p.to_rev or _next_rev(base["rev"], [r["rev"] for r in rows])
                rev_seq_id += 1
                new_row = {"id": rev_seq_id, "item_id": item_id, "rev": label, "rev_seq": max(r["rev_seq"] for r in rows) + 1,
                           "status": "released", "created_by": s.user.id, "created_at": now, "released_at": now,
                           "change_note": f"{order.code}: " + ("; ".join(p.notes) if p.notes else "변경 승인")}
                db["revisions"].append(new_row)
                for ln in [x for x in db["bom_lines"] if x["parent_revision_id"] == base["id"]]:
                    child_no = item_no_of[ln["child_item_id"]]
                    child_id = id_of.get(p.replace[child_no], ln["child_item_id"]) if child_no in p.replace else ln["child_item_id"]
                    qty = p.quantities.get(item_no_of.get(child_id, child_no), p.quantities.get(child_no, ln["quantity"]))
                    line_seq += 1
                    db["bom_lines"].append({**ln, "id": line_seq, "parent_revision_id": new_row["id"], "child_item_id": child_id, "quantity": qty})
                self._carry_specs_and_joints(p, base["rev"], label)
                full = any(_is_full(sc) for sc in p.scopes) and all(sc.applies == "new" for sc in p.scopes)
                if full:
                    base["status"] = "obsolete"                       # 전체 범위면 이전 개정은 더 쓰지 않는다. 부분이면 released 로 남는다
                else:
                    self._revision_scopes[(p.item_no, label)] = tuple(sc for sc in p.scopes if sc.applies == "new")
                issued.append(f"{p.item_no}@{label}")
        return issued

    def _carry_specs_and_joints(self, p: Any, from_rev: str, to_rev: str) -> None:
        for spec in self._changes.list_revision_specs(p.item_no, from_rev):
            value, src = p.specs.get(spec.key, (spec.value, spec.source))
            self._changes.put_revision_spec(RevisionSpec(item_no=p.item_no, revision=to_rev, key=spec.key, value=value, unit=spec.unit,
                                                         source=src if src in ("drawing", "opms", "cad_estimate", "manual") else "manual"))  # type: ignore[arg-type]
        have = {s.key for s in self._changes.list_revision_specs(p.item_no, from_rev)}
        for key, (value, src) in p.specs.items():
            if key not in have:
                self._changes.put_revision_spec(RevisionSpec(item_no=p.item_no, revision=to_rev, key=key, value=value, unit="mm",
                                                             source=src if src in ("drawing", "opms", "cad_estimate", "manual") else "manual"))  # type: ignore[arg-type]
        for j in self._changes.list_joints(p.item_no, from_rev):
            self._changes.put_joint(FasteningJoint(
                assembly_item_no=j.assembly_item_no, assembly_revision=to_rev, name=j.name,
                bolt_item_no=p.replace.get(j.bolt_item_no, j.bolt_item_no), nut_item_no=p.replace.get(j.nut_item_no, j.nut_item_no),
                washer_item_no=p.replace.get(j.washer_item_no, j.washer_item_no) if j.washer_item_no else None,
                washers_per_bolt=p.joint.get("washers_per_bolt", j.washers_per_bolt), bolt_count=p.joint.get("bolt_count", j.bolt_count),
                clamped=j.clamped))

    def effective_revision_at(self, item_no: str, subject: scope_mod.ScopeSubject) -> str | None:
        """부분 적용으로 `released` 개정이 둘 이상일 때, 이 사업장 · 로트 · 일련번호 · 날짜에 쓰는 개정(design 3.6 `effective_revision_at`)."""
        released = sorted((r for r in self._bom().revisions(item_no) if r.status == "released"), key=lambda r: -r.rev_seq)
        for r in released:
            scopes = self._revision_scopes.get((item_no, r.rev))
            if scopes is None or scope_mod.classify_any(scopes, subject) == "inside":
                return r.rev
        return released[-1].rev if released else None

    # ------------------------------------------------------------------ 내보내기 · 그래프 · 온톨로지 보고

    def export(self, s: Session, code: str) -> ChangeExport:
        req, order = self._resolve(s, code)
        if order.status not in ("approved", "implemented") or order.approved_run_id is None:
            raise _bad(409, ChangeErrorCode.CHANGE_NOT_APPROVED, "승인된 변경만 내보낼 수 있어요")
        run = self._changes.get_run(order.code, order.approved_run_id)
        if run is None:
            raise not_found(ChangeErrorCode.IMPACT_NOT_COMPUTED, "승인 때 본 영향 분석이 없어요")
        return ChangeExport(
            code=req.code, order_code=order.code, title=req.title, approved_by=order.approved_by or "", approved_at=_iso(order.approved_at) or "",
            ontology_version=run.ontology_version, temporary=run.temporary,
            targets=[_target_view(t) for t in self._changes.list_targets(order.code)], findings=[_finding_view(f) for f in run.findings],
            dispositions=[_disposition_view(d) for d in self._changes.list_dispositions(order.code, include_superseded=True)])

    def impact_graph(self, s: Session, code: str) -> ImpactGraphView:
        _, order = self._resolve(s, code)
        run = self._changes.get_run(order.code)
        if run is None:
            raise not_found(ChangeErrorCode.IMPACT_NOT_COMPUTED, "영향 분석을 아직 실행하지 않았어요")
        return _graph(order, self._changes.list_targets(order.code), run)

    def ontology_impact(self, from_version: str | None, to_version: str | None) -> OntologyImpactView:
        """온톨로지 버전 변경 보고(읽기). 부품 개정이나 변경 지시를 만들지 않는다(F-CHG-10). OPMS 를 읽을 수 없으면 503."""
        self._part_source().ontology_version()                 # OPMS_NOT_CONFIGURED · OPMS_UNAVAILABLE 을 그대로 낸다
        rows = self._changes.list_ontology_impacts()
        if from_version:
            rows = [r for r in rows if r.from_version == from_version]
        if to_version:
            rows = [r for r in rows if r.to_version == to_version]
        if not rows:
            raise not_found("ONTOLOGY_IMPACT_NOT_FOUND", "해당 온톨로지 버전 변경 보고가 없어요")
        r = rows[-1]
        return OntologyImpactView(from_version=r.from_version, to_version=r.to_version, computed_at=r.computed_at.isoformat(),
                                  rules_changed=list(r.summary.rules_changed), parts_flagged=list(r.summary.parts_flagged),
                                  change_request_code=r.change_request_code)

    # ------------------------------------------------------------------ 외부 feed (읽기 사본 받기)

    def _item_exists(self, item_no: str) -> bool:
        return bool(self._bom().revisions(item_no))

    def feed_work_orders(self, body: WorkOrderFeedIn) -> FeedResult:
        def build(row: Any) -> WorkOrder:
            if not self._item_exists(row.product_item_no):
                raise _Rejected(ChangeErrorCode.ITEM_NOT_FOUND)
            return WorkOrder(
                source_system=body.source_system, as_of=datetime.fromisoformat(row.as_of), wo_no=row.wo_no, site=row.site,
                product_item_no=row.product_item_no, bom_revision=row.bom_revision, process_rev=row.process_rev, status=row.status,
                qty_planned=row.qty_planned, qty_done=row.qty_done, lot_no=row.lot_no, serial_from=row.serial_from, serial_to=row.serial_to,
                start_date=date.fromisoformat(row.start_date) if row.start_date else None,
                due_date=date.fromisoformat(row.due_date) if row.due_date else None,
                bom_refs=tuple(WorkOrderBomRef(item_no=r.item_no, revision=r.rev, qty_required=r.qty_required, qty_issued=r.qty_issued)
                               for r in row.bom_refs))
        return self._feed(body.rows, build, self._changes.upsert_work_order)

    def feed_purchase_order_lines(self, body: PurchaseOrderLineFeedIn) -> FeedResult:
        def build(row: Any) -> PurchaseOrderLine:
            if not self._item_exists(row.item_no):
                raise _Rejected(ChangeErrorCode.ITEM_NOT_FOUND)
            return PurchaseOrderLine(
                source_system=body.source_system, as_of=datetime.fromisoformat(row.as_of), po_no=row.po_no, line_no=row.line_no,
                item_no=row.item_no, item_rev=row.item_rev, qty_ordered=row.qty_ordered, qty_received=row.qty_received,
                due_date=date.fromisoformat(row.due_date) if row.due_date else None, supplier=row.supplier, site=row.site, status=row.status)
        return self._feed(body.rows, build, self._changes.upsert_purchase_order_line)

    def feed_stock_lots(self, body: StockLotFeedIn) -> FeedResult:
        def build(row: Any) -> StockLot:
            if not self._item_exists(row.item_no):
                raise _Rejected(ChangeErrorCode.ITEM_NOT_FOUND)
            return StockLot(
                source_system=body.source_system, as_of=datetime.fromisoformat(row.as_of), lot_no=row.lot_no, item_no=row.item_no,
                item_rev=row.item_rev, site=row.site, location=row.location, qty_on_hand=row.qty_on_hand,
                qty_allocated=row.qty_allocated, status=row.status)
        return self._feed(body.rows, build, self._changes.upsert_stock_lot)

    def _feed(self, rows: Sequence[Any], build: Callable[[Any], Any], upsert: Callable[[Any], str]) -> FeedResult:
        """일부 행이 실패해도 나머지는 적용한다. 늦은 `as_of` 는 무시(ignored_stale), 모르는 품번 · 잘못된 행은 rejected."""
        applied = ignored = 0
        rejected: list[FeedRejectedRow] = []
        for i, row in enumerate(rows):
            try:
                obj = build(row)
            except _Rejected as e:
                rejected.append(FeedRejectedRow(row=i, code=e.code))
                continue
            except (ValidationError, ValueError):
                rejected.append(FeedRejectedRow(row=i, code="INVALID_ROW"))
                continue
            if upsert(obj) == "ignored_older":
                ignored += 1
            else:
                applied += 1
        if applied:
            self.refresh_open_orders()
        self._log(None, "feed", applied=applied, ignored_stale=ignored, rejected=len(rejected))
        return FeedResult(applied=applied, ignored_stale=ignored, rejected=rejected)


# ---------------------------------------------------------------------- 도우미 · 뷰 변환


class _Rejected(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _first_message(e: Exception) -> str:
    if isinstance(e, ValidationError):
        errs = e.errors()
        return str(errs[0]["msg"]) if errs else str(e)
    return str(e)


def _invalid(e: ValidationError) -> ApiException:
    return _bad(422, "INVALID_REQUEST", "요청 값이 올바르지 않아요: " + _first_message(e),
                {"errors": [{"loc": [str(x) for x in err["loc"]], "msg": err["msg"]} for err in e.errors()]})


def _scope_from(sc: ChangeScopeIn) -> ApplicabilityScope:
    return ApplicabilityScope(
        effective_from=date.fromisoformat(sc.effective_from) if sc.effective_from else None,
        effective_to=date.fromisoformat(sc.effective_to) if sc.effective_to else None,
        site=sc.site, lot_nos=tuple(sc.lot_nos) if sc.lot_nos is not None else None, serial_from=sc.serial_from, serial_to=sc.serial_to,
        applies=sc.applies, note=sc.note)


def _scope_view(sc: ApplicabilityScope) -> ChangeScopeView:
    return ChangeScopeView(
        id=sc.id or 0, effective_from=_iso(sc.effective_from), effective_to=_iso(sc.effective_to), site=sc.site,
        lot_nos=list(sc.lot_nos) if sc.lot_nos is not None else None, serial_from=sc.serial_from, serial_to=sc.serial_to,
        applies=sc.applies, note=sc.note)


def _target_view(t: ChangeTarget) -> ChangeTargetView:
    return ChangeTargetView(
        id=t.id or 0, change_kind=t.change_kind, item_no=t.item_no, from_revision=t.from_revision, to_revision=t.to_revision,
        replacement_item_no=t.replacement_item_no, parent_revision=t.parent_revision, before=dict(t.before), after=dict(t.after),
        note=t.note, scopes=[_scope_view(x) for x in t.scopes])


def _order_view(o: ChangeOrder) -> ChangeOrderView:
    return ChangeOrderView(code=o.code, status=o.status, product_code=o.product_code, approved_by=o.approved_by,
                           approved_at=_iso(o.approved_at), approved_run_id=o.approved_run_id)


def _run_summary(run: ImpactRun) -> ChangeRunSummary:
    c: defaultdict[str, int] = defaultdict(int)
    for f in run.findings:
        c[f.severity] += 1
    return ChangeRunSummary(blocked=c["blocked"], affected=c["affected"], review=c["review"], none=c["none"], stale=run.stale, partial=run.partial)


def _finding_view(f: ImpactFinding) -> ImpactFindingView:
    return ImpactFindingView(
        id=f.id or 0, kind=f.kind, subject_type=f.subject_type, subject_ref=f.subject_ref, severity=f.severity, verdict=f.verdict,
        reason_code=f.reason_code, message=f.message,
        basis=FindingBasisView(ontology_version=f.basis.ontology_version, rule_id=f.basis.rule_id, as_of=f.basis.as_of.isoformat()),
        temporary=f.temporary, approximate=f.approximate, inputs=dict(f.inputs), required=f.required, actual=f.actual, gap=f.gap,
        scope_class=f.scope_class, suggested_disposition=f.suggested_disposition)


def _run_view(run: ImpactRun) -> ImpactRunView:
    return ImpactRunView(
        id=run.id or 0, order_code=run.order_code, computed_at=run.computed_at.isoformat(), computed_by=run.computed_by,
        input_hash=run.input_hash, ontology_version=run.ontology_version, temporary=run.temporary, partial=run.partial,
        external_as_of={k: v.isoformat() for k, v in run.external_as_of.items()}, stale=run.stale, stale_reasons=list(run.stale_reasons),
        warnings=list(run.warnings), summary=_run_summary(run), findings=[_finding_view(f) for f in run.findings])


def _disposition_view(d: Disposition) -> DispositionView:
    return DispositionView(id=d.id or 0, finding_id=d.finding_id, finding_kind=d.finding_kind, action=d.action, reason=d.reason,
                           scope_id=d.scope_id, decided_by=d.decided_by, decided_at=d.decided_at.isoformat(), superseded_by=d.superseded_by)


def _review_view(r: ChangeReview) -> ChangeReviewView:
    return ChangeReviewView(id=r.id or 0, function=r.function, verdict=r.verdict, comment=r.comment, run_id=r.run_id,
                            reviewer=r.reviewer, reviewed_at=r.reviewed_at.isoformat())


_NODE_KIND = {"bom_usage": "revision", "product": "product", "work_order": "work_order", "purchase_order_line": "purchase_order_line",
              "stock_lot": "stock_lot", "fit_pair": "joint", "fit_grip": "joint", "strength_grade": "joint", "substitute": "item"}
_RANK = {"blocked": 0, "affected": 1, "review": 2, "none": 3}


def _graph(order: ChangeOrder, targets: Sequence[ChangeTarget], run: ImpactRun) -> ImpactGraphView:
    """영향 그래프: 변경 → 대상 품목 → 사용 조립품(경로) → 제품, 변경 → 영향 객체(작업지시 · 발주 · 재고 · 체결부). 노드 심각도는 가장 나쁜 것."""
    nodes: dict[str, ImpactGraphNode] = {}
    edges: dict[tuple[str, str, str], ImpactGraphEdge] = {}

    def node(nid: str, label: str, kind: str, severity: str | None = None) -> str:
        cur = nodes.get(nid)
        if cur is None:
            nodes[nid] = ImpactGraphNode(id=nid, label=label, kind=kind, severity=severity)    # type: ignore[arg-type]
        elif severity and (cur.severity is None or _RANK[severity] < _RANK[cur.severity]):
            nodes[nid] = cur.model_copy(update={"severity": severity})
        return nid

    def edge(a: str, b: str, kind: str) -> None:
        edges.setdefault((a, b, kind), ImpactGraphEdge(source=a, target=b, kind=kind))          # type: ignore[arg-type]

    change = node(f"change:{order.code}", order.code, "change")
    for t in targets:
        tid = node(f"item:{t.item_no}", t.item_no, "item")
        edge(change, tid, "changes")
        if t.replacement_item_no:
            edge(tid, node(f"item:{t.replacement_item_no}", t.replacement_item_no, "item"), "replaces")
    for f in run.findings:
        kind = _NODE_KIND[f.kind]
        if f.kind in ("bom_usage", "product"):
            path = [str(x) for x in f.inputs.get("path", [])]
            for a, b in zip(path, path[1:], strict=False):
                edge(node(f"item:{b}", b, "item"), node(f"item:{a}", a, "item"), "contains")
            nid = node(f"item:{path[-1]}" if path else f"{kind}:{f.subject_ref}", f.subject_ref, kind if f.kind == "product" else "item", f.severity)
            edge(change, nid, "affects")
        else:
            nid = node(f"{kind}:{f.subject_ref}", f.subject_ref, kind, f.severity)
            edge(change, nid, "affects")
    return ImpactGraphView(nodes=list(nodes.values()), edges=list(edges.values()))


__all__ = ["ChangeService"]
