"""처분(Disposition) 검증과 승인 가능 조건 검사. 순수 함수다.

근거: docs/change-impact-design.md 4.5 · 4.6 · 4.7 · 6.3, docs/change-impact-ontology.md 7장.

- 영향 발견(`ImpactFinding`)과 처분은 다르다. 처분은 **사람의 결정**이고 PDM 안의 기록이다(ERP · MES 에 쓰지 않는다).
- 승인 조건(기본 정책): `blocked` 가 남아 있으면 승인할 수 없다 · `affected` 마다 처분이 있어야 한다 · `review` 는 `no_action_needed` 로 닫을 수 있다
  · 분석이 낡지(stale) 않았고 최신이며 OPMS 를 못 읽은(partial) 분석이 아니다 · 필요한 부서 검토가 모두 `approve` 다.
- `blocked` 를 사유를 적고 예외 승인할 수 있게 할지(`accept_risk`)는 안전 · 품질 정책이라 정하지 않았다(design 10.3-2). 기본은 **막는다**.
  정책이 정해지면 `allow_accept_risk_on_blocked=True` 로 켠다.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from onto_pdm.changes.models import (
    ChangeErrorCode,
    ChangeReview,
    Disposition,
    DispositionAction,
    ImpactFinding,
    ImpactRun,
    ReviewFunction,
    blocks_approval,
    is_action_allowed,
    requires_disposition,
)
from onto_pdm.errors import ApiException

FindingKey = tuple[str, str, str]      # (kind, subject_type, subject_ref)


def finding_key(f: ImpactFinding) -> FindingKey:
    return (f.kind, f.subject_type, f.subject_ref)


def validate_action(finding_kind: str, action: str) -> None:
    """대상 종류에 없는 선택지는 `DISPOSITION_INVALID`(422)."""
    if not is_action_allowed(finding_kind, action):
        raise ApiException(422, ChangeErrorCode.DISPOSITION_INVALID, f"{finding_kind} 에는 {action} 처분이 없어요",
                           {"kind": finding_kind, "action": action})


def validate_disposition(finding: ImpactFinding, action: str, reason: str) -> None:
    """처분 한 건의 입력 검증: 선택지 · 사유. `accept_risk` 를 `blocked` 에 쓰는 것은 정책 결정 전까지 막는다."""
    validate_action(finding.kind, action)
    if not reason.strip():
        raise ApiException(422, ChangeErrorCode.DISPOSITION_INVALID, "처분 사유가 비어 있어요", {"action": action})
    if action == "accept_risk" and blocks_approval(finding.severity):
        raise ApiException(422, ChangeErrorCode.DISPOSITION_INVALID,
                           "blocked 영향은 위험을 받아들이는 처분으로 닫을 수 없어요. 변경안을 고치세요 (예외 승인 정책은 미정)",
                           {"finding_id": finding.id, "severity": finding.severity})


@dataclass(frozen=True)
class ApprovalProblem:
    """승인을 막는 문제 한 가지. `status` 는 API 가 쓸 HTTP 상태, `details` 는 오류 본문에 그대로 담는다."""

    code: str
    message: str
    details: Mapping[str, Any] = field(default_factory=dict)
    status: int = 409


def active_dispositions(dispositions: Iterable[Disposition]) -> dict[int, Disposition]:
    """finding 별로 **효력 있는** 처분(재계산으로 대체되지 않은 것 중 가장 늦게 결정한 것)."""
    best: dict[int, Disposition] = {}
    for d in dispositions:
        if d.superseded_by is not None:
            continue
        cur = best.get(d.finding_id)
        if cur is None or d.decided_at >= cur.decided_at:
            best[d.finding_id] = d
    return best


def check_approvable(
    run: ImpactRun,
    dispositions: Sequence[Disposition] = (),
    *,
    is_latest_run: bool = True,
    required_functions: Collection[ReviewFunction] = (),
    reviews: Sequence[ChangeReview] = (),
    allow_accept_risk_on_blocked: bool = False,
) -> list[ApprovalProblem]:
    """승인할 수 없는 이유 목록(비어 있으면 승인 가능). 순서: 분석 상태 → blocked → 처분 필요 → 검토.

    `run.findings` 의 `id` 가 처분의 `finding_id` 와 맞아야 한다(저장된 분석)."""
    problems: list[ApprovalProblem] = []
    if run.stale or not is_latest_run:
        problems.append(ApprovalProblem(
            ChangeErrorCode.IMPACT_STALE, "영향 분석이 낡았어요. 다시 계산한 뒤 승인하세요",
            {"stale_reasons": list(run.stale_reasons), "latest": is_latest_run}))
    if run.partial:
        problems.append(ApprovalProblem(
            ChangeErrorCode.IMPACT_PARTIAL, "OPMS를 읽지 못한 분석으로는 승인할 수 없어요. OPMS에 연결한 뒤 다시 계산하세요"))

    active = active_dispositions(dispositions)
    invalid = [d for d in active.values() if not _valid_for(run, d)]
    if invalid:
        problems.append(ApprovalProblem(
            ChangeErrorCode.DISPOSITION_INVALID, "대상 종류에 없는 처분이 있어요",
            {"finding_ids": sorted(d.finding_id for d in invalid)}, status=422))

    blocked = [f for f in run.findings if blocks_approval(f.severity) and not _risk_accepted(f, active, allow_accept_risk_on_blocked)]
    if blocked:
        problems.append(ApprovalProblem(
            ChangeErrorCode.BLOCKED_FINDINGS, "제안대로면 성립하지 않는 영향(blocked)이 남아 있어요. 변경안을 고치세요",
            {"finding_ids": [f.id for f in blocked if f.id is not None], "count": len(blocked)}))

    missing = [f for f in run.findings if requires_disposition(f.severity) and (f.id is None or f.id not in active)]
    if missing:
        problems.append(ApprovalProblem(
            ChangeErrorCode.DISPOSITION_REQUIRED, "처분이 정해지지 않은 영향(affected)이 있어요",
            {"finding_ids": [f.id for f in missing if f.id is not None], "count": len(missing)}))

    if required_functions:
        done = {r.function for r in _latest_reviews(reviews, run.id) if r.verdict == "approve"}
        need = sorted(set(required_functions) - done)
        if need:
            problems.append(ApprovalProblem(
                ChangeErrorCode.REVIEW_REQUIRED, "부서 검토가 끝나지 않았어요", {"functions": need}))
    return problems


def raise_if_not_approvable(problems: Sequence[ApprovalProblem]) -> None:
    """첫 번째 문제를 `ApiException` 으로 낸다. 서비스가 승인 직전에 부른다."""
    if problems:
        p = problems[0]
        details = dict(p.details)
        if len(problems) > 1:
            details["also"] = [x.code for x in problems[1:]]
        raise ApiException(p.status, p.code, p.message, details or None)


def _valid_for(run: ImpactRun, d: Disposition) -> bool:
    return is_action_allowed(d.finding_kind, d.action)


def _risk_accepted(f: ImpactFinding, active: Mapping[int, Disposition], allowed: bool) -> bool:
    if not allowed or f.id is None:
        return False
    d = active.get(f.id)
    return d is not None and d.action == "accept_risk"


def _latest_reviews(reviews: Sequence[ChangeReview], run_id: int | None) -> list[ChangeReview]:
    """분석(`run_id`)을 보고 한 검토 중 부서별 최신 한 건. 다른 분석에 대한 검토는 무효다(분석이 바뀌면 다시 검토)."""
    latest: dict[str, ChangeReview] = {}
    for r in reviews:
        if run_id is not None and r.run_id != run_id:
            continue
        cur = latest.get(r.function)
        if cur is None or r.reviewed_at >= cur.reviewed_at:
            latest[r.function] = r
    return list(latest.values())


def carry_over_suggestions(
    previous_findings: Sequence[ImpactFinding], previous_dispositions: Sequence[Disposition], new_findings: Sequence[ImpactFinding],
) -> dict[FindingKey, DispositionAction]:
    """재계산 뒤 같은 `(kind, subject_type, subject_ref)` finding 에 이전 처분을 **제안**으로만 가져온다(자동 확정하지 않는다, design 4.6).
    새 finding 에서 선택지가 허용되지 않는 처분은 가져오지 않는다."""
    old_by_id = {f.id: f for f in previous_findings if f.id is not None}
    active = active_dispositions(previous_dispositions)
    by_key: dict[FindingKey, DispositionAction] = {}
    for fid, d in active.items():
        f = old_by_id.get(fid)
        if f is not None:
            by_key[finding_key(f)] = d.action
    return {finding_key(n): by_key[finding_key(n)] for n in new_findings
            if finding_key(n) in by_key and is_action_allowed(n.kind, by_key[finding_key(n)])}


__all__ = [
    "FindingKey", "finding_key", "validate_action", "validate_disposition", "ApprovalProblem", "active_dispositions",
    "check_approvable", "raise_if_not_approvable", "carry_over_suggestions",
]
