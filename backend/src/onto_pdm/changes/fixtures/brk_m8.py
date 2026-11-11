"""`BRK-M8` "M8 체결 브래킷 모듈" 시험 · 시연 픽스처 3벌. 근거: docs/change-impact-design.md 9.1 · docs/change-impact-ontology.md 6장.

**앱 목(mock) 금지 원칙(사용자 지시 2026-11-11)**: 이 데이터는 `PDM_FIXTURE=brk-m8` 일 때만 `load_from_env` 가 올린다. 기본 상태에서는
아무것도 올리지 않는다. 모든 외부(ERP · MES) 행은 `source_system='fixture'` 이고, OPMS 에 없는 품목은 `OPMS: 미등록` 속성을 단다.

변형:
- `base` — R00 기준선. 모듈 1 = 상판 1 + 하판 1 + 체결 세트 1(볼트 ×4 · 너트 ×4 · 와셔 ×8), 체결부 1개, 개정별 판 두께 8 mm, 외부 사본.
- `sc1`  — base + 교체 후보 너트 `P-00000000023`(피치 1.0) + "너트 교체" 변경 요청 · 지시 · 대상(범위 전체).
- `sc2`  — base + 후보 플랜지볼트 `P-00000000015`(M8×40) + "상판 두께 8 → 12" 변경 요청 · 지시 · 대상(일련번호 71 이후, 사업장 S1 · S2).

OPMS 부품 값(`OPMS_PARTS`)은 **읽기 대역**이다. 값만 주고 OPMS DB 에는 접속하지 않는다. `P-…01 · …22 · …23 · …25` 는 2026-11-12 OPMS 개발 DB(온톨로지 0.19.0)를
읽기 전용으로 확인한 값이고, `P-…15` 는 OPMS `data/demo_seed/parts.yaml` 의 값이다(개발 DB 에서는 확인하지 않았다).

`PdmStore` Protocol 에는 쓰기 메서드가 없어서, 픽스처는 `InMemoryPdmStore.db`(시드와 같은 snake_case 사전)에 직접 행을 넣는다.
기본 시드(`seed.json`)에는 같은 품번(`P-00000000001` 등)이 다른 뜻으로 있으므로, 픽스처를 올릴 저장소는 `empty_seed()` 로 만든다.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from datetime import date, datetime
from typing import Any, Literal

from onto_pdm.changes.models import (
    ApplicabilityScope,
    ChangeOrder,
    ChangeRequest,
    ChangeTarget,
    ClampedPart,
    FasteningJoint,
    PurchaseOrderLine,
    RevisionSpec,
    StockLot,
    WorkOrder,
    WorkOrderBomRef,
)
from onto_pdm.changes.store import ChangeStore
from onto_pdm.store.memory import InMemoryPdmStore

Variant = Literal["base", "sc1", "sc2"]
VARIANTS: tuple[Variant, ...] = ("base", "sc1", "sc2")
ENV_NAME = "PDM_FIXTURE"
FIXTURE_NAME = "brk-m8"

PRODUCT_CODE = "BRK-M8"
ITEM_MODULE, ITEM_TOP, ITEM_BOTTOM, ITEM_SET = "BRK-M8", "BRK-M8-P01", "BRK-M8-P02", "BRK-M8-SET"
BOLT, NUT, WASHER = "P-00000000001", "P-00000000022", "P-00000000025"
NUT_FINE, FLANGE_BOLT = "P-00000000023", "P-00000000015"          # sc1 · sc2 후보

FIXTURE_AS_OF = datetime.fromisoformat("2026-11-12T09:00:00+09:00")
_RELEASED_AT = "2026-11-01T09:00:00+09:00"

# ---------------------------------------------------------------- OPMS 읽기 대역 (값만)

OPMS_PARTS: Mapping[str, Mapping[str, Any]] = {
    BOLT: {"class": "HexBolt", "name": "Hex Bolt M8x30",
           "attrs": {"threadSize": "M8", "length": 30.0, "pitch": 1.25, "strengthGrade": "A2-70",
                     "material": "SUS304", "surfaceTreatment": "ZincPlated"}},
    NUT: {"class": "HexNut", "name": "Hex Nut M8",
          "attrs": {"threadSize": "M8", "pitch": 1.25, "nutHeight": 6.8, "strengthGrade": "A4-80",
                    "material": "SUS316", "surfaceTreatment": "Plain"}},
    WASHER: {"class": "FlatWasher", "name": "Flat Washer M8",
             "attrs": {"threadSize": "M8", "innerDiameter": 8.4, "outerDiameter": 16.0, "thickness": 1.6,
                       "material": "SUS304", "surfaceTreatment": "ZincPlated"}},
    NUT_FINE: {"class": "HexNut", "name": "Hex Nut M8 fine thread",
               "attrs": {"threadSize": "M8", "pitch": 1.0, "nutHeight": 6.8, "strengthGrade": "A2-70",
                         "material": "SUS304", "surfaceTreatment": "ZincPlated"}},
    FLANGE_BOLT: {"class": "HexFlangeBolt", "name": "Hex Flange Bolt M8x40",
                  "attrs": {"threadSize": "M8", "length": 40.0, "pitch": 1.25, "strengthGrade": "A4-80",
                            "material": "SUS316", "surfaceTreatment": "Plain", "flangeDiameter": 17.0}},
}


def opms_part_values(part_no: str) -> dict[str, Any]:
    """OPMS 읽기 대역: 분류 코드와 속성 값. 없는 품번은 KeyError."""
    return copy.deepcopy(dict(OPMS_PARTS[part_no]))


# ---------------------------------------------------------------- 저장소 준비

def empty_seed() -> dict[str, Any]:
    """픽스처를 올릴 `InMemoryPdmStore(seed=...)` 용 빈 시드. 사용자 3명만 있다(관리자 · 설계 · 승인)."""
    return {
        "version": 1,
        "users": [
            {"id": 1, "login_id": "kim", "name": "김관리", "role": "admin"},
            {"id": 2, "login_id": "lee", "name": "이설계", "role": "engineer"},
            {"id": 3, "login_id": "choi", "name": "최승인", "role": "approver"},
        ],
        "products": [], "classes": [], "materials": [], "items": [], "revisions": [], "bom_lines": [],
        "identifiers": [], "inventory": [], "documents": [], "doc_links": [], "passages": [],
    }


class FixtureConflict(ValueError):
    """이미 같은 품번 · id · 코드가 있는 저장소에 픽스처를 올리려 했다. 덮어쓰지 않는다."""


# ---------------------------------------------------------------- PDM 품목 · 개정 · BOM

# (id, item_no, name, name_ko, item_type, OPMS 등록)
_ITEMS: tuple[tuple[int, str, str, str, str, bool], ...] = (
    (2000, ITEM_MODULE, "M8 fastened bracket module", "M8 체결 브래킷 모듈", "assembly", False),
    (2001, ITEM_TOP, "Top bracket", "상판 브래킷", "part", False),
    (2002, ITEM_BOTTOM, "Bottom bracket", "하판 브래킷", "part", False),
    (2003, ITEM_SET, "Fastening set", "체결 세트", "assembly", False),
    (2101, BOLT, "Hex Bolt M8x30", "육각볼트 M8x30", "standard", True),
    (2102, NUT, "Hex Nut M8", "육각너트 M8", "standard", True),
    (2103, WASHER, "Flat Washer M8", "평와셔 M8", "standard", True),
)
_CANDIDATES: Mapping[str, tuple[int, str, str, str, str, bool]] = {
    "sc1": (2104, NUT_FINE, "Hex Nut M8 fine thread", "육각너트 M8 가는나사", "standard", True),
    "sc2": (2105, FLANGE_BOLT, "Hex Flange Bolt M8x40", "육각플랜지볼트 M8x40", "standard", True),
}
# 승인 리비전 R00: id 는 품목 id + 1000
_BOM: tuple[tuple[int, str, str, int, int], ...] = (   # (줄 id, 부모 품목, 자식 품목, 수량, find_no)
    (4001, ITEM_MODULE, ITEM_TOP, 1, 1), (4002, ITEM_MODULE, ITEM_BOTTOM, 1, 2), (4003, ITEM_MODULE, ITEM_SET, 1, 3),
    (4004, ITEM_SET, BOLT, 4, 1), (4005, ITEM_SET, NUT, 4, 2), (4006, ITEM_SET, WASHER, 8, 3),
)


def _item_row(spec: tuple[int, str, str, str, str, bool]) -> dict[str, Any]:
    iid, no, name, name_ko, kind, registered = spec
    attrs: dict[str, Any] = {"OPMS": "등록" if registered else "미등록"}
    return {"id": iid, "item_no": no, "name": name, "name_ko": name_ko, "item_type": kind, "unit": "EA",
            "class_iri": None, "attributes": attrs, "created_by": 1}


def _revision_row(spec: tuple[int, str, str, str, str, bool]) -> dict[str, Any]:
    return {"id": spec[0] + 1000, "item_id": spec[0], "rev": "R00", "rev_seq": 0, "status": "released", "created_by": 1,
            "created_at": _RELEASED_AT, "released_at": _RELEASED_AT, "change_note": "최초 승인 (픽스처)"}


def _guard(db: Mapping[str, Any], ids: set[int], nos: set[str], rev_ids: set[int]) -> None:
    clash = sorted({x["item_no"] for x in db["items"]} & nos)
    clash += [f"품목 id {x['id']}" for x in db["items"] if x["id"] in ids]
    clash += [f"개정 id {x['id']}" for x in db["revisions"] if x["id"] in rev_ids]
    clash += [f"제품 {x['code']}" for x in db["products"] if x["code"] == PRODUCT_CODE]
    if clash:
        raise FixtureConflict(
            f"이미 있는 품번 · id 와 겹칩니다: {', '.join(clash)}. 픽스처는 InMemoryPdmStore(seed=empty_seed()) 에 올리세요")


def _load_pdm(pdm_store: InMemoryPdmStore, variant: Variant) -> None:
    specs = list(_ITEMS)
    if variant in _CANDIDATES:
        specs.append(_CANDIDATES[variant])
    with pdm_store._lock:  # noqa: SLF001 — PdmStore Protocol 에 쓰기가 없어 픽스처만 직접 넣는다
        db = pdm_store.db
        _guard(db, {s[0] for s in specs}, {s[1] for s in specs}, {s[0] + 1000 for s in specs})
        id_of = {s[1]: s[0] for s in specs}
        db["items"].extend(_item_row(s) for s in specs)
        db["revisions"].extend(_revision_row(s) for s in specs)
        db["bom_lines"].extend({"id": lid, "parent_revision_id": id_of[p] + 1000, "child_item_id": id_of[c], "quantity": q, "find_no": f}
                               for lid, p, c, q, f in _BOM)
        db["products"].append({"id": 2000, "code": PRODUCT_CODE, "name": "M8 체결 브래킷 모듈",
                               "description": "볼트 · 너트 · 와셔로 판 두 장을 체결한 시험용 제품 (픽스처)", "root_item_no": ITEM_MODULE})


# ---------------------------------------------------------------- 변경 저장소: 사양 · 체결부 · 외부 사본

def _specs() -> list[RevisionSpec]:
    return [RevisionSpec(item_no=no, revision="R00", key="thickness", value=8.0, unit="mm", source="drawing")
            for no in (ITEM_TOP, ITEM_BOTTOM)]


def _joint() -> FasteningJoint:
    return FasteningJoint(assembly_item_no=ITEM_MODULE, assembly_revision="R00", name="상·하판 체결", bolt_item_no=BOLT,
                          nut_item_no=NUT, washer_item_no=WASHER, washers_per_bolt=2, bolt_count=4,
                          clamped=(ClampedPart(item_no=ITEM_TOP), ClampedPart(item_no=ITEM_BOTTOM)))


def _work_orders() -> list[WorkOrder]:
    def wo(no: str, status: str, lot: str, start: int, end: int, site: str, done: int, plan: int, begin: str, due: str) -> WorkOrder:
        return WorkOrder(
            source_system="fixture", as_of=FIXTURE_AS_OF, wo_no=no, site=site, product_item_no=ITEM_MODULE, bom_revision="R00",
            status=status, qty_planned=plan, qty_done=done, lot_no=lot, serial_from=start, serial_to=end,   # type: ignore[arg-type]
            start_date=date.fromisoformat(begin), due_date=date.fromisoformat(due),
            bom_refs=(WorkOrderBomRef(item_no=NUT, revision="R00", qty_required=4 * plan, qty_issued=4 * done),
                      WorkOrderBomRef(item_no=BOLT, revision="R00", qty_required=4 * plan, qty_issued=4 * done)))

    return [
        wo("WO-FX-0001", "completed", "LOT-2610", 1, 50, "S1", 50, 50, "2026-10-05", "2026-10-20"),
        wo("WO-FX-0002", "in_progress", "LOT-2611", 51, 80, "S1", 12, 30, "2026-11-02", "2026-11-20"),
        wo("WO-FX-0003", "released", "LOT-2612", 81, 120, "S2", 0, 40, "2026-12-01", "2026-12-20"),   # 미착수(릴리스됨)
    ]


def _po_lines() -> list[PurchaseOrderLine]:
    common: dict[str, Any] = {"source_system": "fixture", "as_of": FIXTURE_AS_OF, "supplier": "SupplierB"}
    return [
        PurchaseOrderLine(po_no="PO-FX-100", line_no=10, item_no=NUT, item_rev="R00", qty_ordered=200, qty_received=80,
                          due_date=date(2026, 11, 30), site="S1", status="partial", **common),   # 미입고 120
        PurchaseOrderLine(po_no="PO-FX-100", line_no=20, item_no=BOLT, item_rev="R00", qty_ordered=500, qty_received=0,
                          due_date=date(2026, 12, 10), site="S2", status="open", **common),
    ]


def _stock_lots() -> list[StockLot]:
    common: dict[str, Any] = {"source_system": "fixture", "as_of": FIXTURE_AS_OF}
    return [
        StockLot(lot_no="LT-N-01", item_no=NUT, item_rev="R00", site="S1", location="자재창고", qty_on_hand=300, status="available", **common),
        StockLot(lot_no="LT-N-02", item_no=NUT, item_rev="R00", site="S1", location="격리구역", qty_on_hand=40, status="quarantine", **common),
    ]


# ---------------------------------------------------------------- 변경 요청 · 지시 · 대상

_REQUESTED_AT = datetime.fromisoformat("2026-11-12T10:00:00+09:00")


def _add_change(changes: ChangeStore, *, code_no: int, title: str, reason: str, before: str, after: str,
                target: ChangeTarget) -> tuple[ChangeRequest, ChangeOrder, ChangeTarget]:
    req = changes.create_request(ChangeRequest(
        code=f"CR-2026-{code_no:04d}", title=title, reason=reason, before_summary=before, after_summary=after,
        status="accepted", product_code=PRODUCT_CODE, requested_by="lee", requested_at=_REQUESTED_AT))
    order = changes.create_order(ChangeOrder(code=f"CO-2026-{code_no:04d}", request_code=req.code, product_code=PRODUCT_CODE))
    return req, order, changes.add_target(order.code, target)


def _load_sc1(changes: ChangeStore) -> None:
    _add_change(
        changes, code_no=1, title=f"너트 {NUT} → {NUT_FINE}", reason="재고 조달처 변경으로 가는나사 너트를 검토한다 (시험 데이터)",
        before="육각너트 M8 피치 1.25 (SUS316 · A4-80)", after="육각너트 M8 피치 1.0 (SUS304 · A2-70)",
        target=ChangeTarget(change_kind="replace", item_no=NUT, from_revision="R00", replacement_item_no=NUT_FINE,
                            parent_revision="R00", note="체결 세트 R00 의 BOM 줄", scopes=(ApplicabilityScope(applies="new", note="전체"),)))


def _load_sc2(changes: ChangeStore) -> None:
    scopes = tuple(ApplicabilityScope(applies="new", effective_from=date(2026, 12, 1), site=site, serial_from=71)
                   for site in ("S1", "S2"))
    _add_change(
        changes, code_no=2, title="상판 브래킷 두께 8 → 12 mm", reason="강성 보강을 위해 상판을 두껍게 한다 (시험 데이터)",
        before="상판 두께 8 mm", after="상판 두께 12 mm",
        target=ChangeTarget(change_kind="revise", item_no=ITEM_TOP, from_revision="R00", to_revision="R01",
                            before={"thickness": 8.0}, after={"thickness": 12.0}, note="같은 품번 안의 도면 치수 개정", scopes=scopes))


# ---------------------------------------------------------------- 공개 진입점

def load_brk_m8(pdm_store: InMemoryPdmStore, change_store: ChangeStore, variant: Variant = "base") -> Variant:
    """픽스처를 저장소에 올린다. 같은 저장소에 두 번 올리거나 기본 시드에 올리면 `FixtureConflict`."""
    if variant not in VARIANTS:
        raise ValueError(f"알 수 없는 변형 {variant!r}. 가능: {', '.join(VARIANTS)}")
    _load_pdm(pdm_store, variant)
    for spec in _specs():
        change_store.put_revision_spec(spec)
    change_store.put_joint(_joint())
    for wo in _work_orders():
        change_store.upsert_work_order(wo)
    for line in _po_lines():
        change_store.upsert_purchase_order_line(line)
    for lot in _stock_lots():
        change_store.upsert_stock_lot(lot)
    if variant == "sc1":
        _load_sc1(change_store)
    elif variant == "sc2":
        _load_sc2(change_store)
    return variant


def fixture_enabled(env: Mapping[str, str]) -> bool:
    """`PDM_FIXTURE=brk-m8`(또는 `brk-m8:sc1` · `brk-m8:sc2`)일 때만 True. 값이 없거나 다르면 False — 기본은 아무것도 올리지 않는다."""
    return env.get(ENV_NAME, "").strip().lower().split(":", 1)[0] == FIXTURE_NAME


def load_from_env(env: Mapping[str, str], pdm_store: InMemoryPdmStore, change_store: ChangeStore) -> Variant | None:
    """환경변수가 켜져 있으면 픽스처를 올리고 변형 이름을, 아니면 아무것도 하지 않고 None 을 돌려준다."""
    if not fixture_enabled(env):
        return None
    _, _, variant = env[ENV_NAME].strip().lower().partition(":")
    return load_brk_m8(pdm_store, change_store, (variant or "base"))  # type: ignore[arg-type]


__all__ = [
    "Variant", "VARIANTS", "ENV_NAME", "FIXTURE_NAME", "PRODUCT_CODE", "ITEM_MODULE", "ITEM_TOP", "ITEM_BOTTOM", "ITEM_SET",
    "BOLT", "NUT", "WASHER", "NUT_FINE", "FLANGE_BOLT", "FIXTURE_AS_OF", "OPMS_PARTS", "opms_part_values", "empty_seed",
    "FixtureConflict", "load_brk_m8", "fixture_enabled", "load_from_env",
]
