"""OPMS 온톨로지 스냅샷에서 체결 짝 규칙(`mates_with`)과 대체 규칙(`substitutes`)을 읽는다. 읽기만 하고 판정은 하지 않는다.

- 규칙은 스냅샷의 `rules`(규칙 id → {type, applies_to, spec, message, severity})에 있다. 실제 OPMS 0.19.0 에서 확인한 모양이다
  (`bolt_nut`: type `mates_with`, applies_to `Bolt`, spec `{with: Nut, blocking: threadSize, match: [pitch]}`).
- 짝에서 "있으면 좋은 속성"(`prefer`, 예: 재질 · 표면처리)은 스냅샷 `relations.matesWith.pairs` 에 있다.
- 클래스의 상위 사슬은 스냅샷 `classes.<코드>.path` 다 (`HexBolt` → [MechanicalPart, Fastener, Bolt, HexBolt]).
- OPMS 에는 mates 판정 서버 API 가 없다(CR-NEXT-part-relation-rule 결정 5). 그래서 PDM 이 이 명세로 같은 4상태를 계산한다(changes/fit.py).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from onto_pdm.opms.reader import OntologySnapshot


@dataclass(frozen=True)
class MatesRule:
    """볼트↔너트처럼 짝이 맞아야 하는 두 분류. `blocking` 이 다르면 짝이 아니고, `match` 가 다르면 맞지 않는다."""

    rule_id: str
    left_class: str                 # applies_to
    right_class: str                # spec.with
    blocking: tuple[str, ...]
    match: tuple[str, ...]
    prefer: tuple[str, ...] = ()
    message: str = ""
    severity: str = "warning"


@dataclass(frozen=True)
class SubstituteRule:
    """`replacement_class` 가 `replaced_class` (와 흡수하는 부품)를 대신할 수 있는 조건."""

    rule_id: str
    replaced_class: str             # spec.replaces
    replacement_class: str          # applies_to
    same: tuple[str, ...]           # 같아야 하는 속성
    confirm: tuple[str, ...]        # 사람이 확인할 속성
    absorbs: tuple[str, ...] = ()   # 흡수하는 부품 분류(예: FlatWasher)
    message: str = ""


def _as_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,)
    return tuple(str(v) for v in value)


def _rules(snapshot: OntologySnapshot) -> Mapping[str, Mapping[str, Any]]:
    rules = snapshot.data.get("rules") or {}
    if isinstance(rules, Mapping):
        return {str(k): v for k, v in rules.items() if isinstance(v, Mapping)}
    # 목록 모양(`[{id, ...}]`)도 받는다
    return {str(r.get("id") or r.get("rule_id")): r for r in rules if isinstance(r, Mapping) and (r.get("id") or r.get("rule_id"))}


def _prefer_for(snapshot: OntologySnapshot, a: str, b: str) -> tuple[str, ...]:
    pairs = ((snapshot.data.get("relations") or {}).get("matesWith") or {}).get("pairs") or []
    for p in pairs:
        if isinstance(p, Mapping) and {p.get("from_class"), p.get("to_class")} == {a, b}:
            return _as_tuple(p.get("prefer"))
    return ()


def ontology_version(snapshot: OntologySnapshot) -> str:
    return snapshot.version


def mates_rules(snapshot: OntologySnapshot) -> list[MatesRule]:
    """스냅샷의 `mates_with` 규칙. 규칙 id 순으로 돌려준다(결정적)."""
    out: list[MatesRule] = []
    for rule_id, r in sorted(_rules(snapshot).items()):
        if r.get("type") != "mates_with":
            continue
        spec = r.get("spec") or {}
        left, right = r.get("applies_to"), spec.get("with")
        if not left or not right:
            continue
        out.append(MatesRule(
            rule_id=rule_id, left_class=str(left), right_class=str(right),
            blocking=_as_tuple(spec.get("blocking")), match=_as_tuple(spec.get("match")),
            prefer=_prefer_for(snapshot, str(left), str(right)),
            message=str(r.get("message") or ""), severity=str(r.get("severity") or "warning"),
        ))
    return out


def substitute_rules(snapshot: OntologySnapshot) -> list[SubstituteRule]:
    """스냅샷의 `substitutes` 규칙(예: 플랜지볼트가 육각볼트 + 평와셔를 대신한다)."""
    out: list[SubstituteRule] = []
    for rule_id, r in sorted(_rules(snapshot).items()):
        if r.get("type") != "substitutes":
            continue
        spec = r.get("spec") or {}
        replaced, replacement = spec.get("replaces"), r.get("applies_to")
        if not replaced or not replacement:
            continue
        absorbs = tuple(str(a.get("class")) for a in (spec.get("absorbs") or []) if isinstance(a, Mapping) and a.get("class"))
        out.append(SubstituteRule(
            rule_id=rule_id, replaced_class=str(replaced), replacement_class=str(replacement),
            same=_as_tuple(spec.get("same")), confirm=_as_tuple(spec.get("confirm")), absorbs=absorbs,
            message=str(r.get("message") or ""),
        ))
    return out


def class_path(snapshot: OntologySnapshot, class_code: str) -> tuple[str, ...]:
    classes = snapshot.data.get("classes") or {}
    path = (classes.get(class_code) or {}).get("path")
    return tuple(str(c) for c in path) if path else (class_code,)


def class_is_a(snapshot: OntologySnapshot, class_code: str, ancestor: str) -> bool:
    """`class_code` 가 `ancestor` 이거나 그 하위 분류인가(예: HexBolt 는 Bolt)."""
    return class_code == ancestor or ancestor in class_path(snapshot, class_code)


def prop_label(snapshot: OntologySnapshot, key: str) -> str:
    label = ((snapshot.data.get("properties") or {}).get(key) or {}).get("label") or {}
    return str(label.get("ko") or key)
