// =====================================================================
// 질의 — OWL2-RL 추론(하위 클래스 · 하위 속성 · 속성 사슬 · 이행 관계)이 하던 일을 경로 질의로 옮긴 것.
//   Neo4j 는 추론기가 없다. 저장하지 않은 관계는 질의가 따라가서 찾는다.
//   BOM 따라가기는 수량화 경로 패턴(5.9+)을 쓴다: ( … )+ 는 '한 번 이상 반복'이다.
//   품번(part_no)은 OPMS 의 :Part 에만 있으므로 (:PdmItem)-[:OF_PART]->(:Part) 로 건너가 읽는다.
//   "// @이름 ($인자)" 줄이 질의 하나의 시작이다 (neo4j/test/verify.py 가 이 표지로 나눈다).
// =====================================================================

// ---------- hasComponent (속성 사슬): 현재 승인 BOM 의 한 단계 아래 ----------
// @direct_components ($part_no)
MATCH (top:PdmItem)-[:OF_PART]->(:Part {part_no: $part_no})
MATCH (top)-[:CURRENT_REVISION]->(:ItemRevision)-[l:CONTAINS]->(:PdmItem)-[:OF_PART]->(cp:Part)
RETURN cp.part_no AS part_no, l.quantity AS quantity, l.find_no AS find_no
ORDER BY l.find_no;

// ---------- hasComponentTransitive + PG bom_explode: 모든 단계의 하위 품목과 누적 수량 ----------
//   RDF 에서는 수량을 SPARQL 로 곱할 수 없어 PostgreSQL bom_explode 가 계산했다. 그래프 경로에서는 곱할 수 있다.
//   같은 부품이 여러 갈래로 들어가면 갈래마다 곱한 값을 더한다. 승인(PG)이 원본이고 이 질의는 그래프 쪽 사본으로 하는 조회다.
// @bom_explode ($part_no)
MATCH (top:PdmItem)-[:OF_PART]->(:Part {part_no: $part_no})
MATCH (top) ( (:PdmItem)-[:CURRENT_REVISION]->(:ItemRevision)-[l:CONTAINS]->(:PdmItem) )+ (leaf:PdmItem)
MATCH (leaf)-[:OF_PART]->(lp:Part)
RETURN lp.part_no AS part_no, size(l) AS level, sum(reduce(q = 1.0, x IN l | q * x.quantity)) AS total_quantity
ORDER BY level, part_no;

// ---------- 역전개(where-used): 이 품목이 들어간 모든 상위 품목 ----------
// @where_used ($part_no)
MATCH (leaf:PdmItem)-[:OF_PART]->(:Part {part_no: $part_no})
MATCH (top:PdmItem) ( (:PdmItem)-[:CURRENT_REVISION]->(:ItemRevision)-[:CONTAINS]->(:PdmItem) )+ (leaf)
MATCH (top)-[:OF_PART]->(tp:Part)
RETURN DISTINCT tp.part_no AS part_no
ORDER BY part_no;

// ---------- "이 재료(상위 개념 포함)가 들어간 모든 제품" ----------
//   RDF: ?m a cls:M0111 (하위 클래스 추론). LPG: 재료 개념의 BROADER 를 따라 올라간다.
//   제품 → 최상위 조립품 → 전 단계 하위 품목(자기 자신 포함) → (OPMS 의 :Part 가 가진) 재료
// @products_with_material ($material)
MATCH (m:ProductModel)-[:ROOT_ITEM]->(root:PdmItem)
MATCH (root) ( (:PdmItem)-[:CURRENT_REVISION]->(:ItemRevision)-[:CONTAINS]->(:PdmItem) )* (part:PdmItem)
MATCH (part)-[:OF_PART]->(:Part)-[:HAS_VALUE {prop: 'material'}]->(:Concept)-[:BROADER*0..]->(:Concept {code: $material})
RETURN DISTINCT m.code AS product
ORDER BY product;

// ---------- 하위 클래스 추론: 이 분류(하위 포함)의 품목 ----------
// @items_of_class ($class)
MATCH (:PdmItem)-[:OF_PART]->(p:Part)-[:INSTANCE_OF]->(:Class)-[:SUBCLASS_OF*0..]->(:Class {code: $class})
RETURN p.part_no AS part_no
ORDER BY part_no;

// ---------- 하위 속성 추론(altPartNumber): 종류와 상관없이 별칭 하나로 찾기 ----------
//   RDF 는 legacyPartNumber · erpCode … 를 altPartNumber 의 하위 속성으로 두고 추론으로 모았다.
//   LPG 는 별칭이 모두 :PartIdentifier 라서 종류를 따지지 않으면 그대로 모인다. 종류로 좁히려면 a.scheme 를 건다.
// @find_by_alias ($norm)
MATCH (:PartIdentifier {norm: $norm})-[:IDENTIFIES]->(:PdmItem)-[:OF_PART]->(p:Part)
RETURN DISTINCT p.part_no AS part_no
ORDER BY part_no;

// ---------- 리비전 이력 ----------
// @revisions ($part_no)
MATCH (i:PdmItem)-[:OF_PART]->(:Part {part_no: $part_no})
MATCH (i)-[:HAS_REVISION]->(r:ItemRevision)
RETURN r.rev AS rev, r.status AS status, EXISTS { (i)-[:CURRENT_REVISION]->(r) } AS is_current
ORDER BY r.rev_seq;

// ---------- 이름 검색 (PG pg_trgm 자리) ----------
// @search_name ($q)
CALL db.index.fulltext.queryNodes('pdm_item_name_ft', $q) YIELD node, score
MATCH (node)-[:OF_PART]->(p:Part)
RETURN p.part_no AS part_no
ORDER BY score DESC, part_no;
