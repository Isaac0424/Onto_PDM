"""적용 범위(유효일 · 사업장 · 로트 · 일련번호) 겹침 · 포함 판정. 순수 함수만 있다.

근거: docs/change-impact-design.md 4.3 · 7, docs/change-impact-ontology.md 7.2.

- `classify(scope, obj)`: 외부 객체가 범위에 **들어가는가** → `inside · outside · partial · unknown`.
  비교에 필요한 값이 비어 있으면 `unknown` 이다. **`inside` 로 가정하지 않는다**(안전한 쪽).
- `classify_any(scopes, obj)`: 범위가 여럿일 때. `applies='new'` 에 들어가면 새 개정 적용 대상이고, `applies='old'` 에만 들어가면
  기존 개정을 계속 쓰는 쪽이라 변경 영향이 없다(`outside`). 범위가 하나도 없으면 "전체"가 아니라 **미정**이다(`unknown`, SCOPE_REQUIRED).
- `overlaps(a, b)`: 두 범위가 겹치는가(같은 `applies` 끼리 겹치면 SCOPE_OVERLAP 후보).
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date

from onto_pdm.changes.models import ApplicabilityScope, PurchaseOrderLine, ScopeClass, StockLot, WorkOrder


@dataclass(frozen=True)
class ScopeSubject:
    """범위와 견줄 외부 객체의 값. 비어 있는 칸은 None 이다."""

    site: str | None = None
    lot_no: str | None = None
    serial_from: int | None = None
    serial_to: int | None = None
    on_date: date | None = None


def subject_of(obj: WorkOrder | PurchaseOrderLine | StockLot | ScopeSubject) -> ScopeSubject:
    """작업지시 · 발주 항목 · 재고 로트에서 범위 비교에 쓰는 값을 꺼낸다."""
    if isinstance(obj, ScopeSubject):
        return obj
    if isinstance(obj, WorkOrder):
        return ScopeSubject(site=obj.site, lot_no=obj.lot_no, serial_from=obj.serial_from, serial_to=obj.serial_to,
                            on_date=obj.start_date or obj.due_date)
    if isinstance(obj, PurchaseOrderLine):
        return ScopeSubject(site=obj.site, on_date=obj.due_date)
    return ScopeSubject(site=obj.site, lot_no=obj.lot_no)       # StockLot: 날짜 · 일련번호가 없다


# ---------------------------------------------------------------- 칸별 판정


def _site(scope: ApplicabilityScope, s: ScopeSubject) -> ScopeClass:
    if scope.site is None:
        return "inside"
    if s.site is None:
        return "unknown"
    return "inside" if s.site == scope.site else "outside"


def _lot(scope: ApplicabilityScope, s: ScopeSubject) -> ScopeClass:
    if scope.lot_nos is None:
        return "inside"
    if s.lot_no is None:
        return "unknown"        # 로트 번호 체계 미정(design 10.3-4): 값이 없으면 안다고 하지 않는다
    return "inside" if s.lot_no in scope.lot_nos else "outside"


def _serial(scope: ApplicabilityScope, s: ScopeSubject) -> ScopeClass:
    if scope.serial_from is None and scope.serial_to is None:
        return "inside"
    if s.serial_from is None or s.serial_to is None:
        return "unknown"
    lo = scope.serial_from if scope.serial_from is not None else -math.inf
    hi = scope.serial_to if scope.serial_to is not None else math.inf
    if s.serial_from >= lo and s.serial_to <= hi:
        return "inside"
    if s.serial_to < lo or s.serial_from > hi:
        return "outside"
    return "partial"            # 구간이 범위 경계를 걸친다(예: 작업지시 #100~#150, 범위 #120~)


def _date(scope: ApplicabilityScope, s: ScopeSubject) -> ScopeClass:
    if scope.effective_from is None and scope.effective_to is None:
        return "inside"
    if s.on_date is None:
        return "unknown"
    if scope.effective_from is not None and s.on_date < scope.effective_from:
        return "outside"
    if scope.effective_to is not None and s.on_date > scope.effective_to:
        return "outside"
    return "inside"


def _combine(parts: Iterable[ScopeClass]) -> ScopeClass:
    classes = list(parts)
    if "outside" in classes:
        return "outside"        # 하나라도 명확히 밖이면 밖이다
    if "partial" in classes:
        return "partial"
    if "unknown" in classes:
        return "unknown"
    return "inside"


# ---------------------------------------------------------------- 공개 함수


def classify(scope: ApplicabilityScope, obj: WorkOrder | PurchaseOrderLine | StockLot | ScopeSubject) -> ScopeClass:
    """외부 객체 하나가 범위 하나에 들어가는가. 모든 조건이 객체 값으로 확정되어 안이면 `inside`."""
    s = subject_of(obj)
    return _combine((_site(scope, s), _lot(scope, s), _serial(scope, s), _date(scope, s)))


def classify_any(scopes: Iterable[ApplicabilityScope], obj: WorkOrder | PurchaseOrderLine | StockLot | ScopeSubject) -> ScopeClass:
    """범위 목록 전체로 본 판정. 우선순위: new 에 inside > new 에 partial > old 에 inside(= 기존 개정 유지, outside) > unknown > outside."""
    scope_list = list(scopes)
    if not scope_list:
        return "unknown"        # 범위가 없으면 '전체 · 즉시'가 아니라 미정이다
    news = [classify(s, obj) for s in scope_list if s.applies == "new"]
    olds = [classify(s, obj) for s in scope_list if s.applies == "old"]
    if "inside" in news:
        return "inside"
    if "partial" in news:
        return "partial"
    if "inside" in olds:
        return "outside"
    if "unknown" in news or not news:
        return "unknown"
    return "outside"


def _interval_overlap(a_lo: float | date | None, a_hi: float | date | None, b_lo: float | date | None, b_hi: float | date | None) -> bool:
    """닫힌 구간 두 개가 겹치는가(None 은 열린 끝)."""
    if a_hi is not None and b_lo is not None and a_hi < b_lo:      # type: ignore[operator]
        return False
    if b_hi is not None and a_lo is not None and b_hi < a_lo:      # type: ignore[operator]
        return False
    return True


def overlaps(a: ApplicabilityScope, b: ApplicabilityScope) -> bool:
    """두 범위가 겹치는가: 유효일 · 일련번호 구간이 겹치고, 사업장이 (한쪽이 전체이거나) 같고, 로트 목록이 (한쪽이 전체이거나) 교집합이 있다."""
    if not _interval_overlap(a.effective_from, a.effective_to, b.effective_from, b.effective_to):
        return False
    if not _interval_overlap(a.serial_from, a.serial_to, b.serial_from, b.serial_to):
        return False
    if a.site is not None and b.site is not None and a.site != b.site:
        return False
    return not (a.lot_nos is not None and b.lot_nos is not None and not set(a.lot_nos) & set(b.lot_nos))


def find_overlaps(scopes: Iterable[ApplicabilityScope]) -> list[tuple[int, int]]:
    """같은 `applies` 끼리 겹치는 범위 쌍의 위치(i, j). `new` 와 `old` 가 겹치는 것은 서로 모순이라 이것도 낸다(어느 개정을 쓰라는 건가)."""
    items = list(scopes)
    return [(i, j) for i in range(len(items)) for j in range(i + 1, len(items)) if overlaps(items[i], items[j])]


__all__ = ["ScopeSubject", "subject_of", "classify", "classify_any", "overlaps", "find_overlaps"]
