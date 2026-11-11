"""체결 적합성 판정: 볼트↔너트↔와셔 짝 · 그립 길이 · 강도등급 · 대체. 순수 계산이고 저장 · 네트워크가 없다.

근거: docs/change-impact-design.md 4.4 · 4.5 · 5.2, docs/change-impact-ontology.md 5 · 6장.

- **짝(mates_with)**: OPMS 스냅샷의 규칙 명세(`bolt_nut` · `bolt_washer` · `nut_washer`)를 읽어 OPMS 와 같은 4상태(fits · mismatch · unknown ·
  unrelated)를 PDM 4상태(ok · no · unknown)로 옮긴다. OPMS 에는 mates 서버 판정 API 가 없어서 **임시 판정**이고 항상 `temporary=True` 다.
- **그립 길이**: 관통 체결의 필요 볼트 길이. **시연용 가정**이고 기준 출처 · 담당자가 없다(OPMS 규칙이 아니다 → rule_id `pdm:grip_length`).
      필요 길이 = Σ판 두께 + 와셔 두께 × 와셔 수 + 너트 높이(nutHeight) + 2 × 볼트 피치
- **강도등급**: OPMS 에 순서 비교가 없다. 값이 다르면 판정하지 않고 "사람이 확인"(review)으로 남긴다.
- 판정 결과(`FitResult`)는 `ImpactFinding` 의 재료다. 심각도는 4.5 표: no → blocked, conditional · unknown → review, ok → none.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from onto_pdm.changes.models import FindingKind, Severity, Verdict
from onto_pdm.changes.ports import PartAttrs, PartAttrSource
from onto_pdm.opms.mates import MatesRule, SubstituteRule

# 그립 길이(시연용 가정, 기준 미지정). OPMS `fit_check` 의 margin · warn_within 모양을 따른다.
GRIP_THREAD_MARGIN_PITCHES = 2.0        # 너트 밖으로 나오는 나사 여유 = 2 × 피치
GRIP_WARN_WITHIN = 1.0                  # 여유가 이보다 작으면 conditional(thin_margin)
GRIP_RULE_ID = "pdm:grip_length"
STRENGTH_RULE_ID = "pdm:strength_grade"

SEVERITY_BY_VERDICT: Mapping[str, Severity] = {"ok": "none", "conditional": "review", "unknown": "review", "no": "blocked"}

_LABELS = {
    "threadSize": "나사 호칭", "pitch": "피치", "threadDirection": "나사 방향", "length": "길이", "nutHeight": "너트 높이",
    "thickness": "두께", "material": "재질", "surfaceTreatment": "표면처리", "strengthGrade": "강도 등급",
}


def severity_for(verdict: str) -> Severity:
    return SEVERITY_BY_VERDICT[verdict]


def _r6(x: float) -> float:
    return round(x, 6)


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or not isinstance(v, int | float):
        return None
    return float(v)


def _same(a: Any, b: Any) -> bool:
    fa, fb = _num(a), _num(b)
    if fa is not None and fb is not None:
        return math.isclose(fa, fb, rel_tol=0, abs_tol=1e-9)
    if isinstance(a, str) and isinstance(b, str):
        return a.strip() == b.strip()
    return a == b


def _show(v: Any) -> str:
    return f"{v:g}" if isinstance(v, float) else str(v)


# ---------------------------------------------------------------- 입력 · 출력 값


@dataclass(frozen=True)
class PartRef:
    """체결부의 부품 하나. OPMS 에서 못 찾았으면 `attrs` 가 None 이다."""

    part_no: str
    attrs: PartAttrs | None = None


@dataclass(frozen=True)
class PlateInput:
    item_no: str
    thickness: float | None             # 값이 없으면 판정 불가(unknown)
    inferred: bool = False              # CAD 추정값이면 판정을 한 단계 낮춘다


@dataclass(frozen=True)
class JointInput:
    """변경 **후** 상태의 체결부 하나. 짝 · 그립 · 강도 판정의 입력."""

    assembly_item_no: str
    name: str
    bolt: PartRef
    nut: PartRef
    washer: PartRef | None
    washers_per_bolt: int
    plates: tuple[PlateInput, ...]


@dataclass(frozen=True)
class FitResult:
    """판정 한 건. `ImpactFinding` 의 재료(식별 · 심각도 · 근거 · 값)다."""

    kind: FindingKind
    subject_suffix: str                  # `bolt-nut` · `grip` · `strength` · `substitute`
    verdict: Verdict
    severity: Severity
    reason_code: str
    message: str
    rule_id: str | None
    temporary: bool = True
    approximate: bool = False
    required: float | None = None
    actual: float | None = None
    gap: float | None = None
    inputs: Mapping[str, Any] = field(default_factory=dict)
    suggested_disposition: str | None = None


class FitJudge(Protocol):
    """체결 적합성 판정기. 지금은 `PdmTemporaryFitJudge`(OPMS 규칙 명세로 PDM 이 계산), OPMS 가 mates 판정 API 를 열면 그 호출 결과를 그대로 쓰는 구현으로 바꾼다."""

    def judge_pair(self, left: PartRef, right: PartRef) -> FitResult: ...

    def judge_joint(self, joint: JointInput) -> list[FitResult]: ...

    def judge_substitute(self, old: PartRef, new: PartRef) -> FitResult | None: ...


# ---------------------------------------------------------------- 그립 길이


def grip_required_length(plates: Sequence[float], washer_thickness: float, washers: int, nut_height: float, pitch: float) -> float:
    """필요 볼트 길이 = Σ판 두께 + 와셔 두께 × 와셔 수 + 너트 높이 + 2 × 피치."""
    return _r6(sum(plates) + washer_thickness * washers + nut_height + GRIP_THREAD_MARGIN_PITCHES * pitch)


def judge_grip(
    *, plates: Sequence[PlateInput], washer_thickness: float | None, washers: int, nut_height: float | None,
    pitch: float | None, bolt_length: float | None, bolt_no: str = "", temporary: bool = True,
) -> FitResult:
    """그립 길이 판정. margin ≥ 1.0 ok · 0 ≤ margin < 1.0 conditional(thin_margin) · margin < 0 no(shortfall) · 값 없음 unknown(value_missing).
    CAD 추정 입력이 하나라도 있으면 ok 를 conditional(approximate_value)로 낮춘다(no 는 그대로, '추정' 표시)."""
    missing: list[str] = []
    for p in plates:
        if p.thickness is None:
            missing.append(f"thickness@{p.item_no}")
    if washers and washer_thickness is None:
        missing.append("thickness@washer")
    if nut_height is None:
        missing.append("nutHeight")
    if pitch is None:
        missing.append("pitch")
    if bolt_length is None:
        missing.append("length")
    approximate = any(p.inferred for p in plates)
    inputs: dict[str, Any] = {
        "plates": [{"item_no": p.item_no, "thickness": p.thickness, "inferred": p.inferred} for p in plates],
        "washers": washers, "washerThickness": washer_thickness, "nutHeight": nut_height, "pitch": pitch,
        "boltLength": bolt_length, "unit": "mm",
    }
    if missing:
        return FitResult(
            kind="fit_grip", subject_suffix="grip", verdict="unknown", severity=severity_for("unknown"), reason_code="value_missing",
            message=f"그립 길이를 계산할 값이 비어 있어요: {', '.join(missing)}", rule_id=GRIP_RULE_ID, temporary=temporary,
            approximate=approximate, inputs={**inputs, "missing": missing},
        )
    assert nut_height is not None and pitch is not None and bolt_length is not None        # missing 이 비었으므로
    required = grip_required_length([float(p.thickness) for p in plates if p.thickness is not None], washer_thickness or 0.0, washers, nut_height, pitch)
    margin = _r6(bolt_length - required)
    inputs["required"] = required
    inputs["margin"] = margin
    if margin < 0:
        gap = _r6(-margin)
        return FitResult(
            kind="fit_grip", subject_suffix="grip", verdict="no", severity=severity_for("no"), reason_code="shortfall",
            message=f"필요한 볼트 길이 {_show(required)} mm에 {_show(gap)} mm 모자라요 (볼트 {_show(bolt_length)} mm)", rule_id=GRIP_RULE_ID,
            temporary=temporary, approximate=approximate, required=required, actual=bolt_length, gap=gap, inputs=inputs,
            suggested_disposition="block_change",
        )
    if margin < GRIP_WARN_WITHIN:
        return FitResult(
            kind="fit_grip", subject_suffix="grip", verdict="conditional", severity=severity_for("conditional"), reason_code="thin_margin",
            message=f"여유가 {_show(margin)} mm로 얇아요 (필요 {_show(required)} mm, 볼트 {_show(bolt_length)} mm)", rule_id=GRIP_RULE_ID,
            temporary=temporary, approximate=approximate, required=required, actual=bolt_length, inputs=inputs,
            suggested_disposition="review_with_design",
        )
    if approximate:
        return FitResult(
            kind="fit_grip", subject_suffix="grip", verdict="conditional", severity=severity_for("conditional"), reason_code="approximate_value",
            message=f"길이는 맞지만 판 두께가 CAD 추정값이에요 (필요 {_show(required)} mm, 볼트 {_show(bolt_length)} mm). 실물로 확인하세요",
            rule_id=GRIP_RULE_ID, temporary=temporary, approximate=True, required=required, actual=bolt_length, inputs=inputs,
            suggested_disposition="review_with_design",
        )
    return FitResult(
        kind="fit_grip", subject_suffix="grip", verdict="ok", severity=severity_for("ok"), reason_code="grip_ok",
        message=f"볼트 {_show(bolt_length)} mm로 충분해요 (필요 {_show(required)} mm, 여유 {_show(margin)} mm)", rule_id=GRIP_RULE_ID,
        temporary=temporary, required=required, actual=bolt_length, inputs=inputs,
    )


# ---------------------------------------------------------------- 짝


def _blocking_values(left: PartAttrs | None, right: PartAttrs | None, keys: Sequence[str]) -> tuple[list[str], list[tuple[str, Any, Any]]]:
    """(비어 있는 속성 이름, 다른 속성 (이름, 왼쪽 값, 오른쪽 값))."""
    missing: list[str] = []
    differ: list[tuple[str, Any, Any]] = []
    for k in keys:
        a = None if left is None else left.values.get(k)
        b = None if right is None else right.values.get(k)
        if a is None or b is None:
            missing.append(k)
        elif not _same(a, b):
            differ.append((k, a, b))
    return missing, differ


class PdmTemporaryFitJudge:
    """OPMS 스냅샷의 규칙 명세로 PDM 이 계산하는 **임시** 판정기. 모든 결과가 `temporary=True` 다."""

    def __init__(self, source: PartAttrSource) -> None:
        self._source = source
        self._rules: Sequence[MatesRule] | None = None
        self._subs: Sequence[SubstituteRule] | None = None

    # -- 규칙(처음 쓸 때 한 번 읽는다) --
    def _mates(self) -> Sequence[MatesRule]:
        if self._rules is None:
            self._rules = self._source.mates_rules()
        return self._rules

    def _substitutes(self) -> Sequence[SubstituteRule]:
        if self._subs is None:
            self._subs = self._source.substitute_rules()
        return self._subs

    @property
    def label(self) -> Callable[[str], str]:
        return lambda key: _LABELS.get(key) or self._source.prop_label(key)

    def _find_rule(self, left: PartAttrs, right: PartAttrs) -> tuple[MatesRule, bool] | None:
        """(규칙, 뒤집힘 여부). 규칙 id 순으로 처음 맞는 것."""
        for rule in self._mates():
            if self._source.class_is_a(left.class_code, rule.left_class) and self._source.class_is_a(right.class_code, rule.right_class):
                return rule, False
            if self._source.class_is_a(right.class_code, rule.left_class) and self._source.class_is_a(left.class_code, rule.right_class):
                return rule, True
        return None

    # -- 짝 --
    def judge_pair(self, left: PartRef, right: PartRef) -> FitResult:
        suffix = f"{_role(left)}-{_role(right)}"
        if left.attrs is None or right.attrs is None:
            absent = [r.part_no for r in (left, right) if r.attrs is None]
            return FitResult(
                kind="fit_pair", subject_suffix=suffix, verdict="unknown", severity="review", reason_code="pair_unknown",
                message=f"OPMS에서 부품을 찾지 못해 짝을 확인할 수 없어요: {', '.join(absent)}", rule_id=None, temporary=True,
                inputs={"left": left.part_no, "right": right.part_no, "missing_parts": absent},
            )
        found = self._find_rule(left.attrs, right.attrs)
        base_inputs: dict[str, Any] = {"left": left.part_no, "right": right.part_no}
        if found is None:
            return FitResult(
                kind="fit_pair", subject_suffix=suffix, verdict="unknown", severity="review", reason_code="no_rule",
                message=f"{left.attrs.class_code} ↔ {right.attrs.class_code} 짝 규칙이 OPMS에 없어요", rule_id=None, temporary=True,
                inputs={**base_inputs, "classes": [left.attrs.class_code, right.attrs.class_code]},
            )
        rule, _ = found
        lab = self.label
        b_missing, b_differ = _blocking_values(left.attrs, right.attrs, rule.blocking)
        if b_differ:
            k, a, b = b_differ[0]
            return self._pair(suffix, rule, "no", "pair_unrelated", f"{lab(k)}이 달라 짝이 아니에요 ({_show(a)} ↔ {_show(b)})",
                              {**base_inputs, "differs": [k]}, left, right)
        if b_missing:
            return self._pair(suffix, rule, "unknown", "pair_unknown", f"{', '.join(lab(k) for k in b_missing)} 값이 비어 있어 짝을 확인할 수 없어요",
                              {**base_inputs, "missing": b_missing}, left, right)
        m_missing, m_differ = _blocking_values(left.attrs, right.attrs, rule.match)
        if m_differ:
            k, a, b = m_differ[0]
            return self._pair(suffix, rule, "no", "pair_mismatch", f"{lab(k)} 값이 달라 맞지 않아요 ({_show(a)} ↔ {_show(b)})",
                              {**base_inputs, "differs": [d[0] for d in m_differ]}, left, right)
        if m_missing:
            return self._pair(suffix, rule, "unknown", "pair_unknown", f"{', '.join(lab(k) for k in m_missing)} 값이 비어 있어 짝을 확인할 수 없어요",
                              {**base_inputs, "missing": m_missing}, left, right)
        return self._pair(suffix, rule, "ok", "pair_fits", "나사 규격이 맞는 짝이에요", base_inputs, left, right)

    def _pair(self, suffix: str, rule: MatesRule, verdict: Verdict, reason: str, message: str, inputs: dict[str, Any],
              left: PartRef, right: PartRef) -> FitResult:
        # 있으면 좋은 속성(재질 · 표면처리)이 다른 것은 짝 성립에 영향이 없다(OPMS 도 안내만). 메모로만 남긴다.
        prefer_differs: list[str] = []
        if left.attrs is not None and right.attrs is not None:
            for k in rule.prefer:
                a, b = left.attrs.values.get(k), right.attrs.values.get(k)
                if a is not None and b is not None and not _same(a, b):
                    prefer_differs.append(k)
        if prefer_differs:
            inputs = {**inputs, "prefer_differs": prefer_differs}
        return FitResult(
            kind="fit_pair", subject_suffix=suffix, verdict=verdict, severity=severity_for(verdict), reason_code=reason, message=message,
            rule_id=rule.rule_id, temporary=True, inputs=inputs,
            suggested_disposition={"no": "block_change", "unknown": "review_with_design"}.get(verdict),
        )

    # -- 강도등급 --
    def judge_strength(self, bolt: PartRef, nut: PartRef) -> FitResult | None:
        """같으면 finding 이 없다(None). 다르면 순서 비교가 없어 판정하지 않고 사람이 확인한다."""
        a = None if bolt.attrs is None else bolt.attrs.values.get("strengthGrade")
        b = None if nut.attrs is None else nut.attrs.values.get("strengthGrade")
        inputs = {"bolt": bolt.part_no, "nut": nut.part_no, "boltGrade": a, "nutGrade": b}
        if a is not None and b is not None and _same(a, b):
            return None
        if a is None or b is None:
            return FitResult(
                kind="strength_grade", subject_suffix="strength", verdict="unknown", severity="review", reason_code="value_missing",
                message="볼트 또는 너트의 강도 등급 값이 비어 있어요. 사람이 확인하세요", rule_id=STRENGTH_RULE_ID, temporary=True,
                inputs=inputs, suggested_disposition="review_with_design",
            )
        return FitResult(
            kind="strength_grade", subject_suffix="strength", verdict="unknown", severity="review", reason_code="strength_differs",
            message=f"강도 등급 조합 {_show(a)} ↔ {_show(b)}는 OPMS에 순서 비교가 없어 사람이 확인해야 해요", rule_id=STRENGTH_RULE_ID,
            temporary=True, inputs=inputs, suggested_disposition="review_with_design",
        )

    # -- 체결부 한 곳 --
    def judge_joint(self, joint: JointInput) -> list[FitResult]:
        results = [self.judge_pair(joint.bolt, joint.nut)]
        if joint.washer is not None:
            results.append(self.judge_pair(joint.bolt, joint.washer))
            results.append(self.judge_pair(joint.nut, joint.washer))
        bolt_v = joint.bolt.attrs.values if joint.bolt.attrs else {}
        nut_v = joint.nut.attrs.values if joint.nut.attrs else {}
        washer_t = _num(joint.washer.attrs.values.get("thickness")) if joint.washer and joint.washer.attrs else None
        results.append(judge_grip(
            plates=joint.plates, washer_thickness=washer_t, washers=joint.washers_per_bolt if joint.washer else 0,
            nut_height=_num(nut_v.get("nutHeight")), pitch=_num(bolt_v.get("pitch")), bolt_length=_num(bolt_v.get("length")),
            bolt_no=joint.bolt.part_no,
        ))
        strength = self.judge_strength(joint.bolt, joint.nut)
        if strength is not None:
            results.append(strength)
        return results

    # -- 대체 --
    def judge_substitute(self, old: PartRef, new: PartRef) -> FitResult | None:
        """분류가 달라진 교체가 OPMS `substitutes` 규칙 대상이면 조건부(conditional) finding 을 낸다. 규칙 대상이 아니면 None."""
        if old.attrs is None or new.attrs is None or old.attrs.class_code == new.attrs.class_code:
            return None
        for rule in self._substitutes():
            if not (self._source.class_is_a(old.attrs.class_code, rule.replaced_class)
                    and self._source.class_is_a(new.attrs.class_code, rule.replacement_class)):
                continue
            lab = self.label
            same_differs = [k for k in rule.same if (a := old.attrs.values.get(k)) is not None and (b := new.attrs.values.get(k)) is not None and not _same(a, b)]
            confirm_differs = [k for k in rule.confirm if (a := old.attrs.values.get(k)) is not None and (b := new.attrs.values.get(k)) is not None and not _same(a, b)]
            parts = [f"{rule.replacement_class}가 {rule.replaced_class}"
                     + (f"와 {', '.join(rule.absorbs)}" if rule.absorbs else "") + "를 대신하는 조합이에요 — 부품 구성을 바꿔야 해요"]
            if same_differs:
                parts.append("규칙상 같아야 하는 값이 달라요: " + ", ".join(f"{lab(k)} {_show(old.attrs.values[k])}→{_show(new.attrs.values[k])}" for k in same_differs))
            if confirm_differs:
                parts.append("사람이 확인할 값: " + ", ".join(f"{lab(k)} {_show(old.attrs.values[k])}→{_show(new.attrs.values[k])}" for k in confirm_differs)
                             + (" (강도 등급은 순서 비교 불가)" if "strengthGrade" in confirm_differs else ""))
            return FitResult(
                kind="substitute", subject_suffix="substitute", verdict="conditional", severity=severity_for("conditional"),
                reason_code="substitute_conditional", message=". ".join(parts), rule_id=rule.rule_id, temporary=True,
                inputs={"old": old.part_no, "new": new.part_no, "same_differs": same_differs, "confirm_differs": confirm_differs,
                        "absorbs": list(rule.absorbs)},
                suggested_disposition="review_with_design",
            )
        return None


def _role(ref: PartRef) -> str:
    """`bolt-nut` 같은 짝 이름을 만들 때 쓰는 역할 이름. 분류를 모르면 품번을 쓴다."""
    code = ref.attrs.class_code if ref.attrs else ""
    for needle, role in (("Bolt", "bolt"), ("Nut", "nut"), ("Washer", "washer")):
        if needle in code:
            return role
    return ref.part_no


__all__ = [
    "GRIP_RULE_ID", "STRENGTH_RULE_ID", "GRIP_WARN_WITHIN", "SEVERITY_BY_VERDICT", "severity_for",
    "PartRef", "PlateInput", "JointInput", "FitResult", "FitJudge", "PdmTemporaryFitJudge",
    "grip_required_length", "judge_grip",
]
