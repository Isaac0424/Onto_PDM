// =====================================================================
// Onto PDM — Neo4j(LPG) 스키마. Neo4j 5.26 Community 에서 돌아간다 (OPMS compose 와 같은 이미지).
//   설계 설명: docs/neo4j-lpg-design.md
//
// 규칙
//   * OPMS 가 만드는 제약·인덱스(Part.part_no, Class.code …)는 여기서 다시 만들지 않는다.
//   * 여기 있는 라벨(PdmItem, ItemRevision, ProductModel, PartIdentifier, MaterialProfile)은
//     PDM 이 소유한다. OPMS 의 ontology sync 는 이 라벨을 건드리지 않는다.
//   * PDM 은 OPMS 의 :Part 에 라벨도 속성도 달지 않는다. 품번은 (:PdmItem)-[:OF_PART]->(:Part) 로만 잇는다.
//   * Community 는 고유 제약만 있다. 존재·타입·관계 개수 규칙은 neo4j/checks.cypher 가 검사한다.
//   * 모두 IF NOT EXISTS 라서 여러 번 실행해도 된다.
// =====================================================================

// 품목: PG item.id 와 1:1. 품번(part_no)은 OPMS 가 소유하는 Part 의 고유 키다.
CREATE CONSTRAINT pdm_item_id IF NOT EXISTS
  FOR (n:PdmItem) REQUIRE n.pdm_item_id IS UNIQUE;

// 승인 리비전: PG item_revision.id 와 1:1
CREATE CONSTRAINT pdm_revision_id IF NOT EXISTS
  FOR (n:ItemRevision) REQUIRE n.pdm_revision_id IS UNIQUE;

// 제품(모델): PG product.code
CREATE CONSTRAINT product_model_code IF NOT EXISTS
  FOR (n:ProductModel) REQUIRE n.code IS UNIQUE;

// 품번 별칭: key = '<scheme>|<norm_key(value)>'
CREATE CONSTRAINT part_identifier_key IF NOT EXISTS
  FOR (n:PartIdentifier) REQUIRE n.key IS UNIQUE;

// 재료 프로필(밀도): 재료 개념(Concept.code)마다 하나
CREATE CONSTRAINT material_profile_concept IF NOT EXISTS
  FOR (n:MaterialProfile) REQUIRE n.concept_code IS UNIQUE;

// 별칭을 정규화한 값으로 찾는다 ('BLT-0038' = 'blt 0038')
CREATE INDEX part_identifier_norm IF NOT EXISTS
  FOR (n:PartIdentifier) ON (n.norm);

// 조달 구분(assembly · part · standard · purchased)으로 거르는 목록
CREATE INDEX pdm_item_type IF NOT EXISTS
  FOR (n:PdmItem) ON (n.item_type);

// 이름 검색(PG 의 pg_trgm 자리). 한글은 cjk 분석기(2글자 단위)로 쪼갠다.
CREATE FULLTEXT INDEX pdm_item_name_ft IF NOT EXISTS
  FOR (n:PdmItem) ON EACH [n.name, n.name_ko]
  OPTIONS { indexConfig: { `fulltext.analyzer`: 'cjk' } };

CALL db.awaitIndexes();
