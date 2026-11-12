// =====================================================================
// 변경 영향 분석 예시 데이터 — 목표 제품 BRK-M8 (M8 체결 브래킷 모듈). 품번 · 수량 · 값은 docs/change-impact-ontology.md 6장과 같다.
//   모든 문장이 MERGE 라 여러 번 실행해도 결과가 같다(발행기가 같은 승인본을 다시 발행해도 안전해야 한다).
//   시험 · 설명용이다. 앱 화면의 데이터가 아니며, 외부(ERP · MES) 사본은 모두 source_system = 'fixture' 로 구분한다.
//
//   이 파일은 PDM 의 몫만 쓴다: PdmItem(+OF_PART) · 리비전 · BOM · 제품 · RevisionAttribute · FastenedJoint ·
//   외부 읽기 사본 · 승인된 변경 지시. OPMS 의 :Part · 분류 · 재료 값은 이미 있는 것을 읽기만 하고, :Part 에는 라벨도 속성도 달지 않는다.
//   전제: neo4j/schema.cypher · neo4j/changes-schema.cypher 를 먼저 올렸고, :Part 가 이미 있다(격리 시험은
//         neo4j/test/opms-standin.cypher · changes-opms-standin.cypher). neo4j/sample.cypher 와 같은 DB 에는 올리지 않는다
//         (같은 :Part P-…01 에 PDM 품목이 둘이 되어 part_one_item 이 위반이다).
//
//   구조 (기준선 R00)
//     BRK-M8 모듈 R00 → 상판(8mm) · 하판(8mm) · 체결 세트 R00 → 육각볼트 M8x30 ×4 · 육각너트 M8 ×4 · 평와셔 M8 ×8
//     OPMS :Part 가 없는 것: 모듈 · 상판 · 하판 · 체결 세트(opms_registered = false + item_no)
//   승인된 변경 (그래프에는 승인된 지시만 있다)
//     CO-2026-0002 (SC-2) 상판 두께 8 → 12 mm + 볼트를 플랜지 M8x40 으로 교체 + 와셔 8 → 4. 일련번호 71 이후 일부 범위로만 적용
//                         → 상판 · 체결 세트 · 모듈에 R00(released)과 R01(released, 현재)이 함께 있다
//     CO-2026-0003 (SC-3) 볼트 P-…01 도면에 검사 조건 추가(규격 값 그대로) = 같은 품번의 새 개정. 전체 범위 → R00 은 obsolete
//   SC-1(너트를 가는나사 P-…23 으로 교체)은 짝 불일치(blocked)라 승인할 수 없어서 그래프에 지시가 없다. 대상 부품(P-…23)만 있다.
// =====================================================================

// ---------- 제품 구성 품목: PDM 노드 ----------
//   OPMS 미등록 품목은 item_no 로 구분한다. 규격품은 OF_PART 로 OPMS :Part 에 잇는다(품번은 :Part 에만 있다).
UNWIND [
  {id: 2000, item_no: 'BRK-M8',     type: 'assembly', name: 'M8 Bracket Module', name_ko: 'M8 체결 브래킷 모듈'},
  {id: 2001, item_no: 'BRK-M8-P01', type: 'part',     name: 'Top Bracket',       name_ko: '상판 브래킷'},
  {id: 2002, item_no: 'BRK-M8-P02', type: 'part',     name: 'Bottom Bracket',    name_ko: '하판 브래킷'},
  {id: 2003, item_no: 'BRK-M8-SET', type: 'assembly', name: 'Fastener Set',      name_ko: '체결 세트'}
] AS row
MERGE (i:PdmItem {pdm_item_id: row.id})
  SET i.item_no = row.item_no, i.item_type = row.type, i.name = row.name, i.name_ko = row.name_ko, i.uom = 'EA',
      i.opms_registered = false;

UNWIND [
  {id: 2101, part_no: 'P-00000000001', name: 'Hex Bolt M8x30',          name_ko: '육각볼트 M8x30'},
  {id: 2102, part_no: 'P-00000000022', name: 'Hex Nut M8',              name_ko: '육각너트 M8'},
  {id: 2103, part_no: 'P-00000000025', name: 'Flat Washer M8',          name_ko: '평와셔 M8'},
  {id: 2104, part_no: 'P-00000000023', name: 'Hex Nut M8 Fine Thread',  name_ko: '육각너트 M8 가는나사'},
  {id: 2105, part_no: 'P-00000000015', name: 'Hex Flange Bolt M8x40',   name_ko: '육각플랜지볼트 M8x40'}
] AS row
MATCH (p:Part {part_no: row.part_no})
MERGE (i:PdmItem {pdm_item_id: row.id})
  SET i.item_type = 'standard', i.name = row.name, i.name_ko = row.name_ko, i.uom = 'EA'
MERGE (i)-[:OF_PART]->(p);

// ---------- 승인 리비전 ----------
//   R00: 모두 승인. R01: 일부 범위로 적용한 SC-2(상판 · 체결 세트 · 모듈)와 전체 범위로 적용한 SC-3(볼트 도면).
//   일부 범위로 적용한 개정은 이전 개정(R00)도 released 로 남는다(이미 만든 제품 · 진행 중 작업이 기존 사양을 쓴다).
UNWIND [
  {id: 3000, item: 2000, rev: 'R00', seq: 0, status: 'released', current: false, at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 3001, item: 2001, rev: 'R00', seq: 0, status: 'released', current: false, at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 3002, item: 2002, rev: 'R00', seq: 0, status: 'released', current: true,  at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 3003, item: 2003, rev: 'R00', seq: 0, status: 'released', current: false, at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 3101, item: 2101, rev: 'R00', seq: 0, status: 'obsolete', current: false, at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 3102, item: 2102, rev: 'R00', seq: 0, status: 'released', current: true,  at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 3103, item: 2103, rev: 'R00', seq: 0, status: 'released', current: true,  at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 3104, item: 2104, rev: 'R00', seq: 0, status: 'released', current: true,  at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 3105, item: 2105, rev: 'R00', seq: 0, status: 'released', current: true,  at: '2026-11-01T09:00:00+09:00', note: '최초 승인'},
  {id: 3111, item: 2101, rev: 'R01', seq: 1, status: 'released', current: true,  at: '2026-11-25T10:00:00+09:00', note: '도면에 검사 조건 추가(규격 값 그대로)'},
  {id: 3200, item: 2000, rev: 'R01', seq: 1, status: 'released', current: true,  at: '2026-11-20T10:00:00+09:00', note: '상판 두께 · 체결 세트 변경에 따른 모듈 개정'},
  {id: 3201, item: 2001, rev: 'R01', seq: 1, status: 'released', current: true,  at: '2026-11-20T10:00:00+09:00', note: '상판 두께 8 → 12 mm'},
  {id: 3203, item: 2003, rev: 'R01', seq: 1, status: 'released', current: true,  at: '2026-11-20T10:00:00+09:00', note: '볼트를 플랜지 M8x40 으로 교체, 와셔 8 → 4'}
] AS row
MATCH (i:PdmItem {pdm_item_id: row.item})
MERGE (r:ItemRevision {pdm_revision_id: row.id})
  SET r.rev = row.rev, r.rev_seq = row.seq, r.status = row.status,
      r.released_at = datetime(row.at), r.change_note = row.note
MERGE (i)-[:HAS_REVISION]->(r)
FOREACH (_ IN CASE WHEN row.current THEN [1] ELSE [] END | MERGE (i)-[:CURRENT_REVISION]->(r));

// ---------- BOM 줄: 부모는 리비전, 자식은 품목 ----------
UNWIND [
  {rev: 3000, child: 2001, qty: 1.0, find: 1}, {rev: 3000, child: 2002, qty: 1.0, find: 2}, {rev: 3000, child: 2003, qty: 1.0, find: 3},
  {rev: 3200, child: 2001, qty: 1.0, find: 1}, {rev: 3200, child: 2002, qty: 1.0, find: 2}, {rev: 3200, child: 2003, qty: 1.0, find: 3},
  {rev: 3003, child: 2101, qty: 4.0, find: 1}, {rev: 3003, child: 2102, qty: 4.0, find: 2}, {rev: 3003, child: 2103, qty: 8.0, find: 3},
  {rev: 3203, child: 2105, qty: 4.0, find: 1}, {rev: 3203, child: 2102, qty: 4.0, find: 2}, {rev: 3203, child: 2103, qty: 4.0, find: 3}
] AS row
MATCH (r:ItemRevision {pdm_revision_id: row.rev})
MATCH (c:PdmItem {pdm_item_id: row.child})
MERGE (r)-[l:CONTAINS]->(c)
  SET l.quantity = row.qty, l.find_no = row.find;

// ---------- 제품(모델) ----------
MATCH (root:PdmItem {pdm_item_id: 2000})
MERGE (m:ProductModel {code: 'BRK-M8'})
  SET m.pdm_product_id = 2, m.name = 'M8 체결 브래킷 모듈'
MERGE (m)-[:ROOT_ITEM]->(root);

// ---------- PDM 소유 수치: 판 두께 (OPMS 에 없다. 규격 값이 아니라 설계 값) ----------
UNWIND [
  {rev: 3001, value: 8.0,  source: 'drawing'},
  {rev: 3002, value: 8.0,  source: 'drawing'},
  {rev: 3201, value: 12.0, source: 'drawing'}
] AS row
MATCH (r:ItemRevision {pdm_revision_id: row.rev})
MERGE (a:RevisionAttribute {attr_key: toString(row.rev) + '|thickness'})
  SET a.key = 'thickness', a.value = row.value, a.unit = 'mm', a.source = row.source, a.confirmed = true, a.approximate = false
MERGE (r)-[:HAS_ATTR]->(a);

// ---------- 체결 접합부: 조립품(체결 세트) 개정이 가진다. 어느 판을 어느 볼트 · 너트 · 와셔로 조이는가 ----------
UNWIND [
  {rev: 3003, bolt: 2101, nut: 2102, washer: 2103, per_bolt: 2},
  {rev: 3203, bolt: 2105, nut: 2102, washer: 2103, per_bolt: 1}
] AS row
MATCH (r:ItemRevision {pdm_revision_id: row.rev})
MATCH (top:PdmItem {pdm_item_id: 2001}), (bot:PdmItem {pdm_item_id: 2002})
MATCH (b:PdmItem {pdm_item_id: row.bolt}), (n:PdmItem {pdm_item_id: row.nut}), (w:PdmItem {pdm_item_id: row.washer})
MERGE (j:FastenedJoint {joint_key: toString(row.rev) + '|상·하판 체결'})
  SET j.name = '상·하판 체결', j.bolt_count = 4, j.washers_per_bolt = row.per_bolt, j.source = 'manual', j.confirmed = true
MERGE (r)-[:HAS_JOINT]->(j)
MERGE (j)-[:CLAMPS {stack_order: 1}]->(top)
MERGE (j)-[:CLAMPS {stack_order: 2}]->(bot)
MERGE (j)-[:USES_BOLT]->(b)
MERGE (j)-[:USES_NUT]->(n)
MERGE (j)-[:USES_WASHER]->(w);

// ---------- 외부(ERP · MES) 읽기 사본: 시험 픽스처. 앱 화면에 쓰지 않는다 ----------
UNWIND [
  {wo: 'WO-FX-0001', st: 'completed',   lot: 'LOT-2610', ser_from: 1,  ser_to: 50,  site: 'S1', plan: 50.0, done: 50.0, start: '2026-11-03'},
  {wo: 'WO-FX-0002', st: 'in_progress', lot: 'LOT-2611', ser_from: 51, ser_to: 80,  site: 'S1', plan: 30.0, done: 12.0, start: '2026-11-10'},
  {wo: 'WO-FX-0003', st: 'released',    lot: 'LOT-2612', ser_from: 81, ser_to: 120, site: 'S2', plan: 40.0, done: 0.0,  start: '2026-12-02'}
] AS row
MATCH (r:ItemRevision {pdm_revision_id: 3000})
MERGE (w:WorkOrder {wo_no: row.wo})
  SET w.status = row.st, w.lot_no = row.lot, w.serial_from = row.ser_from, w.serial_to = row.ser_to, w.site = row.site,
      w.qty_planned = row.plan, w.qty_done = row.done, w.start_date = date(row.start), w.process_rev = 'P01',
      w.source_system = 'fixture', w.as_of = datetime('2026-11-12T09:00:00+09:00')
MERGE (w)-[:USES_BOM]->(r);

UNWIND [
  {po: 'PO-FX-100', line: 10, item: 2102, ordered: 200.0, received: 80.0, site: 'S1', st: 'partial'},
  {po: 'PO-FX-100', line: 20, item: 2101, ordered: 100.0, received: 0.0,  site: 'S2', st: 'open'}
] AS row
MATCH (i:PdmItem {pdm_item_id: row.item})
MERGE (p:PurchaseOrderLine {po_line_key: row.po + '/' + toString(row.line)})
  SET p.po_no = row.po, p.line_no = row.line, p.ordered_rev = 'R00', p.qty_ordered = row.ordered, p.qty_received = row.received,
      p.qty_open = row.ordered - row.received, p.site = row.site, p.status = row.st,
      p.source_system = 'fixture', p.as_of = datetime('2026-11-12T09:00:00+09:00')
MERGE (p)-[:ORDERS]->(i);

UNWIND [
  {lot: 'LT-N-01', item: 2102, no: 'P-00000000022', qty: 300.0, site: 'S1', st: 'available'},
  {lot: 'LT-N-02', item: 2102, no: 'P-00000000022', qty: 50.0,  site: 'S2', st: 'available'},
  {lot: 'LT-B-01', item: 2101, no: 'P-00000000001', qty: 500.0, site: 'S1', st: 'available'}
] AS row
MATCH (i:PdmItem {pdm_item_id: row.item})
MERGE (s:StockLot {lot_key: row.lot + '|' + row.no})
  SET s.lot_no = row.lot, s.qty_on_hand = row.qty, s.qty_allocated = 0.0, s.site = row.site, s.status = row.st,
      s.source_system = 'fixture', s.as_of = datetime('2026-11-12T09:00:00+09:00')
MERGE (s)-[:STOCK_OF]->(i);

// =====================================================================
// 승인된 변경 지시 (그래프에는 승인된 것만 있다)
// =====================================================================

// ---------- 요청 · 지시 ----------
UNWIND [
  {cr: 'CR-2026-0002', co: 'CO-2026-0002', title: '상판 두께 8 → 12 mm', reason: '상판 강성 보강',
   by: 'lee', req_at: '2026-11-13T09:00:00+09:00', ok_by: 'choi', ok_at: '2026-11-20T10:00:00+09:00', run: 2},
  {cr: 'CR-2026-0003', co: 'CO-2026-0003', title: '볼트 도면에 검사 조건 추가', reason: '수입 검사 항목 보강',
   by: 'lee', req_at: '2026-11-22T09:00:00+09:00', ok_by: 'choi', ok_at: '2026-11-25T10:00:00+09:00', run: 1}
] AS row
MERGE (cr:ChangeRequest {code: row.cr})
  SET cr.title = row.title, cr.reason = row.reason, cr.origin = 'design', cr.status = 'accepted',
      cr.requested_by = row.by, cr.requested_at = datetime(row.req_at), cr.product_code = 'BRK-M8'
MERGE (co:ChangeOrder {code: row.co})
  SET co.status = 'approved', co.product_code = 'BRK-M8', co.approved_by = row.ok_by, co.approved_at = datetime(row.ok_at),
      co.approved_run_id = row.run, co.ontology_version = '0.19.0'
MERGE (co)-[:ISSUED_FROM]->(cr);

// ---------- 변경 대상 ----------
//   CHANGES = 바꾸는 품목의 현재 개정 · IN_PARENT = (교체 · BOM 줄 편집이면) 줄이 들어 있는 조립품의 개정
//   REPLACES = 교체할 새 품목 · RESULTED_IN = 승인으로 생긴 새 개정(교체 · BOM 편집이면 조립품의 새 개정)
//   CASCADES_TO = 상위 조립품에 연쇄로 생긴 새 개정
UNWIND [
  {co: 'CO-2026-0002', id: 1, kind: 'attribute_edit', item: 'BRK-M8-P01', rev_from: 'R00', rev_to: 'R01', parent: null, repl: null,
   before: '{"thickness": 8}', after: '{"thickness": 12}', note: '상판 두께',
   changes: 3001, in_parent: null, replaces: null, result: 3201, cascade: 3200},
  {co: 'CO-2026-0002', id: 2, kind: 'replace', item: 'P-00000000001', rev_from: 'R00', rev_to: 'R01', parent: 'R00', repl: 'P-00000000015',
   before: '{"item": "P-00000000001"}', after: '{"item": "P-00000000015"}', note: '육각볼트 M8x30 → 육각플랜지볼트 M8x40',
   changes: 3101, in_parent: 3003, replaces: 2105, result: 3203, cascade: 3200},
  {co: 'CO-2026-0002', id: 3, kind: 'bom_edit', item: 'P-00000000025', rev_from: 'R00', rev_to: 'R01', parent: 'R00', repl: null,
   before: '{"quantity": 8}', after: '{"quantity": 4}', note: '플랜지볼트라 머리 쪽 와셔가 필요 없다',
   changes: 3103, in_parent: 3003, replaces: null, result: 3203, cascade: 3200},
  {co: 'CO-2026-0003', id: 1, kind: 'revise', item: 'P-00000000001', rev_from: 'R00', rev_to: 'R01', parent: null, repl: null,
   before: '{}', after: '{"note": "수입 검사 조건 추가"}', note: '규격 값은 그대로, 같은 품번의 새 개정',
   changes: 3101, in_parent: null, replaces: null, result: 3111, cascade: null}
] AS row
MATCH (co:ChangeOrder {code: row.co})
MERGE (t:ChangeTarget {target_key: row.co + '#' + toString(row.id)})
  SET t.target_id = row.id, t.change_kind = row.kind, t.item_no = row.item, t.from_revision = row.rev_from, t.to_revision = row.rev_to,
      t.parent_revision = row.parent, t.replacement_item_no = row.repl, t.before_json = row.before, t.after_json = row.after, t.note = row.note
MERGE (co)-[:HAS_TARGET]->(t)
WITH t, row
MATCH (c:ItemRevision {pdm_revision_id: row.changes})
MERGE (t)-[:CHANGES]->(c)
WITH t, row
MATCH (nr:ItemRevision {pdm_revision_id: row.result})
MERGE (t)-[:RESULTED_IN]->(nr)
FOREACH (pid IN CASE WHEN row.in_parent IS NULL THEN [] ELSE [row.in_parent] END |
  MERGE (p:ItemRevision {pdm_revision_id: pid}) MERGE (t)-[:IN_PARENT]->(p))
FOREACH (iid IN CASE WHEN row.replaces IS NULL THEN [] ELSE [row.replaces] END |
  MERGE (n:PdmItem {pdm_item_id: iid}) MERGE (t)-[:REPLACES]->(n))
FOREACH (cid IN CASE WHEN row.cascade IS NULL THEN [] ELSE [row.cascade] END |
  MERGE (m:ItemRevision {pdm_revision_id: cid}) MERGE (t)-[:CASCADES_TO]->(m));

// ---------- 적용 범위 ----------
//   SC-2: 2026-12-01 부터, 일련번호 71 이후만 새 개정(applies = 'new'). 그 앞의 제품 · 작업은 기존 개정을 쓴다.
//   SC-3: 제한 없는 전체 범위(날짜 · 사업장 · 로트 · 일련번호를 지정하지 않음) → 이전 개정은 obsolete.
UNWIND [
  {t: 'CO-2026-0002#1', eff_from: date('2026-12-01'), serial_from: 71, note: '일련번호 71 이후'},
  {t: 'CO-2026-0002#2', eff_from: date('2026-12-01'), serial_from: 71, note: '일련번호 71 이후'},
  {t: 'CO-2026-0002#3', eff_from: date('2026-12-01'), serial_from: 71, note: '일련번호 71 이후'},
  {t: 'CO-2026-0003#1', eff_from: null,               serial_from: null, note: '전체 범위'}
] AS row
MATCH (t:ChangeTarget {target_key: row.t})
MERGE (s:ApplicabilityScope {scope_key: row.t})
  SET s.effective_from = row.eff_from, s.serial_from = row.serial_from, s.applies = 'new', s.note = row.note
MERGE (t)-[:SCOPED_BY]->(s);

// ---------- 영향 발견 ----------
//   CO-2026-0002: 분석 1(이력: 상판 12mm 만 보면 그립 부족 → blocked)과 분석 2(승인된 분석: 볼트 교체 · 와셔 4 를 더해 해소).
//   분석 2 의 발견이 '지금의 영향'이다(ChangeOrder.approved_run_id = 2). 분석 2 의 그립 발견이 분석 1 의 것을 SUPERSEDES 한다.
UNWIND [
  {co: 'CO-2026-0002', run: 1, id: 1,  kind: 'fit_grip', subj_type: 'joint', subj: '3003|상·하판 체결', sev: 'blocked', verdict: 'no',
   reason: 'shortfall', msg: '필요 길이 32.5 mm, 볼트 30 mm — 2.5 mm 부족', rule: 'pdm:grip_length', req: 32.5, act: 30.0, gap: 2.5,
   scope_class: null, suggest: 'block_change', aff_kind: 'joint', aff: '3003|상·하판 체결', aff_id: null},
  {co: 'CO-2026-0002', run: 2, id: 1,  kind: 'fit_grip', subj_type: 'joint', subj: '3203|상·하판 체결', sev: 'none', verdict: 'ok',
   reason: 'grip_ok', msg: '필요 길이 30.9 mm, 볼트 40 mm — 여유 9.1 mm(과대 길이는 판정하지 않는다)', rule: 'pdm:grip_length', req: 30.9, act: 40.0, gap: null,
   scope_class: null, suggest: null, aff_kind: 'joint', aff: '3203|상·하판 체결', aff_id: null},
  {co: 'CO-2026-0002', run: 2, id: 2,  kind: 'fit_pair', subj_type: 'joint', subj: '3203|상·하판 체결', sev: 'none', verdict: 'ok',
   reason: 'pair_fits', msg: '볼트 P-…15 ↔ 너트 P-…22: 나사 호칭 · 피치 일치', rule: 'bolt_nut', req: null, act: null, gap: null,
   scope_class: null, suggest: null, aff_kind: 'joint', aff: '3203|상·하판 체결', aff_id: null},
  {co: 'CO-2026-0002', run: 2, id: 3,  kind: 'substitute', subj_type: 'joint', subj: '3203|상·하판 체결', sev: 'review', verdict: 'conditional',
   reason: 'substitute_conditional', msg: '플랜지볼트가 육각볼트 + 평와셔를 대신한다: 와셔 수량 변경(8 → 4)과 같이 승인', rule: 'flange_bolt_for_bolt_washer', req: null, act: null, gap: null,
   scope_class: null, suggest: 'review_with_design', aff_kind: 'joint', aff: '3203|상·하판 체결', aff_id: null},
  {co: 'CO-2026-0002', run: 2, id: 4,  kind: 'bom_usage', subj_type: 'revision', subj: 'BRK-M8-SET R00', sev: 'none', verdict: null,
   reason: 'where_used', msg: '체결 세트 R00 이 모듈 R00 에 들어 있다', rule: null, req: null, act: null, gap: null,
   scope_class: null, suggest: 'acknowledge', aff_kind: 'revision', aff: null, aff_id: 3000},
  {co: 'CO-2026-0002', run: 2, id: 5,  kind: 'work_order', subj_type: 'work_order', subj: 'WO-FX-0001', sev: 'none', verdict: null,
   reason: 'used_in_completed', msg: '생산 완료(일련번호 1~50): 범위 밖, 기존 사양 허용', rule: null, req: null, act: null, gap: null,
   scope_class: 'outside', suggest: 'use_as_is', aff_kind: 'work_order', aff: 'WO-FX-0001', aff_id: null},
  {co: 'CO-2026-0002', run: 2, id: 6,  kind: 'work_order', subj_type: 'work_order', subj: 'WO-FX-0002', sev: 'affected', verdict: null,
   reason: 'used_in_progress', msg: '진행 중(일련번호 51~80): 71~80 만 범위에 걸린다 — 별도 변경 검토', rule: null, req: null, act: null, gap: null,
   scope_class: 'partial', suggest: 'change_in_progress', aff_kind: 'work_order', aff: 'WO-FX-0002', aff_id: null},
  {co: 'CO-2026-0002', run: 2, id: 7,  kind: 'work_order', subj_type: 'work_order', subj: 'WO-FX-0003', sev: 'affected', verdict: null,
   reason: 'used_in_progress', msg: '미착수(일련번호 81~120): 범위 안 — 새 개정을 쓴다', rule: null, req: null, act: null, gap: null,
   scope_class: 'inside', suggest: 'apply_new', aff_kind: 'work_order', aff: 'WO-FX-0003', aff_id: null},
  {co: 'CO-2026-0002', run: 2, id: 8,  kind: 'purchase_order_line', subj_type: 'purchase_order', subj: 'PO-FX-100/20', sev: 'affected', verdict: null,
   reason: 'open_po_line', msg: '구 볼트 미입고 100 — 발주를 바꿀지 정한다', rule: null, req: null, act: null, gap: null,
   scope_class: null, suggest: 'amend', aff_kind: 'po', aff: 'PO-FX-100/20', aff_id: null},
  {co: 'CO-2026-0002', run: 2, id: 9,  kind: 'stock_lot', subj_type: 'stock_lot', subj: 'LT-B-01|P-00000000001', sev: 'affected', verdict: null,
   reason: 'stock_on_hand', msg: '구 볼트 재고 500 — 소진할지 격리할지 정한다', rule: null, req: null, act: null, gap: null,
   scope_class: null, suggest: 'use_up', aff_kind: 'stock', aff: 'LT-B-01|P-00000000001', aff_id: null},
  {co: 'CO-2026-0003', run: 1, id: 1,  kind: 'bom_usage', subj_type: 'revision', subj: 'BRK-M8-SET R00', sev: 'none', verdict: null,
   reason: 'where_used', msg: '볼트 P-…01 이 체결 세트에 들어 있다. 규격이 같아 체결 판정은 하지 않는다', rule: null, req: null, act: null, gap: null,
   scope_class: null, suggest: 'acknowledge', aff_kind: 'revision', aff: null, aff_id: 3003}
] AS row
MATCH (co:ChangeOrder {code: row.co})
MERGE (f:ImpactFinding {finding_key: row.co + '#' + toString(row.run) + '#' + toString(row.id)})
  SET f.finding_id = row.id, f.run_id = row.run, f.kind = row.kind, f.subject_type = row.subj_type, f.subject_ref = row.subj,
      f.severity = row.sev, f.verdict = row.verdict, f.reason_code = row.reason, f.summary = row.msg,
      f.basis_ontology_version = '0.19.0', f.basis_rule_id = row.rule,
      f.basis_as_of = datetime('2026-11-18T09:00:00+09:00'), f.computed_at = datetime('2026-11-18T09:00:00+09:00'),
      f.temporary = (row.kind IN ['fit_pair', 'fit_grip', 'strength_grade', 'substitute']),
      f.approximate = false, f.inputs_json = '{}',
      f.required = row.req, f.actual = row.act, f.gap = row.gap, f.scope_class = row.scope_class, f.suggested_disposition = row.suggest
MERGE (co)-[:HAS_FINDING]->(f)
WITH f, row
OPTIONAL MATCH (jt:FastenedJoint {joint_key: row.aff}) WHERE row.aff_kind = 'joint'
OPTIONAL MATCH (rv:ItemRevision {pdm_revision_id: row.aff_id}) WHERE row.aff_kind = 'revision'
OPTIONAL MATCH (wo:WorkOrder {wo_no: row.aff}) WHERE row.aff_kind = 'work_order'
OPTIONAL MATCH (po:PurchaseOrderLine {po_line_key: row.aff}) WHERE row.aff_kind = 'po'
OPTIONAL MATCH (sl:StockLot {lot_key: row.aff}) WHERE row.aff_kind = 'stock'
FOREACH (x IN CASE WHEN jt IS NULL THEN [] ELSE [jt] END | MERGE (f)-[:AFFECTS]->(x))
FOREACH (x IN CASE WHEN rv IS NULL THEN [] ELSE [rv] END | MERGE (f)-[:AFFECTS]->(x))
FOREACH (x IN CASE WHEN wo IS NULL THEN [] ELSE [wo] END | MERGE (f)-[:AFFECTS]->(x))
FOREACH (x IN CASE WHEN po IS NULL THEN [] ELSE [po] END | MERGE (f)-[:AFFECTS]->(x))
FOREACH (x IN CASE WHEN sl IS NULL THEN [] ELSE [sl] END | MERGE (f)-[:AFFECTS]->(x));

// 어느 변경 때문에 생긴 영향인가
MATCH (f:ImpactFinding {finding_key: 'CO-2026-0002#1#1'}), (t:ChangeTarget {target_key: 'CO-2026-0002#1'}) MERGE (f)-[:CAUSED_BY]->(t);
MATCH (f:ImpactFinding {finding_key: 'CO-2026-0002#2#3'}), (t:ChangeTarget {target_key: 'CO-2026-0002#2'}) MERGE (f)-[:CAUSED_BY]->(t);
MATCH (f:ImpactFinding {finding_key: 'CO-2026-0002#2#9'}), (t:ChangeTarget {target_key: 'CO-2026-0002#2'}) MERGE (f)-[:CAUSED_BY]->(t);

// 재분석: 분석 2 의 그립 발견이 분석 1 의 것을 대체한다 (이력은 남는다)
MATCH (nw:ImpactFinding {finding_key: 'CO-2026-0002#2#1'}), (old:ImpactFinding {finding_key: 'CO-2026-0002#1#1'})
MERGE (nw)-[:SUPERSEDES]->(old);

// ---------- 처분 결정 (영향 ≠ 변경: 영향마다 사람이 어떻게 할지 정한다) ----------
//   finding_severity · finding_reason_code 는 결정할 때 본 영향의 값이다 (결정 뒤에 영향이 바뀌지 않았는지 검사한다)
UNWIND [
  {co: 'CO-2026-0002', id: 1, f: 'CO-2026-0002#2#3', kind: 'substitute',          action: 'review_with_design', reason: '체결 구성(볼트 교체 · 와셔 4) 승인',            by: 'lee'},
  {co: 'CO-2026-0002', id: 2, f: 'CO-2026-0002#2#6', kind: 'work_order',          action: 'change_in_progress', reason: '71~80 은 별도 변경 검토, 51~70 은 옛 개정으로 마무리', by: 'choi'},
  {co: 'CO-2026-0002', id: 3, f: 'CO-2026-0002#2#7', kind: 'work_order',          action: 'apply_new',          reason: '시작 전이라 새 개정을 쓴다',                       by: 'choi'},
  {co: 'CO-2026-0002', id: 4, f: 'CO-2026-0002#2#8', kind: 'purchase_order_line', action: 'amend',              reason: '남은 100 개는 플랜지볼트로 변경 요청',              by: 'park'},
  {co: 'CO-2026-0002', id: 5, f: 'CO-2026-0002#2#9', kind: 'stock_lot',           action: 'use_up',             reason: '구 볼트 재고는 소진 후 전환',                      by: 'park'}
] AS row
MATCH (co:ChangeOrder {code: row.co})
MATCH (f:ImpactFinding {finding_key: row.f})
MERGE (d:Disposition {disposition_key: row.co + '#' + toString(row.id)})
  SET d.disposition_id = row.id, d.finding_kind = row.kind, d.action = row.action, d.reason = row.reason, d.decided_by = row.by,
      d.decided_at = datetime('2026-11-19T15:00:00+09:00'), d.finding_severity = f.severity, d.finding_reason_code = f.reason_code
REMOVE d.superseded_by
MERGE (d)-[:DECIDES]->(f)
MERGE (co)-[:HAS_DISPOSITION]->(d);

// 처분이 자기 범위로 덮어쓸 수 있다: 진행 중 작업의 처분은 71~80 에만
MATCH (d:Disposition {disposition_key: 'CO-2026-0002#2'})
MERGE (s:ApplicabilityScope {scope_key: 'CO-2026-0002#d2'})
  SET s.serial_from = 71, s.serial_to = 80, s.applies = 'new', s.note = 'WO-FX-0002 의 71~80'
MERGE (d)-[:SCOPED_BY]->(s);

// ---------- 부서별 검토 서명: 설계는 늘, 구매는 발주 · 재고가, 생산은 작업지시가 affected 일 때 ----------
UNWIND [
  {co: 'CO-2026-0002', id: 1, fn: 'design',     run: 2, by: 'lee',  comment: '체결 구성 확인'},
  {co: 'CO-2026-0002', id: 2, fn: 'purchasing', run: 2, by: 'park', comment: '발주 변경 가능'},
  {co: 'CO-2026-0002', id: 3, fn: 'production', run: 2, by: 'choi', comment: '일련번호 71 이후 적용'},
  {co: 'CO-2026-0003', id: 1, fn: 'design',     run: 1, by: 'lee',  comment: '도면 개정'}
] AS row
MATCH (co:ChangeOrder {code: row.co})
MERGE (r:ReviewSignoff {review_key: row.co + '#' + toString(row.id)})
  SET r.function = row.fn, r.verdict = 'approve', r.reviewer = row.by, r.comment = row.comment, r.run_id = row.run,
      r.reviewed_at = datetime('2026-11-19T16:00:00+09:00')
MERGE (co)-[:HAS_REVIEW]->(r);

// ---------- 온톨로지 버전 변경 보고 (읽기 보고. 개정도 요청도 만들지 않는다) ----------
MERGE (oi:OntologyImpact {oi_key: '0.18.0>0.19.0'})
  SET oi.from_version = '0.18.0', oi.to_version = '0.19.0', oi.computed_at = datetime('2026-11-12T09:00:00+09:00'),
      oi.rules_changed = ['bolt_length_vs_hole_depth'], oi.parts_flagged = [];
