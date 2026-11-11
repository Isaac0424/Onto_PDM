"""OPMS 읽기 시험용 가짜 OPMS: 실제 스냅샷 모양(0.15.0)을 줄여 만든 온톨로지와 부품. 시험 안에서만 쓰는 가짜 데이터다."""

from __future__ import annotations

from collections.abc import Collection, Mapping
from typing import Any

from onto_pdm.opms.errors import OpmsUnavailable
from onto_pdm.opms.reader import OntologySnapshot, RawPart


def _eff(required: bool = False, **extra: Any) -> dict[str, Any]:
    return {"required": required, "min": None, "max": None, "severity": {}, **extra}


def _cls(label_ko: str, parent: str | None, path: list[str], *, leaf: bool, family: str | None, props: dict[str, Any], keys: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"label": {"ko": label_ko, "en": label_ko}, "definition": f"{label_ko} 정의", "parent": parent, "leaf": leaf, "path": path,
            "family_root": family, "properties": props, "declared": {}, "key_properties": keys or [], "distinguishing": [], "own_distinguishing": [],
            "sibling_markers": [], "rules": [], "terms": []}


BOLT_KEYS = [
    {"prop": "threadSize", "blocking": True, "weight": 1.0, "tolerance": None, "tolerance_type": None},
    {"prop": "length", "blocking": False, "weight": 1.0, "tolerance": 0.2, "tolerance_type": "absolute"},
    {"prop": "material", "blocking": False, "weight": 1.0, "tolerance": None, "tolerance_type": None},
    {"prop": "surfaceTreatment", "blocking": False, "weight": 1.0, "tolerance": None, "tolerance_type": None},
    {"prop": "pitch", "blocking": False, "weight": 1.0, "tolerance": None, "tolerance_type": None},
]
NUT_KEYS = [
    {"prop": "threadSize", "blocking": True, "weight": 1.0, "tolerance": None, "tolerance_type": None},
    {"prop": "pitch", "blocking": False, "weight": 1.0, "tolerance": None, "tolerance_type": None},
]
_BOLT_PROPS = {**{k: _eff(True) for k in ("threadSize", "material", "surfaceTreatment", "pitch", "threadDirection")}, "length": _eff(True, min=3.0)}
_NUT_PROPS = {k: _eff(True) for k in ("threadSize", "pitch")}


def snapshot(version: str = "0.15.0", *, head_fixed: bool = False) -> OntologySnapshot:
    head = (lambda v: {"headType": _eff(False, fixed=v)}) if head_fixed else (lambda v: {})
    classes = {
        "MechanicalPart": _cls("기계 부품", None, ["MechanicalPart"], leaf=False, family=None, props={}),
        "Fastener": _cls("체결 부품", "MechanicalPart", ["MechanicalPart", "Fastener"], leaf=False, family=None, props={}),
        "Bolt": _cls("볼트", "Fastener", ["MechanicalPart", "Fastener", "Bolt"], leaf=False, family="Bolt", props=_BOLT_PROPS, keys=BOLT_KEYS),
        "HexBolt": _cls("육각볼트", "Bolt", ["MechanicalPart", "Fastener", "Bolt", "HexBolt"], leaf=True, family="Bolt", props={**_BOLT_PROPS, **head("Hex")}, keys=BOLT_KEYS),
        "HexFlangeBolt": _cls("육각플랜지볼트", "Bolt", ["MechanicalPart", "Fastener", "Bolt", "HexFlangeBolt"], leaf=True, family="Bolt",
                              props={**_BOLT_PROPS, "flangeDiameter": _eff(True)}, keys=BOLT_KEYS),
        "SocketHeadBolt": _cls("육각구멍붙이볼트", "Bolt", ["MechanicalPart", "Fastener", "Bolt", "SocketHeadBolt"], leaf=True, family="Bolt",
                               props={**_BOLT_PROPS, "socketSize": _eff(True, min=1.5), "strengthGrade": _eff(True), **head("Socket")}, keys=BOLT_KEYS),
        "WingBolt": _cls("나비볼트", "Bolt", ["MechanicalPart", "Fastener", "Bolt", "WingBolt"], leaf=True, family="Bolt", props=_BOLT_PROPS, keys=BOLT_KEYS),   # 머리 모양 없음
        "Nut": _cls("너트", "Fastener", ["MechanicalPart", "Fastener", "Nut"], leaf=False, family="Nut", props=_NUT_PROPS, keys=NUT_KEYS),
        "HexNut": _cls("육각너트", "Nut", ["MechanicalPart", "Fastener", "Nut", "HexNut"], leaf=True, family="Nut", props=_NUT_PROPS, keys=NUT_KEYS),
    }
    props = {
        "threadSize": {"label": {"ko": "나사 규격", "en": "Thread size"}, "datatype": "string", "canonical_unit": None, "scheme": None},
        "length": {"label": {"ko": "길이", "en": "Length"}, "datatype": "decimal", "canonical_unit": "mm", "scheme": None},
        # 실제 스냅샷처럼 피치는 나사 규격별 값 표(lookup)를 갖고, 나사 방향은 원문에 없으면 오른나사로 채운다(omitted_default)
        "pitch": {"label": {"ko": "피치", "en": "Pitch"}, "datatype": "decimal", "canonical_unit": "mm", "scheme": None,
                  "lookup": {"key": "threadSize", "scheme": "thread_series", "default": "Coarse",
                             "table": {"M3": {"Coarse": [0.5], "Fine": [0.35]}, "M4": {"Coarse": [0.7], "Fine": [0.5]}, "M8": {"Coarse": [1.25], "Fine": [1.0, 0.75]}}}},
        "threadDirection": {"label": {"ko": "나사 방향", "en": "Thread direction"}, "datatype": "concept", "canonical_unit": None, "scheme": "thread_direction",
                            "omitted_default": "RightHand"},
        "strengthGrade": {"label": {"ko": "강도 등급", "en": "Strength grade"}, "datatype": "string", "canonical_unit": None, "scheme": None},
        "material": {"label": {"ko": "재질", "en": "Material"}, "datatype": "concept", "canonical_unit": None, "scheme": "material"},
        "surfaceTreatment": {"label": {"ko": "표면처리", "en": "Surface treatment"}, "datatype": "concept", "canonical_unit": None, "scheme": "surface_treatment"},
        "socketSize": {"label": {"ko": "육각구멍 크기", "en": "Hex socket size"}, "datatype": "decimal", "canonical_unit": "mm", "scheme": None},
        "flangeDiameter": {"label": {"ko": "플랜지 지름", "en": "Flange diameter"}, "datatype": "decimal", "canonical_unit": "mm", "scheme": None},
    }
    concepts = {
        "SUS304": {"scheme": "material", "pref_label": "SUS304"},
        "SCM435": {"scheme": "material", "pref_label": "SCM435"},
        "ZincPlated": {"scheme": "surface_treatment", "pref_label": "아연도금"},
        "Plain": {"scheme": "surface_treatment", "pref_label": "무처리"},
        "RightHand": {"scheme": "thread_direction", "pref_label": "오른나사"},
        "Coarse": {"scheme": "thread_series", "pref_label": "보통 나사"},
    }
    return OntologySnapshot(version=version, data={"version": version, "classes": classes, "properties": props, "concepts": concepts})


def _part(no: int, cls: str, **values: Any) -> RawPart:
    return RawPart(part_no=f"P-{no:011d}", class_code=cls, values=values)


PARTS: list[RawPart] = [
    _part(1, "HexBolt", threadSize="M8", length=30.0, material="SUS304", surfaceTreatment="ZincPlated", pitch=1.25),
    _part(2, "HexBolt", threadSize="M10", length=40.0, material="SCM435", surfaceTreatment="Plain", pitch=1.5),
    _part(3, "HexFlangeBolt", threadSize="M8", length=30.0, material="SUS304", surfaceTreatment="ZincPlated", pitch=1.25, flangeDiameter=17.0),
    _part(46, "SocketHeadBolt", threadSize="M3", length=8.0, material="SCM435", surfaceTreatment="ZincPlated", pitch=0.5, socketSize=2.5),
    _part(47, "SocketHeadBolt", threadSize="M4", length=10.0, material="SCM435", surfaceTreatment="ZincPlated", pitch=0.7, socketSize=3.0),
    _part(48, "SocketHeadBolt", threadSize="M4", length=15.0, material="SUS304", surfaceTreatment="Plain", pitch=0.7, socketSize=3.0),
    _part(49, "SocketHeadBolt", threadSize="M4", length=15.0, material="SCM435", surfaceTreatment="ZincPlated", socketSize=3.0),   # 피치 없음(불완전)
    _part(60, "HexNut", threadSize="M8", pitch=1.25),
    _part(61, "WingBolt", threadSize="M8", length=30.0, material="SUS304", surfaceTreatment="Plain", pitch=1.25),
]


class FakeOpms:
    """OpmsReader 를 흉내 내는 읽기 전용 가짜. 읽기 호출 기록(calls)과 장애 흉내(down)를 둔다."""

    def __init__(self, parts: list[RawPart] | None = None, *, head_fixed: bool = False, down: OpmsUnavailable | None = None) -> None:
        self._parts = PARTS if parts is None else parts
        self._snap = snapshot(head_fixed=head_fixed)
        self.down = down
        self.calls: list[tuple[str, Any]] = []
        self.closed = False

    def _check(self) -> None:
        if self.down is not None:
            raise self.down

    def ontology(self) -> OntologySnapshot:
        self._check()
        self.calls.append(("ontology", None))
        return self._snap

    def parts(self, class_codes: Collection[str] | None = None, equals: Mapping[str, Any] | None = None) -> list[RawPart]:
        self._check()
        self.calls.append(("parts", (sorted(class_codes) if class_codes is not None else None, dict(equals or {}))))
        out = [p for p in self._parts if class_codes is None or p.class_code in class_codes]
        return [p for p in out if all(p.values.get(k) == v for k, v in (equals or {}).items())]

    def part(self, part_no: str) -> RawPart | None:
        self._check()
        return next((p for p in self._parts if p.part_no == part_no), None)

    def counts(self) -> dict[str, int]:
        self._check()
        return {"parts": len(self._parts), "classes": len(self._snap.data["classes"])}

    def close(self) -> None:
        self.closed = True
