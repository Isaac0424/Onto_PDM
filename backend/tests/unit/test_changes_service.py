"""변경 서비스(메모리 저장소 위): 요청 · 대상 · 범위 검증, stale, 처분 규칙, 승인 발행(새 개정), 유효 개정 선택, 반려. 라우트 없이 서비스를 직접 부른다."""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from onto_pdm.changes.fixtures import BOLT, FLANGE_BOLT, FIXTURE_AS_OF, ITEM_BOTTOM, ITEM_MODULE, ITEM_SET, ITEM_TOP, NUT
from onto_pdm.changes.models import ChangeErrorCode
from onto_pdm.changes.scope import ScopeSubject
from onto_pdm.contracts import (
    ChangeCreateRequest,
    ChangeRejectIn,
    ChangeReviewIn,
    ChangeScopeIn,
    ChangeScopesIn,
    ChangeTargetIn,
    DispositionIn,
    StockLotFeedIn,
    StockLotFeedRow,
)
from onto_pdm.errors import ApiException
from tests.unit.changes_api_helpers import SC1, SC2, World, make_world, session


def _code(excinfo: pytest.ExceptionInfo[ApiException]) -> tuple[int, str]:
    return excinfo.value.status, excinfo.value.code


def _new_change(w: World, who: str = "lee") -> str:
    d = w.service.create_change(session(w, who), ChangeCreateRequest(title="시험 변경", reason="시험"))
    return d.code


# ------------------------------------------------------------------ 요청 만들기


def test_create_change_makes_request_and_empty_order_with_sequential_codes() -> None:
    w = make_world(None)
    a = w.service.create_change(session(w, "lee"), ChangeCreateRequest(title="A", reason="왜"))
    b = w.service.create_change(session(w, "lee"), ChangeCreateRequest(title="B", reason="왜"))
    assert (a.code, b.code) == ("CR-2026-0001", "CR-2026-0002")
    assert a.order is not None and a.order.code == "CO-2026-0001" and a.order.status == "draft"
    assert a.status == "draft" and a.targets == [] and a.latest_run is None


def test_viewer_cannot_create_and_unknown_product_is_404() -> None:
    w = make_world(None)
    viewer = session(w, "lee").__class__(user=session(w, "lee").user.model_copy(update={"role": "viewer"}))
    with pytest.raises(ApiException) as e:
        w.service.create_change(viewer, ChangeCreateRequest(title="A", reason="왜"))
    assert _code(e) == (403, ChangeErrorCode.FORBIDDEN)
    with pytest.raises(ApiException) as e2:
        w.service.create_change(session(w, "lee"), ChangeCreateRequest(title="A", reason="왜", product_code="NOPE"))
    assert e2.value.status == 404


def test_draft_is_visible_to_author_and_admin_mode_only() -> None:
    w = make_world(None)
    code = _new_change(w)
    w.service.get_detail(session(w, "lee"), code)
    w.service.get_detail(session(w, "kim", admin_mode=True), code)
    with pytest.raises(ApiException) as e:
        w.service.get_detail(session(w, "choi"), code)               # 승인자라도 관리자 모드가 아니면 남의 작업중 건은 안 보인다
    assert _code(e) == (404, ChangeErrorCode.CHANGE_NOT_FOUND)


# ------------------------------------------------------------------ 대상 검증 (F-CHG-10 · SC-3)


def test_target_item_must_exist_and_be_released() -> None:
    w = make_world("base")
    s = session(w, "lee")
    code = _new_change(w)
    with pytest.raises(ApiException) as e:
        w.service.add_target(s, code, ChangeTargetIn(change_kind="replace", item_no="NOPE", replacement_item_no=NUT))
    assert _code(e) == (404, ChangeErrorCode.ITEM_NOT_FOUND)
    with pytest.raises(ApiException) as e:
        w.service.add_target(s, code, ChangeTargetIn(change_kind="replace", item_no=NUT, replacement_item_no="NOPE"))
    assert _code(e) == (404, ChangeErrorCode.ITEM_NOT_FOUND)
    with pytest.raises(ApiException) as e:
        w.service.add_target(s, code, ChangeTargetIn(change_kind="revise", item_no=ITEM_TOP, from_revision="R09",
                                                     before={"thickness": 8}, after={"thickness": 12}))
    assert _code(e) == (409, ChangeErrorCode.TARGET_NOT_RELEASED)


def test_revise_that_changes_the_spec_is_refused_as_a_new_part_number() -> None:
    """SC-3: 규격(길이)이 바뀌면 개정이 아니라 교체(새 품번)다. 같은 품번 안의 도면 치수는 개정이다."""
    w = make_world("base")
    s = session(w, "lee")
    code = _new_change(w)
    with pytest.raises(ApiException) as e:
        w.service.add_target(s, code, ChangeTargetIn(change_kind="revise", item_no=BOLT, before={"length": 30}, after={"length": 35}))
    assert _code(e) == (422, ChangeErrorCode.REVISION_CHANGES_IDENTITY)
    assert "length" in e.value.body.error.details["changed"]
    with pytest.raises(ApiException) as e:                          # 속성 변경도 규격이면 같다
        w.service.add_target(s, code, ChangeTargetIn(change_kind="attribute_edit", item_no=BOLT, before={"material": "SUS304"}, after={"material": "SUS316"}))
    assert _code(e) == (422, ChangeErrorCode.REVISION_CHANGES_IDENTITY)
    ok = w.service.add_target(s, code, ChangeTargetIn(change_kind="revise", item_no=ITEM_TOP, before={"thickness": 8}, after={"thickness": 12}))
    assert ok.to_revision == "R01" and ok.from_revision == "R00"      # 새 개정 번호는 자동으로 붙는다


def test_targets_can_only_change_while_the_order_is_a_draft() -> None:
    w = make_world("sc2")
    s = session(w, "lee")
    w.service.run_impact(s, SC2)
    w.service.submit(s, SC2)
    with pytest.raises(ApiException) as e:
        w.service.add_target(s, SC2, ChangeTargetIn(change_kind="replace", item_no=BOLT, replacement_item_no=FLANGE_BOLT))
    assert _code(e) == (409, ChangeErrorCode.CHANGE_STATE_INVALID)


# ------------------------------------------------------------------ 적용 범위


def test_scope_validation_and_overlap() -> None:
    w = make_world("sc2")
    s = session(w, "lee")
    tid = w.service.get_detail(s, SC2).targets[0].id
    with pytest.raises(ApiException) as e:
        w.service.set_scope(s, SC2, tid, ChangeScopesIn(scopes=[ChangeScopeIn(serial_from=100, serial_to=10)]))
    assert _code(e) == (422, ChangeErrorCode.SCOPE_INVALID)
    with pytest.raises(ApiException) as e:
        w.service.set_scope(s, SC2, tid, ChangeScopesIn(scopes=[ChangeScopeIn(effective_from="내일")]))
    assert _code(e) == (422, ChangeErrorCode.SCOPE_INVALID)
    with pytest.raises(ApiException) as e:
        w.service.set_scope(s, SC2, tid, ChangeScopesIn(scopes=[ChangeScopeIn(site="S1", serial_from=1, serial_to=50),
                                                                ChangeScopeIn(site="S1", serial_from=40, serial_to=90)]))
    assert _code(e) == (409, ChangeErrorCode.SCOPE_OVERLAP)
    saved = w.service.set_scope(s, SC2, tid, ChangeScopesIn(scopes=[ChangeScopeIn(site="S1", serial_from=1, serial_to=50),
                                                                    ChangeScopeIn(site="S1", serial_from=51, applies="old")]))
    assert [x.id for x in saved] and saved[0].site == "S1"


def test_submit_requires_a_scope_and_a_fresh_analysis() -> None:
    w = make_world("sc2")
    s = session(w, "lee")
    tid = w.service.get_detail(s, SC2).targets[0].id
    w.service.set_scope(s, SC2, tid, ChangeScopesIn(scopes=[]))        # 범위를 비운다 → '전체'가 아니라 미정
    with pytest.raises(ApiException) as e:
        w.service.submit(s, SC2)
    assert _code(e) == (409, ChangeErrorCode.SCOPE_REQUIRED)
    w.service.set_scope(s, SC2, tid, ChangeScopesIn(scopes=[ChangeScopeIn()]))
    with pytest.raises(ApiException) as e:                              # 분석이 아직 없다
        w.service.submit(s, SC2)
    assert _code(e) == (409, ChangeErrorCode.IMPACT_NOT_COMPUTED)
    w.service.run_impact(s, SC2)
    assert w.service.submit(s, SC2).order.status == "in_review"           # type: ignore[union-attr]


# ------------------------------------------------------------------ stale


def test_editing_targets_or_scope_marks_the_latest_run_stale_and_blocks_submit() -> None:
    w = make_world("sc2")
    s = session(w, "lee")
    w.service.run_impact(s, SC2)
    assert w.service.get_detail(s, SC2).latest_run.stale is False        # type: ignore[union-attr]
    tid = w.service.get_detail(s, SC2).targets[0].id
    w.service.set_scope(s, SC2, tid, ChangeScopesIn(scopes=[ChangeScopeIn(site="S1")]))
    run = w.service.get_detail(s, SC2).latest_run
    assert run is not None and run.stale and run.stale_reasons == ["input_changed"]
    with pytest.raises(ApiException) as e:
        w.service.submit(s, SC2)
    assert _code(e) == (409, ChangeErrorCode.IMPACT_STALE)
    assert w.service.run_impact(s, SC2).stale is False                    # 다시 계산하면 풀린다


def test_newer_external_feed_marks_run_stale_but_older_feed_does_not() -> None:
    w = make_world("sc2")
    s = session(w, "lee")
    w.service.run_impact(s, SC2)

    def feed(as_of: datetime) -> object:
        row = StockLotFeedRow(lot_no="LT-N-01", item_no=NUT, qty_on_hand=1, as_of=as_of.isoformat())
        return w.service.feed_stock_lots(StockLotFeedIn(source_system="fixture", rows=[row]))

    older = feed(FIXTURE_AS_OF - timedelta(days=1))
    assert older.ignored_stale == 1 and older.applied == 0                # type: ignore[attr-defined]
    assert w.service.get_detail(s, SC2).latest_run.stale is False         # type: ignore[union-attr]
    newer = feed(FIXTURE_AS_OF + timedelta(hours=1))
    assert newer.applied == 1                                             # type: ignore[attr-defined]
    run = w.service.get_detail(s, SC2).latest_run
    assert run is not None and run.stale and "external_feed_newer" in run.stale_reasons


# ------------------------------------------------------------------ 처분


def test_disposition_rules() -> None:
    w = make_world("sc1")
    s = session(w, "lee")
    run = w.service.run_impact(s, SC1)
    blocked = next(f for f in run.findings if f.severity == "blocked")
    po = next(f for f in run.findings if f.kind == "purchase_order_line")
    with pytest.raises(ApiException) as e:                                 # 발주 항목에 재고 처분은 없다
        w.service.put_disposition(s, SC1, po.id, DispositionIn(action="use_up", reason="x"))
    assert _code(e) == (422, ChangeErrorCode.DISPOSITION_INVALID)
    with pytest.raises(ApiException) as e:                                 # blocked 는 위험 수용으로 닫을 수 없다(정책 미정 → 기본 막음)
        w.service.put_disposition(s, SC1, blocked.id, DispositionIn(action="accept_risk", reason="괜찮다"))
    assert _code(e) == (422, ChangeErrorCode.DISPOSITION_INVALID)
    with pytest.raises(ApiException) as e:
        w.service.put_disposition(s, SC1, po.id, DispositionIn(action="amend", reason="   "))
    assert e.value.status == 422
    with pytest.raises(ApiException) as e:
        w.service.put_disposition(s, SC1, 99999, DispositionIn(action="amend", reason="x"))
    assert e.value.status == 404
    first = w.service.put_disposition(s, SC1, po.id, DispositionIn(action="amend", reason="수량 정정 요청"))
    second = w.service.put_disposition(s, SC1, po.id, DispositionIn(action="cancel", reason="취소로 바꿈"))
    assert first.superseded_by is None and second.action == "cancel"
    history = w.service.get_detail(s, SC1).dispositions
    assert [d.superseded_by is not None for d in history if d.finding_id == po.id] == [True, False]     # 이전 결정은 이력으로 남는다


# ------------------------------------------------------------------ 승인: 새 개정 발행 · 부분 범위 · 전체 범위 · 반려


def _approve_sc2(w: World) -> None:
    from tests.unit.changes_api_helpers import CHOI, LEE, decide_all_affected, run_impact, url

    tid = w.client.post(url(f"/changes/{SC2}/targets"), headers=LEE,
                        json={"change_kind": "replace", "item_no": BOLT, "replacement_item_no": FLANGE_BOLT, "parent_revision": "R00"}).json()["id"]
    w.client.put(url(f"/changes/{SC2}/targets/{tid}/scope"), headers=LEE, json={"scopes": [
        {"site": "S1", "serial_from": 71, "effective_from": "2026-12-01"}, {"site": "S2", "serial_from": 71, "effective_from": "2026-12-01"}]})
    run = run_impact(w, SC2)
    decide_all_affected(w, SC2, run)
    assert w.client.post(url(f"/changes/{SC2}/submit"), headers=LEE).status_code == 200
    for who, fn in ((LEE, "design"), (CHOI, "purchasing"), (CHOI, "production")):
        assert w.client.post(url(f"/changes/{SC2}/reviews"), headers=who, json={"function": fn, "verdict": "approve"}).status_code == 201
    assert w.client.post(url(f"/changes/{SC2}/approve"), headers=CHOI).status_code == 200


def test_partial_scope_approval_keeps_the_old_revision_released_and_picks_by_scope() -> None:
    """SC-2: 일련번호 71 이후만 새 개정. 이미 만든 제품(#70 이하)은 기존 사양(R00)을 그대로 쓴다 — 이전 개정을 폐기하지 않는다."""
    from tests.unit.changes_api_helpers import revisions

    w = make_world("sc2")
    _approve_sc2(w)
    for item in (ITEM_TOP, ITEM_SET, ITEM_MODULE):                      # 상판(개정) · 체결 세트(볼트 교체) · 모듈(체결 구성 갱신)
        assert revisions(w, item) == [("R01", "released"), ("R00", "released")], item
    assert revisions(w, ITEM_BOTTOM) == [("R00", "released")]            # 건드리지 않은 부품은 그대로
    at = date(2026, 12, 5)
    assert w.service.effective_revision_at(ITEM_TOP, ScopeSubject(site="S1", serial_from=70, serial_to=70, on_date=at)) == "R00"
    assert w.service.effective_revision_at(ITEM_TOP, ScopeSubject(site="S1", serial_from=75, serial_to=75, on_date=at)) == "R01"
    assert w.service.effective_revision_at(ITEM_TOP, ScopeSubject(site="S3", serial_from=75, serial_to=75, on_date=at)) == "R00"   # 범위 밖 사업장
    # 새 개정은 값(두께 12)과 교체(볼트→플랜지볼트)를 담고, 기존 개정 값은 그대로다
    assert {s.revision: s.value for s in w.changes.list_revision_specs(ITEM_TOP) if s.key == "thickness"} == {"R00": 8.0, "R01": 12.0}
    new_joint = next(j for j in w.changes.list_joints(ITEM_MODULE, "R01"))
    assert new_joint.bolt_item_no == FLANGE_BOLT and next(j for j in w.changes.list_joints(ITEM_MODULE, "R00")).bolt_item_no == BOLT
    assert w.service.audit[-1]["action"] == "change.approve" and len(w.service.audit[-1]["revisions"]) == 3


def test_full_scope_approval_obsoletes_the_previous_revision() -> None:
    from tests.unit.changes_api_helpers import CHOI, LEE, decide_all_affected, revisions, run_impact, url

    w = make_world("sc2")
    tid = w.service.get_detail(session(w, "lee"), SC2).targets[0].id
    w.client.put(url(f"/changes/{SC2}/targets/{tid}/scope"), headers=LEE, json={"scopes": [{}]})        # 전체
    t2 = w.client.post(url(f"/changes/{SC2}/targets"), headers=LEE,
                       json={"change_kind": "replace", "item_no": BOLT, "replacement_item_no": FLANGE_BOLT, "parent_revision": "R00"}).json()["id"]
    w.client.put(url(f"/changes/{SC2}/targets/{t2}/scope"), headers=LEE, json={"scopes": [{}]})
    run = run_impact(w, SC2)
    decide_all_affected(w, SC2, run)
    w.client.post(url(f"/changes/{SC2}/submit"), headers=LEE)
    for who, fn in ((LEE, "design"), (CHOI, "purchasing"), (CHOI, "production")):
        w.client.post(url(f"/changes/{SC2}/reviews"), headers=who, json={"function": fn, "verdict": "approve"})
    assert w.client.post(url(f"/changes/{SC2}/approve"), headers=CHOI).status_code == 200
    assert revisions(w, ITEM_TOP) == [("R01", "released"), ("R00", "obsolete")]          # 전체 범위면 이전 개정은 폐기
    assert w.service.effective_revision_at(ITEM_TOP, ScopeSubject(site="S1", serial_from=1)) == "R01"


def test_reject_records_the_reason_and_needs_one() -> None:
    w = make_world("sc2")
    s, choi = session(w, "lee"), session(w, "choi")
    w.service.run_impact(s, SC2)
    w.service.submit(s, SC2)
    with pytest.raises(ApiException) as e:
        w.service.reject(choi, SC2, ChangeRejectIn(reason="  "))
    assert e.value.status == 422
    d = w.service.reject(choi, SC2, ChangeRejectIn(reason="두께 변경은 보류"))
    assert d.status == "rejected" and d.order.status == "rejected"          # type: ignore[union-attr]
    assert any(r.verdict == "reject" and "보류" in r.comment for r in d.reviews)
    assert revisions_untouched(w)


def revisions_untouched(w: World) -> bool:
    from tests.unit.changes_api_helpers import revisions
    return revisions(w, ITEM_TOP) == [("R00", "released")]


def test_roles_gate_the_transitions() -> None:
    w = make_world("sc2")
    lee, choi = session(w, "lee"), session(w, "choi")
    w.service.run_impact(lee, SC2)
    w.service.submit(lee, SC2)
    with pytest.raises(ApiException) as e:                                 # 설계 엔지니어는 승인할 수 없다
        w.service.approve(lee, SC2)
    assert _code(e) == (403, ChangeErrorCode.FORBIDDEN)
    with pytest.raises(ApiException) as e:                                 # 구매 · 생산 검토는 승인자 · 관리자만(자격 표가 생기기 전 임시 규칙)
        w.service.add_review(lee, SC2, ChangeReviewIn(function="purchasing", verdict="approve"))
    assert _code(e) == (403, ChangeErrorCode.FORBIDDEN)
    fresh = _new_change(w)                                                 # 새 요청(draft)은 승인자 · 관리자만 접수한다
    with pytest.raises(ApiException) as e:
        w.service.accept(lee, fresh)
    assert _code(e) == (403, ChangeErrorCode.FORBIDDEN)
    assert w.service.accept(session(w, "kim", admin_mode=True), fresh).status == "accepted"
    with pytest.raises(ApiException) as e:                                 # 이미 접수된 요청을 다시 접수할 수는 없다
        w.service.accept(choi, SC2)
    assert _code(e) == (409, ChangeErrorCode.CHANGE_STATE_INVALID)
