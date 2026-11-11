"""적용 범위 겹침 · 포함 판정 (docs/change-impact-design.md 4.3 · 7)."""

from __future__ import annotations

from datetime import date

import pytest

from onto_pdm.changes import scope as S
from onto_pdm.changes.models import ApplicabilityScope, PurchaseOrderLine, StockLot, WorkOrder
from tests.unit.changes_helpers import NOW, fixture_wo


def sc(**kw: object) -> ApplicabilityScope:
    return ApplicabilityScope(**kw)      # type: ignore[arg-type]


def subj(**kw: object) -> S.ScopeSubject:
    return S.ScopeSubject(**kw)          # type: ignore[arg-type]


# ---------------------------------------------------------------- classify: 칸별

def test_unrestricted_scope_contains_anything_known() -> None:
    assert S.classify(sc(), subj()) == "inside"      # 제한이 없으면 값이 비어 있어도 안이다
    assert S.classify(sc(), subj(site="A", lot_no="L-1")) == "inside"


def test_site() -> None:
    assert S.classify(sc(site="A"), subj(site="A")) == "inside"
    assert S.classify(sc(site="A"), subj(site="B")) == "outside"
    assert S.classify(sc(site="A"), subj()) == "unknown"          # 사업장 값이 비어 있으면 안이라고 가정하지 않는다


def test_lot_list_and_unknown_lot_scheme() -> None:
    s = sc(lot_nos=("L-001", "L-002"))
    assert S.classify(s, subj(lot_no="L-002")) == "inside"
    assert S.classify(s, subj(lot_no="L-009")) == "outside"
    assert S.classify(s, subj()) == "unknown"                     # 로트 번호 체계 미정 · 값 없음 → unknown


def test_serial_range_boundaries() -> None:
    s = sc(serial_from=120)                                       # #120 이상(열린 끝)
    assert S.classify(s, subj(serial_from=120, serial_to=150)) == "inside"        # 경계 포함
    assert S.classify(s, subj(serial_from=1, serial_to=119)) == "outside"
    assert S.classify(s, subj(serial_from=100, serial_to=150)) == "partial"       # 구간이 경계를 걸친다
    assert S.classify(s, subj(serial_from=100)) == "unknown"                      # 한쪽 끝만 있으면 모른다
    closed = sc(serial_from=10, serial_to=20)
    assert S.classify(closed, subj(serial_from=10, serial_to=20)) == "inside"
    assert S.classify(closed, subj(serial_from=21, serial_to=30)) == "outside"
    assert S.classify(closed, subj(serial_from=15, serial_to=25)) == "partial"
    assert S.classify(closed, subj(serial_from=0, serial_to=30)) == "partial"     # 범위를 통째로 품는 구간도 걸침


def test_date_window() -> None:
    s = sc(effective_from=date(2026, 12, 1), effective_to=date(2026, 12, 31))
    assert S.classify(s, subj(on_date=date(2026, 12, 1))) == "inside"
    assert S.classify(s, subj(on_date=date(2026, 12, 31))) == "inside"
    assert S.classify(s, subj(on_date=date(2026, 11, 30))) == "outside"
    assert S.classify(s, subj(on_date=date(2027, 1, 1))) == "outside"
    assert S.classify(s, subj()) == "unknown"


def test_combination_outside_beats_partial_beats_unknown() -> None:
    s = sc(site="A", serial_from=120)
    assert S.classify(s, subj(site="B", serial_from=100, serial_to=150)) == "outside"
    assert S.classify(s, subj(site="A", serial_from=100, serial_to=150)) == "partial"
    assert S.classify(s, subj(site="A", serial_from=100, serial_to=150, lot_no=None)) == "partial"
    assert S.classify(sc(site="A", lot_nos=("L-1",)), subj(site="A")) == "unknown"
    assert S.classify(sc(site="A", lot_nos=("L-1",)), subj(site="A", lot_no="L-1")) == "inside"


# ---------------------------------------------------------------- 외부 객체에서 값 꺼내기

def test_subject_of_external_objects() -> None:
    wo = fixture_wo("WO-1", "planned", site="A", lot_no="L-1", serial_from=5, serial_to=9, start_date=date(2026, 12, 2), due_date=date(2026, 12, 9))
    s = S.subject_of(wo)
    assert (s.site, s.lot_no, s.serial_from, s.serial_to, s.on_date) == ("A", "L-1", 5, 9, date(2026, 12, 2))
    assert S.subject_of(fixture_wo("WO-2", "planned", due_date=date(2026, 12, 9))).on_date == date(2026, 12, 9)   # 시작일이 없으면 납기
    po = PurchaseOrderLine(source_system="fixture", as_of=NOW, po_no="P", line_no=1, item_no="X", qty_ordered=1, due_date=date(2026, 12, 5), site="B")
    assert S.subject_of(po) == S.ScopeSubject(site="B", on_date=date(2026, 12, 5))
    lot = StockLot(source_system="fixture", as_of=NOW, lot_no="LT", item_no="X", qty_on_hand=3, site="B")
    assert S.subject_of(lot) == S.ScopeSubject(site="B", lot_no="LT")
    assert isinstance(wo, WorkOrder)


def test_classify_accepts_external_objects_directly() -> None:
    wo = fixture_wo("WO-3", "planned", site="A", serial_from=130, serial_to=140)
    assert S.classify(sc(site="A", serial_from=120), wo) == "inside"
    assert S.classify(sc(site="B"), wo) == "outside"


# ---------------------------------------------------------------- classify_any

def test_classify_any_without_scope_is_unknown_not_everything() -> None:
    assert S.classify_any([], subj(site="A")) == "unknown"        # SCOPE_REQUIRED: 범위가 없으면 '전체'가 아니라 미정


def test_classify_any_priorities() -> None:
    new_a = sc(site="A")
    old_b = sc(site="B", applies="old")
    assert S.classify_any([new_a], subj(site="A")) == "inside"
    assert S.classify_any([new_a], subj(site="B")) == "outside"
    # new 에 partial → partial
    assert S.classify_any([sc(serial_from=120)], subj(serial_from=100, serial_to=150)) == "partial"
    # old 에 들어가면 기존 개정을 계속 쓰는 쪽 → 변경 영향 없음
    assert S.classify_any([new_a, old_b], subj(site="B")) == "outside"
    # new 에 inside 가 우선
    assert S.classify_any([sc(site="A"), sc(site="A", applies="old")], subj(site="A")) == "inside"
    # old 범위만 있으면 새 개정이 어디에 적용되는지 모른다
    assert S.classify_any([old_b], subj(site="A")) == "unknown"
    # new 가 unknown
    assert S.classify_any([sc(lot_nos=("L-1",))], subj()) == "unknown"


# ---------------------------------------------------------------- overlaps

def test_overlaps_dimensions() -> None:
    assert S.overlaps(sc(), sc())
    assert S.overlaps(sc(serial_from=10, serial_to=20), sc(serial_from=20, serial_to=30))          # 한 점에서 닿아도 겹친다
    assert not S.overlaps(sc(serial_from=10, serial_to=19), sc(serial_from=20, serial_to=30))
    assert S.overlaps(sc(serial_from=120), sc(serial_from=1, serial_to=500))
    assert not S.overlaps(sc(serial_to=9), sc(serial_from=10))
    assert not S.overlaps(sc(site="A"), sc(site="B"))
    assert S.overlaps(sc(site="A"), sc())                                                          # 한쪽이 전체면 겹친다
    assert not S.overlaps(sc(lot_nos=("L-1",)), sc(lot_nos=("L-2", "L-3")))
    assert S.overlaps(sc(lot_nos=("L-1", "L-2")), sc(lot_nos=("L-2",)))
    assert not S.overlaps(sc(effective_to=date(2026, 11, 30)), sc(effective_from=date(2026, 12, 1)))
    assert S.overlaps(sc(effective_to=date(2026, 12, 1)), sc(effective_from=date(2026, 12, 1)))


def test_overlap_needs_every_dimension() -> None:
    a = sc(site="A", serial_from=1, serial_to=10)
    assert not S.overlaps(a, sc(site="B", serial_from=1, serial_to=10))
    assert not S.overlaps(a, sc(site="A", serial_from=11, serial_to=20))
    assert S.overlaps(a, sc(site="A", serial_from=10, serial_to=20))


def test_overlaps_is_symmetric() -> None:
    pairs = [(sc(serial_from=5), sc(serial_to=4)), (sc(site="A"), sc(site="A", lot_nos=("L",))), (sc(effective_from=date(2026, 1, 1)), sc(effective_to=date(2025, 1, 1)))]
    for a, b in pairs:
        assert S.overlaps(a, b) == S.overlaps(b, a)


def test_find_overlaps_lists_pairs() -> None:
    scopes = [sc(serial_from=1, serial_to=10), sc(serial_from=11, serial_to=20), sc(serial_from=15, serial_to=30)]
    assert S.find_overlaps(scopes) == [(1, 2)]
    assert S.find_overlaps([]) == []


@pytest.mark.parametrize("bad", [dict(serial_from=5, serial_to=1), dict(effective_from=date(2026, 2, 1), effective_to=date(2026, 1, 1)), dict(lot_nos=())])
def test_invalid_scopes_are_rejected_by_model(bad: dict[str, object]) -> None:
    """범위 값 검증은 모델이 한다(엔진은 올바른 범위만 받는다)."""
    with pytest.raises(ValueError):
        sc(**bad)
