"""이름 비교와 매칭의 순수 함수. web/src/api/mock/mockApi.ts 의 normKey · similarity · matchCadParts 와 같은 결과를 낸다.

저장소(InMemoryPdmStore)가 보이는 품목 · 별칭 · 분류를 넘겨 주고, 여기서는 규칙대로 판정만 한다.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

_SEP = re.compile(r"[\s_.\-]+")


def norm_key(s: str) -> str:
    """이름 비교 키: 대문자, 공백 · _ · - · . 제거 (DB norm_key 와 같다)."""
    return _SEP.sub("", s.upper())


def _grams(s: str) -> set[str]:
    t = f" {s.lower()} "
    return {t[i : i + 2] for i in range(len(t) - 1)}


def similarity(a: str, b: str) -> float:
    """두 글자 묶음 유사도 (pg_trgm 대신 쓰는 근사, Dice 계수)."""
    ga, gb = _grams(a), _grams(b)
    common = len(ga & gb)
    total = len(ga) + len(gb)
    return (2 * common) / total if total else 0.0


def round2(x: float) -> float:
    """JS `Math.round(x * 100) / 100` (반올림은 절반을 올림)."""
    return math.floor(x * 100 + 0.5) / 100


@dataclass(frozen=True)
class Catalog:
    """매칭에 필요한 데이터. 모두 이 사용자에게 보이는 것만 담는다."""

    items: list[dict[str, Any]]  # 품목 (item_no, name, name_ko, class_iri, id …) — 보이는 것만, 시드 순서
    identifiers: dict[int, list[dict[str, str]]]  # item id → 별칭 [{scheme, value}]
    classes: list[dict[str, Any]]  # 분류 전체

    def class_path(self, iri: str | None) -> list[str]:
        out: list[str] = []
        by_iri = {c["iri"]: c for c in self.classes}
        c = by_iri.get(iri) if iri else None
        while c is not None:
            out.insert(0, c["label_ko"])
            c = by_iri.get(c.get("parent_iri")) if c.get("parent_iri") else None
        return out


# 이름으로 분류를 추정한다: 분류 이름이 그대로 들어 있거나, 흔한 동의어(나사 → 볼트)
_SYNONYMS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"나사|볼트|screw|bolt", re.IGNORECASE), "볼트"),
    (re.compile(r"모터"), "서보 모터"),
    (re.compile(r"감속"), "감속기"),
)


def _class_for(cat: Catalog, name: str) -> dict[str, Any] | None:
    part_classes = [c for c in cat.classes if c["kind"] == "part"]
    lower = name.lower()
    direct = [c for c in part_classes if c["label_ko"] in name or (c.get("label_en") and c["label_en"].lower() in lower)]
    if direct:
        return sorted(direct, key=lambda c: -len(c["label_ko"]))[0]  # 안정 정렬: 길이가 같으면 시드 순서
    for pattern, label in _SYNONYMS:
        if pattern.search(name):
            return next((c for c in part_classes if c["label_ko"] == label), None)
    return None


def match_cad_part(cat: Catalog, raw: str) -> dict[str, Any]:
    """CAD 부품 이름 하나를 보유 품번과 맞춘다 (docs/pdm-design.md 6장). 결과는 CadPartMatch 모양의 dict."""
    name = raw.strip()
    lower = name.lower()
    key = norm_key(name)

    def result(it: dict[str, Any], method: str, score: float, status: str) -> dict[str, Any]:
        cls = next((c for c in cat.classes if c["iri"] == it.get("class_iri")), None)
        out: dict[str, Any] = {
            "name": raw, "status": status, "item_no": it["item_no"], "item_name": it.get("name_ko") or it["name"],
            "method": method, "score": score,
        }
        if cls:
            out.update(class_iri=cls["iri"], class_label=cls["label_ko"], class_path=cat.class_path(cls["iri"]))
        return out

    def names_of(it: dict[str, Any]) -> list[str]:
        return [it["item_no"], it["name"], it.get("name_ko") or ""]

    aliases = cat.identifiers
    for it in cat.items:
        if any(v.lower() == lower for v in names_of(it)):
            return result(it, "exact", 1, "matched")
    for it in cat.items:
        if any(a["scheme"] != "cad_name" and a["value"].lower() == lower for a in aliases.get(it["id"], [])):
            return result(it, "alias", 1, "matched")
    for it in cat.items:
        if any(a["scheme"] == "cad_name" and a["value"].lower() == lower for a in aliases.get(it["id"], [])):
            return result(it, "cad_name", 0.97, "suggested")
    for it in cat.items:
        if any(v and norm_key(v) == key for v in names_of(it)):
            return result(it, "normalized", 0.95, "suggested")
    # 유사도: 설계는 0.3 이상이지만 목 데이터는 이름이 짧아 0.5 로 올렸다
    best: tuple[dict[str, Any], float] | None = None
    for it in cat.items:
        score = max(similarity(name, it["name"]), similarity(name, it["name_ko"]) if it.get("name_ko") else 0.0)
        if score >= 0.5 and (best is None or score > best[1]):
            best = (it, score)
    if best:
        return result(best[0], "fuzzy", round2(best[1]), "suggested")

    cls = _class_for(cat, name)
    out = {"name": raw, "status": "none"}
    if cls:
        out.update(class_iri=cls["iri"], class_label=cls["label_ko"], class_path=cat.class_path(cls["iri"]))
    return out


def duplicate_candidates(items: Iterable[dict[str, Any]], identifiers: list[dict[str, Any]], name: str,
                         alias_values: list[str] | None = None) -> list[dict[str, Any]]:
    """등록 요청을 제출할 때 붙는 중복 후보 (match_item_candidates 근사). items 는 **전체** 품목이다."""
    alias_values = alias_values or []
    items = list(items)
    by_id = {it["id"]: it for it in items}
    found: dict[str, dict[str, Any]] = {}

    def put(c: dict[str, Any]) -> None:
        prev = found.get(c["item_no"])
        if prev is None or prev["score"] < c["score"]:
            found[c["item_no"]] = c

    for it in items:
        if name in (it["item_no"], it["name"]):
            put({"item_no": it["item_no"], "name": it["name"], "method": "exact", "score": 1})
        elif norm_key(it["item_no"]) == norm_key(name) or norm_key(it["name"]) == norm_key(name):
            put({"item_no": it["item_no"], "name": it["name"], "method": "normalized", "score": 0.95})
        else:
            s = max(similarity(it["name"], name), similarity(it["name_ko"], name) if it.get("name_ko") else 0.0)
            if s >= 0.3:
                put({"item_no": it["item_no"], "name": it["name"], "method": "fuzzy", "score": round2(s)})
    # 이름과 요청에 적은 별칭 값 모두로 기존 별칭을 찾는다
    for term in [name, *alias_values]:
        for x in identifiers:
            if x["value"] == term or norm_key(x["value"]) == norm_key(term):
                it = by_id[x["item_id"]]
                score = 0.95 if x["value"] != term else 0.97 if x["scheme"] == "cad_name" else 1
                put({"item_no": it["item_no"], "name": it["name"], "method": "cad_name" if x["scheme"] == "cad_name" else "alias", "score": score})
    return sorted(found.values(), key=lambda c: -c["score"])[:5]


def match_bom_sheet_row(cat: Catalog, row: dict[str, Any]) -> dict[str, Any]:
    """BOM 시트 한 줄을 보유 품번과 맞춘다.

    - 품번이 정확히(공백 · 하이픈 · 대소문자 무시) 일치 → matched (자동 확정)
    - 이름이 일치하거나 비슷하면 → suggested (사람이 확정)
    - 아니면 → none
    """
    line = row["line"]
    item_no = (row.get("item_no") or "").strip()
    name = (row.get("name") or "").strip()

    if item_no:
        key = norm_key(item_no)
        for it in cat.items:
            if norm_key(it["item_no"]) == key:
                return {"line": line, "status": "matched", "item_no": it["item_no"], "item_name": it.get("name_ko") or it["name"],
                        "reason": "품번 일치"}
        for it in cat.items:
            if any(norm_key(a["value"]) == key for a in cat.identifiers.get(it["id"], [])):
                return {"line": line, "status": "suggested", "item_no": it["item_no"], "item_name": it.get("name_ko") or it["name"],
                        "reason": f"별칭 {item_no} 로 찾았습니다. 대표 품번을 확인하세요"}
    if name:
        m = match_cad_part(cat, name)
        if m["status"] != "none":
            how = {"exact": "이름 일치", "alias": "별칭 일치", "cad_name": "CAD 이름 별칭", "normalized": "이름이 거의 같음", "fuzzy": "이름이 비슷함"}[m["method"]]
            return {"line": line, "status": "suggested", "item_no": m["item_no"], "item_name": m["item_name"],
                    "reason": f"{how}: 품번이 {'없어서' if not item_no else '맞지 않아서'} 이름으로 찾았습니다. 확인하세요"}
    return {"line": line, "status": "none", "reason": "보유 품번 없음" + (f" ({item_no})" if item_no else "")}
