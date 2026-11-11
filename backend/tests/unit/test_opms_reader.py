"""OPMS Neo4j 읽기 어댑터: 읽기 전용 강제, 오류 번역, 온톨로지 캐시. 가짜 드라이버로(Neo4j 없이)."""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from neo4j import READ_ACCESS
from neo4j.exceptions import AuthError, ServiceUnavailable

from onto_pdm.opms import errors
from onto_pdm.opms import reader as reader_mod
from onto_pdm.opms.reader import Neo4jOpmsReader, UnconfiguredOpmsReader, assert_read_only, reader_from_env
from tests.unit.opms_fixtures import snapshot


# ---------------------------------------------------------------- 읽기 전용 강제
@pytest.mark.parametrize("cypher", [
    "CREATE (n:Part {part_no: 'x'})",
    "MATCH (p:Part) SET p.length = 1 RETURN p",
    "MATCH (p:Part) REMOVE p.length",
    "MATCH (p:Part) DETACH DELETE p",
    "MATCH (p:Part) DELETE p",
    "MERGE (p:Part {part_no: 'x'})",
    "MATCH (p:Part) FOREACH (x IN [1] | SET p.a = x)",
    "CALL db.labels() YIELD label RETURN label",
    "LOAD CSV FROM 'file:///x.csv' AS r RETURN r",
    "DROP INDEX x",
    "MATCH (n) RETURN n; MATCH (m) RETURN m",
    "MATCH (n) CALL apoc.create.node(['X'], {}) YIELD node RETURN node",
    "match (p:Part) set p.x = 1",                                                              # 소문자도
])
def test_write_statements_are_rejected(cypher: str) -> None:
    with pytest.raises(ValueError):
        assert_read_only(cypher)


@pytest.mark.parametrize("cypher", [
    "MATCH (p:Part) RETURN p.part_no",
    "MATCH (p:Part {part_no: 'SET DELETE CREATE'}) RETURN p",                                  # 문자열 리터럴 안의 단어는 쓰기가 아니다
    "MATCH (p:Part) WHERE p.name = \"MERGE\" RETURN p",
    "MATCH (p:Part) RETURN p.settings, p.created_at, p.offset",                               # 단어 일부는 걸리지 않는다
    "MATCH (p:Part) RETURN count(p);",                                                         # 끝의 세미콜론 하나는 허용
])
def test_read_statements_pass(cypher: str) -> None:
    assert_read_only(cypher)


def test_every_query_the_adapter_sends_is_read_only() -> None:
    queries = [v for k, v in vars(reader_mod).items() if k.endswith("_QUERY") and isinstance(v, str)]
    assert len(queries) == 4
    for q in queries:
        assert_read_only(q)


class FakeRecord:
    def __init__(self, d: dict[str, Any]) -> None:
        self._d = d

    def data(self) -> dict[str, Any]:
        return self._d


class FakeTx:
    def __init__(self, rows: list[dict[str, Any]], log: list[Any]) -> None:
        self._rows, self._log = rows, log

    def run(self, cypher: str, **params: Any) -> list[FakeRecord]:
        self._log.append(("run", re.sub(r"\s+", " ", cypher)[:40], params))
        return [FakeRecord(r) for r in self._rows]


class FakeSession:
    """execute_read 만 있다. execute_write · write_transaction · run 은 없어서 쓰면 바로 AttributeError 다."""

    def __init__(self, rows: list[dict[str, Any]], log: list[Any], kwargs: dict[str, Any]) -> None:
        self._rows, self._log = rows, log
        log.append(("session", kwargs))

    def __enter__(self) -> FakeSession:
        return self

    def __exit__(self, *a: object) -> None:
        return None

    def execute_read(self, fn: Any) -> Any:
        self._log.append(("execute_read",))
        return fn(FakeTx(self._rows, self._log))


class FakeDriver:
    def __init__(self, rows: list[dict[str, Any]] | None = None, *, error: Exception | None = None) -> None:
        self.rows, self.error, self.log, self.closed = rows or [], error, [], False

    def session(self, **kwargs: Any) -> FakeSession:
        if self.error:
            raise self.error
        return FakeSession(self.rows, self.log, kwargs)

    def close(self) -> None:
        self.closed = True


def reader(driver: FakeDriver, **kw: Any) -> Neo4jOpmsReader:
    return Neo4jOpmsReader("bolt://x", "u", "p", driver_factory=lambda uri, auth: driver, **kw)


def test_sessions_are_opened_read_only_and_only_execute_read_is_used() -> None:
    d = FakeDriver([{"props": {"part_no": "P-00000000001", "threadSize": "M8", "created_at": object()}, "class_code": "HexBolt"}])
    parts = reader(d).parts(["HexBolt"], {"threadSize": "M8"})
    assert d.log[0] == ("session", {"default_access_mode": READ_ACCESS}) and ("execute_read",) in d.log
    assert [e[0] for e in d.log] == ["session", "execute_read", "run"]
    assert d.log[2][2] == {"codes": ["HexBolt"], "eq": {"threadSize": "M8"}}                   # 값은 파라미터로 (문자열 조립 없음)
    assert parts[0].part_no == "P-00000000001" and dict(parts[0].values) == {"threadSize": "M8"}   # 시간 값 · 시스템 속성은 빠진다


def test_database_name_is_passed_to_the_session_when_given() -> None:
    d = FakeDriver([])
    reader(d, database="neo4j").parts()
    assert d.log[0][1]["database"] == "neo4j"


def test_ontology_is_cached_for_the_ttl_then_read_again() -> None:
    snap = snapshot()
    d = FakeDriver([{"version": "0.15.0", "snapshot": json.dumps(snap.data)}])
    now = [100.0]
    r = reader(d, snapshot_ttl_seconds=30, clock=lambda: now[0])
    assert r.ontology().version == "0.15.0"
    now[0] = 120.0
    r.ontology()
    assert [e for e in d.log if e[0] == "execute_read"].__len__() == 1                          # TTL 안에는 다시 읽지 않는다
    now[0] = 131.0
    r.ontology()
    assert [e for e in d.log if e[0] == "execute_read"].__len__() == 2


def test_ontology_accepts_a_snapshot_that_is_already_a_dict() -> None:
    d = FakeDriver([{"version": "0.15.0", "snapshot": snapshot().data}])
    assert "HexBolt" in reader(d).ontology().data["classes"]


def test_missing_ontology_is_a_clear_503() -> None:
    with pytest.raises(errors.OpmsUnavailable) as e:
        reader(FakeDriver([])).ontology()
    assert e.value.status == 503 and e.value.code == "OPMS_NO_ONTOLOGY"


@pytest.mark.parametrize("exc,code", [
    (ServiceUnavailable("down"), "OPMS_UNAVAILABLE"),
    (AuthError("bad"), "OPMS_AUTH_FAILED"),
    (ConnectionRefusedError(), "OPMS_UNAVAILABLE"),
])
def test_neo4j_failures_become_503_with_a_code(exc: Exception, code: str) -> None:
    with pytest.raises(errors.OpmsUnavailable) as e:
        reader(FakeDriver(error=exc)).counts()
    assert e.value.status == 503 and e.value.code == code


def test_a_write_query_is_refused_before_it_reaches_the_driver() -> None:
    d = FakeDriver([])
    with pytest.raises(ValueError):
        reader(d)._read("MATCH (p:Part) SET p.x = 1")
    assert d.log == []


def test_close_closes_the_driver_once() -> None:
    d = FakeDriver([])
    r = reader(d)
    r.counts()
    r.close()
    r.close()
    assert d.closed is True


def test_the_driver_is_not_created_until_first_use() -> None:
    made: list[int] = []
    Neo4jOpmsReader("bolt://x", "u", "p", driver_factory=lambda uri, auth: made.append(1))     # 만들기만 해서는 연결하지 않는다
    assert made == []


# ---------------------------------------------------------------- 설정
def test_reader_from_env() -> None:
    assert isinstance(reader_from_env({}), UnconfiguredOpmsReader)
    assert isinstance(reader_from_env({"PDM_NEO4J_URI": "bolt://x", "PDM_NEO4J_USER": "u"}), UnconfiguredOpmsReader)     # 비밀번호가 없으면 설정 없음
    assert isinstance(reader_from_env({"PDM_NEO4J_URI": "bolt://x", "PDM_NEO4J_USER": "u", "PDM_NEO4J_PASSWORD": "p"}), Neo4jOpmsReader)


def test_unconfigured_reader_refuses_every_read() -> None:
    r = UnconfiguredOpmsReader()
    for call in (r.ontology, r.counts, lambda: r.parts(), lambda: r.part("P-1")):
        with pytest.raises(errors.OpmsUnavailable) as e:
            call()
        assert e.value.code == "OPMS_NOT_CONFIGURED"
