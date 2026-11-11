"""영향 탐색 엔진이 기대는 읽기 전용 입구(Protocol). 구현은 저장소 · OPMS 어댑터가 맞춘다(C2).

엔진(`impact.py`)은 이 Protocol 만 알고 PG · 메모리 저장소 · OPMS Neo4j 를 모른다. 모든 메서드는 부수 효과가 없다.
근거: docs/change-impact-design.md 2.1 · 4 · 5장.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from pydantic import AwareDatetime

from onto_pdm.changes.models import FasteningJoint, PurchaseOrderLine, RevisionSpec, StockLot, WorkOrder
from onto_pdm.opms import mates
from onto_pdm.opms.mates import MatesRule, SubstituteRule
from onto_pdm.opms.reader import OntologySnapshot, OpmsReader

# ---------------------------------------------------------------- BOM


@dataclass(frozen=True)
class UsageRow:
    """대상 품목이 쓰이는 상위 품목 하나(역전개 결과). 상위 개정마다 한 줄이다(부분 적용 중이면 두 개정이 같이 나온다)."""

    item_no: str                       # 상위 품목(조립품 · 제품 루트)
    revision: str | None               # 대상이 들어 있는 그 상위 개정
    depth: int = 1                     # 1 = 직접 부모
    path: tuple[str, ...] = ()         # 대상 → … → 상위 품목 품번 경로
    quantity: float = 1.0              # 누적 수량
    product_code: str | None = None    # 제품 루트(`ProductModel.root_item`)이면 제품 코드
    name: str = ""


@dataclass(frozen=True)
class BomLine:
    item_no: str                       # 자식 품목
    quantity: float
    find_no: int | None = None


@dataclass(frozen=True)
class BomDiffLine:
    item_no: str
    change: Literal["added", "removed", "quantity_changed"]
    qty_a: float | None = None
    qty_b: float | None = None


class BomSource(Protocol):
    def where_used(self, item_no: str) -> Sequence[UsageRow]:
        """대상이 쓰이는 상위 품목 · 개정(역전개). 어디에도 안 쓰이면 빈 목록이다."""
        ...

    def bom_lines(self, item_no: str, revision: str | None = None) -> Sequence[BomLine]:
        """조립품 한 개정의 직접 자식 줄(변경 후 BOM 가상 전개의 바탕). `revision=None` 이면 현재 승인본. 조립품이 아니면 빈 목록."""
        ...

    def compare_revisions(self, item_no: str, rev_a: str, rev_b: str) -> Sequence[BomDiffLine]:
        """같은 조립품의 두 개정의 BOM 차이(R00 vs R01)."""
        ...


# ---------------------------------------------------------------- 외부(ERP · MES) 읽기 사본


@dataclass(frozen=True)
class ExternalState:
    """외부 3종의 기준 시각(종류별 `as_of` 최댓값)과 행 수. 영향 분석이 낡았는지(stale) 볼 때 쓴다."""

    as_of: Mapping[str, AwareDatetime] = field(default_factory=dict)      # work_order · purchase_order_line · stock_lot
    counts: Mapping[str, int] = field(default_factory=dict)


class ExternalSource(Protocol):
    def work_orders(self, item_nos: Collection[str]) -> Sequence[WorkOrder]:
        """제품 품번이 `item_nos` 에 있거나 BOM 참조에 `item_nos` 의 품목이 있는 작업지시."""
        ...

    def purchase_order_lines(self, item_no: str) -> Sequence[PurchaseOrderLine]: ...

    def stock_lots(self, item_no: str) -> Sequence[StockLot]: ...

    def external_state(self) -> ExternalState: ...


# ---------------------------------------------------------------- PDM 소유 수치(판 두께) · 체결 구성


class SpecSource(Protocol):
    def joints_for(self, assembly_item_no: str, assembly_revision: str | None = None) -> Sequence[FasteningJoint]:
        """조립품 개정에 붙은 체결 구성. `assembly_revision=None` 이면 현재 승인본."""
        ...

    def spec_value(self, item_no: str, key: str, revision: str | None = None) -> RevisionSpec | None:
        """개정별 PDM 소유 수치(예: 판 `thickness`). `revision=None` 이면 현재 승인본의 값."""
        ...


# ---------------------------------------------------------------- OPMS 값 · 규칙


@dataclass(frozen=True)
class PartAttrs:
    """OPMS `:Part` 한 개: 품번 · 분류 코드 · 속성 값(숫자 · 문자열 · 개념 코드)."""

    part_no: str
    class_code: str
    values: Mapping[str, Any] = field(default_factory=dict)


class PartAttrSource(Protocol):
    """OPMS 에서 읽는 것만. OPMS 를 못 읽으면 `OpmsUnavailable`(503)을 낸다."""

    def ontology_version(self) -> str: ...

    def part_attrs(self, part_no: str) -> PartAttrs | None: ...

    def mates_rules(self) -> Sequence[MatesRule]: ...

    def substitute_rules(self) -> Sequence[SubstituteRule]: ...

    def class_is_a(self, class_code: str, ancestor: str) -> bool: ...

    def prop_label(self, key: str) -> str: ...


class ReaderPartSource:
    """`OpmsReader`(Neo4j 직접 읽기)를 `PartAttrSource` 로 맞춘다. 스냅샷은 한 번만 읽는다(한 번의 분석 동안 같은 온톨로지 버전을 쓴다)."""

    def __init__(self, reader: OpmsReader) -> None:
        self._reader = reader
        self._snapshot: OntologySnapshot | None = None

    def _snap(self) -> OntologySnapshot:
        if self._snapshot is None:
            self._snapshot = self._reader.ontology()
        return self._snapshot

    def ontology_version(self) -> str:
        return mates.ontology_version(self._snap())

    def part_attrs(self, part_no: str) -> PartAttrs | None:
        raw = self._reader.part(part_no)
        return None if raw is None else PartAttrs(part_no=raw.part_no, class_code=raw.class_code, values=dict(raw.values))

    def mates_rules(self) -> Sequence[MatesRule]:
        return mates.mates_rules(self._snap())

    def substitute_rules(self) -> Sequence[SubstituteRule]:
        return mates.substitute_rules(self._snap())

    def class_is_a(self, class_code: str, ancestor: str) -> bool:
        return mates.class_is_a(self._snap(), class_code, ancestor)

    def prop_label(self, key: str) -> str:
        return mates.prop_label(self._snap(), key)


__all__ = [
    "UsageRow", "BomLine", "BomDiffLine", "BomSource", "ExternalState", "ExternalSource", "SpecSource",
    "PartAttrs", "PartAttrSource", "ReaderPartSource",
]
