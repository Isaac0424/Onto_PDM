// =====================================================================
// OPMS 가 이미 만들어 둔 것의 '축소 모사' 2 — 변경 영향 분석 시험(neo4j/test/verify_changes.py)에서만 쓴다.
//   neo4j/test/opms-standin.cypher 다음에 올린다(분류 · 재료 체계 · 제약은 그쪽이 만든다). 실제 DB 에서는 실행하지 않는다.
//   값은 OPMS 개발 DB(온톨로지 0.19.0, PDM 브랜치)를 2026-11-12 에 읽기 전용으로 읽은 것과 같다:
//     P-…01 HexBolt M8x30 · P-…22 HexNut M8 · P-…23 HexNut M8 가는나사 · P-…25 FlatWasher M8 · P-…15 HexFlangeBolt M8x40.
//   P-…01 은 opms-standin.cypher 에 이미 있으므로 여기서 건드리지 않는다(:Part 의 속성 수가 바뀌지 않게).
//   P-…15 의 속성은 OPMS 개발 DB 에서 직접 확인하지 못했고 OPMS data/demo_seed/parts.yaml 값이다.
//   판 · 모듈 · 체결 세트에는 OPMS :Part 가 없다(OPMS 에 조립품 · 가공품 분류가 없다 — docs/neo4j-lpg-design.md 6장).
// =====================================================================

// 분류: 플랜지 볼트 (opms-standin.cypher 에는 HexBolt · HexNut · FlatWasher 가 있다)
MERGE (c:Class {code: 'HexFlangeBolt'});
MATCH (c:Class {code: 'HexFlangeBolt'}), (p:Class {code: 'Bolt'})
MERGE (c)-[:SUBCLASS_OF]->(p);

UNWIND [
  {part_no: 'P-00000000015', blocking_key: 'Bolt|threadSize=M8',
   attrs: {threadSize: 'M8', length: 40.0, material: 'SUS316', surfaceTreatment: 'Plain', pitch: 1.25,
           threadDirection: 'RightHand', strengthGrade: 'A4-80', flangeDiameter: 17.0}},
  {part_no: 'P-00000000022', blocking_key: 'Nut|threadSize=M8',
   attrs: {threadSize: 'M8', pitch: 1.25, material: 'SUS316', surfaceTreatment: 'Plain',
           threadDirection: 'RightHand', strengthGrade: 'A4-80', widthAcrossFlats: 13.0, nutHeight: 6.8}},
  {part_no: 'P-00000000023', blocking_key: 'Nut|threadSize=M8',
   attrs: {threadSize: 'M8', pitch: 1.0, material: 'SUS304', surfaceTreatment: 'ZincPlated',
           threadDirection: 'RightHand', strengthGrade: 'A2-70', nutHeight: 6.8}},
  {part_no: 'P-00000000025', blocking_key: 'Washer|threadSize=M8',
   attrs: {threadSize: 'M8', innerDiameter: 8.4, outerDiameter: 16.0, thickness: 1.6, material: 'SUS304',
           surfaceTreatment: 'ZincPlated'}}
] AS row
MERGE (p:Part {part_no: row.part_no})
  ON CREATE SET p.created_at = datetime('2026-11-01T09:00:00+09:00'), p.record_origin = 'seed'
SET p += row.attrs,
    p.updated_at = datetime('2026-11-01T09:00:00+09:00'),
    p.blocking_key = row.blocking_key
MERGE (r:PartReservation {part_no: row.part_no})
  ON CREATE SET r.origin = 'seed', r.status = 'used', r.created_at = p.created_at, r.used_at = p.created_at;

UNWIND [
  {part_no: 'P-00000000015', cls: 'HexFlangeBolt'},
  {part_no: 'P-00000000022', cls: 'HexNut'},
  {part_no: 'P-00000000023', cls: 'HexNut'},
  {part_no: 'P-00000000025', cls: 'FlatWasher'}
] AS row
MATCH (p:Part {part_no: row.part_no}), (c:Class {code: row.cls})
MERGE (p)-[:INSTANCE_OF]->(c);

// 개념 값: 노드 속성(material)과 HAS_VALUE 가 항상 같이 쓰인다 (OPMS 불변식)
UNWIND ['P-00000000015', 'P-00000000022', 'P-00000000023', 'P-00000000025'] AS no
MATCH (p:Part {part_no: no})
MATCH (m:Concept {code: p.material})-[:IN_SCHEME]->(:Scheme {code: 'material'})
MERGE (p)-[:HAS_VALUE {prop: 'material'}]->(m);
