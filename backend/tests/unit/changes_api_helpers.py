"""변경 영향 분석 서비스 · 라우트 시험용 앱 만들기. 실제 픽스처(`changes/fixtures`)를 올린 앱 + OPMS 읽기 대역(`StubReader`).

OPMS 값은 개발 DB(온톨로지 0.19.0)와 같은 모양의 대역이다. **시험 안에서만** 쓴다(앱 목 데이터가 아니다).
엔진 단위 시험(`changes_helpers.py`의 `World`)과는 별개다: 이쪽은 저장소 · 서비스 · 라우트까지 이은 통합 시험의 바탕이다.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient

from onto_pdm.api.app import PREFIX, create_app
from onto_pdm.changes.fixtures import empty_seed, load_brk_m8
from onto_pdm.changes.service import ChangeService
from onto_pdm.changes.store import InMemoryChangeStore
from onto_pdm.opms import OpmsReader
from onto_pdm.store.base import Session
from onto_pdm.store.memory import InMemoryPdmStore
from tests.unit.changes_helpers import StubReader

TOKEN = "feed-token"
LEE = {"X-PDM-User": "lee"}                                    # engineer
CHOI = {"X-PDM-User": "choi"}                                  # approver
KIM = {"X-PDM-User": "kim", "X-PDM-Admin-Mode": "1"}           # admin(관리자 모드)

SC1, SC2 = "CR-2026-0001", "CR-2026-0002"


def url(path: str) -> str:
    return f"{PREFIX}{path}"


@dataclass
class World:
    client: TestClient
    pdm: InMemoryPdmStore
    changes: InMemoryChangeStore
    service: ChangeService
    clock: list[datetime]

    def tick(self, minutes: int = 1) -> datetime:
        self.clock[0] += timedelta(minutes=minutes)
        return self.clock[0]


def make_world(variant: str | None = "sc2", *, reader: OpmsReader | None = None, token: str | None = TOKEN) -> World:
    """`variant=None` 이면 픽스처 없이 빈 저장소(기본 사용자만)."""
    pdm = InMemoryPdmStore(empty_seed())
    changes = InMemoryChangeStore()
    if variant:
        load_brk_m8(pdm, changes, variant)               # type: ignore[arg-type]
    env = {"PDM_FEED_TOKEN": token} if token else {}
    app = create_app(pdm, reader if reader is not None else StubReader(), changes=changes, env=env)
    clock = [datetime(2026, 11, 12, 12, 0, tzinfo=UTC)]
    app.state.change_service._clock = lambda: clock[0]          # 시험에서 시각을 고정한다
    return World(TestClient(app), pdm, changes, app.state.change_service, clock)


def session(world: World, login: str, *, admin_mode: bool = False) -> Session:
    user = world.pdm.find_user(login)
    assert user is not None
    return Session(user=user, admin_mode=admin_mode)


def findings(run: dict[str, Any], *, severity: str | None = None, kind: str | None = None) -> list[dict[str, Any]]:
    return [f for f in run["findings"] if (severity is None or f["severity"] == severity) and (kind is None or f["kind"] == kind)]


def run_impact(w: World, code: str, who: dict[str, str] = LEE) -> dict[str, Any]:
    r = w.client.post(url(f"/changes/{code}/impact"), headers=who)
    assert r.status_code == 200, r.text
    return r.json()  # type: ignore[no-any-return]


def revisions(w: World, item_no: str) -> list[tuple[str, str]]:
    detail = w.client.get(url(f"/items/{item_no}"), headers=KIM).json()
    return [(x["rev"], x["status"]) for x in detail["revisions"]]


# 처분 기본값(시험용): 영향 종류별로 허용되는 가장 단순한 선택
_ACTION = {"work_order": "apply_new", "purchase_order_line": "amend", "stock_lot": "use_up"}


def decide_all_affected(w: World, code: str, run: dict[str, Any], who: dict[str, str] = LEE) -> None:
    for f in findings(run, severity="affected"):
        action = "change_in_progress" if f["kind"] == "work_order" and f["reason_code"] == "used_in_progress" else _ACTION[f["kind"]]
        r = w.client.put(url(f"/changes/{code}/dispositions/{f['id']}"), headers=who, json={"action": action, "reason": "시험 결정"})
        assert r.status_code == 200, r.text
