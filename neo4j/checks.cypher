// =====================================================================
// 데이터 검사 — ontology/shapes-data.ttl(SHACL)을 Cypher 로 옮긴 것.
//   검사마다 위반을 한 줄씩 (rule, subject, message) 로 돌려준다. 결과가 없으면 통과다.
//   발행기는 승인본을 쓴 같은 트랜잭션에서 이 검사를 돌리고, 한 줄이라도 나오면 롤백한다 (SHACL 의 '커밋 거부' 자리).
//   Neo4j Community 에는 존재 · 타입 제약이 없어서 이 검사가 그 일을 한다.
//
//   null 안전: 속성이 없거나 타입이 다르면 비교가 null 이 되어 WHERE 에서 빠진다.
//   그래서 '양수여야 한다'는 NOT coalesce(x > 0, false) 로 쓴다 (OPMS PRD 10.3 'null 안전 비교').
//
//   소유 구분: 이 파일은 PDM 이 소유한 것(:PdmItem · ItemRevision · BOM · ProductModel · MaterialProfile · PartIdentifier)과
//   그것이 OPMS 의 :Part 로 건너가는 연결(OF_PART)만 검사한다. :Part 안의 불변식(재료 속성과 HAS_VALUE 가 같다,
//   품번 예약이 있다, record_origin 이 목록에 있다 등)은 OPMS 가 소유하고 OPMS reconcile 이 검사하므로 여기서 하지 않는다.
//   검사 대상: PDM 이 가져간 품목(:PdmItem)만. OPMS 가 등록했고 PDM 이 아직 가져가지 않은 :Part 는 보지 않는다.
//
//   subject 는 가능하면 품번(part_no)이다. 품번으로 건너갈 :Part 가 없으면 '#<pdm_item_id>'.
//   "// @이름" 줄이 검사 하나의 시작이다 (neo4j/test/verify.py 가 이 표지로 나눈다).
// =====================================================================

// ---------- 품목 ↔ 품목 마스터 연결 ----------

// PDM 품목은 OPMS 품목 마스터(:Part) 정확히 하나에 붙는다
// @item_one_part
MATCH (i:PdmItem)
WHERE COUNT { (i)-[:OF_PART]->(:Part) } <> 1
RETURN 'item_one_part' AS rule, '#' + toString(i.pdm_item_id) AS subject, '품목은 정확히 한 :Part 에 OF_PART 로 붙는다' AS message;

// 한 :Part 에는 PDM 품목이 하나만 (같은 품번이 PDM 에 두 번 들어오면 안 된다)
// @part_one_item
MATCH (p:Part)
WHERE COUNT { (:PdmItem)-[:OF_PART]->(p) } > 1
RETURN 'part_one_item' AS rule, p.part_no AS subject, '한 품번에 PDM 품목이 둘 이상이다' AS message;

// ---------- 품목 (ItemShape · MaterialRequiredShape) ----------

// @part_no_format
MATCH (:PdmItem)-[:OF_PART]->(p:Part)
WHERE NOT coalesce(p.part_no =~ 'P-[0-9]{11}', false)
RETURN 'part_no_format' AS rule, p.part_no AS subject, '품번은 P- 와 숫자 11자리 (OPMS settings.part_no)' AS message;

// @item_name_required
MATCH (i:PdmItem)
WHERE NOT coalesce(trim(i.name) <> '', false)
OPTIONAL MATCH (i)-[:OF_PART]->(p:Part)
RETURN 'item_name_required' AS rule, coalesce(p.part_no, '#' + toString(i.pdm_item_id)) AS subject, '이름(name)이 필요하다' AS message;

// @item_type_valid
MATCH (i:PdmItem)
WHERE NOT coalesce(i.item_type IN ['assembly', 'part', 'standard', 'purchased'], false)
OPTIONAL MATCH (i)-[:OF_PART]->(p:Part)
RETURN 'item_type_valid' AS rule, coalesce(p.part_no, '#' + toString(i.pdm_item_id)) AS subject, '조달 구분은 assembly · part · standard · purchased' AS message;

// 가공품 · 표준품은 재료가 있어야 한다 (조립품 · 일반 구매품은 없어도 된다). 재료 값은 OPMS 가 :Part 에 둔 것을 읽는다
// @material_required
MATCH (i:PdmItem)-[:OF_PART]->(p:Part)
WHERE i.item_type IN ['part', 'standard']
  AND NOT EXISTS { (p)-[:HAS_VALUE {prop: 'material'}]->(:Concept) }
RETURN 'material_required' AS rule, p.part_no AS subject, '가공품 · 표준품은 재료가 필요하다' AS message;

// 재료는 재료 체계(material)의 개념이어야 한다
// @material_in_scheme
MATCH (:PdmItem)-[:OF_PART]->(p:Part)-[:HAS_VALUE {prop: 'material'}]->(c:Concept)
WHERE NOT EXISTS { (c)-[:IN_SCHEME]->(:Scheme {code: 'material'}) }
RETURN 'material_in_scheme' AS rule, p.part_no AS subject, '재료는 material 체계의 개념이어야 한다: ' + c.code AS message;

// 질량은 kg 단위 양수 하나
// @mass_positive
MATCH (i:PdmItem)
WHERE i.mass_kg IS NOT NULL AND NOT coalesce(i.mass_kg > 0, false)
OPTIONAL MATCH (i)-[:OF_PART]->(p:Part)
RETURN 'mass_positive' AS rule, coalesce(p.part_no, '#' + toString(i.pdm_item_id)) AS subject, '질량은 kg 단위 양수' AS message;

// ---------- 리비전 (ItemRevisionShape) ----------

// 승인본만 발행한다: 작업중(wip) · 검토중은 그래프에 없다
// @revision_status_valid
MATCH (r:ItemRevision)
WHERE NOT coalesce(r.status IN ['released', 'obsolete'], false)
RETURN 'revision_status_valid' AS rule, toString(r.pdm_revision_id) AS subject, '발행된 리비전은 released 또는 obsolete 만' AS message;

// @revision_label_required
MATCH (r:ItemRevision)
WHERE NOT coalesce(trim(r.rev) <> '', false)
RETURN 'revision_label_required' AS rule, toString(r.pdm_revision_id) AS subject, '리비전 표기(rev) 하나 필수' AS message;

// 리비전은 품목 하나에만 속한다
// @revision_owner
MATCH (r:ItemRevision)
WHERE COUNT { (r)<-[:HAS_REVISION]-(:PdmItem) } <> 1
RETURN 'revision_owner' AS rule, toString(r.pdm_revision_id) AS subject, '리비전은 정확히 한 품목의 HAS_REVISION 이어야 한다' AS message;

// 현재 승인 리비전은 하나만 (owl:subPropertyOf 가 하던 'CURRENT 는 HAS 의 일부'도 여기서 지킨다)
// @one_current_revision
MATCH (i:PdmItem)-[:CURRENT_REVISION]->(r:ItemRevision)
WITH i, count(r) AS n
WHERE n > 1
OPTIONAL MATCH (i)-[:OF_PART]->(p:Part)
RETURN 'one_current_revision' AS rule, coalesce(p.part_no, '#' + toString(i.pdm_item_id)) AS subject, '현재 승인 리비전은 하나만: ' + toString(n) + '개' AS message;

// @current_is_revision_of_item
MATCH (i:PdmItem)-[:CURRENT_REVISION]->(r:ItemRevision)
WHERE NOT EXISTS { (i)-[:HAS_REVISION]->(r) }
OPTIONAL MATCH (i)-[:OF_PART]->(p:Part)
RETURN 'current_is_revision_of_item' AS rule, coalesce(p.part_no, '#' + toString(i.pdm_item_id)) AS subject, '현재 리비전은 이 품목의 리비전이어야 한다' AS message;

// @current_is_released
MATCH (i:PdmItem)-[:CURRENT_REVISION]->(r:ItemRevision)
WHERE NOT coalesce(r.status = 'released', false)
OPTIONAL MATCH (i)-[:OF_PART]->(p:Part)
RETURN 'current_is_released' AS rule, coalesce(p.part_no, '#' + toString(i.pdm_item_id)) AS subject, '현재 리비전은 released 여야 한다: ' + coalesce(r.status, 'null') AS message;

// ---------- BOM (BomLineShape) ----------

// BOM 의 자식은 PDM 품목이다 (OPMS 의 :Part 를 바로 가리키면 안 된다)
// @bom_child_is_item
MATCH (:ItemRevision)-[:CONTAINS]->(c)
WHERE NOT c:PdmItem
RETURN 'bom_child_is_item' AS rule, coalesce(c.part_no, toString(elementId(c))) AS subject, 'BOM 의 자식은 PDM 품목(:PdmItem)이어야 한다' AS message;

// @bom_quantity_positive
MATCH (r:ItemRevision)-[l:CONTAINS]->(c:PdmItem)
WHERE NOT coalesce(l.quantity > 0, false)
RETURN 'bom_quantity_positive' AS rule, toString(r.pdm_revision_id) + ' -> #' + toString(c.pdm_item_id) AS subject, '수량은 양수 하나' AS message;

// @bom_find_no_integer
MATCH (r:ItemRevision)-[l:CONTAINS]->(c:PdmItem)
WHERE l.find_no IS NOT NULL AND NOT l.find_no IS :: INTEGER
RETURN 'bom_find_no_integer' AS rule, toString(r.pdm_revision_id) + ' -> #' + toString(c.pdm_item_id) AS subject, '도면 번호는 정수' AS message;

// 같은 리비전 안에서 도면 번호는 겹치지 않는다 (PG: bom_line_find_no_uq)
// @bom_find_no_unique
MATCH (r:ItemRevision)-[l:CONTAINS]->(:PdmItem)
WHERE l.find_no IS NOT NULL
WITH r, l.find_no AS find_no, count(*) AS n
WHERE n > 1
RETURN 'bom_find_no_unique' AS rule, toString(r.pdm_revision_id) AS subject, '도면 번호가 겹친다: ' + toString(find_no) AS message;

// 같은 자식은 한 줄로 합친다 (PG: UNIQUE (parent_revision_id, child_item_id)). MERGE 로 쓰면 생기지 않지만 CREATE 로 쓰면 생긴다
// @bom_child_once
MATCH (r:ItemRevision)-[l:CONTAINS]->(c:PdmItem)
WITH r, c, count(l) AS n
WHERE n > 1
RETURN 'bom_child_once' AS rule, toString(r.pdm_revision_id) + ' -> #' + toString(c.pdm_item_id) AS subject, '같은 자식이 ' + toString(n) + '줄: 수량으로 합친다' AS message;

// 현재 승인 BOM 을 따라 자기 자신으로 돌아오면 안 된다
// @bom_no_cycle
MATCH (i:PdmItem)
MATCH (i) ( (:PdmItem)-[:CURRENT_REVISION]->(:ItemRevision)-[:CONTAINS]->(:PdmItem) )+ (i)
OPTIONAL MATCH (i)-[:OF_PART]->(p:Part)
RETURN DISTINCT 'bom_no_cycle' AS rule, coalesce(p.part_no, '#' + toString(i.pdm_item_id)) AS subject, 'BOM 이 자기 자신을 포함한다' AS message;

// ---------- 제품 (ProductShape) ----------

// @product_root_assembly
MATCH (m:ProductModel)-[:ROOT_ITEM]->(r)
WHERE NOT coalesce(r.item_type = 'assembly', false)
RETURN 'product_root_assembly' AS rule, m.code AS subject, '제품의 최상위 품목은 조립품(PDM 품목)' AS message;

// @product_one_root
MATCH (m:ProductModel)
WHERE COUNT { (m)-[:ROOT_ITEM]->() } <> 1
RETURN 'product_one_root' AS rule, m.code AS subject, '제품의 최상위 품목은 정확히 하나' AS message;

// ---------- 재료 프로필 (MaterialShape) ----------

// @density_positive
MATCH (mp:MaterialProfile)
WHERE NOT coalesce(mp.density_g_cm3 > 0, false)
RETURN 'density_positive' AS rule, mp.concept_code AS subject, '밀도는 g/cm³ 단위 양수' AS message;

// @profile_one_concept
MATCH (mp:MaterialProfile)
WHERE COUNT { (mp)-[:PROFILE_OF]->(:Concept) } <> 1
RETURN 'profile_one_concept' AS rule, mp.concept_code AS subject, '재료 프로필은 재료 개념 하나에 붙는다' AS message;

// ---------- 품번 별칭 ----------

// @identifier_scheme_valid
MATCH (a:PartIdentifier)
WHERE NOT coalesce(a.scheme IN ['legacy', 'erp', 'mes', 'supplier', 'customer', 'drawing', 'cad_name'], false)
RETURN 'identifier_scheme_valid' AS rule, coalesce(a.key, '(key 없음)') AS subject, '별칭 종류가 목록에 없다: ' + coalesce(a.scheme, 'null') AS message;

// @identifier_owner
MATCH (a:PartIdentifier)
WHERE COUNT { (a)-[:IDENTIFIES]->(:PdmItem) } <> 1
RETURN 'identifier_owner' AS rule, coalesce(a.key, '(key 없음)') AS subject, '별칭은 정확히 한 품목을 가리킨다' AS message;

// @identifier_key
MATCH (a:PartIdentifier)
WHERE NOT coalesce(a.key = a.scheme + '|' + a.norm, false)
RETURN 'identifier_key' AS rule, coalesce(a.key, '(key 없음)') AS subject, 'key 는 scheme|norm 이어야 한다' AS message;
