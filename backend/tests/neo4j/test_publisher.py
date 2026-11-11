"""그래프 발행기 — 일회용 Neo4j 컨테이너에서 돈다 (pytest -m neo4j tests/neo4j).

컨테이너는 포트를 무작위로 127.0.0.1 에만 열고 시험이 끝나면 지운다. 사용자의 실제 Neo4j(OPMS 의 compose)에는 닿지 않는다.
OPMS 가 소유하는 것(:Part · :Class · :Concept)은 neo4j/test/opms-standin.cypher 와 시험의 보조 코드가 흉내 낸다.
"""

from __future__ import annotations

import copy
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from neo4j import Driver, GraphDatabase

from onto_pdm.graph import GraphPublishError, apply_schema, publish_data
from onto_pdm.graph.cypher import named_blocks, neo4j_dir, split_statements
from onto_pdm.store import InMemoryPdmStore, Session

pytestmark = pytest.mark.neo4j

IMAGE = "neo4j:5.26.32-community"  # OPMS docker-compose.yml 의 neo4j 와 같은 버전


def _docker(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", *args], capture_output=True, text=True, encoding="utf-8")


@pytest.fixture(scope="module")
def bolt_uri() -> Iterator[str]:
    if shutil.which("docker") is None or _docker("info").returncode != 0:
        pytest.skip("Docker 를 쓸 수 없다")
    name = f"onto-pdm-publish-{uuid.uuid4().hex[:8]}"
    started = _docker("run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::7687", "-e", "NEO4J_AUTH=none", IMAGE)
    assert started.returncode == 0, started.stderr
    try:
        port = _docker("port", name, "7687/tcp").stdout.strip().splitlines()[0].rsplit(":", 1)[1]
        uri = f"bolt://127.0.0.1:{port}"
        deadline = time.time() + 150
        while True:
            try:
                with GraphDatabase.driver(uri) as d:
                    d.verify_connectivity()
                break
            except Exception:  # noqa: BLE001 - 아직 뜨는 중
                if time.time() > deadline:
                    raise
                time.sleep(2)
        yield uri
    finally:
        _docker("rm", "-f", name)


@pytest.fixture(scope="module")
def driver(bolt_uri: str) -> Iterator[Driver]:
    with GraphDatabase.driver(bolt_uri) as d:
        yield d


@pytest.fixture
def store() -> InMemoryPdmStore:
    return InMemoryPdmStore()


def run_script(driver: Driver, text: str) -> None:
    with driver.session() as session:
        for stmt in split_statements(text):
            session.run(stmt).consume()


def opms_side(driver: Driver, data: dict[str, Any], *, skip: tuple[str, ...] = ()) -> None:
    """OPMS 가 이미 해 둔 일을 흉내 낸다: 분류 · 재료 · 품목 마스터(:Part) 와 재료 값(HAS_VALUE)."""
    run_script(driver, (neo4j_dir() / "test" / "opms-standin.cypher").read_text(encoding="utf-8"))
    materials = {m["name"]: m for m in InMemoryPdmStore().db["materials"]}
    with driver.session() as session:
        session.run("MERGE (s:Scheme {code: 'material'})").consume()
        for name in materials:
            session.run("MATCH (s:Scheme {code: 'material'}) MERGE (c:Concept {code: $c}) MERGE (c)-[:IN_SCHEME]->(s)", c=name).consume()
        iri_to_name = {m["iri"]: m["name"] for m in InMemoryPdmStore().db["materials"]}
        for it in data["items"]:
            if it["item_no"] in skip:
                continue
            session.run("MERGE (p:Part {part_no: $no}) ON CREATE SET p.record_origin = 'seed'", no=it["item_no"]).consume()
            if it.get("material_iri"):
                session.run("MATCH (p:Part {part_no: $no}), (c:Concept {code: $c}) MERGE (p)-[:HAS_VALUE {prop: 'material'}]->(c)",
                            no=it["item_no"], c=iri_to_name[it["material_iri"]]).consume()


@pytest.fixture
def graph(driver: Driver, store: InMemoryPdmStore) -> Driver:
    """시험마다 비운 DB + 스키마 + OPMS 쪽 흉내."""
    with driver.session() as session:
        session.run("MATCH (n) DETACH DELETE n").consume()
        for row in session.run("SHOW CONSTRAINTS YIELD name"):
            session.run(f"DROP CONSTRAINT {row['name']} IF EXISTS").consume()
        for row in session.run("SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP'"):
            session.run(f"DROP INDEX {row['name']} IF EXISTS").consume()
    apply_schema(driver)
    opms_side(driver, store.export_publication("HCR3A"))
    return driver


def count(driver: Driver, query: str, **params: Any) -> int:
    with driver.session() as session:
        return int(session.run(query, **params).single()["n"])  # type: ignore[index]


def totals(driver: Driver) -> tuple[int, int]:
    return count(driver, "MATCH (n) RETURN count(n) AS n"), count(driver, "MATCH ()-[r]->() RETURN count(r) AS n")


def part_snapshot(driver: Driver) -> list[tuple[Any, ...]]:
    with driver.session() as session:
        return [tuple(r) for r in session.run("MATCH (p:Part) RETURN p.part_no, labels(p), properties(p) ORDER BY p.part_no")]


# ---------------------------------------------------------------- 시험


def test_schema_apply_is_idempotent(graph: Driver) -> None:
    first = apply_schema(graph)
    second = apply_schema(graph)
    assert first == second >= 9
    names = {r["name"] for r in graph.session().run("SHOW CONSTRAINTS YIELD name")}
    assert {"pdm_item_id", "pdm_revision_id", "product_model_code", "part_identifier_key", "material_profile_concept"} <= names


def test_publish_writes_the_approved_graph_and_passes_all_checks(graph: Driver, store: InMemoryPdmStore) -> None:
    data = store.export_publication("HCR3A")
    counts = publish_data(graph, data)

    assert counts["items"] == len(data["items"]) == 14 and counts["products"] == 1
    assert count(graph, "MATCH (:PdmItem) RETURN count(*) AS n") == 14
    assert count(graph, "MATCH (:PdmItem)-[:OF_PART]->(:Part) RETURN count(*) AS n") == 14
    # 승인본만: 작업중 · 검토중 리비전은 그래프에 없다 (P-...100 R02 wip, P-...112 R01 in_review)
    assert count(graph, "MATCH (r:ItemRevision) WHERE r.status IN ['wip', 'in_review'] RETURN count(r) AS n") == 0
    assert count(graph, "MATCH (r:ItemRevision) RETURN count(r) AS n") == len(data["revisions"])
    assert count(graph, "MATCH (:PdmItem)-[:CURRENT_REVISION]->(:ItemRevision) RETURN count(*) AS n") == len(data["current"])

    with graph.session() as session:
        root = session.run(
            "MATCH (:ProductModel {code: 'HCR3A'})-[:ROOT_ITEM]->(i:PdmItem)-[:OF_PART]->(p:Part), (i)-[:CURRENT_REVISION]->(r) "
            "RETURN p.part_no AS part_no, r.rev AS rev, r.status AS status, i.item_type AS item_type").single()
        assert dict(root) == {"part_no": "P-00000000100", "rev": "R01", "status": "released", "item_type": "assembly"}
        history = session.run("MATCH (:PdmItem {pdm_item_id: 3})-[:HAS_REVISION]->(r) RETURN r.rev AS rev, r.status AS s ORDER BY r.rev_seq").data()
        assert history == [{"rev": "R00", "s": "obsolete"}, {"rev": "R01", "s": "released"}]
        alias = session.run("MATCH (:PartIdentifier {norm: 'BLT0038'})-[:IDENTIFIES]->(:PdmItem)-[:OF_PART]->(p) RETURN p.part_no AS n").single()
        assert alias["n"] == "P-00000000001"
        density = session.run("MATCH (mp:MaterialProfile {concept_code: 'A6061'})-[:PROFILE_OF]->(:Concept) RETURN mp.density_g_cm3 AS d").single()
        assert density["d"] == 2.7


def test_graph_quantities_match_the_pdm_bom(graph: Driver, store: InMemoryPdmStore) -> None:
    """neo4j/queries.cypher 의 bom_explode 가 PDM 의 BOM 전개(총수량)와 같은 답을 낸다."""
    publish_data(graph, store.export_publication("HCR3A"))
    query = named_blocks((neo4j_dir() / "queries.cypher").read_text(encoding="utf-8"))["bom_explode"]
    with graph.session() as session:
        in_graph: dict[str, float] = {}
        for row in session.run(query, part_no="P-00000000100"):
            in_graph[row["part_no"]] = in_graph.get(row["part_no"], 0.0) + row["total_quantity"]

    admin = Session(user=store.find_user("kim"), admin_mode=False)  # type: ignore[arg-type]
    in_pdm: dict[str, float] = {}

    def walk(nodes: list[Any]) -> None:
        for n in nodes:
            in_pdm[n.item.item_no] = in_pdm.get(n.item.item_no, 0.0) + n.total_quantity
            walk(n.children)

    walk(store.get_product_bom(admin, "HCR3A", "released").nodes)
    assert in_graph == in_pdm
    assert in_graph["P-00000000001"] == 24.0                                       # 12 + 12 (두 관절 모듈에 쓰임)


def test_republish_is_idempotent(graph: Driver, store: InMemoryPdmStore) -> None:
    data = store.export_publication("HCR3A")
    publish_data(graph, data)
    before = totals(graph)
    publish_data(graph, data)
    publish_data(graph, store.export_publication("HCR3A"))
    assert totals(graph) == before


def test_publish_does_not_touch_opms_owned_part_nodes(graph: Driver, store: InMemoryPdmStore) -> None:
    before = part_snapshot(graph)
    publish_data(graph, store.export_publication("HCR3A"))
    assert part_snapshot(graph) == before                                          # 속성도 라벨도 그대로: :Part 는 OPMS 소유


def test_missing_part_stops_before_writing_anything(graph: Driver, store: InMemoryPdmStore) -> None:
    with graph.session() as session:
        session.run("MATCH (p:Part {part_no: 'P-00000000140'}) DETACH DELETE p").consume()
    before = totals(graph)
    with pytest.raises(GraphPublishError) as e:
        publish_data(graph, store.export_publication("HCR3A"))
    assert e.value.code == "part_missing" and e.value.details == ["P-00000000140"]
    assert totals(graph) == before and count(graph, "MATCH (n:PdmItem) RETURN count(n) AS n") == 0


def _same_revision_pair(d: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    seen: dict[int, dict[str, Any]] = {}
    for line in d["lines"]:
        if line["revision_id"] in seen:
            return seen[line["revision_id"]], line
        seen[line["revision_id"]] = line
    raise AssertionError("한 리비전에 BOM 줄이 둘 이상인 시드가 필요하다")


def _dup_find_no(d: dict[str, Any]) -> None:
    first, second = _same_revision_pair(d)
    second["find_no"] = first["find_no"]


@pytest.mark.parametrize(("name", "tamper", "rule"), [
    ("수량 0", lambda d: d["lines"][0].update(quantity=0), "bom_quantity_positive"),
    ("도면 번호 중복", _dup_find_no, "bom_find_no_unique"),
    ("이름 없음", lambda d: d["items"][0].update(name=""), "item_name_required"),
    ("조달 구분 오류", lambda d: d["items"][0].update(item_type="weird"), "item_type_valid"),
    ("질량 음수", lambda d: d["items"][4].update(mass_kg=-1.0), "mass_positive"),
])
def test_check_failure_rolls_everything_back(graph: Driver, store: InMemoryPdmStore, name: str, tamper: Any, rule: str) -> None:
    data = copy.deepcopy(store.export_publication("HCR3A"))
    tamper(data)
    before = totals(graph)
    with pytest.raises(GraphPublishError) as e:
        publish_data(graph, data)
    assert e.value.code == "check_failed", name
    assert rule in {v["rule"] for v in e.value.details}, (name, e.value.details)
    assert totals(graph) == before, "위반이 있으면 쓴 것이 모두 롤백돼야 한다"
    assert count(graph, "MATCH (n:PdmItem) RETURN count(n) AS n") == 0


def test_new_release_moves_current_revision(graph: Driver, store: InMemoryPdmStore) -> None:
    data = store.export_publication("HCR3A")
    publish_data(graph, data)

    nxt = copy.deepcopy(data)
    r01 = next(r for r in nxt["revisions"] if r["item_id"] == 3 and r["rev"] == "R01")
    r01["status"] = "obsolete"
    nxt["revisions"].append({"id": 9999, "item_id": 3, "rev": "R02", "rev_seq": 2, "status": "released", "change_note": "J2 브레이크",
                             "released_at": "2026-11-01T09:00:00+09:00", "created_by": 1, "created_at": "2026-11-01T09:00:00+09:00"})
    nxt["lines"] += [dict(l, revision_id=9999) for l in data["lines"] if l["revision_id"] == r01["id"]]
    nxt["current"] = [c if c["item_id"] != 3 else {"item_id": 3, "revision_id": 9999} for c in nxt["current"]]
    publish_data(graph, nxt)

    with graph.session() as session:
        cur = session.run("MATCH (:PdmItem {pdm_item_id: 3})-[:CURRENT_REVISION]->(r) RETURN r.rev AS rev").data()
        assert cur == [{"rev": "R02"}]                                             # 옛 현재 리비전 관계는 지워지고 하나만 남는다
        states = session.run("MATCH (:PdmItem {pdm_item_id: 3})-[:HAS_REVISION]->(r) RETURN r.rev AS rev, r.status AS s ORDER BY r.rev_seq").data()
        assert states == [{"rev": "R00", "s": "obsolete"}, {"rev": "R01", "s": "obsolete"}, {"rev": "R02", "s": "released"}]
