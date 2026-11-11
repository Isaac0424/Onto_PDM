"""확정한 분류 · 속성으로 적용되는 조립 규칙 고르기. 순수 함수(저장소 · 네트워크 없음).

원칙: **값이 없으면 단정하지 않는다.** 조건마다 yes · no · unknown 으로 평가하고, 하나라도 no 면 적용 안 됨, no 는 없고 unknown 이 있으면 unknown, 모두 yes 면 yes.
평가하는 조건(규칙 모양은 rules/rules.yaml):
  * class   — applies_to.classes(+proposed_classes) 중 하나가 요청 분류 또는 class_path(상위 분류)에 있다. 분류 조건이 없는 규칙은 분류를 보지 않는다.
  * role    — applies_to.context.role. 요청에 role 이 없으면 unknown.
  * model   — applies_to.context.model 이 로봇 모델 일부로 **제한**돼 있을 때만(전체 모델이면 조건이 아니다). 요청 모델이 없으면 unknown.
  * attribute — applies_to.where(같음 · 목록 · min/max)와, 근거가 있는 파라미터의 식별 값(threadSize · length_mm · length_min_mm).
  * lookup  — 규칙의 표(model 키)에서 요청 속성과 맞는 행. 모델을 알면 한 행으로 정해지고, 모르면 속성과 맞는 행이 후보가 된다.
select 는 분류가 대상인 규칙(scope=part)과, 요청 role 이 같은 역할 전용 규칙(scope=role)만 본다. 제품 · 설치 전반 규칙(scope=product)은 목록 API 로 본다.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from onto_pdm.rulebook.build import Rulebook
from onto_pdm.rulebook.models import (
    ConditionResult,
    LookupResolution,
    LookupRow,
    Param,
    Rule,
    SelectCounts,
    SelectedRule,
    SelectRequest,
    SelectResponse,
)

Tri = Literal["yes", "no", "unknown"]
_ALIAS = {"length": "length_mm", "thread_size": "threadSize", "thread": "threadSize"}
_MODEL_RE = re.compile(r"HCR[\s_-]*(\d+)\s*([A-Z])", re.I)
_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")
_TOL = 0.05          # mm 비교 허용 오차 (CAD 치수는 0.05 mm 안에서 규격 길이와 맞는다)
_NOTE = (
    "값이 없거나 확정되지 않은 조건은 '미확인'(unknown)이고 규칙이 적용된다고 단정하지 않습니다. "
    "cad · unknown 근거의 파라미터는 confirmed=false 이므로 작업자 화면에서 확정값처럼 보이면 안 됩니다. "
    "class_path(상위 분류)를 주지 않으면 분류는 정확히 일치만 봅니다."
)


# ---------------------------------------------------------------- 값 정규화
def norm_model(v: str | None) -> str | None:
    """'HCR12A' · 'hcr-12a' · 'HCR 12A' → 'HCR-12A'. 로봇 모델로 읽을 수 없으면 None(미확인)."""
    if not v:
        return None
    m = _MODEL_RE.search(v)
    return f"HCR-{m.group(1)}{m.group(2).upper()}" if m else None


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int | float):
        return float(v)
    if isinstance(v, str):
        m = _NUM_RE.search(v)
        return float(m.group()) if m else None
    return None


def _thread(v: Any) -> str:
    return str(v).strip().upper().replace(" ", "")


def _attrs(req: SelectRequest) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in req.attributes.items():
        if v is None or v == "":
            continue
        out[_ALIAS.get(k, k)] = v
    return out


def _show(v: Any) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _cond(kind: str, key: str, expected: str, actual: Any, result: Tri, message: str) -> ConditionResult:
    return ConditionResult(kind=kind, key=key, expected=expected, actual=None if actual is None else _show(actual), result=result, message=message)  # type: ignore[arg-type]


# ---------------------------------------------------------------- 속성 하나 비교
def _compare(key: str, expected: Any, attrs: dict[str, Any]) -> tuple[Tri, str, Any]:
    """속성 key 를 expected(스칼라 · 목록 · {min,max})와 비교. (결과, 기대 표시, 실제 값)."""
    actual = attrs.get(key)
    if isinstance(expected, dict):
        lo, hi = _num(expected.get("min")), _num(expected.get("max"))
        shown = f"{key} {'≥ ' + _show(lo) if lo is not None else ''}{' ' if lo is not None and hi is not None else ''}{'≤ ' + _show(hi) if hi is not None else ''}".strip()
        if actual is None:
            return "unknown", shown, None
        n = _num(actual)
        if n is None:
            return "unknown", shown, actual
        ok = (lo is None or n >= lo - _TOL) and (hi is None or n <= hi + _TOL)
        return ("yes" if ok else "no"), shown, actual
    options = [x for x in (expected if isinstance(expected, list) else [expected]) if x is not None]
    shown = f"{key} = {' | '.join(_show(x) for x in options)}"
    if actual is None:
        return "unknown", shown, None
    if key == "threadSize":
        ok = _thread(actual) in {_thread(x) for x in options}
    elif all(_num(x) is not None for x in options) and _num(actual) is not None:
        ok = any(abs(_num(actual) - _num(x)) <= _TOL for x in options)        # type: ignore[operator]
    else:
        ok = str(actual).strip() in {str(x).strip() for x in options}
    return ("yes" if ok else "no"), shown, actual


def _param_constraints(rule: Rule) -> list[tuple[str, Any, str]]:
    """근거가 있는 파라미터 중 요청 속성과 비교할 식별 값. [(속성 키, 기대 값, 연산)]."""
    out: list[tuple[str, Any, str]] = []
    for p in rule.parameters:
        if p.value is None or p.source not in ("manual", "cad"):
            continue
        if p.name == "threadSize":
            out.append(("threadSize", p.value, "eq"))
        elif p.name == "length_mm":
            out.append(("length_mm", p.value, "eq"))
        elif p.name == "length_min_mm":
            out.append(("length_mm", {"min": p.value}, "min"))
    return out


# ---------------------------------------------------------------- 표(lookup)
def _row_match(row: LookupRow, attrs: dict[str, Any]) -> Tri:
    results: list[Tri] = []
    for key in ("threadSize", "length_mm"):
        if key in row.values:
            results.append(_compare(key, row.values[key], attrs)[0])
    if not results:
        return "yes"
    if "no" in results:
        return "no"
    return "unknown" if "unknown" in results else "yes"


def _row_text(row: LookupRow) -> str:
    bits = [f"{k} {_show(v)}" for k, v in row.values.items() if k in ("threadSize", "length_mm")]
    return f"{row.key}({', '.join(bits)})" if bits else row.key


def _lookup(rule: Rule, attrs: dict[str, Any], model: str | None) -> tuple[LookupResolution | None, list[ConditionResult]]:
    lk = rule.lookup
    if lk is None:
        return None, []
    comparable = any(k in r.values for r in lk.rows for k in ("threadSize", "length_mm"))
    if lk.key != "model":
        # 키가 모델이 아닌 표(설치 유형 등) — 요청과 이어지지 않으므로 전체를 그대로 보여 주고 조건으로는 보지 않는다
        return LookupResolution(key=lk.key, status="all", rows=list(lk.rows)), []
    if model:
        row = next((r for r in lk.rows if r.key == model), None)
        if row is None:
            return LookupResolution(key=lk.key, status="none", rows=[]), [
                _cond("lookup", "model", model, model, "unknown", f"표에 {model} 행이 없습니다")]
        if not comparable:
            return LookupResolution(key=lk.key, status="selected", rows=[row]), []        # 모델로 행이 정해지고 비교할 규격 값은 없는 표
        res = _row_match(row, attrs)
        msg = {"yes": f"{model} 행의 규격과 맞습니다 ({_row_text(row)})", "no": f"{model} 행의 규격({_row_text(row)})과 요청 속성이 맞지 않습니다",
               "unknown": f"{model} 행({_row_text(row)})과 비교할 속성 값이 없습니다"}[res]
        return LookupResolution(key=lk.key, status="selected", rows=[row]), [_cond("lookup", "model", _row_text(row), None, res, msg)]
    if not comparable:
        return LookupResolution(key=lk.key, status="all", rows=list(lk.rows)), []         # 모델을 모르면 전체 행(모델별 값)을 보여 준다
    consistent = [r for r in lk.rows if _row_match(r, attrs) != "no"]
    provided = [k for k in ("threadSize", "length_mm") if k in attrs]
    if provided and not consistent:
        return LookupResolution(key=lk.key, status="none", rows=[]), [_cond(
            "lookup", "model", " / ".join(_row_text(r) for r in lk.rows), None, "no", "표의 어떤 모델 행과도 요청 규격이 맞지 않습니다")]
    return LookupResolution(key=lk.key, status="candidates", rows=consistent), [_cond(
        "lookup", "model", " / ".join(_row_text(r) for r in consistent), None, "unknown",
        "로봇 모델을 알면 표의 행이 정해집니다 — 맞는 후보 행: " + ", ".join(_row_text(r) for r in consistent))]


# ---------------------------------------------------------------- 규칙 하나
def _evaluate(rule: Rule, book: Rulebook, req: SelectRequest, attrs: dict[str, Any], model: str | None,
              class_set: set[str]) -> tuple[list[ConditionResult], LookupResolution | None]:
    ap = rule.applies_to
    conds: list[ConditionResult] = []

    targets = [*ap.classes, *ap.proposed_classes]
    if targets:
        hit = [c for c in targets if c in class_set]
        label = " | ".join(targets)
        if hit:
            via = "" if hit[0] == req.class_code else f" (상위 분류 {hit[0]})"
            conds.append(_cond("class", "class", label, req.class_code, "yes", f"분류 {req.class_code}이(가) 대상입니다{via}"))
        else:
            hint = "" if req.class_path else " — class_path 를 주면 상위 분류도 봅니다"
            conds.append(_cond("class", "class", label, req.class_code, "no", f"분류 {req.class_code}은(는) 대상({label})이 아닙니다{hint}"))

    if ap.role:
        if req.role is None:
            conds.append(_cond("role", "role", ap.role, None, "unknown", f"이 부품이 하는 일(role)을 알아야 합니다: {ap.role_label or ap.role}"))
        elif req.role == ap.role:
            conds.append(_cond("role", "role", ap.role, req.role, "yes", f"역할 {ap.role}"))
        else:
            conds.append(_cond("role", "role", ap.role, req.role, "no", f"역할 {req.role}은(는) 이 규칙의 역할({ap.role})이 아닙니다"))

    if ap.models and set(ap.models) != set(book.models):                      # 일부 모델로 제한된 규칙만 모델이 조건이다
        label = " | ".join(ap.models)
        if model is None:
            conds.append(_cond("model", "model", label, None, "unknown", f"로봇 모델({label})을 알아야 합니다"))
        elif model in ap.models:
            conds.append(_cond("model", "model", label, model, "yes", f"모델 {model}"))
        else:
            conds.append(_cond("model", "model", label, model, "no", f"모델 {model}은(는) 대상({label})이 아닙니다"))

    for key, expected in ap.where.items():
        res, shown, actual = _compare(_ALIAS.get(key, key), expected, attrs)
        msg = {"yes": f"{shown} 충족", "no": f"{shown} 아님 (요청 {_show(actual)})", "unknown": f"{shown} — 요청에 {key} 값이 없습니다"}[res]
        conds.append(_cond("attribute", key, shown, actual, res, msg))

    for key, expected, _op in _param_constraints(rule):
        res, shown, actual = _compare(key, expected, attrs)
        msg = {"yes": f"{shown} 일치", "no": f"{shown} 아님 (요청 {_show(actual)})", "unknown": f"{shown} — 요청에 값이 없습니다"}[res]
        conds.append(_cond("attribute", key, shown, actual, res, msg))

    resolution, lk_conds = _lookup(rule, attrs, model)
    conds.extend(lk_conds)
    return conds, resolution


def _unconfirmed(params: list[Param]) -> list[str]:
    return [p.name for p in params if not p.confirmed]


def select_rules(book: Rulebook, req: SelectRequest) -> SelectResponse:
    attrs = _attrs(req)
    model = norm_model(req.model) or norm_model(req.product)
    class_set = {req.class_code, *req.class_path}
    selected: list[SelectedRule] = []
    n = {"yes": 0, "unknown": 0, "no": 0}

    for rule in book.rules.values():
        if rule.scope == "product" or (rule.scope == "role" and req.role is None):
            continue                                                            # 분류도 역할도 요청과 이어지지 않는 규칙은 고르지 않는다
        conds, resolution = _evaluate(rule, book, req, attrs, model, class_set)
        failed = [c for c in conds if c.result == "no"]
        unknown = [c for c in conds if c.result == "unknown"]
        applicable: Tri = "no" if failed else ("unknown" if unknown else "yes")
        n[applicable] += 1
        if applicable == "no" and not req.include_inapplicable:
            continue
        selected.append(SelectedRule(
            rule=rule, applicable=applicable, matched_conditions=[c for c in conds if c.result == "yes"], unknown_conditions=unknown,
            failed_conditions=failed, lookup=resolution, unconfirmed_parameters=_unconfirmed(rule.parameters),
        ))

    order = {"yes": 0, "unknown": 1, "no": 2}
    selected.sort(key=lambda s: (order[s.applicable], s.rule.id))
    return SelectResponse(
        class_code=req.class_code, role=req.role, model=model, rules=selected, counts=SelectCounts(**n), note=_NOTE,
    )
