// =====================================================================
// OPMS 가 이미 만들어 둔 것의 '축소 모사'. 격리 시험(neo4j/test/verify.py)에서만 쓴다.
//   실제 DB 에서는 실행하지 않는다 — OPMS 가 소유하는 라벨이라 sync · 등록이 만든 것과 겹치면 안 된다.
//   원본: D:\ernest_hemingway_OPMS  ontology/classes.yaml · ontology/vocab/concepts.csv ·
//         src/registry/ontology/ddl.py · docs/PRD.md 10.3(그래프 모델) · 10.4(seed load)
//
//   1) ontology sync 가 만드는 것: :Class · :Scheme · :Concept 과 관계
//   2) OPMS 등록 경로(여기서는 seed load 로 모사)가 만드는 것: :Part · :PartReservation · INSTANCE_OF · HAS_VALUE
//      :Part 의 속성은 OPMS 온톨로지 값 + 예약 키(part_no, created_at, updated_at, record_origin, blocking_key)뿐이다.
//      PDM 의 값(이름 · 조달 구분 · 질량 …)은 여기에 없고 :PdmItem 에 있다.
//      조립품(P-…10 · 20 · 30)은 OPMS 분류에 해당 클래스가 없어 INSTANCE_OF 없이 둔다 (docs/neo4j-lpg-design.md 6장).
// =====================================================================

CREATE CONSTRAINT class_code IF NOT EXISTS FOR (n:Class) REQUIRE n.code IS UNIQUE;
CREATE CONSTRAINT scheme_code IF NOT EXISTS FOR (n:Scheme) REQUIRE n.code IS UNIQUE;
CREATE CONSTRAINT concept_code IF NOT EXISTS FOR (n:Concept) REQUIRE n.code IS UNIQUE;
CREATE CONSTRAINT part_no IF NOT EXISTS FOR (n:Part) REQUIRE n.part_no IS UNIQUE;
CREATE CONSTRAINT part_reservation_part_no IF NOT EXISTS FOR (n:PartReservation) REQUIRE n.part_no IS UNIQUE;

// ---------- 1) 온톨로지 (sync) ----------

// 분류 트리 (일부)
UNWIND [
  {code: 'MechanicalPart', parent: null},
  {code: 'Fastener',       parent: 'MechanicalPart'},
  {code: 'Bolt',           parent: 'Fastener'},
  {code: 'HexBolt',        parent: 'Bolt'},
  {code: 'Nut',            parent: 'Fastener'},
  {code: 'HexNut',         parent: 'Nut'},
  {code: 'Washer',         parent: 'Fastener'},
  {code: 'FlatWasher',     parent: 'Washer'}
] AS row
MERGE (c:Class {code: row.code});

UNWIND [
  {code: 'Fastener', parent: 'MechanicalPart'}, {code: 'Bolt', parent: 'Fastener'}, {code: 'HexBolt', parent: 'Bolt'},
  {code: 'Nut', parent: 'Fastener'}, {code: 'HexNut', parent: 'Nut'},
  {code: 'Washer', parent: 'Fastener'}, {code: 'FlatWasher', parent: 'Washer'}
] AS row
MATCH (c:Class {code: row.code}), (p:Class {code: row.parent})
MERGE (c)-[:SUBCLASS_OF]->(p);

// 재료 체계: 강종 미상 상위 개념(Stainless · CarbonSteel)과 등급
MERGE (s:Scheme {code: 'material'});

UNWIND [
  {code: 'Stainless',   broader: null,          selectable: false},
  {code: 'SUS304',      broader: 'Stainless',   selectable: true},
  {code: 'SUS316',      broader: 'Stainless',   selectable: true},
  {code: 'CarbonSteel', broader: null,          selectable: false},
  {code: 'SS400',       broader: 'CarbonSteel', selectable: true}
] AS row
MATCH (s:Scheme {code: 'material'})
MERGE (c:Concept {code: row.code})
  SET c.pref_label = row.code, c.selectable = row.selectable, c.is_none = false
MERGE (c)-[:IN_SCHEME]->(s);

UNWIND [
  {code: 'SUS304', broader: 'Stainless'}, {code: 'SUS316', broader: 'Stainless'}, {code: 'SS400', broader: 'CarbonSteel'}
] AS row
MATCH (c:Concept {code: row.code}), (b:Concept {code: row.broader})
MERGE (c)-[:BROADER]->(b);

// ---------- 2) 품목 마스터 (OPMS 가 소유) ----------
//   값은 정규형(개념은 코드, 길이 · 피치는 mm). 출처는 seed 라 예약도 origin=seed, review_id 없음, used 뿐이다 (OPMS PRD 10.3).
UNWIND [
  {part_no: 'P-00000000001', blocking_key: 'Bolt|threadSize=M8',
   attrs: {threadSize: 'M8', length: 30.0, material: 'SUS304', surfaceTreatment: 'Plain', pitch: 1.25,
           threadDirection: 'RightHand', strengthGrade: 'A2-70'}},
  {part_no: 'P-00000000002', blocking_key: 'Nut|threadSize=M8',
   attrs: {threadSize: 'M8', pitch: 1.25, material: 'SUS304', surfaceTreatment: 'Plain',
           threadDirection: 'RightHand', strengthGrade: 'A2-70'}},
  {part_no: 'P-00000000003', blocking_key: 'Washer|threadSize=M8',
   attrs: {threadSize: 'M8', innerDiameter: 8.4, outerDiameter: 16.0, thickness: 1.6, material: 'SS400',
           surfaceTreatment: 'ZincPlated'}},
  {part_no: 'P-00000000010', blocking_key: null, attrs: {}},
  {part_no: 'P-00000000020', blocking_key: null, attrs: {}},
  {part_no: 'P-00000000030', blocking_key: null, attrs: {}}
] AS row
MERGE (p:Part {part_no: row.part_no})
  ON CREATE SET p.created_at = datetime('2026-11-01T09:00:00+09:00'), p.record_origin = 'seed'
SET p += row.attrs,
    p.updated_at = datetime('2026-11-01T09:00:00+09:00'),
    p.blocking_key = row.blocking_key
MERGE (r:PartReservation {part_no: row.part_no})
  ON CREATE SET r.origin = 'seed', r.status = 'used', r.created_at = p.created_at, r.used_at = p.created_at;

// 분류: (:Part)-[:INSTANCE_OF]->(:Class)
UNWIND [
  {part_no: 'P-00000000001', cls: 'HexBolt'},
  {part_no: 'P-00000000002', cls: 'HexNut'},
  {part_no: 'P-00000000003', cls: 'FlatWasher'}
] AS row
MATCH (p:Part {part_no: row.part_no}), (c:Class {code: row.cls})
MERGE (p)-[:INSTANCE_OF]->(c);

// 개념 값: 노드 속성(material)과 HAS_VALUE 가 항상 같이 쓰인다 (OPMS 불변식)
UNWIND ['P-00000000001', 'P-00000000002', 'P-00000000003'] AS no
MATCH (p:Part {part_no: no})
MATCH (m:Concept {code: p.material})-[:IN_SCHEME]->(:Scheme {code: 'material'})
MERGE (p)-[:HAS_VALUE {prop: 'material'}]->(m);
