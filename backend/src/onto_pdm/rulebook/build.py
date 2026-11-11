"""`rules/*.yaml`(사람이 쓴 모양)를 응답 모델로 바꾼다. 값을 만들거나 고치지 않는다 — 비어 있는 `unknown` 은 비어 있는 채로 둔다."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Any, cast

from onto_pdm.rulebook.models import (
    AppliesTo,
    CadAssembly,
    CadInference,
    CadPart,
    Caution,
    Check,
    Cycle,
    EventCheck,
    Gap,
    Grade,
    InspectionItem,
    Lookup,
    LookupRow,
    NotCovered,
    Operation,
    Param,
    Rule,
    SourceRef,
    Step,
    StepTarget,
    TextValue,
    Tool,
    WorkStandard,
    WorkStandardSummary,
)

GRADES = ("manual", "standard", "cad", "unknown")
# 출처 · 근거를 나타낼 뿐 값이 아닌 키 (표의 행 값을 모을 때 뺀다)
_ROW_META = {"source", "ref", "gap", "note", "estimated", "approval_required", "inferred"}


class RulebookError(Exception):
    """rules/ 를 읽거나 모양을 맞추지 못했다 (YAML 문법 · 필수 필드 누락)."""


@dataclass
class Rulebook:
    docs: dict[str, dict[str, Any]]
    roles: dict[str, str]
    operations: dict[str, Operation]
    not_covered: dict[str, NotCovered]
    tools: dict[str, Tool]
    rules: dict[str, Rule]
    gaps: dict[str, Gap]
    work_standards: dict[str, WorkStandard]
    models: tuple[str, ...] = ()
    counts: dict[str, int] = field(default_factory=dict)
    by_grade: dict[str, int] = field(default_factory=dict)

    def summary_of(self, ws: WorkStandard) -> WorkStandardSummary:
        return WorkStandardSummary(**{k: getattr(ws, k) for k in WorkStandardSummary.model_fields})


# ---------------------------------------------------------------- 공통
def _s(v: Any) -> str | None:
    return None if v is None else str(v)


def _present(v: Any) -> bool:
    return v is not None and v != "" and v != []


def _list(v: Any) -> list[Any]:
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def _label(doc: str | None, d: dict[str, Any], one: dict[str, Any], pages: list[int]) -> str:
    sec = _s(one.get("sec"))
    where = (f" {sec}절" if sec else "") + (f" p.{', '.join(str(p) for p in pages)}" if pages else "")
    kind = d.get("kind")
    if one.get("standard"):
        return f"{one['standard']}(표준 참고)"
    if kind == "manual":
        lang = (doc or "").split("-")[-1]
        return f"사용설명서({lang}){where}"
    if kind == "cad":
        return f"CAD {one.get('node') or doc}"
    return f"{doc}{(' · ' + str(one['node'])) if one.get('node') else ''}" if doc else "출처"


def _refs(ref: Any, docs: dict[str, dict[str, Any]]) -> list[SourceRef]:
    out: list[SourceRef] = []
    for one in _list(ref):
        if not isinstance(one, dict):
            continue
        doc = _s(one.get("doc"))
        d = docs.get(doc or "", {})
        pages = [int(p) for p in _list(one.get("page")) if isinstance(p, int)]
        out.append(SourceRef(
            doc=doc, doc_title=d.get("title"), doc_kind=d.get("kind"), sec=_s(one.get("sec")), pages=pages,
            node=_s(one.get("node")), standard=_s(one.get("standard")), note=_s(one.get("note")),
            label=_label(doc, d, one, pages),
        ))
    return out


def _prov(item: dict[str, Any], docs: dict[str, dict[str, Any]], *, has_value: bool) -> dict[str, Any]:
    """Valued 필드. confirmed 는 사용설명서 근거이고 추정이 아니며 값이 있을 때만 true."""
    source = item.get("source")
    source = source if source in GRADES else "unknown"
    estimated = bool(item.get("estimated") or item.get("inferred"))
    return {
        "source": cast(Grade, source),
        "refs": _refs(item.get("ref"), docs),
        "gap_id": _s(item.get("gap")),
        "estimated": estimated,
        "approval_required": bool(item.get("approval_required")),
        "confirmed": source == "manual" and not estimated and has_value,
    }


def _param(name: str, item: Any, docs: dict[str, dict[str, Any]]) -> Param:
    item = item if isinstance(item, dict) else {"value": item}
    value = item.get("value")
    return Param(
        name=name, value=value, unit=_s(item.get("unit")), condition=_s(item.get("condition")), note=_s(item.get("note")),
        **_prov(item, docs, has_value=_present(value)),
    )


def _grade_counts(*groups: Any) -> dict[str, int]:
    c: Counter[str] = Counter()
    for g in groups:
        for v in _list(g):
            if v is not None:
                c[v.source] += 1
    return {k: c.get(k, 0) for k in GRADES}


# ---------------------------------------------------------------- 공정 · 공구 · 공백
def _operations(raw: dict[str, Any], docs: dict[str, dict[str, Any]]) -> tuple[dict[str, Operation], dict[str, NotCovered]]:
    ops_raw: dict[str, dict[str, Any]] = raw.get("operations") or {}

    def path(code: str) -> list[str]:
        out, cur, seen = [], code, set()
        while cur and cur not in seen:
            seen.add(cur)
            out.append(cur)
            cur = (ops_raw.get(cur) or {}).get("parent")
        return list(reversed(out))

    ops = {
        code: Operation(
            code=code, label_ko=(o.get("label") or {}).get("ko") or code, label_en=(o.get("label") or {}).get("en"),
            definition=o.get("definition") or "", parent=o.get("parent"), opms_code=o.get("opms_code"), path=path(code),
            **_prov(o, docs, has_value=_present(o.get("definition"))),
        )
        for code, o in ops_raw.items()
    }
    nc = {
        code: NotCovered(
            code=code, label_ko=(n.get("label") or {}).get("ko") or code, label_en=(n.get("label") or {}).get("en"),
            reason=n.get("reason") or "", source=n.get("source") if n.get("source") in GRADES else "unknown", gap_id=_s(n.get("gap")),
        )
        for code, n in (raw.get("not_covered") or {}).items()
    }
    return ops, nc


def _tools(raw: dict[str, Any], docs: dict[str, dict[str, Any]]) -> dict[str, Tool]:
    out: dict[str, Tool] = {}
    for tid, t in (raw.get("tools") or {}).items():
        need = t.get("need") or {}
        spec_raw = t.get("spec") or {}
        spec = [_param(k, v, docs) for k, v in spec_raw.items() if k != "note" and isinstance(v, dict)]
        notes = [n for n in [t.get("note"), spec_raw.get("note")] if n]
        gaps = sorted({p.gap_id for p in spec if p.gap_id} | ({need.get("gap")} if need.get("gap") else set()))
        out[tid] = Tool(
            id=tid, name_ko=(t.get("name") or {}).get("ko") or tid,
            need=TextValue(text=need.get("text") or "", **_prov(need, docs, has_value=_present(need.get("text")))),
            spec=spec, note=" ".join(notes) or None, gap_ids=gaps,
        )
    return out


def _gaps(raw: dict[str, Any]) -> dict[str, Gap]:
    return {
        gid: Gap(id=gid, title=g.get("title") or "", needs=g.get("needs") or "", why=g.get("why") or "", who=g.get("who") or "",
                 blocks=[str(b) for b in _list(g.get("blocks"))])
        for gid, g in (raw.get("gaps") or {}).items()
    }


# ---------------------------------------------------------------- 규칙
def _rule(rid: str, r: dict[str, Any], docs: dict[str, dict[str, Any]], ops: dict[str, Operation], roles: dict[str, str],
          gaps: dict[str, Gap]) -> Rule:
    ap = r.get("applies_to") or {}
    ctx = ap.get("context") or {}
    role = ctx.get("role")
    applies = AppliesTo(
        classes=[str(c) for c in _list(ap.get("classes"))], proposed_classes=[str(c) for c in _list(ap.get("proposed_classes"))],
        role=role, role_label=roles.get(role) if role else None, models=[str(m) for m in _list(ctx.get("model"))],
        where=dict(ap.get("where") or {}), **_prov(ap, docs, has_value=True),
    )
    params = [_param(k, v, docs) for k, v in (r.get("parameters") or {}).items()]
    lk = r.get("lookup")
    lookup = None
    if lk:
        rows = [
            LookupRow(
                key=str(k), values={a: b for a, b in row.items() if a not in _ROW_META}, note=_s(row.get("note")),
                **_prov(row, docs, has_value=any(a not in _ROW_META for a in row)),
            )
            for k, row in (lk.get("table") or {}).items()
        ]
        lookup = Lookup(key=str(lk.get("key")), rows=rows)
    cautions = [
        Caution(level=c.get("level") or "", text=c.get("text") or "", level_note=_s(c.get("level_note")), **_prov(c, docs, has_value=_present(c.get("text"))))
        for c in (r.get("cautions") or [])
    ]
    ci = r.get("cad_inference")
    inference = (
        CadInference(part=str(ci.get("part")), quantity=ci.get("quantity"), inferred=bool(ci.get("inferred")), **_prov(ci, docs, has_value=True))
        if isinstance(ci, dict) else None
    )
    scope = "part" if (applies.classes or applies.proposed_classes) else ("role" if applies.role else "product")
    graded: list[Any] = [applies, params, cautions, inference, lookup.rows if lookup else []]
    gap_ids = {x.gap_id for g in graded for x in _list(g) if x is not None and x.gap_id}
    gap_ids |= {gid for gid, g in gaps.items() if rid in g.blocks}
    op = ops.get(r.get("operation") or "")
    return Rule(
        id=rid, name=r.get("name") or rid, operation=r.get("operation") or "", operation_label=op.label_ko if op else None, scope=scope,
        review_status=r.get("status") or "unreviewed", applies_to=applies, parameters=params, lookup=lookup, tools=[str(t) for t in _list(r.get("tools"))],
        cautions=cautions, note=_s(r.get("note")), cad_inference=inference, by_grade=_grade_counts(*graded), gap_ids=sorted(gap_ids),
    )


# ---------------------------------------------------------------- 작업표준서
def _work_standard(wid: str, w: dict[str, Any], docs: dict[str, dict[str, Any]], ops: dict[str, Operation], roles: dict[str, str],
                   gaps: dict[str, Gap]) -> WorkStandard:
    def op_label(code: str | None) -> str | None:
        return ops[code].label_ko if code in ops else None

    steps = [
        Step(
            seq=int(s.get("seq") or i), operation=s.get("operation") or "", operation_label=op_label(s.get("operation")),
            rules=[str(x) for x in _list(s.get("rules"))], text=s.get("text") or "", condition=_s(s.get("condition")),
            targets=[
                StepTarget(role=t.get("role") or "", role_label=roles.get(t.get("role")), quantity=t.get("quantity"),
                           source=t.get("source") if t.get("source") in GRADES else "unknown")
                for t in (s.get("targets") or [])
            ],
            order_binding=_s(s.get("order_binding")), **_prov(s, docs, has_value=_present(s.get("text"))),
        )
        for i, s in enumerate(w.get("steps") or [], 1)
    ]
    checks = [
        Check(text=c.get("text") or "", criterion=_s((c.get("criterion") or {}).get("text")), **_prov(c, docs, has_value=_present(c.get("text"))))
        for c in (w.get("checks") or [])
    ]
    inspections = [
        InspectionItem(
            seq=int(it.get("seq") or i), group=it.get("group") or "", target=it.get("target") or "", check=it.get("check") or "",
            cycle=Cycle(value=(it.get("cycle") or {}).get("value"), unit=(it.get("cycle") or {}).get("unit"), label=(it.get("cycle") or {}).get("label")),
            cycle_note=_s(it.get("cycle_note")), **_prov(it, docs, has_value=_present(it.get("check"))),
        )
        for i, it in enumerate(w.get("inspection_items") or [], 1)
    ]
    events = [
        EventCheck(event=e.get("event") or "", rules=[str(x) for x in _list(e.get("rules"))], text=e.get("text") or "",
                   **_prov(e, docs, has_value=_present(e.get("text"))))
        for e in (w.get("event_checks") or [])
    ]
    assemblies = [
        CadAssembly(
            cad_name=a.get("cad_name") or "", label=a.get("label") or a.get("cad_name") or "", model=a.get("model"),
            parts=[
                CadPart(
                    cad_name=p.get("cad_name") or "", quantity=int(p.get("quantity") or 0), class_code=p.get("class"), kind=_s(p.get("kind")),
                    thread_size=_s(p.get("threadSize")), length_mm=p.get("length_mm"),
                    length_source=p.get("length_source") if p.get("length_source") in GRADES else None, socket_size_mm=p.get("socket_size_mm"),
                    class_basis=_s(p.get("class_basis")), note=_s(p.get("note")), **_prov(p, docs, has_value=True),
                )
                for p in (a.get("parts") or [])
            ],
        )
        for a in (w.get("assemblies") or [])
    ]
    st = w.get("standard_time") or {"value": None, "source": "unknown"}
    standard_time = _param("standard_time", st, docs)
    graded: list[Any] = [steps, checks, inspections, events, standard_time, [p for a in assemblies for p in a.parts]]
    gap_ids = {x.gap_id for g in graded for x in _list(g) if x is not None and x.gap_id}
    gap_ids |= {gid for gid, g in gaps.items() if wid in g.blocks}
    if w.get("procedure_gap"):
        gap_ids.add(str(w["procedure_gap"]))
    return WorkStandard(
        id=wid, title=w.get("title") or wid, models=[str(m) for m in _list(w.get("models"))],
        kind="structure_only" if w.get("kind") == "structure_only" else "procedure", purpose=w.get("purpose") or "",
        review_status=w.get("status") or "unreviewed", revision=str(w.get("revision") or ""),
        rules=[str(x) for x in _list(w.get("rules"))], tools=[str(x) for x in _list(w.get("tools"))],
        step_count=len(steps), inspection_count=len(inspections), assembly_count=len(assemblies), gap_ids=sorted(gap_ids),
        standard_time=standard_time, steps=steps, checks=checks, precautions=[str(x) for x in _list(w.get("precautions"))],
        inspection_items=inspections, event_checks=events, assemblies=assemblies,
        source_files=[str(x) for x in _list(w.get("source_files"))], procedure_gap=_s(w.get("procedure_gap")), by_grade=_grade_counts(*graded),
    )


# ---------------------------------------------------------------- 전체
def build(data: dict[str, Any]) -> Rulebook:
    """`tools/check_rules.load_all` 과 같은 모양의 dict(파일 이름 → 파싱한 YAML)에서 만든다."""
    try:
        docs: dict[str, dict[str, Any]] = (data["sources"] or {}).get("documents") or {}
        roles: dict[str, str] = (data["rules"] or {}).get("roles") or {}
        ops, not_covered = _operations(data["operations"] or {}, docs)
        tools = _tools(data["tools"] or {}, docs)
        gaps = _gaps(data["gaps"] or {})
        rules = {rid: _rule(rid, r, docs, ops, roles, gaps) for rid, r in ((data["rules"] or {}).get("assembly_rules") or {}).items()}
        wss = {wid: _work_standard(wid, w, docs, ops, roles, gaps) for wid, w in ((data["work-standards"] or {}).get("work_standards") or {}).items()}
    except (KeyError, TypeError, AttributeError, ValueError) as e:
        raise RulebookError(f"rules/ 의 모양을 읽지 못했습니다: {type(e).__name__}: {e}") from e

    models = tuple(sorted({m for r in rules.values() for m in r.applies_to.models} | {m for w in wss.values() for m in w.models}))
    by_grade = {g: sum(r.by_grade[g] for r in rules.values()) + sum(w.by_grade[g] for w in wss.values()) for g in GRADES}
    counts = {
        "operations": len(ops), "not_covered": len(not_covered), "tools": len(tools), "rules": len(rules), "work_standards": len(wss),
        "gaps": len(gaps), "steps": sum(w.step_count for w in wss.values()), "inspection_items": sum(w.inspection_count for w in wss.values()),
    }
    return Rulebook(docs=docs, roles=roles, operations=ops, not_covered=not_covered, tools=tools, rules=rules, gaps=gaps,
                    work_standards=wss, models=models, counts=counts, by_grade=by_grade)
