"""실제 OPMS 의 짝 규칙 · 시연 부품으로 체결 판정을 확인한다. **읽기만 한다**(쓰기 문장은 어댑터가 거부한다).

실행: PDM_NEO4J_URI=bolt://127.0.0.1:7687 PDM_NEO4J_USER=neo4j PDM_NEO4J_PASSWORD=... \\
      .venv/Scripts/python -m pytest -m opms_live tests/opms_live/test_live_changes_mates.py -q
환경 변수가 없으면 건너뛴다. 데이터 값에는 거의 기대하지 않고, 있으면 확인하는 형태다(OPMS 데이터가 바뀌어도 시험이 낡지 않게).
"""

from __future__ import annotations

import os

import pytest

from onto_pdm.changes.fit import PartRef, PdmTemporaryFitJudge, PlateInput, judge_grip
from onto_pdm.changes.ports import ReaderPartSource
from onto_pdm.opms import mates, reader_from_env

pytestmark = [
    pytest.mark.opms_live,
    pytest.mark.skipif(not (os.environ.get("PDM_NEO4J_URI") and os.environ.get("PDM_NEO4J_PASSWORD")), reason="PDM_NEO4J_* 환경 변수가 없다"),
]

BOLT, NUT, NUT_FINE, WASHER = "P-00000000001", "P-00000000022", "P-00000000023", "P-00000000025"


@pytest.fixture(scope="module")
def source():  # type: ignore[no-untyped-def]
    reader = reader_from_env()
    yield ReaderPartSource(reader)
    reader.close()


def test_snapshot_has_the_mates_rules_the_judge_needs(source: ReaderPartSource) -> None:
    rules = {r.rule_id: r for r in source.mates_rules()}
    assert {"bolt_nut", "bolt_washer", "nut_washer"} <= set(rules)
    assert rules["bolt_nut"].left_class == "Bolt" and rules["bolt_nut"].right_class == "Nut"
    assert "threadSize" in rules["bolt_nut"].blocking and "pitch" in rules["bolt_nut"].match
    assert source.ontology_version()
    assert source.class_is_a("HexBolt", "Bolt") and source.class_is_a("HexNut", "Nut")
    assert any(r.replacement_class == "HexFlangeBolt" for r in source.substitute_rules())


def _ref(source: ReaderPartSource, no: str) -> PartRef | None:
    attrs = source.part_attrs(no)
    return None if attrs is None else PartRef(no, attrs)


def test_demo_parts_pair_the_way_the_acceptance_numbers_assume(source: ReaderPartSource) -> None:
    bolt, nut, fine, washer = (_ref(source, n) for n in (BOLT, NUT, NUT_FINE, WASHER))
    if None in (bolt, nut, fine, washer):
        pytest.skip("OPMS 시연 부품(P-…01 · 22 · 23 · 25)이 이 DB 에 없다")
    judge = PdmTemporaryFitJudge(source)
    assert judge.judge_pair(bolt, nut).verdict == "ok"                    # type: ignore[arg-type]
    mismatch = judge.judge_pair(bolt, fine)                               # type: ignore[arg-type]
    assert (mismatch.verdict, mismatch.reason_code, mismatch.rule_id) == ("no", "pair_mismatch", "bolt_nut")
    assert mismatch.temporary is True
    assert judge.judge_pair(bolt, washer).verdict == "ok"                 # type: ignore[arg-type]


def test_r00_grip_from_real_values_is_28_5(source: ReaderPartSource) -> None:
    bolt, nut, washer = (source.part_attrs(n) for n in (BOLT, NUT, WASHER))
    if None in (bolt, nut, washer):
        pytest.skip("OPMS 시연 부품이 이 DB 에 없다")
    assert bolt is not None and nut is not None and washer is not None
    r = judge_grip(plates=(PlateInput("TOP", 8.0), PlateInput("BOT", 8.0)), washer_thickness=float(washer.values["thickness"]), washers=2,
                   nut_height=float(nut.values["nutHeight"]), pitch=float(bolt.values["pitch"]), bolt_length=float(bolt.values["length"]))
    assert (r.required, r.verdict) == (28.5, "ok")
    # 개발 DB 확인(2026-11-12): P-…23 에도 nutHeight 가 있다. 비어 있으면 unknown(value_missing)이어야 한다.
    fine = source.part_attrs(NUT_FINE)
    assert fine is not None and ("nutHeight" in fine.values) == (judge_grip(
        plates=(PlateInput("T", 8.0),), washer_thickness=1.6, washers=0, nut_height=fine.values.get("nutHeight"), pitch=1.25, bolt_length=30.0,
    ).verdict != "unknown")


def test_reader_stays_read_only(source: ReaderPartSource) -> None:
    """어댑터는 쓰기 문장을 거부한다(이 시험이 OPMS 에 아무것도 쓰지 않는다는 보증)."""
    from onto_pdm.opms.reader import assert_read_only
    with pytest.raises(ValueError):
        assert_read_only("MATCH (p:Part) SET p.x = 1")
    assert mates.class_path(source._snap(), "HexBolt")[-1] == "HexBolt"
