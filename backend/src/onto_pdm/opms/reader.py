"""OPMS Neo4j 읽기 어댑터. 어댑터 경계는 `OpmsReader` 프로토콜이다.

- **읽기 전용 강제**: 세션을 READ 모드로 열고 `execute_read` 로만 실행하며, 쓰기 문장(CREATE · MERGE · SET · DELETE ·
  REMOVE · DROP · CALL …)은 보내기 전에 `assert_read_only` 가 거부한다. OPMS DB 에는 아무것도 쓰지 않는다.
- **왜 Neo4j 직접인가(임시)**: OPMS API(`/api/v1/*`)는 로그인이 필요하고, PDM 이 OPMS 계정을 만들 수 없다. OPMS 의 부품 매칭 API
  (`POST /parts/match`)는 보류 상태다(OPMS `docs/changes/CR-NEXT-parts-match-api.md`). 그 API 가 열리면 이 프로토콜을
  OPMS API 호출로 구현해 바꿔 끼운다. 같은 Neo4j 에 OPMS 가 만든 `:Class` `:Part` `:OntologyVersion` 을 읽을 뿐이다.
- 온톨로지는 `:OntologyVersion {current: true}.snapshot`(JSON)에서 읽는다. OPMS 런타임이 읽는 것과 같은 원본이다.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from onto_pdm.opms import errors

# 어댑터가 읽는 :Part 의 시스템 속성(속성 값이 아니다)
SYSTEM_PART_KEYS = frozenset({"part_no", "blocking_key", "created_at", "updated_at", "record_origin", "created_by_review"})

_WRITE_WORDS = re.compile(
    r"\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|FOREACH|LOAD|CALL|START|STOP|TERMINATE|GRANT|DENY|REVOKE|ALTER|RENAME|USE)\b",
    re.IGNORECASE,
)


def assert_read_only(cypher: str) -> None:
    """쓰기 문장이 섞인 Cypher 를 거부한다 (문자열 리터럴 안의 단어는 무시). 위반하면 ValueError."""
    stripped = re.sub(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"", "''", cypher)
    if ";" in stripped.rstrip().rstrip(";"):
        raise ValueError("문장은 하나여야 합니다 (세미콜론으로 이은 여러 문장 금지)")
    m = _WRITE_WORDS.search(stripped)
    if m:
        raise ValueError(f"읽기 전용 어댑터라 {m.group(1).upper()} 문장은 보낼 수 없습니다")
    if "apoc." in stripped.lower():
        raise ValueError("apoc 프로시저는 쓰지 않습니다")


@dataclass(frozen=True)
class OntologySnapshot:
    """OPMS 가 적용한 현재 온톨로지 스냅샷."""

    version: str
    data: Mapping[str, Any]


@dataclass(frozen=True)
class RawPart:
    """OPMS `:Part` 한 개: 품번 · 분류 코드 · 속성 값(정규형: 숫자 · 문자열 · 개념 코드)."""

    part_no: str
    class_code: str
    values: Mapping[str, Any] = field(default_factory=dict)


class OpmsReader(Protocol):
    """OPMS 에서 읽는 것. 구현은 Neo4j 직접(지금)이거나 OPMS API(나중)다. 어느 쪽이든 읽기만 한다."""

    def ontology(self) -> OntologySnapshot: ...

    def parts(self, class_codes: Collection[str] | None = None, equals: Mapping[str, Any] | None = None) -> list[RawPart]: ...

    def part(self, part_no: str) -> RawPart | None: ...

    def counts(self) -> dict[str, int]: ...

    def close(self) -> None: ...


class UnconfiguredOpmsReader:
    """접속 설정이 없을 때의 읽기 어댑터: 모든 호출이 503(OPMS_NOT_CONFIGURED)이다."""

    def ontology(self) -> OntologySnapshot:
        raise errors.not_configured()

    def parts(self, class_codes: Collection[str] | None = None, equals: Mapping[str, Any] | None = None) -> list[RawPart]:
        raise errors.not_configured()

    def part(self, part_no: str) -> RawPart | None:
        raise errors.not_configured()

    def counts(self) -> dict[str, int]:
        raise errors.not_configured()

    def close(self) -> None:
        return None


_SNAPSHOT_QUERY = "MATCH (v:OntologyVersion {current: true}) RETURN v.version AS version, v.snapshot AS snapshot LIMIT 1"
_PARTS_QUERY = (
    "MATCH (p:Part)-[:INSTANCE_OF]->(c:Class) "
    "WHERE ($codes IS NULL OR c.code IN $codes) "
    "AND ALL(k IN keys($eq) WHERE p[k] = $eq[k]) "
    "RETURN properties(p) AS props, c.code AS class_code ORDER BY p.part_no"
)
_PART_QUERY = "MATCH (p:Part {part_no: $part_no})-[:INSTANCE_OF]->(c:Class) RETURN properties(p) AS props, c.code AS class_code LIMIT 1"
_COUNTS_QUERY = (
    "MATCH (p:Part) WITH count(p) AS parts "
    "MATCH (c:Class) RETURN parts, count(c) AS classes"
)


def _plain(value: Any) -> Any:
    """Neo4j 시간 · 공간 값은 화면에 필요 없어 빼고, 나머지는 JSON 값으로."""
    return value if isinstance(value, str | int | float | bool) else None


def _raw_part(props: Mapping[str, Any], class_code: str) -> RawPart:
    values = {k: v for k, v in ((k, _plain(v)) for k, v in props.items() if k not in SYSTEM_PART_KEYS) if v is not None}
    return RawPart(part_no=str(props["part_no"]), class_code=class_code, values=values)


class Neo4jOpmsReader:
    """OPMS Neo4j 를 읽기 모드로 읽는다. 드라이버는 처음 쓸 때 만든다(앱을 켤 때 Neo4j 가 꺼져 있어도 켜진다)."""

    def __init__(
        self, uri: str, user: str, password: str, *, database: str | None = None,
        driver_factory: Callable[..., Any] | None = None, snapshot_ttl_seconds: float = 30.0, clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._uri, self._auth, self._database = uri, (user, password), database
        self._factory = driver_factory
        self._driver: Any = None
        self._lock = threading.Lock()
        self._ttl, self._clock = snapshot_ttl_seconds, clock
        self._snap: tuple[float, OntologySnapshot] | None = None

    # ---- 내부 ----
    def _get_driver(self) -> Any:
        with self._lock:
            if self._driver is None:
                factory = self._factory
                if factory is None:
                    from neo4j import GraphDatabase

                    factory = GraphDatabase.driver
                self._driver = factory(self._uri, auth=self._auth)
            return self._driver

    def _read(self, cypher: str, **params: Any) -> list[dict[str, Any]]:
        assert_read_only(cypher)
        try:
            from neo4j import READ_ACCESS
            from neo4j.exceptions import AuthError, Neo4jError, ServiceUnavailable, SessionExpired
        except ImportError as e:  # pragma: no cover
            raise errors.unreachable("neo4j 패키지가 없습니다") from e
        try:
            driver = self._get_driver()
            kwargs: dict[str, Any] = {"default_access_mode": READ_ACCESS}
            if self._database:
                kwargs["database"] = self._database
            with driver.session(**kwargs) as session:
                return session.execute_read(lambda tx: [r.data() for r in tx.run(cypher, **params)])
        except AuthError as e:
            raise errors.auth_failed() from e
        except (ServiceUnavailable, SessionExpired, OSError) as e:
            raise errors.unreachable(type(e).__name__) from e
        except Neo4jError as e:
            raise errors.unreachable(e.code or "Neo4jError") from e

    # ---- OpmsReader ----
    def ontology(self) -> OntologySnapshot:
        now = self._clock()
        if self._snap and now - self._snap[0] < self._ttl:
            return self._snap[1]
        rows = self._read(_SNAPSHOT_QUERY)
        if not rows or rows[0].get("snapshot") is None:
            raise errors.no_ontology()
        raw = rows[0]["snapshot"]
        data = json.loads(raw) if isinstance(raw, str) else raw
        snap = OntologySnapshot(version=str(rows[0]["version"]), data=data)
        self._snap = (now, snap)
        return snap

    def parts(self, class_codes: Collection[str] | None = None, equals: Mapping[str, Any] | None = None) -> list[RawPart]:
        rows = self._read(_PARTS_QUERY, codes=sorted(class_codes) if class_codes is not None else None, eq=dict(equals or {}))
        return [_raw_part(r["props"], r["class_code"]) for r in rows]

    def part(self, part_no: str) -> RawPart | None:
        rows = self._read(_PART_QUERY, part_no=part_no)
        return _raw_part(rows[0]["props"], rows[0]["class_code"]) if rows else None

    def counts(self) -> dict[str, int]:
        rows = self._read(_COUNTS_QUERY)
        return {"parts": int(rows[0]["parts"]), "classes": int(rows[0]["classes"])} if rows else {"parts": 0, "classes": 0}

    def close(self) -> None:
        with self._lock:
            if self._driver is not None:
                self._driver.close()
                self._driver = None


def reader_from_env(env: Mapping[str, str] | None = None) -> OpmsReader:
    """PDM_NEO4J_URI · PDM_NEO4J_USER · PDM_NEO4J_PASSWORD(· PDM_NEO4J_DATABASE)로 읽기 어댑터를 만든다. 없으면 '설정 없음' 어댑터."""
    e = os.environ if env is None else env
    uri, user, password = e.get("PDM_NEO4J_URI"), e.get("PDM_NEO4J_USER"), e.get("PDM_NEO4J_PASSWORD")
    if not (uri and user and password):
        return UnconfiguredOpmsReader()
    return Neo4jOpmsReader(uri, user, password, database=e.get("PDM_NEO4J_DATABASE") or None)
