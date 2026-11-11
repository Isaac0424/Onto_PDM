"""계약 예시 JSON. 시드 저장소와 규칙에서 만든 실제 응답이라 계약과 어긋날 수 없다.

이름은 `<모델>.<이름>` 이다. 시험이 모든 예시를 해당 모델로 다시 읽어 본다 (계약에서 벗어나면 실패).
"""

from __future__ import annotations

from typing import Any

from onto_pdm.contracts import ApiError, AssemblyPartInput, ErrorBody, Health
from onto_pdm.store import InMemoryPdmStore, Session


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
    }
