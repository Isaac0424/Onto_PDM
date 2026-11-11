"""계약 예시 JSON. 시드 저장소와 규칙에서 만든 실제 응답이라 계약과 어긋날 수 없다.

이름은 `<모델>.<이름>` 이다. 시험이 모든 예시를 해당 모델로 다시 읽어 본다 (계약에서 벗어나면 실패).
"""

from __future__ import annotations

from typing import Any

from onto_pdm.contracts import (
    ApiError, AssemblyPartInput, ChangeRunSummary, ChangeSummary, ChangeTargetIn, ErrorBody, FindingBasisView, Health,
    ImpactFindingView, ImpactRunView, StockLotFeedIn, StockLotFeedRow,
)
from onto_pdm.store import InMemoryPdmStore, Session


def _change_examples(dump: Any) -> dict[str, dict[str, Any]]:
    """변경 영향 분석 계약 예시(BRK-M8). 저장소 없이 계약 모델로 직접 만든다. 그립 수치는 design 4.4 의 시연용 가정이다."""
    basis = FindingBasisView(ontology_version="0.19.0", rule_id="pdm:grip_length", as_of="2026-11-12T09:00:00+09:00")
    grip = ImpactFindingView(
        id=1, kind="fit_grip", subject_type="item", subject_ref="P-00000000001", severity="blocked", verdict="no",
        reason_code="shortfall", message="필요 길이 32.5 mm, 볼트 30 mm — 2.5 mm 부족", basis=basis, temporary=True, approximate=False,
        inputs={"plates": [8, 12], "washers": "2x1.6", "nutHeight": 6.8, "pitch": 1.25, "boltLength": 30},
        required=32.5, actual=30, gap=2.5,
    )
    stock = ImpactFindingView(
        id=2, kind="stock_lot", subject_type="stock_lot", subject_ref="LT-N-01", severity="affected",
        reason_code="stock_on_hand", message="구 개정 너트 재고 300개", basis=basis.model_copy(update={"rule_id": None}),
        temporary=False, approximate=False, inputs={"qty_on_hand": 300, "source_system": "fixture"}, scope_class="inside",
        suggested_disposition="quarantine",
    )
    summary = ChangeRunSummary(blocked=1, affected=1, review=0, none=0, stale=False, partial=False)
    run = ImpactRunView(
        id=1, order_code="CO-2026-0001", computed_at="2026-11-12T09:00:00+09:00", computed_by="kim", input_hash="0" * 64,
        ontology_version="0.19.0", temporary=True, partial=False, external_as_of={"stock_lot": "2026-11-12T08:00:00+09:00"},
        stale=False, stale_reasons=[], warnings=[], summary=summary, findings=[grip, stock],
    )
    return {
        "ImpactRunView.sc2_grip_blocked": dump(run),
        "ChangeSummary.sc2": dump(ChangeSummary(
            code="CR-2026-0001", title="상판 두께 8 → 12 mm", status="submitted", order_code="CO-2026-0001", order_status="in_review",
            product_code="BRK-M8", origin="design", requested_by="kim", requested_at="2026-11-12T09:00:00+09:00", run_summary=summary)),
        "ChangeTargetIn.sc2_attribute_edit": dump(ChangeTargetIn(
            change_kind="attribute_edit", item_no="BRK-TOP", from_revision="R00", to_revision="R01",
            before={"thickness": 8}, after={"thickness": 12}, note="상판 두께 변경")),
        "StockLotFeedIn.fixture": dump(StockLotFeedIn(source_system="fixture", rows=[StockLotFeedRow(
            lot_no="LT-N-01", item_no="P-00000000022", site="PLANT-1", location="WH-A", qty_on_hand=300, as_of="2026-11-12T08:00:00+09:00")])),
        "ApiError.disposition_required": dump(ApiError(error=ErrorBody(
            code="DISPOSITION_REQUIRED", message="처분이 필요한 영향이 있습니다", details={"finding_ids": [2]}))),
    }


def examples() -> dict[str, dict[str, Any]]:
    store = InMemoryPdmStore()
    admin = Session(user=store.find_user("kim"), admin_mode=True)  # type: ignore[arg-type]
    dump = lambda m: m.model_dump(mode="json", exclude_none=True)  # noqa: E731
    cad = store.match_cad_parts(admin, ["전원 버튼", "기판 나사 M3", "제어 기판"])
    guides = store.get_assembly_guides([
        AssemblyPartInput(name="상부 커버", size=(126, 80, 3)),
        AssemblyPartInput(name="러그", size=(3, 2.6, 7)),
    ])
    bom = store.get_product_bom(admin, "HCR3A", "released")
    return {
        "Health.default": dump(Health()),
        "ApiError.item_not_found": dump(ApiError(error=ErrorBody(code="ITEM_NOT_FOUND", message="품목 P-99999999999을(를) 찾을 수 없습니다"))),
        "ItemDetail.p00000000001": dump(store.get_item(admin, "P-00000000001")),
        "ProductBom.hcr3a_released": dump(bom.model_copy(update={"nodes": bom.nodes[:1]})),
        "CadPartMatch.matched": dump(cad[0]),
        "CadPartMatch.suggested": dump(cad[1]),
        "CadPartMatch.none": dump(cad[2]),
        "AssemblyGuide.cover": dump(guides[0]),
        "AssemblyGuide.weld": dump(guides[1]),
        "AssemblyRuleDetail.weld": dump(store.get_assembly_rule(admin, "SP-WLD-01")),
        **_change_examples(dump),
    }
