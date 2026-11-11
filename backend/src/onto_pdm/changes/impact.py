"""영향 탐색 엔진. **부수 효과가 없는 순수 함수**다(저장은 service 가 한다, C2).

근거: docs/change-impact-design.md 4장(영향 탐색 · 판정 · 심각도 표 · 결정성 · stale), docs/change-impact-ontology.md 6 · 7장.

흐름: 변경 대상 → 역전개(where_used) → 사용 BOM 개정 → 제품 → 적용 범위로 거르기 → 작업지시 → 발주 · 재고 →
**변경 후 BOM 에서 체결부 재판정**(짝 · 그립 길이 · 강도등급 · 대체) → finding 정렬.

- 영향이 있다는 것(`ImpactFinding`)과 변경해야 한다는 것(처분 `Disposition`)은 다르다. 엔진은 탐지와 **기본 제안**만 낸다(자동 확정 없음).
- 같은 입력이면 같은 finding 목록 · 같은 순서다. 시각 · 난수에 의존하지 않고 `computed_at` 은 `ImpactRun` 머리에만 쓴다(finding 의 basis 에는 같은 값을 복사할 뿐).
- OPMS 를 못 읽으면 외부 · BOM 영향까지는 하고 적합성은 `unknown`(OPMS_UNAVAILABLE)으로 두며 run 을 `partial` 로 표시한다(승인 불가).
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from collections.abc import Collection, Mapping, Sequence
from datetime import date, datetime
from typing import Any

from pydantic import AwareDatetime

from onto_pdm.changes import scope as scope_mod
from onto_pdm.changes.fit import FitJudge, FitResult, JointInput, PartRef, PlateInput
from onto_pdm.changes.models import (
    SEVERITY_RANK,
    ApplicabilityScope,
    ChangeOrder,
    ChangeTarget,
    FasteningJoint,
    FindingBasis,
    ImpactFinding,
    ImpactRun,
    PurchaseOrderLine,
    ScopeClass,
    Severity,
    StockLot,
    WorkOrder,
)
from onto_pdm.changes.ports import (
    BomDiffLine,
    BomLine,
    BomSource,
    ExternalSource,
    ExternalState,
    PartAttrs,
    PartAttrSource,
    SpecSource,
    UsageRow,
)
from onto_pdm.opms.errors import OpmsUnavailable

ENGINE_INPUT_VERSION = 1       # input_hash 의 입력 모양이 바뀌면 올린다
_SPEC_KEYS_IGNORED = frozenset({"spec_source"})


# ---------------------------------------------------------------- 변경 후 BOM 가상 전개 · 개정 비교


def virtual_bom(lines: Sequence[BomLine], targets: Sequence[ChangeTarget], assembly_item_no: str) -> list[BomLine]:
    """현재 조립품 BOM 줄에 변경 대상을 **메모리에서만** 덮은 변경 후 줄. DB 에는 쓰지 않는다.

    교체(`replace`)는 자식 품번을 바꾸고, `bom_edit` 는 `after.quantities`({품번: 수량})로 수량을 바꾼다(없으면 그대로)."""
    replace = {t.item_no: t.replacement_item_no for t in targets if t.change_kind == "replace" and t.replacement_item_no}
    quantities: dict[str, float] = {}
    for t in targets:
        if t.change_kind == "bom_edit" and t.item_no == assembly_item_no:
            quantities.update({str(k): float(v) for k, v in (t.after.get("quantities") or {}).items()})
    out: list[BomLine] = []
    for line in lines:
        item_no = replace.get(line.item_no, line.item_no)
        qty = quantities.get(item_no, quantities.get(line.item_no, line.quantity))
        out.append(BomLine(item_no=item_no, quantity=qty, find_no=line.find_no))
    return out


def virtual_descendants(bom: BomSource, item_no: str, revision: str | None, targets: Sequence[ChangeTarget], *, max_depth: int = 12) -> list[str]:
    """변경 후 BOM 을 아래로 펼친 모든 자손 품번(선순위 순서, 중복 없음). 자식의 개정은 현재 승인본으로 본다. DB 에는 쓰지 않는다."""
    out: list[str] = []
    seen: set[str] = set()

    def walk(no: str, rev: str | None, depth: int) -> None:
        if depth > max_depth:
            return
        for line in virtual_bom(bom.bom_lines(no, rev), targets, no):
            if line.item_no in seen:
                continue
            seen.add(line.item_no)
            out.append(line.item_no)
            walk(line.item_no, None, depth + 1)

    walk(item_no, revision, 1)
    return out


def compare_lines(a: Sequence[BomLine], b: Sequence[BomLine]) -> list[BomDiffLine]:
    """두 BOM 줄 목록의 차이(품번 순). 개정 비교(R00 vs R01)의 순수 계산."""
    qa, qb = {x.item_no: x.quantity for x in a}, {x.item_no: x.quantity for x in b}
    out: list[BomDiffLine] = []
    for item_no in sorted(set(qa) | set(qb)):
        if item_no not in qb:
            out.append(BomDiffLine(item_no, "removed", qa[item_no], None))
        elif item_no not in qa:
            out.append(BomDiffLine(item_no, "added", None, qb[item_no]))
        elif qa[item_no] != qb[item_no]:
            out.append(BomDiffLine(item_no, "quantity_changed", qa[item_no], qb[item_no]))
    return out


# ---------------------------------------------------------------- finding 만들기


def _finding(
    *, kind: str, subject_type: str, subject_ref: str, severity: Severity, reason_code: str, message: str,
    ontology_version: str, as_of: AwareDatetime, rule_id: str | None = None, temporary: bool = False, approximate: bool = False,
    verdict: str | None = None, inputs: Mapping[str, Any] | None = None, required: float | None = None, actual: float | None = None,
    gap: float | None = None, scope_class: ScopeClass | None = None, suggested: str | None = None,
) -> ImpactFinding:
    return ImpactFinding(
        kind=kind, subject_type=subject_type, subject_ref=subject_ref, severity=severity, verdict=verdict,    # type: ignore[arg-type]
        reason_code=reason_code, message=message, basis=FindingBasis(ontology_version=ontology_version, rule_id=rule_id, as_of=as_of),
        temporary=temporary, approximate=approximate, inputs=dict(inputs or {}), required=required, actual=actual, gap=gap,
        scope_class=scope_class, suggested_disposition=suggested,                                             # type: ignore[arg-type]
    )


def _from_fit(r: FitResult, subject_ref: str, subject_type: str, ontology_version: str, as_of: AwareDatetime) -> ImpactFinding:
    return _finding(
        kind=r.kind, subject_type=subject_type, subject_ref=f"{subject_ref}:{r.subject_suffix}", severity=r.severity, verdict=r.verdict,
        reason_code=r.reason_code, message=r.message, ontology_version=ontology_version, as_of=as_of, rule_id=r.rule_id,
        temporary=r.temporary, approximate=r.approximate, inputs=r.inputs, required=r.required, actual=r.actual, gap=r.gap,
        suggested=r.suggested_disposition,
    )


def sort_findings(findings: Sequence[ImpactFinding]) -> list[ImpactFinding]:
    """정렬 키 `severity → kind → subject_type → subject_ref → rule_id`. 같은 입력이면 같은 순서."""
    return sorted(findings, key=lambda f: (SEVERITY_RANK[f.severity], f.kind, f.subject_type, f.subject_ref, f.basis.rule_id or "", f.reason_code))


def _dedupe(findings: Sequence[ImpactFinding]) -> list[ImpactFinding]:
    seen: set[tuple[str, str, str, str]] = set()
    out: list[ImpactFinding] = []
    for f in findings:
        key = (f.kind, f.subject_type, f.subject_ref, f.reason_code)
        if key not in seen:
            seen.add(key)
            out.append(f)
    return out


# ---------------------------------------------------------------- 외부 객체 규칙 (design 4.5 표)


def _wo_severity(wo: WorkOrder, cls: ScopeClass) -> tuple[Severity, str, str | None, str] | None:
    """(심각도, 이유 코드, 기본 제안 처분, 설명). 영향이 없으면 None."""
    status = wo.status
    if status == "cancelled" or cls == "outside":
        return None                                                  # 취소된 지시 · 범위 밖은 영향이 없다
    if status in ("completed", "closed"):
        if cls == "inside":
            return "none", "used_in_completed", "use_as_is", "이미 끝난 작업이에요. 기존 사양으로 허용할지 승인자가 정해요"
        return "review", "scope_unknown", None, "끝난 작업이지만 적용 범위에 들어가는지 확인이 필요해요"
    if status == "in_progress":
        return "affected", "used_in_progress", "change_in_progress", "진행 중인 작업이에요. 별도 변경 검토가 필요해요"
    # planned · released(미착수)
    if cls in ("inside", "partial"):
        return "affected", "used_not_started", "apply_new", "아직 시작하지 않은 작업이에요. 새 개정을 적용할지 정해요"
    return "review", "scope_unknown", None, "적용 범위에 들어가는지 확인이 필요해요"


def _scope_note(cls: ScopeClass) -> str:
    return {"inside": "적용 범위 안", "partial": "적용 범위에 일부 걸침", "unknown": "적용 범위를 확인할 수 없음", "outside": "적용 범위 밖"}[cls]


def _is_old_of(target: ChangeTarget, item_rev: str | None) -> bool:
    """발주 · 재고의 개정이 변경 대상의 **기존** 것인가. 교체(새 품번)면 옛 품번 전부, 그 밖에는 기존 개정(모르면 안전하게 기존으로 본다)."""
    if target.change_kind == "replace":
        return True
    return item_rev is None or target.from_revision is None or item_rev == target.from_revision


# ---------------------------------------------------------------- 영향 분석


def analyze(
    order: ChangeOrder,
    targets: Sequence[ChangeTarget],
    *,
    bom: BomSource,
    specs: SpecSource,
    external: ExternalSource,
    parts: PartAttrSource,
    judge: FitJudge,
    computed_at: AwareDatetime,
    computed_by: str,
    scopes: Sequence[ApplicabilityScope] = (),
) -> ImpactRun:
    """영향 분석 한 번. 입력이 같으면 `input_hash` 와 finding 이 같다. 저장하지 않는다."""
    warnings: list[str] = []
    partial = False
    all_scopes: tuple[ApplicabilityScope, ...] = tuple(scopes) + tuple(s for t in targets for s in t.scopes)
    hashed: dict[str, Any] = {"engine": ENGINE_INPUT_VERSION}

    try:
        ontology_version = parts.ontology_version()
    except OpmsUnavailable as e:
        ontology_version = "unknown"
        partial = True
        warnings.append(f"OPMS를 읽지 못해 적합성은 판정하지 않았어요 ({e.code})")
    hashed["ontology_version"] = ontology_version
    hashed["order"] = order.code
    hashed["targets"] = [t.model_dump(mode="json") for t in targets]
    hashed["scopes"] = [s.model_dump(mode="json") for s in all_scopes]

    findings: list[ImpactFinding] = []

    # 1. 사용처(역전개)
    usage_rows: list[UsageRow] = []
    for t in targets:
        rows = list(bom.where_used(t.item_no))
        if not rows:
            warnings.append(f"{t.item_no}: 쓰이는 곳이 없어요")
        usage_rows.extend(rows)
    usage_rows.sort(key=lambda r: (r.item_no, r.revision or "", r.depth))
    hashed["usage"] = sorted({(r.item_no, r.revision, r.depth, r.product_code) for r in usage_rows}, key=str)
    for r in usage_rows:
        if r.product_code:
            findings.append(_finding(
                kind="product", subject_type="product", subject_ref=r.product_code, severity="none", reason_code="used_in_product",
                message=f"제품 {r.product_code}({r.item_no} {r.revision or '-'})에 쓰여요", ontology_version=ontology_version,
                as_of=computed_at, inputs={"item_no": r.item_no, "revision": r.revision, "path": list(r.path), "quantity": r.quantity},
                suggested="acknowledge",
            ))
        else:
            findings.append(_finding(
                kind="bom_usage", subject_type="revision", subject_ref=f"{r.item_no}@{r.revision or '-'}", severity="none",
                reason_code="used_in_bom", message=f"{r.item_no} {r.revision or '-'}에 {r.quantity:g}개로 쓰여요",
                ontology_version=ontology_version, as_of=computed_at,
                inputs={"path": list(r.path), "quantity": r.quantity, "depth": r.depth}, suggested="acknowledge",
            ))

    # 2. 외부 객체: 작업지시 · 발주 항목 · 재고 로트
    usage_revs: dict[str, set[str | None]] = defaultdict(set)
    for r in usage_rows:
        usage_revs[r.item_no].add(r.revision)
    target_items = {t.item_no for t in targets}
    work_order_items = sorted(set(usage_revs) | target_items)
    seen_wo: set[str] = set()
    for wo in external.work_orders(work_order_items):
        if wo.wo_no in seen_wo:
            continue
        revs = usage_revs.get(wo.product_item_no)
        by_bom = revs is not None and (wo.bom_revision is None or None in revs or wo.bom_revision in revs)
        by_ref = any(ref.item_no in target_items for ref in wo.bom_refs)
        if not (by_bom or by_ref or wo.product_item_no in target_items):
            continue
        seen_wo.add(wo.wo_no)
        cls = scope_mod.classify_any(all_scopes, wo)
        verdict = _wo_severity(wo, cls)
        if verdict is None:
            continue
        severity, reason, suggested, why = verdict
        findings.append(_finding(
            kind="work_order", subject_type="work_order", subject_ref=wo.wo_no, severity=severity, reason_code=reason,
            message=f"작업지시 {wo.wo_no}({wo.status}): {why} · {_scope_note(cls)}", ontology_version=ontology_version, as_of=wo.as_of,
            inputs={"status": wo.status, "bom_revision": wo.bom_revision, "site": wo.site, "lot_no": wo.lot_no,
                    "serial_from": wo.serial_from, "serial_to": wo.serial_to, "source_system": wo.source_system},
            scope_class=cls, suggested=suggested,
        ))

    for t in targets:
        for pol in external.purchase_order_lines(t.item_no):
            if pol.qty_open <= 0 or not _is_old_of(t, pol.item_rev):
                continue
            cls = scope_mod.classify_any(all_scopes, pol)
            if cls == "outside":
                continue
            sev: Severity = "review" if cls == "unknown" else "affected"
            findings.append(_finding(
                kind="purchase_order_line", subject_type="purchase_order_line", subject_ref=f"{pol.po_no}/{pol.line_no}", severity=sev,
                reason_code="scope_unknown" if cls == "unknown" else "open_po_line",
                message=f"발주 {pol.po_no}/{pol.line_no}: 미입고 {pol.qty_open:g}개가 남아 있어요 · {_scope_note(cls)}",
                ontology_version=ontology_version, as_of=pol.as_of,
                inputs={"item_no": pol.item_no, "item_rev": pol.item_rev, "qty_open": pol.qty_open, "supplier": pol.supplier, "source_system": pol.source_system},
                scope_class=cls, suggested=None if cls == "unknown" else "amend",
            ))
        for lot in external.stock_lots(t.item_no):
            if lot.qty_on_hand <= 0 or not _is_old_of(t, lot.item_rev):
                continue
            cls = scope_mod.classify_any(all_scopes, lot)
            if cls == "outside":
                continue
            sev = "review" if cls == "unknown" else "affected"
            findings.append(_finding(
                kind="stock_lot", subject_type="stock_lot", subject_ref=lot.lot_no, severity=sev,
                reason_code="scope_unknown" if cls == "unknown" else "stock_on_hand",
                message=f"재고 로트 {lot.lot_no}: {lot.qty_on_hand:g}개가 남아 있어요 · {_scope_note(cls)}",
                ontology_version=ontology_version, as_of=lot.as_of,
                inputs={"item_no": lot.item_no, "item_rev": lot.item_rev, "qty_on_hand": lot.qty_on_hand, "status": lot.status, "source_system": lot.source_system},
                scope_class=cls, suggested=None if cls == "unknown" else "use_up",
            ))

    # 3. 변경 후 체결부 재판정
    fit, opms_down = _fit_findings(
        targets=targets, usage_rows=usage_rows, bom=bom, specs=specs, parts=parts, judge=judge, ontology_version=ontology_version,
        computed_at=computed_at, partial=partial, warnings=warnings, hashed=hashed,
    )
    findings.extend(fit)
    if opms_down and not partial:
        partial = True
        warnings.append("OPMS를 읽지 못해 적합성은 판정하지 않았어요")

    # 4. 외부 기준 시각 · 입력 해시
    state = external.external_state()
    hashed["external"] = {"as_of": {k: v.isoformat() for k, v in sorted(state.as_of.items())}, "counts": dict(sorted(state.counts.items()))}
    findings = sort_findings(_dedupe(findings))
    return ImpactRun(
        order_code=order.code, computed_at=computed_at, computed_by=computed_by, input_hash=compute_input_hash(hashed),
        ontology_version=ontology_version, temporary=any(f.temporary for f in findings), partial=partial,
        external_as_of=dict(state.as_of), warnings=tuple(warnings), findings=tuple(findings),
    )


def _fit_findings(
    *, targets: Sequence[ChangeTarget], usage_rows: Sequence[UsageRow], bom: BomSource, specs: SpecSource, parts: PartAttrSource,
    judge: FitJudge, ontology_version: str, computed_at: AwareDatetime, partial: bool, warnings: list[str], hashed: dict[str, Any],
) -> tuple[list[ImpactFinding], bool]:
    """(체결 finding 목록, OPMS 를 못 읽었나)."""
    out: list[ImpactFinding] = []
    replace = {t.item_no: t.replacement_item_no for t in targets if t.change_kind == "replace" and t.replacement_item_no}
    spec_override: dict[tuple[str, str], tuple[float, str]] = {}
    joint_override: dict[str, dict[str, int]] = defaultdict(dict)
    for t in targets:
        if t.change_kind in ("revise", "attribute_edit"):
            src = str(t.after.get("spec_source") or "manual")
            for k, v in t.after.items():
                if k not in _SPEC_KEYS_IGNORED and isinstance(v, int | float) and not isinstance(v, bool):
                    spec_override[(t.item_no, k)] = (float(v), src)
        elif t.change_kind == "bom_edit":
            for k in ("washers_per_bolt", "bolt_count"):
                if isinstance(t.after.get(k), int):
                    joint_override[t.item_no][k] = int(t.after[k])

    # 체결 구성이 붙은 조립품 개정: 사용처 상위 개정 + 그 아래 조립품(체결 세트처럼 구성이 하위에 붙는 경우) + 변경 대상 자신
    assemblies: set[tuple[str, str | None]] = {(r.item_no, r.revision) for r in usage_rows if r.revision}
    for t in targets:
        if t.from_revision:
            assemblies.add((t.item_no, t.from_revision))
    joints: list[FasteningJoint] = []
    seen_joint: set[tuple[str, str, str]] = set()

    def collect(item_no: str, rev: str | None) -> None:
        for j in specs.joints_for(item_no, rev):
            key = (j.assembly_item_no, j.assembly_revision, j.name)
            if key not in seen_joint:
                seen_joint.add(key)
                joints.append(j)

    for item_no, rev in sorted(assemblies, key=lambda x: (x[0], x[1] or "")):
        collect(item_no, rev)
        for child in virtual_descendants(bom, item_no, rev, targets):
            collect(child, None)

    attrs_cache: dict[str, PartAttrs | None] = {}
    opms_down = partial

    def attrs_of(part_no: str) -> PartAttrs | None:
        nonlocal opms_down
        if part_no not in attrs_cache:
            try:
                attrs_cache[part_no] = parts.part_attrs(part_no)
            except OpmsUnavailable:
                opms_down = True
                attrs_cache[part_no] = None
        return attrs_cache[part_no]

    used_specs: dict[str, Any] = {}

    def plate_of(item_no: str, key: str) -> PlateInput:
        item_no_after = replace.get(item_no, item_no)
        if (item_no_after, key) in spec_override:
            value, src = spec_override[(item_no_after, key)]
            used_specs[f"{item_no_after}.{key}"] = [value, src]
            return PlateInput(item_no=item_no_after, thickness=value, inferred=src == "cad_estimate")
        sv = specs.spec_value(item_no_after, key)
        if sv is None:
            return PlateInput(item_no=item_no_after, thickness=None)
        used_specs[f"{item_no_after}.{key}"] = [sv.value, sv.source]
        return PlateInput(item_no=item_no_after, thickness=sv.value, inferred=sv.inferred)

    for j in sorted(joints, key=lambda x: (x.assembly_item_no, x.assembly_revision, x.name)):
        # 변경 후 BOM 에 체결 부품이 그대로 있는지(가상 전개)
        in_after = set(virtual_descendants(bom, j.assembly_item_no, j.assembly_revision, targets))
        bolt_no, nut_no = replace.get(j.bolt_item_no, j.bolt_item_no), replace.get(j.nut_item_no, j.nut_item_no)
        washer_no = replace.get(j.washer_item_no, j.washer_item_no) if j.washer_item_no else None
        ref = f"{j.assembly_item_no}#{j.name}"
        ov = joint_override.get(j.assembly_item_no, {})
        joint_after = JointInput(
            assembly_item_no=j.assembly_item_no, name=j.name,
            bolt=PartRef(bolt_no, attrs_of(bolt_no)), nut=PartRef(nut_no, attrs_of(nut_no)),
            washer=PartRef(washer_no, attrs_of(washer_no)) if washer_no else None,
            washers_per_bolt=ov.get("washers_per_bolt", j.washers_per_bolt),
            plates=tuple(plate_of(c.item_no, c.thickness_key) for c in j.clamped),
        )
        if opms_down:
            out.append(_finding(
                kind="fit_pair", subject_type="joint", subject_ref=f"{ref}:opms", severity="review", verdict="unknown",
                reason_code="OPMS_UNAVAILABLE", message="OPMS에 연결되지 않아 체결 적합성을 판정하지 못했어요", ontology_version=ontology_version,
                as_of=computed_at, temporary=True, suggested="review_with_design",
            ))
            continue
        for r in judge.judge_joint(joint_after):
            out.append(_from_fit(r, ref, "joint", ontology_version, computed_at))
        missing_after = [n for n in (bolt_no, nut_no, washer_no) if n and n not in in_after]
        if missing_after:
            out.append(_finding(
                kind="fit_pair", subject_type="joint", subject_ref=f"{ref}:bom", severity="review", verdict="unknown",
                reason_code="pair_unknown", message=f"변경 후 {j.assembly_item_no} BOM에 체결 부품이 없어요: {', '.join(missing_after)}",
                ontology_version=ontology_version, as_of=computed_at, temporary=True, inputs={"missing": missing_after},
                suggested="review_with_design",
            ))

    # 대체(분류가 바뀌는 교체)
    for t in targets:
        if t.change_kind == "replace" and t.replacement_item_no and not opms_down:
            old, new = attrs_of(t.item_no), attrs_of(t.replacement_item_no)
            sub = judge.judge_substitute(PartRef(t.item_no, old), PartRef(t.replacement_item_no, new))
            if sub is not None:
                out.append(_from_fit(sub, f"{t.item_no}->{t.replacement_item_no}", "item", ontology_version, computed_at))

    hashed["specs"] = used_specs
    hashed["parts"] = {no: None if a is None else [a.class_code, sorted((k, str(v)) for k, v in a.values.items())] for no, a in sorted(attrs_cache.items())}
    return out, opms_down


# ---------------------------------------------------------------- 입력 해시 · stale


def compute_input_hash(hashed: Mapping[str, Any]) -> str:
    """정규화 JSON 의 sha256. 같은 입력 → 같은 해시(시각 · 난수 없음)."""
    blob = json.dumps(hashed, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=_json_default)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _json_default(v: Any) -> Any:
    if isinstance(v, datetime | date):
        return v.isoformat()
    if isinstance(v, set | frozenset | tuple):
        return list(v)
    raise TypeError(f"해시할 수 없는 값: {type(v).__name__}")


def stale_reasons(
    run: ImpactRun, *, external_state: ExternalState | None = None, ontology_version: str | None = None, input_hash: str | None = None,
) -> tuple[str, ...]:
    """영향 분석이 낡았는지(design 4.6). 이유 코드: `external_feed_newer` · `ontology_changed` · `input_changed`.

    - 외부 `as_of` 가 분석 때보다 새로워졌거나 외부 행 수가 달라졌다(feed 가 더 새로 들어옴),
    - OPMS 온톨로지 버전이 바뀌었다,
    - 같은 지시를 지금 다시 분석한 `input_hash` 가 다르다(대상 · 범위 · 사양 · 체결 구성 · 영향 품목 개정이 바뀜).
    인자를 주지 않은 항목은 보지 않는다."""
    reasons: list[str] = []
    if external_state is not None:
        for kind, ts in external_state.as_of.items():
            before = run.external_as_of.get(kind)
            if before is None or ts > before:
                reasons.append("external_feed_newer")
                break
    if ontology_version is not None and ontology_version != run.ontology_version:
        reasons.append("ontology_changed")
    if input_hash is not None and input_hash != run.input_hash:
        reasons.append("input_changed")
    return tuple(dict.fromkeys(reasons))


def mark_stale(run: ImpactRun, reasons: Collection[str]) -> ImpactRun:
    """낡은 분석으로 표시한 새 `ImpactRun`(원본은 그대로). 이유가 없으면 그대로 돌려준다."""
    if not reasons:
        return run
    return run.model_copy(update={"stale": True, "stale_reasons": tuple(dict.fromkeys((*run.stale_reasons, *reasons)))})


__all__ = [
    "analyze", "virtual_bom", "virtual_descendants", "compare_lines", "sort_findings", "compute_input_hash", "stale_reasons", "mark_stale",
]
