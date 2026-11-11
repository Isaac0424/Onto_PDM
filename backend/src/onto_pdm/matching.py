"""이름 비교와 매칭의 순수 함수. web/src/api/mock/mockApi.ts 의 normKey · similarity · matchCadParts 와 같은 결과를 낸다.

저장소(InMemoryPdmStore)가 보이는 품목 · 별칭 · 분류를 넘겨 주고, 여기서는 규칙대로 판정만 한다.
"""

from __future__ import annotations

import math
import re
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
