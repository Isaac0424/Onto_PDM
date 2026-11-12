"""온톨로지 버전 변경 보고(`OntologyImpact`). 온톨로지 버전은 부품 개정이 아니다(F-CHG-10).

OPMS 온톨로지 버전이 바뀌면(예: 0.19.0 → 0.20.0) 이미 쓰고 있는 부품 · 체결부가 새 규칙에서 달라질 수 있다. 이 모듈은 그 **후보를 읽기 보고로** 만든다.

- **개정 · 변경 지시 · `ItemRevision` 을 만들지 않는다.** 이 모듈에는 `PdmStore` · `ChangeStore` 에 쓰는 코드 경로가 없다(입력은 값, 출력은 `OntologyImpact` 하나).
  사람이 보고를 보고 변경 요청을 열 수는 있지만, 그 요청의 대상은 PDM 품목 · 개정이지 온톨로지 버전이 아니다.
- OPMS 의 `revalidation_impacts`(`:Part` 값에 대한 error 등급 위반 보고, 보고 전용)와 같은 성격이고, 이쪽은 **PDM 이 가진 BOM · 체결부** 기준이다.
- 판정은 하지 않는다: 부품이 새 규칙에 "맞지 않는다"고 단정하지 않고 "다시 봐야 할 후보"와 그 이유 코드만 낸다. 체결부는 짝 · 강도 판정(`fit.PdmTemporaryFitJudge`, 임시)을
  두 버전의 규칙으로 각각 돌려 **달라진 것만** 표시한다.
- OPMS 에는 읽기만 한다. 버전별 스냅샷은 `:OntologyVersion {version}.snapshot` 에서 읽는다(OPMS `registry ontology sync` 는 옛 버전을 지우지 않는다 — OPMS
  `docs/changes/CR-007-ontology-versions.md`). 개발 DB 에 그 버전이 없으면 `ONTOLOGY_VERSION_NOT_FOUND` 이고, 서비스가 이미 본 스냅샷이 있으면 그것으로 대신한다.
"""

from __future__ import annotations

import json
import math
from collections.abc import Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from onto_pdm.changes import fit as fit_mod
from onto_pdm.changes.models import FasteningJoint, OntologyImpact, OntologyImpactItem, OntologyImpactSummary
from onto_pdm.changes.ports import PartAttrs
from onto_pdm.errors import not_found
from onto_pdm.opms import OpmsReader, mates
from onto_pdm.opms.mates import MatesRule, SubstituteRule
from onto_pdm.opms.reader import OntologySnapshot

# 이유 코드(보고 한 줄마다 하나)
REASON_REQUIRED_MISSING = "required_property_missing"       # 새 버전에서 필수가 됐는데 부품에 값이 없다
REASON_OUT_OF_RANGE = "value_out_of_range"                   # 새 min · max 를 벗어난다
REASON_PROPERTY_REMOVED = "property_removed"                 # 그 분류에서 속성이 없어졌다
REASON_PROPERTY_DEFINITION = "property_definition_changed"   # 속성 정의(자료형 · 단위)가 바뀌었다
REASON_CLASS_REMOVED = "class_removed"                       # 부품의 분류가 새 버전에 없다
REASON_RULE_ADDED = "rule_added"
REASON_RULE_REMOVED = "rule_removed"
REASON_RULE_CHANGED = "rule_changed"
REASON_JOINT_VERDICT = "joint_verdict_changed"               # 체결부(짝 · 강도) 판정이 두 버전에서 다르다

REASON_CODES = (
    REASON_REQUIRED_MISSING, REASON_OUT_OF_RANGE, REASON_PROPERTY_REMOVED, REASON_PROPERTY_DEFINITION, REASON_CLASS_REMOVED,
    REASON_RULE_ADDED, REASON_RULE_REMOVED, REASON_RULE_CHANGED, REASON_JOINT_VERDICT,
)

ERROR_VERSION_NOT_FOUND = "ONTOLOGY_VERSION_NOT_FOUND"


# ---------------------------------------------------------------- 두 스냅샷의 차이 (순수)

@dataclass(frozen=True)
class ClassPropChange:
    """분류의 속성 제약이 바뀐 것. `kind`: added · removed · required_on · required_off · range_changed."""

    class_code: str
    prop: str
    kind: str
    before: str | None = None
    after: str | None = None


@dataclass(frozen=True)
class RuleChange:
    """규칙 하나의 추가 · 삭제 · 변경. `classes` 는 이 규칙이 걸린 분류(applies_to · with · replaces · against)다."""

    rule_id: str
    kind: str                                     # added · removed · changed
    rule_type: str
    classes: tuple[str, ...]
    fields: tuple[str, ...] = ()                  # changed 일 때 달라진 최상위 키


@dataclass(frozen=True)
class OntologyDiff:
    from_version: str
    to_version: str
    classes_added: tuple[str, ...] = ()
    classes_removed: tuple[str, ...] = ()
    class_prop_changes: tuple[ClassPropChange, ...] = ()
    rule_changes: tuple[RuleChange, ...] = ()
    property_defs_changed: tuple[str, ...] = ()   # 자료형 · 단위가 바뀐 속성 키

    @property
    def is_empty(self) -> bool:
        return not (self.classes_added or self.classes_removed or self.class_prop_changes or self.rule_changes or self.property_defs_changed)


def _map(d: Any) -> Mapping[str, Any]:
    return d if isinstance(d, Mapping) else {}


def _classes(snap: OntologySnapshot) -> Mapping[str, Any]:
    return _map(snap.data.get("classes"))


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _fmt(v: Any) -> str:
    n = _num(v)
    if n is None:
        return "없음" if v is None else str(v)
    return str(int(n)) if n == int(n) else str(n)


def _range(spec: Mapping[str, Any]) -> tuple[Any, Any]:
    return spec.get("min"), spec.get("max")


def _range_text(lo: Any, hi: Any) -> str:
    return f"{_fmt(lo)} ~ {_fmt(hi)}"


def _rule_classes(rule: Mapping[str, Any]) -> tuple[str, ...]:
    spec = _map(rule.get("spec"))
    against = _map(spec.get("against"))
    found = [rule.get("applies_to"), spec.get("with"), spec.get("replaces"), against.get("class")]
    return tuple(sorted({str(c) for c in found if c}))


def _rules_of(snap: OntologySnapshot) -> dict[str, Mapping[str, Any]]:
    rules = snap.data.get("rules") or {}
    if isinstance(rules, Mapping):
        return {str(k): v for k, v in rules.items() if isinstance(v, Mapping)}
    return {str(r.get("id") or r.get("rule_id")): r for r in rules if isinstance(r, Mapping) and (r.get("id") or r.get("rule_id"))}


def diff_snapshots(old: OntologySnapshot, new: OntologySnapshot) -> OntologyDiff:
    """두 온톨로지 스냅샷의 차이. 순수 함수이고 결과는 정렬돼 있다(같은 입력 → 같은 출력).

    보는 것: 분류 추가 · 삭제, 분류별 속성의 추가 · 삭제 · 필수 여부 · min · max, 속성 정의의 자료형 · 단위, 규칙의 추가 · 삭제 · 변경(`mates_with` · `fit_check`
    · `substitutes` 등 모든 유형). 라벨 · 설명 · 어휘 같은 표시용 값은 보지 않는다.
    """
    oc, nc = _classes(old), _classes(new)
    added = tuple(sorted(set(nc) - set(oc)))
    removed = tuple(sorted(set(oc) - set(nc)))

    cpc: list[ClassPropChange] = []
    for code in sorted(set(oc) & set(nc)):
        op, np = _map(_map(oc[code]).get("properties")), _map(_map(nc[code]).get("properties"))
        for prop in sorted(set(op) | set(np)):
            if prop not in op:
                cpc.append(ClassPropChange(code, prop, "added", None, "필수" if _map(np[prop]).get("required") else "선택"))
            elif prop not in np:
                cpc.append(ClassPropChange(code, prop, "removed", "필수" if _map(op[prop]).get("required") else "선택", None))
            else:
                a, b = _map(op[prop]), _map(np[prop])
                if bool(a.get("required")) != bool(b.get("required")):
                    on = bool(b.get("required"))
                    cpc.append(ClassPropChange(code, prop, "required_on" if on else "required_off",
                                               "선택" if on else "필수", "필수" if on else "선택"))
                if _range(a) != _range(b):
                    cpc.append(ClassPropChange(code, prop, "range_changed", _range_text(*_range(a)), _range_text(*_range(b))))

    defs: list[str] = []
    op_defs, np_defs = _map(old.data.get("properties")), _map(new.data.get("properties"))
    for prop in sorted(set(op_defs) & set(np_defs)):
        a, b = _map(op_defs[prop]), _map(np_defs[prop])
        if (a.get("datatype"), a.get("canonical_unit")) != (b.get("datatype"), b.get("canonical_unit")):
            defs.append(prop)

    changes: list[RuleChange] = []
    orules, nrules = _rules_of(old), _rules_of(new)
    for rid in sorted(set(orules) | set(nrules)):
        if rid not in orules:
            r = nrules[rid]
            changes.append(RuleChange(rid, "added", str(r.get("type") or ""), _rule_classes(r)))
        elif rid not in nrules:
            r = orules[rid]
            changes.append(RuleChange(rid, "removed", str(r.get("type") or ""), _rule_classes(r)))
        else:
            a, b = orules[rid], nrules[rid]
            keys = tuple(sorted(k for k in set(a) | set(b) if k != "message" and a.get(k) != b.get(k)))
            if keys:
                classes = tuple(sorted(set(_rule_classes(a)) | set(_rule_classes(b))))
                changes.append(RuleChange(rid, "changed", str(b.get("type") or a.get("type") or ""), classes, keys))

    return OntologyDiff(from_version=old.version, to_version=new.version, classes_added=added, classes_removed=removed,
                        class_prop_changes=tuple(cpc), rule_changes=tuple(changes), property_defs_changed=tuple(defs))


# ---------------------------------------------------------------- 영향받는 부품 · 체결부 (순수)

def _is_a(snap: OntologySnapshot, class_code: str, ancestor: str) -> bool:
    return mates.class_is_a(snap, class_code, ancestor)


def _either(old: OntologySnapshot, new: OntologySnapshot, class_code: str, ancestor: str) -> bool:
    """옛 분류 체계에서든 새 체계에서든 `class_code` 가 `ancestor` 이거나 그 하위인가(분류가 없어졌거나 옮겨져도 놓치지 않는다)."""
    return _is_a(new, class_code, ancestor) or _is_a(old, class_code, ancestor)


def _present(values: Mapping[str, Any], prop: str) -> bool:
    v = values.get(prop)
    return v is not None and v != ""


def affected_parts(diff: OntologyDiff, old: OntologySnapshot, new: OntologySnapshot, parts: Mapping[str, PartAttrs]) -> list[OntologyImpactItem]:
    """`parts`(PDM 이 BOM 에 쓰는 OPMS 부품)에서 새 버전에 영향받는 후보를 이유와 함께 돌려준다. 정렬 · 중복 제거됐다. 판정이 아니라 후보다."""
    out: dict[tuple[str, str, str | None], OntologyImpactItem] = {}

    def put(part_no: str, reason: str, ref: str | None, before: str | None, after: str | None, message: str) -> None:
        out.setdefault((part_no, reason, ref), OntologyImpactItem(kind="part", subject=part_no, reason_code=reason, ref=ref,
                                                                 before=before, after=after, message=message))

    for part_no in sorted(parts):
        p = parts[part_no]
        cls, values = p.class_code, p.values

        if cls in diff.classes_removed:
            put(part_no, REASON_CLASS_REMOVED, cls, cls, None, f"분류 {cls} 가 새 온톨로지({diff.to_version})에 없어요")

        for c in diff.class_prop_changes:
            if not _either(old, new, cls, c.class_code):
                continue
            label = mates.prop_label(new, c.prop)
            if c.kind == "required_on" and not _present(values, c.prop):
                put(part_no, REASON_REQUIRED_MISSING, c.prop, c.before, c.after, f"{label}이(가) {c.class_code}의 필수가 됐는데 부품에 값이 없어요")
            elif c.kind == "added" and c.after == "필수" and not _present(values, c.prop):
                put(part_no, REASON_REQUIRED_MISSING, c.prop, None, c.after, f"{label}이(가) {c.class_code}에 필수로 생겼는데 부품에 값이 없어요")
            elif c.kind == "removed" and _present(values, c.prop):
                put(part_no, REASON_PROPERTY_REMOVED, c.prop, c.before, None, f"{label}이(가) {c.class_code}에서 없어졌어요 (부품 값: {_fmt(values.get(c.prop))})")
            elif c.kind == "range_changed":
                spec = _map(_map(_map(_classes(new).get(c.class_code)).get("properties")).get(c.prop))
                lo, hi, v = _num(spec.get("min")), _num(spec.get("max")), _num(values.get(c.prop))
                if v is not None and ((lo is not None and v < lo) or (hi is not None and v > hi)):
                    put(part_no, REASON_OUT_OF_RANGE, c.prop, c.before, c.after,
                        f"{label} {_fmt(v)}이(가) 새 범위({c.after})를 벗어나요")

        for prop in diff.property_defs_changed:
            if _present(values, prop):
                put(part_no, REASON_PROPERTY_DEFINITION, prop, None, None, f"{mates.prop_label(new, prop)}의 자료형 · 단위 정의가 바뀌었어요")

        for rc in diff.rule_changes:
            if any(_either(old, new, cls, c) for c in rc.classes):
                reason = {"added": REASON_RULE_ADDED, "removed": REASON_RULE_REMOVED}.get(rc.kind, REASON_RULE_CHANGED)
                detail = f" ({', '.join(rc.fields)})" if rc.fields else ""
                put(part_no, reason, rc.rule_id, None, None, f"규칙 {rc.rule_id}({rc.rule_type}){detail}이(가) 이 분류에 걸려요")

    return sorted(out.values(), key=lambda i: (i.subject, i.reason_code, i.ref or ""))


class SnapshotPartSource:
    """`ports.PartAttrSource` 를 **고정된 스냅샷 하나**와 부품 값으로 구현한다. 같은 체결부를 두 버전의 규칙으로 돌릴 때 쓴다(OPMS 를 다시 읽지 않는다)."""

    def __init__(self, snapshot: OntologySnapshot, parts: Mapping[str, PartAttrs]) -> None:
        self._snap = snapshot
        self._parts = parts

    def ontology_version(self) -> str:
        return mates.ontology_version(self._snap)

    def part_attrs(self, part_no: str) -> PartAttrs | None:
        return self._parts.get(part_no)

    def mates_rules(self) -> Sequence[MatesRule]:
        return mates.mates_rules(self._snap)

    def substitute_rules(self) -> Sequence[SubstituteRule]:
        return mates.substitute_rules(self._snap)

    def class_is_a(self, class_code: str, ancestor: str) -> bool:
        return mates.class_is_a(self._snap, class_code, ancestor)

    def prop_label(self, key: str) -> str:
        return mates.prop_label(self._snap, key)


_PAIR_MEMBERS = {"bolt-nut": ("bolt", "nut"), "bolt-washer": ("bolt", "washer"), "nut-washer": ("nut", "washer"), "strength": ("bolt", "nut")}


def _pair_results(judge: fit_mod.PdmTemporaryFitJudge, bolt: fit_mod.PartRef, nut: fit_mod.PartRef,
                  washer: fit_mod.PartRef | None) -> dict[str, fit_mod.FitResult]:
    out = {"bolt-nut": judge.judge_pair(bolt, nut)}
    if washer is not None:
        out["bolt-washer"] = judge.judge_pair(bolt, washer)
        out["nut-washer"] = judge.judge_pair(nut, washer)
    strength = judge.judge_strength(bolt, nut)
    if strength is not None:
        out["strength"] = strength
    return out


def _sig(r: fit_mod.FitResult | None) -> tuple[str, str, str | None] | None:
    return None if r is None else (r.verdict, r.reason_code, r.rule_id)


def rejudge_joints(old: OntologySnapshot, new: OntologySnapshot, joints: Iterable[FasteningJoint],
                   parts: Mapping[str, PartAttrs]) -> list[OntologyImpactItem]:
    """체결부마다 짝(볼트↔너트↔와셔) · 강도 판정을 옛 규칙과 새 규칙으로 각각 돌려, **달라진 것만** 돌려준다.

    그립 길이는 온톨로지가 아니라 PDM 의 판 두께 · OPMS 부품 값으로 정해져서 버전이 바뀌어도 같으므로 다시 보지 않는다.
    부품을 OPMS 에서 못 찾은 체결부는 건너뛴다(판정할 값이 없다).
    """
    j_old = fit_mod.PdmTemporaryFitJudge(SnapshotPartSource(old, parts))
    j_new = fit_mod.PdmTemporaryFitJudge(SnapshotPartSource(new, parts))
    items: list[OntologyImpactItem] = []
    for j in sorted(joints, key=lambda x: (x.assembly_item_no, x.assembly_revision, x.name)):
        refs = {no: fit_mod.PartRef(no, parts.get(no)) for no in (j.bolt_item_no, j.nut_item_no, j.washer_item_no) if no}
        bolt, nut = refs[j.bolt_item_no], refs[j.nut_item_no]
        washer = refs.get(j.washer_item_no) if j.washer_item_no else None
        if bolt.attrs is None or nut.attrs is None or (j.washer_item_no and (washer is None or washer.attrs is None)):
            continue
        before, after = _pair_results(j_old, bolt, nut, washer), _pair_results(j_new, bolt, nut, washer)
        for suffix in sorted(set(before) | set(after)):
            b, a = before.get(suffix), after.get(suffix)
            if _sig(b) == _sig(a):
                continue
            items.append(OntologyImpactItem(
                kind="joint", subject=f"{j.assembly_item_no}:{j.name}", reason_code=REASON_JOINT_VERDICT, ref=suffix,
                before=None if b is None else f"{b.verdict}/{b.reason_code}", after=None if a is None else f"{a.verdict}/{a.reason_code}",
                message=(a.message if a is not None else "새 버전에서는 이 판정이 없어요")))
    return items


def build_report(old: OntologySnapshot, new: OntologySnapshot, *, parts: Mapping[str, PartAttrs], joints: Iterable[FasteningJoint],
                 computed_at: datetime, change_request_code: str | None = None) -> OntologyImpact:
    """두 스냅샷의 보고. 순수 함수이고 부수 효과가 없다 — 개정 · 변경 지시를 만들지 않는다. 같은 입력이면 같은 보고다."""
    diff = diff_snapshots(old, new)
    joints = list(joints)
    items = [*affected_parts(diff, old, new, parts), *rejudge_joints(old, new, joints, parts)]
    flagged = {i.subject for i in items if i.kind == "part"}
    changed = {(i.subject, i.ref) for i in items if i.kind == "joint"}
    for j in joints:                                              # 달라진 판정에 관여한 부품만 후보로 올린다(예: 볼트↔너트 짝이 달라졌으면 와셔는 아니다)
        for suffix, members in _PAIR_MEMBERS.items():
            if (f"{j.assembly_item_no}:{j.name}", suffix) in changed:
                flagged.update(no for no in (getattr(j, f"{m}_item_no") for m in members) if no)
    rules = sorted(f"{rc.rule_id}:{rc.kind}" for rc in diff.rule_changes)
    return OntologyImpact(from_version=old.version, to_version=new.version, computed_at=computed_at,
                          summary=OntologyImpactSummary(rules_changed=tuple(rules), parts_flagged=tuple(sorted(flagged))),
                          items=tuple(sorted(items, key=lambda i: (i.kind, i.subject, i.reason_code, i.ref or ""))),
                          change_request_code=change_request_code)


# ---------------------------------------------------------------- 버전별 스냅샷 읽기 (OPMS 읽기 전용)

class SnapshotHistory(Protocol):
    def current(self) -> OntologySnapshot: ...

    def at(self, version: str) -> OntologySnapshot | None: ...


_VERSION_QUERY = "MATCH (v:OntologyVersion {version: $version}) RETURN v.version AS version, v.snapshot AS snapshot LIMIT 1"


class ReaderSnapshotHistory:
    """`OpmsReader` 로 현재 · 지정 버전의 스냅샷을 읽는다. 읽기만 한다(OPMS 어댑터의 읽기 전용 검사를 그대로 거친다).

    버전을 지정해 읽는 공개 메서드가 아직 `OpmsReader` 에 없어서, 있으면 `ontology_at(version)` 을, 없으면 Neo4j 어댑터의 읽기 전용 `_read` 를 쓴다.
    둘 다 없으면(대역 · 설정 없음) 현재 버전만 돌려준다.
    """

    def __init__(self, reader: OpmsReader) -> None:
        self._reader = reader

    def current(self) -> OntologySnapshot:
        return self._reader.ontology()               # OPMS_NOT_CONFIGURED · OPMS_UNAVAILABLE 을 그대로 낸다

    def at(self, version: str) -> OntologySnapshot | None:
        cur = self._reader.ontology()
        if cur.version == version:
            return cur
        public = getattr(self._reader, "ontology_at", None)
        if callable(public):
            return public(version)                                   # type: ignore[no-any-return]
        read = getattr(self._reader, "_read", None)
        if not callable(read):
            return None
        rows = read(_VERSION_QUERY, version=version)
        if not rows or rows[0].get("snapshot") is None:
            return None
        raw = rows[0]["snapshot"]
        return OntologySnapshot(version=str(rows[0]["version"]), data=json.loads(raw) if isinstance(raw, str) else raw)


@dataclass
class SeenSnapshots:
    """서비스가 이미 본 스냅샷(버전 → 스냅샷). OPMS 에 옛 버전이 남아 있지 않을 때 '그때 본 것'과 비교하게 해 준다. 메모리에만 둔다."""

    by_version: dict[str, OntologySnapshot] = field(default_factory=dict)

    def observe(self, snap: OntologySnapshot) -> None:
        self.by_version.setdefault(snap.version, snap)

    def get(self, version: str) -> OntologySnapshot | None:
        return self.by_version.get(version)

    def latest_other_than(self, version: str) -> OntologySnapshot | None:
        others = [s for v, s in self.by_version.items() if v != version]
        return max(others, key=lambda s: _version_key(s.version)) if others else None


def _version_key(v: str) -> tuple[int, ...]:
    parts = []
    for x in v.split("."):
        parts.append(int(x) if x.isdigit() else -1)
    return tuple(parts)


def resolve_pair(history: SnapshotHistory, seen: SeenSnapshots, from_version: str | None, to_version: str | None) -> tuple[OntologySnapshot, OntologySnapshot]:
    """비교할 (옛, 새) 스냅샷을 정한다. 새 = 지정 버전 또는 현재. 옛 = 지정 버전(OPMS → 이미 본 것 순서로 찾는다) 또는 이미 본 것 중 가장 새로운 다른 버전."""
    new = history.current() if to_version is None else (history.at(to_version) or seen.get(to_version))
    if new is None:
        raise not_found(ERROR_VERSION_NOT_FOUND, f"온톨로지 버전 {to_version}을(를) 읽을 수 없어요")
    seen.observe(new)
    if from_version is None:
        old = seen.latest_other_than(new.version)
        if old is None:
            raise not_found(ERROR_VERSION_NOT_FOUND, "비교할 이전 온톨로지 버전이 없어요. 이전 버전(from)을 지정하세요")
    else:
        old = history.at(from_version) or seen.get(from_version)
        if old is None:
            raise not_found(ERROR_VERSION_NOT_FOUND, f"온톨로지 버전 {from_version}의 스냅샷을 OPMS 에서 읽을 수 없어요")
    seen.observe(old)
    return old, new


def used_part_attrs(reader: OpmsReader, item_nos: Collection[str]) -> dict[str, PartAttrs]:
    """BOM 에 쓰인 품번 중 OPMS `:Part` 인 것의 값. OPMS 에 없는 품목(판 · 조립품)은 빠진다. 한 번의 읽기로 가져온다."""
    wanted = set(item_nos)
    return {p.part_no: PartAttrs(part_no=p.part_no, class_code=p.class_code, values=dict(p.values))
            for p in reader.parts(None, None) if p.part_no in wanted}


__all__ = [
    "REASON_CODES", "ERROR_VERSION_NOT_FOUND",
    "ClassPropChange", "RuleChange", "OntologyDiff", "diff_snapshots", "affected_parts", "rejudge_joints", "build_report",
    "SnapshotPartSource", "SnapshotHistory", "ReaderSnapshotHistory", "SeenSnapshots", "resolve_pair", "used_part_attrs",
]
