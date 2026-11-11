"""변경 영향 엔진 시험용 세계(BRK-M8). **시험 안에서만** 쓰는 메모리 구현이다(앱 목 데이터가 아니다 — 모든 외부 행은 `source_system='fixture'`).

부품 속성과 규칙 모양은 실제 OPMS(`PDM` 브랜치, 온톨로지 0.19.0, 2026-11-12 읽기 전용 확인)와 같다:
`P-…01` HexBolt M8×30(피치 1.25 · SUS304 · A2-70), `P-…22` HexNut M8(1.25 · 높이 6.8 · SUS316 · A4-80), `P-…23` HexNut M8 피치 1.0(높이 6.8),
`P-…25` FlatWasher M8(두께 1.6), `P-…15` HexFlangeBolt M8×40(SUS316 · A4-80). 규칙 `bolt_nut` `bolt_washer` `nut_washer` `flange_bolt_for_bolt_washer`.
E1 이 만드는 앱 픽스처(`changes/fixtures/`)와 이름이 겹치지 않게 `W` 접두어와 `Mem*` 이름을 쓴다(C2 에서 통합).
"""

from __future__ import annotations

from collections import deque
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from onto_pdm.changes.models import (
    ApplicabilityScope,
    ChangeOrder,
    ChangeTarget,
    ClampedPart,
    FasteningJoint,
    PurchaseOrderLine,
    RevisionSpec,
    StockLot,
    WorkOrder,
)
from onto_pdm.changes.ports import (
    BomDiffLine,
    BomLine,
    ExternalState,
    ReaderPartSource,
    UsageRow,
)
from onto_pdm.opms.errors import OpmsUnavailable
from onto_pdm.opms.reader import OntologySnapshot, RawPart

KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 11, 12, 9, 0, tzinfo=KST)
LATER = datetime(2026, 11, 12, 15, 0, tzinfo=KST)

BOLT, NUT, NUT_FINE, WASHER, FLANGE_BOLT = (f"P-000000000{n}" for n in ("01", "22", "23", "25", "15"))
NUT_NO_HEIGHT = "P-FIXTURE-NUT-NOH"
MODULE, SET, TOP, BOT = "BRK-M8", "BRK-M8-SET", "BRK-M8-TOP", "BRK-M8-BOT"

# ---------------------------------------------------------------- OPMS 스냅샷 · 부품


def _cls(path: list[str]) -> dict[str, Any]:
    return {"label": {"ko": path[-1], "en": path[-1]}, "parent": path[-2] if len(path) > 1 else None, "leaf": True, "path": path}


def ontology_snapshot(version: str = "0.19.0") -> OntologySnapshot:
    classes = {
        "Bolt": _cls(["MechanicalPart", "Fastener", "Bolt"]),
        "HexBolt": _cls(["MechanicalPart", "Fastener", "Bolt", "HexBolt"]),
        "HexFlangeBolt": _cls(["MechanicalPart", "Fastener", "Bolt", "HexFlangeBolt"]),
        "Nut": _cls(["MechanicalPart", "Fastener", "Nut"]),
        "HexNut": _cls(["MechanicalPart", "Fastener", "Nut", "HexNut"]),
        "Washer": _cls(["MechanicalPart", "Fastener", "Washer"]),
        "FlatWasher": _cls(["MechanicalPart", "Fastener", "Washer", "FlatWasher"]),
    }
    rules = {
        "bolt_nut": {"type": "mates_with", "applies_to": "Bolt", "severity": "warning", "message": "볼트와 너트는 나사 규격과 피치가 같아야 한다",
                     "spec": {"with": "Nut", "blocking": "threadSize", "match": ["pitch"]}},
        "bolt_washer": {"type": "mates_with", "applies_to": "Bolt", "severity": "warning", "message": "와셔 호칭은 볼트와 같아야 한다",
                        "spec": {"with": "Washer", "blocking": "threadSize", "match": []}},
        "nut_washer": {"type": "mates_with", "applies_to": "Nut", "severity": "warning", "message": "와셔 호칭은 너트와 같아야 한다",
                       "spec": {"with": "Washer", "blocking": "threadSize", "match": []}},
        "bolt_length_vs_hole_depth": {"type": "fit_check", "applies_to": "Bolt", "severity": "warning", "message": "볼트 길이 ≥ 홈 깊이 + 2",
                                      "spec": {"subject": {"prop": "length"}, "op": "ge", "against": {"class": None, "prop": None, "context": "holeDepth"},
                                               "margin": {"add": 2.0}, "warn_within": 1.0, "tol": None}},
        "flange_bolt_for_bolt_washer": {"type": "substitutes", "applies_to": "HexFlangeBolt", "severity": "warning", "message": "플랜지볼트는 육각볼트+와셔를 대신한다",
                                        "spec": {"replaces": "HexBolt", "same": ["threadSize", "pitch", "length"],
                                                 "confirm": ["material", "surfaceTreatment", "strengthGrade"],
                                                 "absorbs": [{"class": "FlatWasher", "cover": {"prop": "flangeDiameter", "at_least": "outerDiameter"}}]}},
    }
    relations = {"matesWith": {"symmetric": True, "pairs": [
        {"from_class": "Bolt", "to_class": "Nut", "match": ["threadSize", "pitch", "threadDirection"], "prefer": ["material", "surfaceTreatment"]},
        {"from_class": "Bolt", "to_class": "Washer", "match": ["threadSize"], "prefer": ["material", "surfaceTreatment"]},
    ]}}
    properties = {"pitch": {"label": {"ko": "피치"}}, "threadSize": {"label": {"ko": "나사 호칭"}}, "nutHeight": {"label": {"ko": "너트 높이"}},
                  "flangeDiameter": {"label": {"ko": "플랜지 지름"}}}
    return OntologySnapshot(version=version, data={"version": version, "classes": classes, "rules": rules, "relations": relations, "properties": properties})


def _bolt(no: str, cls: str, length: float, material: str, surface: str, grade: str, **extra: Any) -> RawPart:
    return RawPart(no, cls, {"threadSize": "M8", "pitch": 1.25, "length": length, "material": material, "surfaceTreatment": surface,
                             "strengthGrade": grade, "threadDirection": "RightHand", **extra})


PARTS: dict[str, RawPart] = {p.part_no: p for p in (
    _bolt(BOLT, "HexBolt", 30.0, "SUS304", "ZincPlated", "A2-70"),
    _bolt(FLANGE_BOLT, "HexFlangeBolt", 40.0, "SUS316", "Plain", "A4-80", flangeDiameter=17.0),
    RawPart(NUT, "HexNut", {"threadSize": "M8", "pitch": 1.25, "nutHeight": 6.8, "material": "SUS316", "surfaceTreatment": "Plain",
                            "strengthGrade": "A4-80", "threadDirection": "RightHand"}),
    RawPart(NUT_FINE, "HexNut", {"threadSize": "M8", "pitch": 1.0, "nutHeight": 6.8, "material": "SUS304", "surfaceTreatment": "ZincPlated",
                                 "strengthGrade": "A2-70", "threadDirection": "RightHand"}),
    RawPart(NUT_NO_HEIGHT, "HexNut", {"threadSize": "M8", "pitch": 1.25, "material": "SUS304", "surfaceTreatment": "ZincPlated",
                                      "strengthGrade": "A2-70", "threadDirection": "RightHand"}),      # 너트 높이가 비어 있는 부품(시험 전용)
    RawPart(WASHER, "FlatWasher", {"threadSize": "M8", "innerDiameter": 8.4, "outerDiameter": 16.0, "thickness": 1.6,
                                   "material": "SUS304", "surfaceTreatment": "ZincPlated"}),
)}


class StubReader:
    """`OpmsReader` 의 메모리 구현(읽기 전용)."""

    def __init__(self, version: str = "0.19.0", parts: Mapping[str, RawPart] | None = None) -> None:
        self._snap = ontology_snapshot(version)
        self._parts = dict(PARTS if parts is None else parts)

    def ontology(self) -> OntologySnapshot:
        return self._snap

    def parts(self, class_codes: Collection[str] | None = None, equals: Mapping[str, Any] | None = None) -> list[RawPart]:
        return list(self._parts.values())

    def part(self, part_no: str) -> RawPart | None:
        return self._parts.get(part_no)

    def counts(self) -> dict[str, int]:
        return {"parts": len(self._parts), "classes": 7}

    def close(self) -> None:
        return None


class DownReader(StubReader):
    """OPMS 에 닿지 못하는 상태."""

    def _down(self) -> OpmsUnavailable:
        return OpmsUnavailable("OPMS_UNAVAILABLE", "OPMS 의 Neo4j 에 연결하지 못했습니다 (시험)")

    def ontology(self) -> OntologySnapshot:
        raise self._down()

    def part(self, part_no: str) -> RawPart | None:
        raise self._down()


def part_source(reader: StubReader | None = None) -> ReaderPartSource:
    return ReaderPartSource(reader or StubReader())


# ---------------------------------------------------------------- BOM · 사양 · 외부 사본


class MemBom:
    """조립품 개정 → 자식 줄. 모든 개정은 R00 이고 자식의 개정은 현재 승인본이다."""

    def __init__(self, boms: Mapping[tuple[str, str], Sequence[BomLine]], products: Mapping[str, str], current: Mapping[str, str] | None = None) -> None:
        self._boms = {k: list(v) for k, v in boms.items()}
        self._products = dict(products)
        self._current = dict(current or {})

    def _rev(self, item_no: str, revision: str | None) -> str:
        return revision or self._current.get(item_no, "R00")

    def bom_lines(self, item_no: str, revision: str | None = None) -> list[BomLine]:
        return list(self._boms.get((item_no, self._rev(item_no, revision)), []))

    def where_used(self, item_no: str) -> list[UsageRow]:
        rows: list[UsageRow] = []
        queue: deque[tuple[str, tuple[str, ...], float, int]] = deque([(item_no, (item_no,), 1.0, 0)])
        seen: set[tuple[str, str]] = set()
        while queue:
            child, path, qty, depth = queue.popleft()
            for (parent, rev), lines in sorted(self._boms.items()):
                for line in lines:
                    if line.item_no != child or (parent, rev) in seen:
                        continue
                    seen.add((parent, rev))
                    total = qty * line.quantity
                    new_path = (*path, parent)
                    rows.append(UsageRow(item_no=parent, revision=rev, depth=depth + 1, path=new_path, quantity=total, product_code=self._products.get(parent)))
                    queue.append((parent, new_path, total, depth + 1))
        return rows

    def compare_revisions(self, item_no: str, rev_a: str, rev_b: str) -> list[BomDiffLine]:
        from onto_pdm.changes.impact import compare_lines
        return compare_lines(self.bom_lines(item_no, rev_a), self.bom_lines(item_no, rev_b))


class MemSpecs:
    def __init__(self, joints: Sequence[FasteningJoint] = (), specs: Sequence[RevisionSpec] = ()) -> None:
        self._joints = list(joints)
        self._specs = {(s.item_no, s.key): s for s in specs}

    def joints_for(self, assembly_item_no: str, assembly_revision: str | None = None) -> list[FasteningJoint]:
        return [j for j in self._joints if j.assembly_item_no == assembly_item_no and assembly_revision in (None, j.assembly_revision)]

    def spec_value(self, item_no: str, key: str, revision: str | None = None) -> RevisionSpec | None:
        return self._specs.get((item_no, key))


class MemExternal:
    def __init__(self, wos: Sequence[WorkOrder] = (), pos: Sequence[PurchaseOrderLine] = (), lots: Sequence[StockLot] = ()) -> None:
        self.wos, self.pos, self.lots = list(wos), list(pos), list(lots)

    def work_orders(self, item_nos: Collection[str]) -> list[WorkOrder]:
        wanted = set(item_nos)
        return [w for w in self.wos if w.product_item_no in wanted or any(r.item_no in wanted for r in w.bom_refs)]

    def purchase_order_lines(self, item_no: str) -> list[PurchaseOrderLine]:
        return [p for p in self.pos if p.item_no == item_no]

    def stock_lots(self, item_no: str) -> list[StockLot]:
        return [s for s in self.lots if s.item_no == item_no]

    def external_state(self) -> ExternalState:
        as_of: dict[str, datetime] = {}
        counts: dict[str, int] = {}
        for kind, rows in (("work_order", self.wos), ("purchase_order_line", self.pos), ("stock_lot", self.lots)):
            if rows:
                as_of[kind] = max(r.as_of for r in rows)
                counts[kind] = len(rows)
        return ExternalState(as_of=as_of, counts=counts)


# ---------------------------------------------------------------- BRK-M8 세계


def joint(*, assembly: str = MODULE, washers_per_bolt: int = 2) -> FasteningJoint:
    return FasteningJoint(
        assembly_item_no=assembly, assembly_revision="R00", name="J1", bolt_item_no=BOLT, nut_item_no=NUT, washer_item_no=WASHER,
        washers_per_bolt=washers_per_bolt, bolt_count=4, clamped=(ClampedPart(item_no=TOP), ClampedPart(item_no=BOT)),
    )


def plate_spec(item_no: str, value: float = 8.0, source: str = "manual") -> RevisionSpec:
    return RevisionSpec(item_no=item_no, revision="R00", key="thickness", value=value, source=source)       # type: ignore[arg-type]


def fixture_wo(wo_no: str, status: str, **over: Any) -> WorkOrder:
    base: dict[str, Any] = dict(source_system="fixture", as_of=NOW, wo_no=wo_no, product_item_no=MODULE, bom_revision="R00", status=status, qty_planned=10)
    return WorkOrder(**{**base, **over})


@dataclass
class World:
    bom: MemBom
    specs: MemSpecs
    external: MemExternal
    reader: StubReader = field(default_factory=StubReader)

    @property
    def parts(self) -> ReaderPartSource:
        return ReaderPartSource(self.reader)


def brk_m8(*, joint_at: str = MODULE, top_source: str = "manual", reverse_external: bool = False) -> World:
    """모듈 BRK-M8 R00 = 상판 · 하판(판 8 mm) + 체결 세트(볼트 ×4 · 너트 ×4 · 와셔 ×8). 체결 구성은 `joint_at` 조립품에 붙는다."""
    boms = {
        (MODULE, "R00"): [BomLine(TOP, 1), BomLine(BOT, 1), BomLine(SET, 1)],
        (SET, "R00"): [BomLine(BOLT, 4), BomLine(NUT, 4), BomLine(WASHER, 8)],
    }
    wos = [
        fixture_wo("WO-FX-0001", "completed", site="A", lot_no="L-001", serial_from=1, serial_to=50),
        fixture_wo("WO-FX-0002", "in_progress", site="A", lot_no="L-002", serial_from=51, serial_to=100),
        fixture_wo("WO-FX-0003", "planned", site="A", lot_no="L-003", serial_from=101, serial_to=150),
    ]
    pos = [PurchaseOrderLine(source_system="fixture", as_of=NOW, po_no="PO-FX-100", line_no=10, item_no=NUT, item_rev="R00",
                             qty_ordered=200, qty_received=80, supplier="HANBIT", site="A")]
    lots = [StockLot(source_system="fixture", as_of=NOW, lot_no="LT-N-01", item_no=NUT, item_rev="R00", site="A", qty_on_hand=300)]
    if reverse_external:
        wos, pos, lots = wos[::-1], pos[::-1], lots[::-1]
    return World(
        bom=MemBom(boms, {MODULE: "BRK-M8"}),
        specs=MemSpecs([joint(assembly=joint_at)], [plate_spec(TOP, source=top_source), plate_spec(BOT)]),
        external=MemExternal(wos, pos, lots),
    )


def order() -> ChangeOrder:
    return ChangeOrder(code="CO-2026-0001", request_code="CR-2026-0001", product_code="BRK-M8")


def all_scope() -> ApplicabilityScope:
    """사업장 · 로트 · 일련번호 · 날짜 제한이 없는 범위(새 개정을 전체에 적용)."""
    return ApplicabilityScope()


def t_replace_nut(new: str = NUT_FINE) -> ChangeTarget:
    return ChangeTarget(change_kind="replace", item_no=NUT, replacement_item_no=new, parent_revision="R00", from_revision="R00",
                        before_class="HexNut", after_class="HexNut")


def t_plate(thickness: float = 12.0, **after: Any) -> ChangeTarget:
    return ChangeTarget(change_kind="revise", item_no=TOP, from_revision="R00", to_revision="R01", before={"thickness": 8.0},
                        after={"thickness": thickness, **after})


def d(y: int, m: int, day: int) -> date:
    return date(y, m, day)
