"""처분 검증과 승인 가능 조건 (docs/change-impact-design.md 4.5 · 4.6 · 4.7 · 6.3)."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import timedelta

import pytest

from onto_pdm.changes import dispositions as D
from onto_pdm.changes import impact as I
from onto_pdm.changes.fit import PdmTemporaryFitJudge
from onto_pdm.changes.models import ChangeErrorCode, ChangeReview, ChangeTarget, Disposition, ImpactFinding, ImpactRun
from onto_pdm.errors import ApiException
from tests.unit import changes_helpers as H
from tests.unit.changes_helpers import BOLT, FLANGE_BOLT, NOW, brk_m8, t_plate, t_replace_nut


def run_of(targets: Sequence[ChangeTarget], *, run_id: int = 1, **over: object) -> ImpactRun:
    """영향 분석을 돌리고 저장된 것처럼 id 를 붙인다(finding id 1.. 순서대로)."""
    w = brk_m8()
    r = I.analyze(H.order(), targets, bom=w.bom, specs=w.specs, external=w.external, parts=w.parts, judge=PdmTemporaryFitJudge(w.parts),
                  computed_at=NOW, computed_by="tester", scopes=[H.all_scope()])
    stored = tuple(f.model_copy(update={"id": i, "run_id": run_id}) for i, f in enumerate(r.findings, start=1))
    return r.model_copy(update={"id": run_id, "findings": stored, **over})


def disposition(f: ImpactFinding, action: str, *, at_minutes: int = 0, **over: object) -> Disposition:
    base: dict[str, object] = dict(order_code="CO-2026-0001", finding_id=f.id, finding_kind=f.kind, action=action, reason="승인자 결정",
                                   decided_by="approver", decided_at=NOW + timedelta(minutes=at_minutes))
    return Disposition(**{**base, **over})      # type: ignore[arg-type]


def candidate_targets() -> list[ChangeTarget]:
    """SC-2 후보: 상판 12 mm + 볼트를 플랜지볼트로 교체(차단 없음 · affected 만 남는다)."""
    return [t_plate(12.0), ChangeTarget(change_kind="replace", item_no=BOLT, replacement_item_no=FLANGE_BOLT, parent_revision="R00",
                                         before_class="HexBolt", after_class="HexFlangeBolt")]


def affected(run: ImpactRun) -> list[ImpactFinding]:
    return [f for f in run.findings if f.severity == "affected"]


def codes(problems: Sequence[D.ApprovalProblem]) -> list[str]:
    return [p.code for p in problems]


# ---------------------------------------------------------------- 선택지 검증

def test_validate_action_by_finding_kind() -> None:
    D.validate_action("work_order", "change_in_progress")
    D.validate_action("stock_lot", "quarantine")
    D.validate_action("fit_grip", "choose_substitute")
    with pytest.raises(ApiException) as e:
        D.validate_action("stock_lot", "change_in_progress")            # 재고에 작업지시 처분은 없다
    assert (e.value.status, e.value.code) == (422, ChangeErrorCode.DISPOSITION_INVALID)
    with pytest.raises(ApiException):
        D.validate_action("product", "scrap")


def test_validate_disposition_needs_a_reason_and_never_accepts_risk_on_blocked() -> None:
    run = run_of([t_replace_nut()])
    blocked = next(f for f in run.findings if f.severity == "blocked")
    with pytest.raises(ApiException) as e:
        D.validate_disposition(blocked, "accept_risk", "그냥 쓰자")
    assert e.value.status == 422 and "blocked" in e.value.body.error.message
    D.validate_disposition(blocked, "block_change", "변경안을 고친다")            # 차단 해소 수단은 허용
    with pytest.raises(ApiException):
        D.validate_disposition(blocked, "block_change", "   ")                    # 사유가 비면 안 된다
    sub = next(f for f in run_of(candidate_targets()).findings if f.kind == "substitute")        # review 는 accept_risk 로 닫을 수 있다
    D.validate_disposition(sub, "accept_risk", "사람이 확인함")


# ---------------------------------------------------------------- 승인 가능 조건

def test_sc1_cannot_be_approved_blocked_and_affected_remain() -> None:
    run = run_of([t_replace_nut()])
    problems = D.check_approvable(run)
    assert codes(problems) == [ChangeErrorCode.BLOCKED_FINDINGS, ChangeErrorCode.DISPOSITION_REQUIRED]
    assert problems[0].details["count"] == 1
    n_affected = len(affected(run))
    assert n_affected == 4 and problems[1].details["count"] == n_affected                   # 작업지시 2 · 발주 1 · 재고 1
    assert all(p.status == 409 for p in problems)


def test_blocked_stays_blocked_even_if_every_affected_has_a_disposition() -> None:
    run = run_of([t_replace_nut()])
    ds = [disposition(f, {"work_order": "change_in_progress", "purchase_order_line": "amend", "stock_lot": "use_up"}[f.kind]) for f in affected(run)]
    assert codes(D.check_approvable(run, ds)) == [ChangeErrorCode.BLOCKED_FINDINGS]
    blocked = next(f for f in run.findings if f.severity == "blocked")
    assert D.check_approvable(run, ds)[0].details["finding_ids"] == [blocked.id]


def test_candidate_without_blocked_is_approvable_once_affected_have_dispositions() -> None:
    run = run_of(candidate_targets())
    assert not any(f.severity == "blocked" for f in run.findings)
    assert codes(D.check_approvable(run)) == [ChangeErrorCode.DISPOSITION_REQUIRED]
    todo = affected(run)
    assert {f.kind for f in todo} == {"work_order"}
    ds = [disposition(f, "continue_old" if f.reason_code == "used_in_progress" else "apply_new") for f in todo]
    assert D.check_approvable(run, ds) == []                                               # review · none 은 처분이 없어도 된다


def test_review_findings_do_not_require_a_disposition_but_can_be_closed() -> None:
    run = run_of(candidate_targets())
    sub = next(f for f in run.findings if f.kind == "substitute")
    assert sub.severity == "review" and not any(p.details.get("finding_ids") and sub.id in p.details["finding_ids"] for p in D.check_approvable(run))
    D.validate_disposition(sub, "no_action_needed", "설계 확인 완료")


def test_superseded_and_latest_disposition_rules() -> None:
    run = run_of(candidate_targets())
    wo = affected(run)
    first = [disposition(f, "continue_old", at_minutes=0) for f in wo]
    assert D.check_approvable(run, first) == []
    # 재계산으로 대체된 처분은 효력이 없다
    superseded = [d.model_copy(update={"superseded_by": 99}) for d in first]
    assert codes(D.check_approvable(run, superseded)) == [ChangeErrorCode.DISPOSITION_REQUIRED]
    # 같은 finding 에 처분이 둘이면 가장 늦은 결정이 효력이 있다
    later = disposition(wo[0], "cancel_reissue", at_minutes=10)
    active = D.active_dispositions([*first, later])
    assert active[wo[0].id].action == "cancel_reissue" and len(active) == len(wo)


def test_disposition_for_an_unknown_finding_does_not_count() -> None:
    run = run_of(candidate_targets())
    stray = Disposition(order_code="CO-2026-0001", finding_id=9999, finding_kind="work_order", action="continue_old", reason="x", decided_by="a", decided_at=NOW)
    assert codes(D.check_approvable(run, [stray])) == [ChangeErrorCode.DISPOSITION_REQUIRED]


def test_findings_without_ids_cannot_be_matched_to_dispositions() -> None:
    """저장되지 않은(id 없는) 분석은 처분과 맞출 수 없으므로 affected 가 처분 없음으로 남는다."""
    w = brk_m8()
    raw = I.analyze(H.order(), candidate_targets(), bom=w.bom, specs=w.specs, external=w.external, parts=w.parts, judge=PdmTemporaryFitJudge(w.parts),
                    computed_at=NOW, computed_by="tester", scopes=[H.all_scope()])
    assert codes(D.check_approvable(raw)) == [ChangeErrorCode.DISPOSITION_REQUIRED]


# ---------------------------------------------------------------- 분석 상태

def test_stale_latest_and_partial_runs_cannot_be_approved() -> None:
    run = run_of(candidate_targets())
    ds = [disposition(f, "continue_old") for f in affected(run)]
    assert D.check_approvable(run, ds) == []
    stale = I.mark_stale(run, ["external_feed_newer"])
    p = D.check_approvable(stale, ds)
    assert codes(p) == [ChangeErrorCode.IMPACT_STALE] and p[0].details["stale_reasons"] == ["external_feed_newer"]
    assert codes(D.check_approvable(run, ds, is_latest_run=False)) == [ChangeErrorCode.IMPACT_STALE]
    assert codes(D.check_approvable(run.model_copy(update={"partial": True}), ds)) == [ChangeErrorCode.IMPACT_PARTIAL]


# ---------------------------------------------------------------- 부서 검토

def review(function: str, verdict: str = "approve", run_id: int = 1, at_minutes: int = 0) -> ChangeReview:
    return ChangeReview(order_code="CO-2026-0001", function=function, run_id=run_id, verdict=verdict, reviewer=f"{function}-user",   # type: ignore[arg-type]
                        reviewed_at=NOW + timedelta(minutes=at_minutes))


def test_required_reviews_must_approve_the_same_run() -> None:
    run = run_of(candidate_targets())
    ds = [disposition(f, "continue_old") for f in affected(run)]
    need = ("design", "purchasing", "production")
    p = D.check_approvable(run, ds, required_functions=need)
    assert codes(p) == [ChangeErrorCode.REVIEW_REQUIRED] and p[0].details["functions"] == ["design", "production", "purchasing"]
    reviews = [review("design"), review("purchasing"), review("production")]
    assert D.check_approvable(run, ds, required_functions=need, reviews=reviews) == []
    # 다른 분석(run 2)을 보고 한 검토는 무효 — 분석이 바뀌면 다시 검토한다
    old = [review("design", run_id=2), review("purchasing"), review("production")]
    assert D.check_approvable(run, ds, required_functions=need, reviews=old)[0].details["functions"] == ["design"]
    # 부서별 가장 늦은 검토가 효력: 승인 뒤에 반려하면 승인이 아니다
    flipped = [*reviews, review("production", "reject", at_minutes=5)]
    assert D.check_approvable(run, ds, required_functions=need, reviews=flipped)[0].details["functions"] == ["production"]
    assert D.check_approvable(run, ds, required_functions=(), reviews=[]) == []                  # 필요한 검토가 없으면 묻지 않는다
    assert D.check_approvable(run, ds, required_functions=("design",), reviews=[review("design", "comment")])[0].code == ChangeErrorCode.REVIEW_REQUIRED


# ---------------------------------------------------------------- accept_risk 정책 스위치

def test_accept_risk_on_blocked_is_off_by_default_and_a_switch_when_policy_decides() -> None:
    run = run_of([t_replace_nut()])
    blocked = next(f for f in run.findings if f.severity == "blocked")
    risk = disposition(blocked, "accept_risk")             # 모델은 허용 선택지라 만들 수 있지만(정책은 서비스 입력 검증에서) 기본 승인 조건은 막는다
    others = [disposition(f, {"work_order": "change_in_progress", "purchase_order_line": "amend", "stock_lot": "use_up"}[f.kind]) for f in affected(run)]
    assert codes(D.check_approvable(run, [risk, *others])) == [ChangeErrorCode.BLOCKED_FINDINGS]
    assert D.check_approvable(run, [risk, *others], allow_accept_risk_on_blocked=True) == []     # 정책이 정해지면 켠다(지금은 판단 필요)
    assert codes(D.check_approvable(run, others, allow_accept_risk_on_blocked=True)) == [ChangeErrorCode.BLOCKED_FINDINGS]  # 처분이 없으면 켜도 막힌다


# ---------------------------------------------------------------- 오류로 올리기

def test_raise_if_not_approvable_raises_the_first_problem_with_the_others_listed() -> None:
    run = run_of([t_replace_nut()])
    with pytest.raises(ApiException) as e:
        D.raise_if_not_approvable(D.check_approvable(run))
    assert (e.value.status, e.value.code) == (409, ChangeErrorCode.BLOCKED_FINDINGS)
    assert e.value.body.error.details["also"] == [ChangeErrorCode.DISPOSITION_REQUIRED]
    D.raise_if_not_approvable([])                           # 문제가 없으면 아무 일도 없다


def test_invalid_disposition_problem_is_422() -> None:
    run = run_of(candidate_targets())
    f = affected(run)[0]
    # 모델이 막는 값이라 우회해서(model_construct) 저장소가 잘못 담았을 때를 흉내 낸다
    bad = Disposition.model_construct(order_code="CO-2026-0001", finding_id=f.id, finding_kind="stock_lot", action="change_in_progress",
                                      reason="x", decided_by="a", decided_at=NOW, superseded_by=None, id=None, scope_id=None)
    p = D.check_approvable(run, [bad])
    assert ChangeErrorCode.DISPOSITION_INVALID in codes(p) and next(x for x in p if x.code == ChangeErrorCode.DISPOSITION_INVALID).status == 422


# ---------------------------------------------------------------- 재계산 승계

def test_carry_over_gives_suggestions_only_for_the_same_finding_key() -> None:
    prev = run_of(candidate_targets())
    wo = affected(prev)
    ds = [disposition(wo[0], "continue_old"), disposition(wo[1], "apply_new")]
    again = I.analyze(H.order(), candidate_targets(), bom=brk_m8().bom, specs=brk_m8().specs, external=brk_m8().external, parts=H.part_source(),
                      judge=PdmTemporaryFitJudge(H.part_source()), computed_at=NOW, computed_by="t", scopes=[H.all_scope()])
    carried = D.carry_over_suggestions(prev.findings, ds, again.findings)
    assert carried == {D.finding_key(wo[0]): "continue_old", D.finding_key(wo[1]): "apply_new"}
    # 새 분석에 없는 finding 의 처분은 가져오지 않고, 처분 없는 finding 은 제안이 없다
    shrunk = [f for f in again.findings if f.subject_ref != wo[1].subject_ref]
    assert D.finding_key(wo[1]) not in D.carry_over_suggestions(prev.findings, ds, shrunk)
    assert D.carry_over_suggestions(prev.findings, [], again.findings) == {}


def test_carry_over_skips_actions_the_new_finding_does_not_allow() -> None:
    prev = run_of(candidate_targets())
    f = affected(prev)[0]
    ds = [disposition(f, "continue_old")]
    other_kind = f.model_copy(update={"kind": "stock_lot", "scope_class": "inside", "suggested_disposition": None})
    assert D.carry_over_suggestions(prev.findings, ds, [other_kind]) == {}              # 키가 다르니 승계 없음
    same_key = ImpactFinding(**{**f.model_dump(), "suggested_disposition": None})
    assert D.carry_over_suggestions(prev.findings, ds, [same_key]) == {D.finding_key(f): "continue_old"}
