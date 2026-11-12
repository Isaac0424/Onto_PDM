"""실제 OPMS 로 온톨로지 버전 변경 보고를 확인한다. **읽기만 한다**(쓰기 문장은 어댑터가 거부한다).

실행: PDM_NEO4J_URI=bolt://127.0.0.1:7687 PDM_NEO4J_USER=neo4j PDM_NEO4J_PASSWORD=... \\
      .venv/Scripts/python -m pytest -m opms_live tests/opms_live/test_live_changes_ontology.py -q
환경 변수가 없으면 건너뛴다. OPMS 데이터에 거의 기대하지 않고, 있으면 확인하는 형태다(온톨로지 버전 · 부품이 바뀌어도 깨지지 않게).
"""

from __future__ import annotations

import copy
import os
from datetime import UTC, datetime

import pytest

from onto_pdm.changes import ontology_impact as oi
from onto_pdm.changes.ports import PartAttrs
from onto_pdm.opms import reader_from_env
from onto_pdm.opms.reader import OntologySnapshot

pytestmark = [
    pytest.mark.opms_live,
    pytest.mark.skipif(not (os.environ.get("PDM_NEO4J_URI") and os.environ.get("PDM_NEO4J_PASSWORD")), reason="PDM_NEO4J_* 환경 변수가 없다"),
]

BOLT, NUT = "P-00000000001", "P-00000000022"


@pytest.fixture(scope="module")
def reader():  # type: ignore[no-untyped-def]
    r = reader_from_env()
    yield r
    r.close()


def test_current_version_is_readable_and_unknown_version_is_absent(reader) -> None:  # type: ignore[no-untyped-def]
    history = oi.ReaderSnapshotHistory(reader)
    cur = history.current()
    assert cur.version and "rules" in cur.data and "classes" in cur.data
    assert history.at(cur.version) is not None
    assert history.at("0.0.0-없는-버전") is None                       # 없는 버전은 None(서비스가 404 로 바꾼다)


def test_every_stored_version_is_readable_when_opms_keeps_old_snapshots(reader) -> None:  # type: ignore[no-untyped-def]
    """OPMS 는 옛 버전을 지우지 않는 설계다. 개발 DB 에 버전이 여럿 있으면 모두 읽혀야 하고, 하나뿐이면 그 하나만 확인한다."""
    history = oi.ReaderSnapshotHistory(reader)
    versions = [r["version"] for r in reader._read("MATCH (v:OntologyVersion) RETURN v.version AS version ORDER BY v.version")]  # noqa: SLF001
    assert versions
    for v in versions:
        snap = history.at(v)
        assert snap is not None and snap.version == v


def test_real_parts_are_flagged_when_the_mates_rule_is_tightened(reader) -> None:  # type: ignore[no-untyped-def]
    cur = reader.ontology()
    data = copy.deepcopy(dict(cur.data))
    data["version"] = "9.9.9-synthetic"
    data["rules"]["bolt_nut"]["spec"]["match"] = [*data["rules"]["bolt_nut"]["spec"].get("match", []), "strengthGrade"]
    new = OntologySnapshot(version="9.9.9-synthetic", data=data)

    parts = {p.part_no: PartAttrs(part_no=p.part_no, class_code=p.class_code, values=dict(p.values)) for p in reader.parts(None, None)}
    report = oi.build_report(cur, new, parts=parts, joints=(), computed_at=datetime.now(UTC))
    assert report.summary.rules_changed == ("bolt_nut:changed",)
    flagged = set(report.summary.parts_flagged)
    if BOLT in parts and NUT in parts:
        assert {BOLT, NUT} <= flagged                                  # 볼트 · 너트 계열이 후보에 오른다
    assert all(parts[no].class_code for no in flagged)
    assert not [i for i in report.items if i.kind == "joint"]          # 체결부(PDM 쪽)는 이 시험에 없다
