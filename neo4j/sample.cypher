// =====================================================================
// 예시 데이터 — ontology/examples/sample-abox.ttl 을 LPG 로 옮긴 것. 품번 · 이름 · 수량은 모두 설명용이다.
//   모든 문장이 MERGE 라 여러 번 실행해도 결과가 같다 (발행기가 같은 승인본을 다시 발행해도 안전해야 한다).
//
//   이 파일은 PDM 의 몫만 쓴다: MaterialProfile · PdmItem(+OF_PART) · 별칭 · 리비전 · BOM · 제품.
//   OPMS 의 :Part · 분류(INSTANCE_OF) · 재료 값(HAS_VALUE)은 OPMS 등록 경로가 이미 만들어 둔 것을 읽기만 한다.
//   :Part 에는 라벨도 속성도 달지 않는다.
//   전제: :Part 가 이미 있다. 없으면 MATCH 가 아무것도 찾지 못해 해당 줄이 조용히 빠진다.
//         격리 시험은 neo4j/test/opms-standin.cypher 를 먼저 올린다.
//
//   구조 (TTL 예시와 같은 모양)
//     HCR3A → 본체(P-…20, R00) → 체결 세트 ×2 → (볼트 ×4 · 너트 ×4 · 와셔 ×8)
//     HCR5A → 커버 조립품(P-…30, R00) → 와셔 ×2
//     체결 세트(P-…10)는 R00(obsolete: 볼트 ×4)과 R01(current)이 있다 → 현재 승인 BOM 만 따라가는지 본다
// =====================================================================

// ---------- 재료 프로필 (PDM 소유): 밀도 g/cm³ ----------
UNWIND [
  {code: 'SUS304', density: 7.93},
  {code: 'SUS316', density: 7.98},
  {code: 'SS400',   density: 7.85}
] AS row
MATCH (c:Concept {code: row.code})-[:IN_SCHEME]->(:Scheme {code: 'material'})
MERGE (mp:MaterialProfile {concept_code: row.code})
  SET mp.density_g_cm3 = row.density
MERGE (mp)-[:PROFILE_OF]->(c);

// ---------- 품목: PDM 노드 + OPMS 품목 마스터로 가는 OF_PART ----------
//   id 는 PG item.id. 이름 · 조달 구분 · 단위 · 질량은 PDM 이 소유한다.
UNWIND [
  {id: 1,  part_no: 'P-00000000001', type: 'standard', name: 'Hex Bolt M8x30', name_ko: '육각볼트 M8x30',
   mass: 0.0245, mass_source: 'cad_estimate'},
  {id: 2,  part_no: 'P-00000000002', type: 'standard', name: 'Hex Nut M8', name_ko: '육각너트 M8',
   mass: null, mass_source: null},
  {id: 3,  part_no: 'P-00000000003', type: 'standard', name: 'Flat Washer M8', name_ko: '평와셔 M8',
   mass: null, mass_source: null},
  {id: 10, part_no: 'P-00000000010', type: 'assembly', name: 'Fastener Set', name_ko: '체결 세트',
   mass: null, mass_source: null},
  {id: 20, part_no: 'P-00000000020', type: 'assembly', name: 'HCR3A Body', name_ko: 'HCR3A 본체',
   mass: null, mass_source: null},
  {id: 30, part_no: 'P-00000000030', type: 'assembly', name: 'Cover Assembly', name_ko: '커버 조립품',
   mass: null, mass_source: null}
] AS row
MATCH (p:Part {part_no: row.part_no})
MERGE (i:PdmItem {pdm_item_id: row.id})
  SET i.item_type = row.type, i.name = row.name, i.name_ko = row.name_ko, i.uom = 'EA',
      i.mass_kg = row.mass, i.mass_source = row.mass_source
MERGE (i)-[:OF_PART]->(p);

// ---------- 품번 별칭 (레거시 · ERP · MES · 공급사 · CAD 이름 …): 별칭마다 노드 하나 ----------
UNWIND [
  {part_no: 'P-00000000001', scheme: 'legacy',   value: 'BLT-0038',       norm: 'BLT0038'},
  {part_no: 'P-00000000001', scheme: 'cad_name', value: 'M8x30',          norm: 'M8X30'},
  {part_no: 'P-00000000001', scheme: 'supplier', value: 'HANBIT:HB-0830', norm: 'HANBITHB0830'},
  {part_no: 'P-00000000002', scheme: 'erp',      value: 'N-0008',         norm: 'N0008'}
] AS row
MATCH (i:PdmItem)-[:OF_PART]->(:Part {part_no: row.part_no})
MERGE (a:PartIdentifier {key: row.scheme + '|' + row.norm})
  SET a.scheme = row.scheme, a.value = row.value, a.norm = row.norm
MERGE (a)-[:IDENTIFIES]->(i);

// ---------- 승인 리비전. 작업중(wip) · 검토중은 발행하지 않으므로 그래프에 없다 ----------
UNWIND [
  {id: 1001, part_no: 'P-00000000001', rev: 'R00', seq: 0, status: 'released', current: true,  at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 1002, part_no: 'P-00000000002', rev: 'R00', seq: 0, status: 'released', current: true,  at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 1003, part_no: 'P-00000000003', rev: 'R00', seq: 0, status: 'released', current: true,  at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 1010, part_no: 'P-00000000010', rev: 'R00', seq: 0, status: 'obsolete', current: false, at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 1011, part_no: 'P-00000000010', rev: 'R01', seq: 1, status: 'released', current: true,  at: '2026-11-05T09:00:00+09:00', note: '너트 · 와셔 추가'},
  {id: 1020, part_no: 'P-00000000020', rev: 'R00', seq: 0, status: 'released', current: true,  at: '2026-11-06T09:00:00+09:00', note: '최초 승인'},
  {id: 1030, part_no: 'P-00000000030', rev: 'R00', seq: 0, status: 'released', current: true,  at: '2026-11-06T09:00:00+09:00', note: '최초 승인'}
] AS row
MATCH (i:PdmItem)-[:OF_PART]->(:Part {part_no: row.part_no})
MERGE (r:ItemRevision {pdm_revision_id: row.id})
  SET r.rev = row.rev, r.rev_seq = row.seq, r.status = row.status,
      r.released_at = datetime(row.at), r.change_note = row.note
MERGE (i)-[:HAS_REVISION]->(r)
FOREACH (_ IN CASE WHEN row.current THEN [1] ELSE [] END | MERGE (i)-[:CURRENT_REVISION]->(r));

// ---------- BOM 줄: TTL 의 BomLine 노드 대신 관계(CONTAINS)에 수량 · 도면 번호를 둔다 ----------
//   부모는 '리비전', 자식은 '품목(PdmItem)'이다. 자식의 어느 리비전을 쓸지는 조회할 때 CURRENT_REVISION 으로 정한다.
UNWIND [
  {rev: 1010, child: 'P-00000000001', qty: 4.0,  find: 1},
  {rev: 1011, child: 'P-00000000001', qty: 4.0,  find: 1},
  {rev: 1011, child: 'P-00000000002', qty: 4.0,  find: 2},
  {rev: 1011, child: 'P-00000000003', qty: 8.0,  find: 3},
  {rev: 1020, child: 'P-00000000010', qty: 2.0,  find: 1},
  {rev: 1030, child: 'P-00000000003', qty: 2.0,  find: 1}
] AS row
MATCH (r:ItemRevision {pdm_revision_id: row.rev})
MATCH (c:PdmItem)-[:OF_PART]->(:Part {part_no: row.child})
MERGE (r)-[l:CONTAINS]->(c)
  SET l.quantity = row.qty, l.find_no = row.find;

// ---------- 제품(모델) ----------
UNWIND [
  {id: 1, code: 'HCR3A', name: 'HCR3A', root: 'P-00000000020'},
  {id: 2, code: 'HCR5A', name: 'HCR5A', root: 'P-00000000030'}
] AS row
MATCH (root:PdmItem)-[:OF_PART]->(:Part {part_no: row.root})
MERGE (m:ProductModel {code: row.code})
  SET m.pdm_product_id = row.id, m.name = row.name
MERGE (m)-[:ROOT_ITEM]->(root);
