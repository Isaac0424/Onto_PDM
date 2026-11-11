"""공개 범위와 BOM 규칙 (web/src/api/mock/mockApi.test.ts 의 '공개 범위' 시험과 같은 시나리오)."""

from __future__ import annotations

import pytest

from onto_pdm.errors import ApiException
from onto_pdm.store import InMemoryPdmStore, Session


@pytest.fixture
def store() -> InMemoryPdmStore:
    return InMemoryPdmStore()


def as_user(store: InMemoryPdmStore, login: str, admin_mode: bool) -> Session:
    user = store.find_user(login)
    assert user is not None
    return Session(user=user, admin_mode=admin_mode)


def test_engineer_cannot_see_others_wip_but_admin_mode_can(store: InMemoryPdmStore) -> None:
    mine = store.get_item(as_user(store, "lee", False), "P-00000000150")        # 이설계가 만든 작업중 품목
    assert [r.status for r in mine.revisions] == ["wip"]

    with pytest.raises(ApiException) as e:
        store.get_item(as_user(store, "kim", False), "P-00000000150")           # 관리자 역할이지만 모드 꺼짐
    assert e.value.status == 404 and e.value.code == "ITEM_NOT_FOUND"
    assert store.get_item(as_user(store, "kim", True), "P-00000000150").item_no == "P-00000000150"


def test_admin_role_without_admin_mode_is_not_admin(store: InMemoryPdmStore) -> None:
    s = as_user(store, "kim", False)
    assert not s.is_admin
    cover = next(i for i in store.list_items(s) if i.item_no == "P-00000000112")
    assert cover.latest_revision is not None and cover.latest_revision.rev == "R00"      # 검토중 R01 은 안 보인다
    assert cover.latest_revision.status == "released"


def test_bom_uses_released_or_latest_revision(store: InMemoryPdmStore) -> None:
    admin = as_user(store, "kim", True)
    released = store.get_product_bom(admin, "HCR3A", "released")
    latest = store.get_product_bom(admin, "HCR3A", "latest")
    assert released.revision is not None and released.revision.rev == "R01"
    assert latest.revision is not None and latest.revision.rev == "R02" and latest.revision.status == "wip"
    assert [n.item.item_no for n in released.nodes] == ["P-00000000110", "P-00000000120", "P-00000000130", "P-00000000140"]
    assert "P-00000000150" in [n.item.item_no for n in latest.nodes]                    # 작업중 R02 에만 있는 J1 브레이크

    # R02 는 이설계(lee)의 작업중이다: 본인에게는 보이고, 관리자 모드가 아닌 김관리에게는 안 보인다 → 최신 규칙도 승인본과 같다
    mine = store.get_product_bom(as_user(store, "lee", False), "HCR3A", "latest")
    assert mine.revision is not None and mine.revision.rev == "R02"
    other = store.get_product_bom(as_user(store, "kim", False), "HCR3A", "latest")
    assert other.revision is not None and other.revision.rev == "R01"


def test_total_quantity_multiplies_down_the_tree(store: InMemoryPdmStore) -> None:
    bom = store.get_product_bom(as_user(store, "kim", True), "HCR3A", "released")
    j1 = next(n for n in bom.nodes if n.item.item_no == "P-00000000120")
    bolt = next(n for n in j1.children if n.item.item_no == "P-00000000001")
    assert (bolt.quantity, bolt.total_quantity) == (12, 12)
    base = next(n for n in bom.nodes if n.item.item_no == "P-00000000110")
    assert next(n for n in base.children if n.item.item_no == "P-00000000002").total_quantity == 8


def test_unknown_product_and_revision(store: InMemoryPdmStore) -> None:
    s = as_user(store, "kim", True)
    with pytest.raises(ApiException) as e:
        store.get_product_bom(s, "NOPE", "released")
    assert (e.value.status, e.value.code) == (404, "PRODUCT_NOT_FOUND")
    with pytest.raises(ApiException) as e2:
        store.get_bom(s, 999, "released")
    assert (e2.value.status, e2.value.code) == (404, "REVISION_NOT_FOUND")
