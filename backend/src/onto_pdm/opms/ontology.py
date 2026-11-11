"""OPMS 온톨로지 스냅샷(JSON) 읽기 도우미. 클래스 · 속성 · 개념 · 핵심 속성 · 고정 값을 꺼낸다. 판단은 하지 않는다."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from onto_pdm.opms.models import OpmsClass, OpmsClassDetail, OpmsKeyProperty, OpmsLookupDefault, OpmsPart, OpmsPropertySpec
from onto_pdm.opms.reader import OntologySnapshot, RawPart

# 임시: OPMS 온톨로지(0.15.0)에는 아직 머리 모양(headType)이 없다. OPMS 의 `CR-NEXT-head-type-ontology`(초안)가 적용돼
# 클래스가 headType 을 `fixed` 로 고정하면 그 값을 쓰고, 그 전까지는 이 표(OPMS 클래스 코드 → 머리 모양)로 대신한다.
# OPMS 에 headType 이 생기면 이 표는 지운다 (head_type_of 가 스냅샷의 fixed 를 먼저 본다).
TEMPORARY_HEAD_TYPE_BY_CLASS: Mapping[str, str] = {
    "HexBolt": "Hex",
    "HexFlangeBolt": "HexFlange",
    "SocketHeadBolt": "Socket",
}


class Ontology:
    def __init__(self, snapshot: OntologySnapshot) -> None:
        self.version = snapshot.version
        self._d: Mapping[str, Any] = snapshot.data
        self._classes: Mapping[str, Any] = snapshot.data.get("classes", {})
        self._props: Mapping[str, Any] = snapshot.data.get("properties", {})
        self._concepts: Mapping[str, Any] = snapshot.data.get("concepts", {})

    # ---- 클래스 ----
    def has_class(self, code: str) -> bool:
        return code in self._classes

    def class_codes(self) -> list[str]:
        return sorted(self._classes)

    def is_leaf(self, code: str) -> bool:
        return bool(self._classes.get(code, {}).get("leaf"))

    def leaves(self) -> list[str]:
        return [c for c in self.class_codes() if self.is_leaf(c)]

    def family_root(self, code: str) -> str | None:
        return self._classes.get(code, {}).get("family_root")

    def label(self, code: str) -> str:
        return str(self._classes.get(code, {}).get("label", {}).get("ko") or code)

    def path(self, code: str) -> list[str]:
        return list(self._classes.get(code, {}).get("path") or [code])

    def path_labels(self, code: str) -> list[str]:
        return [self.label(c) if c in self._classes else c for c in self.path(code)]

    def properties_of(self, code: str) -> Mapping[str, Any]:
        return self._classes.get(code, {}).get("properties") or {}

    def key_properties(self, code: str) -> list[dict[str, Any]]:
        return list(self._classes.get(code, {}).get("key_properties") or [])

    def fixed(self, code: str, prop: str) -> str | None:
        eff = self.properties_of(code).get(prop)
        return eff.get("fixed") if isinstance(eff, Mapping) else None

    def head_type_of(self, code: str) -> tuple[str, str] | None:
        """(머리 모양, 출처). 온톨로지의 고정 값이 먼저, 없으면 임시 표."""
        fixed = self.fixed(code, "headType")
        if fixed:
            return fixed, "ontology"
        temp = TEMPORARY_HEAD_TYPE_BY_CLASS.get(code)
        return (temp, "pdm_temporary") if temp else None

    # ---- 속성 · 개념 ----
    def prop_label(self, key: str) -> str:
        return str(self._props.get(key, {}).get("label", {}).get("ko") or key)

    def prop_unit(self, key: str) -> str | None:
        return self._props.get(key, {}).get("canonical_unit")

    def prop_datatype(self, key: str) -> str:
        return str(self._props.get(key, {}).get("datatype") or "string")

    def concept_label(self, code: str) -> str | None:
        c = self._concepts.get(code)
        return c.get("pref_label") if isinstance(c, Mapping) else None

    def _lookup_default(self, lookup: Any) -> OpmsLookupDefault | None:
        """속성의 값 표(lookup)에서 기본 열(예: 보통 나사)의 값만 꺼낸다. 표가 없으면 None."""
        if not isinstance(lookup, Mapping) or not lookup.get("key"):
            return None
        series = lookup.get("default")
        table = lookup.get("table") or {}
        values = {str(k): [float(x) for x in row[series]] for k, row in table.items() if isinstance(row, Mapping) and series in row} if series else {}
        return OpmsLookupDefault(key=str(lookup["key"]), series=series, series_label=self.concept_label(series) if series else None, values=values)

    # ---- 화면용 모델 ----
    def to_class(self, code: str) -> OpmsClass:
        head = self.head_type_of(code)
        c = self._classes.get(code, {})
        return OpmsClass(
            code=code, label_ko=self.label(code), label_en=c.get("label", {}).get("en"), definition=c.get("definition"),
            parent=c.get("parent"), leaf=self.is_leaf(code), path=self.path(code), path_labels=self.path_labels(code),
            family_root=self.family_root(code),
            head_type=head[0] if head else None, head_type_source=head[1] if head else None,  # type: ignore[arg-type]
        )

    def to_class_detail(self, code: str) -> OpmsClassDetail:
        base = self.to_class(code)
        specs: list[OpmsPropertySpec] = []
        for key, eff in sorted(self.properties_of(code).items()):
            p = self._props.get(key, {})
            default = p.get("omitted_default")
            specs.append(OpmsPropertySpec(
                key=key, label_ko=self.prop_label(key), label_en=p.get("label", {}).get("en"), datatype=self.prop_datatype(key),
                unit=self.prop_unit(key), scheme=p.get("scheme"), required=bool(eff.get("required")),
                min=eff.get("min"), max=eff.get("max"), fixed=eff.get("fixed"),
                omitted_default=default, omitted_default_label=self.concept_label(default) if default else None,
                lookup_default=self._lookup_default(p.get("lookup")),
            ))
        keys = [OpmsKeyProperty(
            prop=kp["prop"], label_ko=self.prop_label(kp["prop"]), blocking=bool(kp.get("blocking")), weight=float(kp.get("weight") or 1.0),
            tolerance=kp.get("tolerance"), tolerance_type=kp.get("tolerance_type"),
        ) for kp in self.key_properties(code)]
        return OpmsClassDetail(**base.model_dump(), properties=specs, key_properties=keys,
                               distinguishing=list(self._classes.get(code, {}).get("distinguishing") or []))

    # ---- 부품 표시 ----
    def display(self, prop: str, value: Any) -> str:
        """값을 사람이 읽는 문자열로: 개념 코드는 라벨, 숫자는 단위와 함께."""
        if self.prop_datatype(prop) == "concept":
            return self.concept_label(str(value)) or str(value)
        unit = self.prop_unit(prop)
        text = f"{value:g}" if isinstance(value, float) else str(value)
        return f"{text} {unit}" if unit else text

    def part_label(self, class_code: str, values: Mapping[str, Any]) -> str:
        """OPMS 부품에는 이름이 없다: 분류 이름 + 핵심 속성 앞 세 개 (예: '육각볼트 M8 · 30 mm · SUS304')."""
        shown = [self.display(kp["prop"], values[kp["prop"]]) for kp in self.key_properties(class_code) if kp["prop"] in values][:3]
        return f"{self.label(class_code)} {' · '.join(shown)}".strip()

    def to_part(self, raw: RawPart) -> OpmsPart:
        concept_props = [k for k in raw.values if self.prop_datatype(k) == "concept"]
        return OpmsPart(
            part_no=raw.part_no, class_code=raw.class_code, class_label=self.label(raw.class_code),
            class_path_labels=self.path_labels(raw.class_code), label=self.part_label(raw.class_code, raw.values),
            values=dict(raw.values),
            value_labels={k: self.display(k, raw.values[k]) for k in concept_props},
        )
