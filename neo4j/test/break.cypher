// =====================================================================
// 일부러 망가뜨린 데이터 — neo4j/test/verify.py 가 sample.cypher 위에 올린 뒤 checks.cypher 가 모두 잡는지 본다.
//   (ontology/tests/check_ontology.py 의 '망가뜨린 데이터는 거부된다'와 같은 역할)
//   :Part 쪽을 고치는 문장은 'OPMS 가 소유한 값이 틀어졌을 때 PDM 검사가 잡는가'를 보려는 것이다.
// =====================================================================

// material_required: 표준품의 재료 연결(OPMS 의 HAS_VALUE)이 끊겼다
MATCH (:Part {part_no: 'P-00000000002'})-[h:HAS_VALUE {prop: 'material'}]->(:Concept) DELETE h;

// one_current_revision, current_is_revision_of_item: 다른 품목의 리비전을 현재로 건다
MATCH (i:PdmItem)-[:OF_PART]->(:Part {part_no: 'P-00000000001'}), (r:ItemRevision {pdm_revision_id: 1002})
CREATE (i)-[:CURRENT_REVISION]->(r);

// material_in_scheme: 재료 체계에 속하지 않은 개념을 재료로
CREATE (:Concept {code: 'NotAMaterial'});
MATCH (p:Part {part_no: 'P-00000000020'}), (c:Concept {code: 'NotAMaterial'})
CREATE (p)-[:HAS_VALUE {prop: 'material'}]->(c);

// bom_quantity_positive
MATCH (:ItemRevision {pdm_revision_id: 1011})-[l:CONTAINS]->(:PdmItem)-[:OF_PART]->(:Part {part_no: 'P-00000000001'}) SET l.quantity = 0;

// bom_find_no_unique: 너트의 도면 번호를 볼트와 같게
MATCH (:ItemRevision {pdm_revision_id: 1011})-[l:CONTAINS]->(:PdmItem)-[:OF_PART]->(:Part {part_no: 'P-00000000002'}) SET l.find_no = 1;

// bom_find_no_integer
MATCH (:ItemRevision {pdm_revision_id: 1011})-[l:CONTAINS]->(:PdmItem)-[:OF_PART]->(:Part {part_no: 'P-00000000003'}) SET l.find_no = '3';

// bom_child_once: 같은 자식을 CREATE 로 한 줄 더
MATCH (r:ItemRevision {pdm_revision_id: 1030}), (c:PdmItem)-[:OF_PART]->(:Part {part_no: 'P-00000000003'})
CREATE (r)-[:CONTAINS {quantity: 1.0, find_no: 2}]->(c);

// bom_child_is_item: PDM 품목이 아니라 OPMS 의 :Part 를 바로 자식으로
CREATE (:Part {part_no: 'P-00000000099'});
MATCH (r:ItemRevision {pdm_revision_id: 1030}), (c:Part {part_no: 'P-00000000099'})
CREATE (r)-[:CONTAINS {quantity: 1.0, find_no: 3}]->(c);

// bom_no_cycle: 체결 세트가 본체를 포함
MATCH (r:ItemRevision {pdm_revision_id: 1011}), (top:PdmItem)-[:OF_PART]->(:Part {part_no: 'P-00000000020'})
CREATE (r)-[:CONTAINS {quantity: 1.0, find_no: 9}]->(top);

// density_positive
MATCH (mp:MaterialProfile {concept_code: 'SS400'}) SET mp.density_g_cm3 = -7.85;

// profile_one_concept: 개념 없이 떠 있는 프로필
CREATE (:MaterialProfile {concept_code: 'GHOST', density_g_cm3: 1.0});

// part_no_format: 옛 형식 (OPMS 의 :Part 품번이 형식을 벗어난 경우)
MATCH (p:Part {part_no: 'P-00000000003'}) SET p.part_no = 'P0000003';

// item_name_required
MATCH (i:PdmItem)-[:OF_PART]->(:Part {part_no: 'P-00000000030'}) SET i.name = null;

// item_type_valid
MATCH (i:PdmItem)-[:OF_PART]->(:Part {part_no: 'P-00000000010'}) SET i.item_type = 'weird';

// mass_positive
MATCH (i:PdmItem)-[:OF_PART]->(:Part {part_no: 'P-00000000001'}) SET i.mass_kg = -1.0;

// item_one_part: :Part 에 붙지 않은 PDM 품목
CREATE (:PdmItem {pdm_item_id: 999, item_type: 'part', name: 'orphan', uom: 'EA'});

// item_one_part 의 예외: opms_registered = false 인 가공품은 :Part 없이도 위반이 아니다(#997 은 잡히면 안 된다).
//   규격품(standard)은 같은 표시가 있어도 예외가 아니다(#996 은 잡혀야 한다) — neo4j/test/verify_changes.py 가 subject 로 확인한다.
CREATE (:PdmItem {pdm_item_id: 997, item_type: 'part', name: 'unregistered plate', uom: 'EA', opms_registered: false, item_no: 'X-997'});
CREATE (:PdmItem {pdm_item_id: 996, item_type: 'standard', name: 'unregistered standard', uom: 'EA', opms_registered: false, item_no: 'X-996'});

// part_one_item: 같은 품번에 PDM 품목이 하나 더
MATCH (p:Part {part_no: 'P-00000000001'})
CREATE (:PdmItem {pdm_item_id: 998, item_type: 'part', name: 'duplicate', uom: 'EA'})-[:OF_PART]->(p);

// revision_status_valid, current_is_released: 작업중 리비전이 새어 나온 경우
MATCH (r:ItemRevision {pdm_revision_id: 1030}) SET r.status = 'wip';

// revision_label_required
MATCH (r:ItemRevision {pdm_revision_id: 1003}) REMOVE r.rev;

// revision_owner: 주인 없는 리비전
CREATE (:ItemRevision {pdm_revision_id: 9999, rev: 'R00', rev_seq: 0, status: 'released'});

// product_root_assembly, product_one_root: HCR5A 에 부품을 두 번째 최상위로
MATCH (m:ProductModel {code: 'HCR5A'}), (i:PdmItem)-[:OF_PART]->(:Part {part_no: 'P-00000000001'})
WHERE i.pdm_item_id = 1
CREATE (m)-[:ROOT_ITEM]->(i);

// identifier_scheme_valid, identifier_owner, identifier_key
CREATE (:PartIdentifier {key: 'foo|X', scheme: 'foo', value: 'x', norm: 'Y'});
