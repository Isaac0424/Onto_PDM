"""CAD 에서 읽고 사람이 확정한 값 → OPMS 부품 후보. **임시 구현**이다.

OPMS 의 원칙은 '서버가 준 판정 그대로'(PDM 이 같은 DB 를 읽어 점수를 다시 계산하지 않는다)이고, 그 판정 API
(`POST /parts/match`)는 OPMS 쪽에서 보류 상태다(OPMS `docs/changes/CR-NEXT-parts-match-api.md`). 그 API 가 열릴 때까지
PDM 이 OPMS 의 dedupe(`registry/similarity.py` 의 `score_candidates`)와 **같은 방식**을 읽어 재현한다:

- 점수 = Σ(가중치 × 일치) / Σ(비교한 속성의 가중치). 가중치 · 허용오차는 스냅샷의 key_properties.
- 숫자는 허용오차 이하면 일치, 개념 · 문자열은 코드 일치. 값이 없는 속성(문서나 부품 쪽)은 비교에서 뺀다.
- confirmed ≥ 0.95, suspected ≥ 0.70, 그 미만은 버린다(OPMS settings.yaml `dedupe`). 점수순 상위 top_k(5).
- 핵심 속성 중 문서 값이 하나라도 없거나 근사(CAD 값)이면 판정은 최대 suspected(capped).
- 후보의 클래스가 문서의 클래스와 다르면(같은 계열 형제) 최대 suspected(class_capped).
- 머리 모양이 다르면 후보에서 뺀다(OPMS `CR-NEXT-head-type-ontology` H8 과 같은 취지: 다른 머리 = 다른 부품).

OPMS 의 match API 가 생기면 이 모듈을 그 API 호출로 바꾼다 (OpmsReader 경계 밖이라 라우트는 그대로).
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from decimal import Decimal
from typing import Any

from onto_pdm.errors import ApiException
from onto_pdm.opms.models import OpmsMatchCandidate, OpmsMatchProp, OpmsMatchRequest, OpmsMatchResult, Scalar
from onto_pdm.opms.ontology import Ontology
from onto_pdm.opms.reader import OpmsReader, RawPart

# OPMS settings.yaml `dedupe` 값을 따른다 (읽어 온 것이 아니라 옮겨 적은 값: OPMS 가 바꾸면 여기도 바꿔야 한다)
CONFIRMED = 0.95
SUSPECTED = 0.70
TOP_K = 5
DECIMAL_PLACES = 6

_THREAD = re.compile(r"^M[0-9]+(\.[0-9]+)?$")
NOTE = "임시 판정: OPMS 의 match API 가 열리기 전까지 PDM 이 OPMS 의 dedupe 방식으로 계산한 후보입니다. CAD 에서 읽은 값은 근사라 '후보'까지만 됩니다."


def _number(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


def _same(doc: Any, part: Any, kp: Mapping[str, Any]) -> bool:
    if _number(doc) and _number(part):
        tol = Decimal(str(kp.get("tolerance") or 0))
        if kp.get("tolerance_type") == "relative":
            tol *= abs(Decimal(str(part)))
        return round(abs(Decimal(str(doc)) - Decimal(str(part))), DECIMAL_PLACES) <= tol
    return doc == part


def _normalize(onto: Ontology, values: Mapping[str, Scalar]) -> dict[str, Scalar]:
    """OPMS 의 값 정규화를 필요한 만큼만: 나사 규격 'M8'(대문자, 'm8' · 'M 8' 허용), 숫자는 숫자로. 모르는 속성은 버린다."""
    out: dict[str, Scalar] = {}
    for key, raw in values.items():
        if raw is None or raw == "":
            continue
        if onto.prop_datatype(key) == "decimal":
            try:
                out[key] = float(raw)
            except (TypeError, ValueError):
                continue
        elif key == "threadSize":
            text = re.sub(r"\s+", "", str(raw)).upper()
            if _THREAD.match(text):
                out[key] = text
        else:
            out[key] = raw
    return out


def _doc_head(onto: Ontology, class_code: str | None, requested: str | None) -> str | None:
    if class_code:
        head = onto.head_type_of(class_code)
        if head:
            return head[0]
    return requested


def match(onto: Ontology, reader: OpmsReader, req: OpmsMatchRequest) -> OpmsMatchResult:
    values = _normalize(onto, req.values)
    version = onto.version

    def none(reason: str, note: str | None = None) -> OpmsMatchResult:
        return OpmsMatchResult(verdict="none", reason=reason, candidates=[], ontology_version=version, note=note or NOTE)  # type: ignore[arg-type]

    if req.class_code is not None:
        if not onto.has_class(req.class_code):
            return none("unknown_class", f"OPMS 온톨로지에 없는 분류입니다: {req.class_code}")
        if not onto.is_leaf(req.class_code):
            raise ApiException(422, "INVALID_REQUEST", "분류는 리프 분류만 받습니다 (어느 핵심 속성을 쓸지 정할 수 없습니다)")
    if not values:
        return none("no_values")

    head = _doc_head(onto, req.class_code, req.head_type)
    if req.class_code is not None:
        root = onto.family_root(req.class_code)
        pool = [c for c in onto.leaves() if onto.family_root(c) == root]
    else:
        # 분류를 모르면: 준 속성을 모두 가진 분류만 후보 (예: 길이가 있는 것은 볼트 계열)
        pool = [c for c in onto.leaves() if all(k in onto.properties_of(c) for k in values)]
    if head is not None:
        pool = [c for c in pool if (onto.head_type_of(c) or (None,))[0] == head]
    if not pool:
        return none("no_candidate", f"머리 모양 '{head}' 인 OPMS 분류가 없습니다." if head else None)

    # 비교에 쓸 핵심 속성: 문서 분류가 있으면 그 분류, 없으면 후보 분류의 계열 뿌리(계열 안에서는 같다)
    def key_props_of(code: str) -> list[dict[str, Any]]:
        return onto.key_properties(code)

    ref_class = req.class_code
    blocking = {kp["prop"]: values[kp["prop"]] for kp in (key_props_of(ref_class) if ref_class else []) if kp.get("blocking") and kp["prop"] in values}
    if ref_class is None:
        blocking = {"threadSize": values["threadSize"]} if "threadSize" in values else {}
    parts = reader.parts(pool, equals=blocking)

    out: list[OpmsMatchCandidate] = []
    for part in parts:
        key_props = key_props_of(ref_class or part.class_code)
        cand = _score(onto, req, values, part, key_props, ref_class)
        if cand is not None:
            out.append(cand)
    out.sort(key=lambda c: (-c.score, c.part_no))
    out = out[: req.limit or TOP_K]
    verdict = "confirmed" if any(c.verdict == "confirmed" for c in out) else ("suspected" if out else "none")
    return OpmsMatchResult(verdict=verdict, reason="ok" if out else "no_candidate", candidates=out, ontology_version=version, note=NOTE)


def _score(onto: Ontology, req: OpmsMatchRequest, values: Mapping[str, Scalar], part: RawPart,
           key_props: list[dict[str, Any]], ref_class: str | None) -> OpmsMatchCandidate | None:
    matched: dict[str, bool | None] = {}
    for kp in key_props:
        k = kp["prop"]
        doc, have = values.get(k), part.values.get(k)
        matched[k] = None if (doc is None or have is None) else _same(doc, have, kp)
    weights = {kp["prop"]: float(kp.get("weight") or 1.0) for kp in key_props}
    compared = [k for k, hit in matched.items() if hit is not None]
    total = sum(weights[k] for k in compared)
    if total == 0:
        return None
    score = sum(weights[k] for k in compared if matched[k]) / total
    if score < SUSPECTED:
        return None
    doc_capped = req.approximate or any(values.get(kp["prop"]) is None for kp in key_props)
    capped = doc_capped or any(part.values.get(kp["prop"]) is None for kp in key_props)
    class_capped = ref_class is not None and part.class_code != ref_class
    verdict = "confirmed" if score >= CONFIRMED and not capped and not class_capped else "suspected"
    props = [OpmsMatchProp(
        prop_key=kp["prop"], label=onto.prop_label(kp["prop"]), hit=matched[kp["prop"]],
        doc_display=onto.display(kp["prop"], values[kp["prop"]]) if kp["prop"] in values else None,
        part_display=onto.display(kp["prop"], part.values[kp["prop"]]) if kp["prop"] in part.values else None,
    ) for kp in key_props]
    return OpmsMatchCandidate(
        part_no=part.part_no, class_code=part.class_code, class_label=onto.label(part.class_code),
        class_path_labels=onto.path_labels(part.class_code), label=onto.part_label(part.class_code, part.values),
        verdict=verdict, score=round(score, 4), capped=capped, class_capped=class_capped, matched=props,
    )
