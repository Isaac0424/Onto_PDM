"""승인된 제품 BOM 을 Neo4j 에 발행한다 (모델 B: docs/neo4j-lpg-design.md).

- **MERGE 멱등**: 같은 승인본을 다시 발행해도 노드 · 관계 수가 같다. 현재 리비전이 바뀌면 옛 CURRENT_REVISION 을 지우고 새로 건다.
- **한 트랜잭션**: 쓰기와 neo4j/checks.cypher 의 검사(SHACL 의 '커밋 거부' 자리)가 같은 트랜잭션이다. 위반이 한 줄이라도 나오면 롤백한다.
- **:Part 는 만들지 않는다**: 품번 마스터는 OPMS 가 소유한다. 없으면 `part_missing` 으로 멈춘다 (아무것도 쓰기 전에 확인한다).
- 승인본(released · obsolete)만 나간다. 작업중 · 검토중 리비전은 저장소가 내보내지 않는다.
"""

from __future__ import annotations

from typing import Any

from neo4j import Driver, ManagedTransaction

from onto_pdm.graph.cypher import check_statements, schema_statements
from onto_pdm.matching import norm_key
from onto_pdm.store.base import PdmStore


class GraphPublishError(Exception):
    """발행을 거부했다. code: part_missing | check_failed."""

    def __init__(self, code: str, message: str, details: list[Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or []


def apply_schema(driver: Driver) -> int:
    """neo4j/schema.cypher 를 문장마다 자동 커밋으로 적용한다 (IF NOT EXISTS 라 여러 번 해도 된다). 적용한 문장 수를 돌려준다."""
    statements = schema_statements()
    with driver.session() as session:
        for stmt in statements:
            session.run(stmt).consume()
    return len(statements)


# ---------------------------------------------------------------- Cypher (고정 문자열, 값은 모두 파라미터)

MISSING_PARTS = """
UNWIND $item_nos AS no
OPTIONAL MATCH (p:Part {part_no: no})
WITH no, p WHERE p IS NULL
RETURN no
"""

UPSERT_ITEMS = """
UNWIND $items AS row
MATCH (p:Part {part_no: row.item_no})
MERGE (i:PdmItem {pdm_item_id: row.id})
  SET i.item_type = row.item_type, i.name = row.name, i.name_ko = row.name_ko, i.uom = row.unit,
      i.mass_kg = row.mass_kg, i.mass_source = row.mass_source
MERGE (i)-[:OF_PART]->(p)
RETURN count(i) AS n
"""

UPSERT_REVISIONS = """
UNWIND $revisions AS row
MATCH (i:PdmItem {pdm_item_id: row.item_id})
MERGE (r:ItemRevision {pdm_revision_id: row.id})
  SET r.rev = row.rev, r.rev_seq = row.rev_seq, r.status = row.status,
      r.released_at = CASE WHEN row.released_at IS NULL THEN null ELSE datetime(row.released_at) END,
      r.change_note = row.change_note
MERGE (i)-[:HAS_REVISION]->(r)
RETURN count(r) AS n
"""

MOVE_CURRENT = """
UNWIND $current AS row
MATCH (i:PdmItem {pdm_item_id: row.item_id}), (r:ItemRevision {pdm_revision_id: row.revision_id})
OPTIONAL MATCH (i)-[old:CURRENT_REVISION]->(o:ItemRevision) WHERE o <> r
DELETE old
MERGE (i)-[:CURRENT_REVISION]->(r)
RETURN count(r) AS n
"""

# 승인본에서 사라진 현재 리비전 (예: 모든 승인 리비전이 폐기됨)
DROP_STALE_CURRENT = """
MATCH (i:PdmItem)-[old:CURRENT_REVISION]->(:ItemRevision)
WHERE i.pdm_item_id IN $item_ids AND NOT i.pdm_item_id IN $current_item_ids
DELETE old
"""

UPSERT_LINES = """
UNWIND $lines AS row
MATCH (r:ItemRevision {pdm_revision_id: row.revision_id}), (c:PdmItem {pdm_item_id: row.child_item_id})
MERGE (r)-[l:CONTAINS]->(c)
  SET l.quantity = row.quantity, l.find_no = row.find_no
RETURN count(l) AS n
"""

# 리비전의 BOM 에서 빠진 자식은 관계를 지운다 (승인본의 BOM 은 바뀌지 않지만, 다시 발행할 때 PDM 쪽이 정답이다)
PRUNE_LINES = """
UNWIND $keep AS row
MATCH (:ItemRevision {pdm_revision_id: row.revision_id})-[l:CONTAINS]->(c:PdmItem)
WHERE NOT c.pdm_item_id IN row.child_item_ids
DELETE l
"""

UPSERT_IDENTIFIERS = """
UNWIND $identifiers AS row
MATCH (i:PdmItem {pdm_item_id: row.item_id})
MERGE (a:PartIdentifier {key: row.scheme + '|' + row.norm})
  SET a.scheme = row.scheme, a.value = row.value, a.norm = row.norm
MERGE (a)-[:IDENTIFIES]->(i)
RETURN count(a) AS n
"""

PRUNE_IDENTIFIERS = """
UNWIND $keep AS row
MATCH (a:PartIdentifier)-[:IDENTIFIES]->(:PdmItem {pdm_item_id: row.item_id})
WHERE NOT a.key IN row.keys
DETACH DELETE a
"""

# 재료 프로필: 재료 개념(:Concept)은 OPMS 가 소유한다. 없으면 만들지 않고 건너뛴다
UPSERT_MATERIAL_PROFILES = """
UNWIND $materials AS row
MATCH (c:Concept {code: row.concept_code})
MERGE (mp:MaterialProfile {concept_code: row.concept_code})
  SET mp.density_g_cm3 = row.density
MERGE (mp)-[:PROFILE_OF]->(c)
RETURN count(mp) AS n
"""

UPSERT_PRODUCT = """
MATCH (root:PdmItem {pdm_item_id: $root_item_id})
MERGE (m:ProductModel {code: $code})
  SET m.pdm_product_id = $product_id, m.name = $name
WITH m, root
OPTIONAL MATCH (m)-[old:ROOT_ITEM]->(o:PdmItem) WHERE o <> root
DELETE old
MERGE (m)-[:ROOT_ITEM]->(root)
RETURN count(m) AS n
"""


def _n(tx: ManagedTransaction, query: str, **params: Any) -> int:
    record = tx.run(query, **params).single()
    return int(record["n"]) if record else 0


def _publish(tx: ManagedTransaction, data: dict[str, Any]) -> dict[str, int]:
    items, revisions, lines = data["items"], data["revisions"], data["lines"]

    missing = [r["no"] for r in tx.run(MISSING_PARTS, item_nos=[i["item_no"] for i in items])]
    if missing:  # 아무것도 쓰기 전에 멈춘다: :Part 는 OPMS 등록 경로가 만든다
        raise GraphPublishError("part_missing", f":Part 가 없는 품번이 있습니다 (OPMS 에 먼저 등록돼야 합니다): {', '.join(missing)}", missing)

    counts = {"items": _n(tx, UPSERT_ITEMS, items=items)}
    counts["revisions"] = _n(tx, UPSERT_REVISIONS, revisions=revisions)
    counts["current"] = _n(tx, MOVE_CURRENT, current=data["current"])
    tx.run(DROP_STALE_CURRENT, item_ids=[i["id"] for i in items], current_item_ids=[c["item_id"] for c in data["current"]]).consume()
    counts["bom_lines"] = _n(tx, UPSERT_LINES, lines=lines)
    keep = [{"revision_id": r["id"], "child_item_ids": [l["child_item_id"] for l in lines if l["revision_id"] == r["id"]]} for r in revisions]
    tx.run(PRUNE_LINES, keep=keep).consume()

    identifiers = [{**x, "norm": norm_key(x["value"])} for x in data["identifiers"]]
    counts["identifiers"] = _n(tx, UPSERT_IDENTIFIERS, identifiers=identifiers)
    keys_by_item: dict[int, list[str]] = {i["id"]: [] for i in items}
    for x in identifiers:
        keys_by_item[x["item_id"]].append(f'{x["scheme"]}|{x["norm"]}')
    tx.run(PRUNE_IDENTIFIERS, keep=[{"item_id": k, "keys": v} for k, v in keys_by_item.items()]).consume()

    counts["material_profiles"] = _n(tx, UPSERT_MATERIAL_PROFILES, materials=data["materials"])
    p = data["product"]
    counts["products"] = _n(tx, UPSERT_PRODUCT, root_item_id=p["root_item_id"], code=p["code"], product_id=p["id"], name=p["name"])

    # 같은 트랜잭션에서 검사한다: 위반이 하나라도 있으면 예외 → 롤백
    violations: list[dict[str, str]] = []
    for name, query in check_statements().items():
        for row in tx.run(query):
            violations.append({"rule": row["rule"], "subject": row["subject"], "message": row["message"]})
    if violations:
        head = "; ".join(f'{v["rule"]}({v["subject"]})' for v in violations[:5])
        raise GraphPublishError("check_failed", f"데이터 검사 위반 {len(violations)}건: {head}", violations)
    return counts


def publish_data(driver: Driver, data: dict[str, Any]) -> dict[str, int]:
    """export_publication() 이 만든 데이터를 한 트랜잭션으로 발행한다. 실패하면 아무것도 남지 않는다."""
    with driver.session() as session:
        return session.execute_write(_publish, data)


def publish_product(driver: Driver, store: PdmStore, code: str) -> dict[str, int]:
    """제품의 승인 BOM 을 발행한다. 돌려주는 값은 쓴 개수 (items · revisions · current · bom_lines · identifiers · material_profiles · products)."""
    return publish_data(driver, store.export_publication(code))
