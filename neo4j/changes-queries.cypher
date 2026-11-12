// =====================================================================
// 변경 영향 분석 질의 — docs/change-impact-ontology.md 8장. neo4j/queries.cypher 와 같은 형식이다.
//   "// @이름 ($인자)" 줄이 질의 하나의 시작이다 (neo4j/test/verify_changes.py 가 이 표지로 나눈다).
//
//   기존 queries.cypher 의 @where_used · @bom_explode 는 '현재 승인 BOM'(CURRENT_REVISION)만 따라간다.
//   변경 영향 분석은 옛 개정 · 폐기 개정도 봐야 한다(진행 중 작업이 옛 개정을 쓸 수 있다). 그래서 HAS_REVISION 전체를 따라가는
//   cr_* 질의를 따로 둔다. 단순 사용처 목록은 기존 질의를 쓴다.
//
//   $item_ref 는 OPMS 품번(P-…) 또는 OPMS :Part 가 없는 PDM 품목의 item_no(BRK-M8-P01 …) 다.
//   ontology 문서 초안은 $part_no 였다. 판 · 모듈 · 체결 세트에는 품번이 없어서(SC-2 가 상판의 사용처를 묻는다) 둘 다 받게 넓혔다.
//   원본은 PG(where_used · bom_explode)이고 이 질의들은 승인된 변경의 그래프 사본으로 하는 조회다. 승인 전 what-if 는 백엔드가 계산한다.
// =====================================================================

// ---------- 대상 품목이 들어간 모든 BOM 개정(승인 · 옛 개정 · 폐기 포함) ----------
//   대상 → 그것을 담은 모든 개정 → 그 개정의 품목 → 그것을 담은 모든 개정 … 을 끝까지. 후보 전체를 낸다(보수적).
//   상위 개정이 하위의 어느 개정을 쓰는지는 조회 시점의 효력 규칙(CURRENT)으로 정하므로 여기서는 좁히지 않는다.
// @cr_where_used_revisions ($item_ref)
MATCH (leaf:PdmItem)
WHERE leaf.item_no = $item_ref OR EXISTS { (leaf)-[:OF_PART]->(:Part {part_no: $item_ref}) }
MATCH (leaf) ( (:PdmItem)<-[:CONTAINS]-(r:ItemRevision)<-[:HAS_REVISION]-(:PdmItem) )+ (:PdmItem)
UNWIND r AS rev
MATCH (top:PdmItem)-[:HAS_REVISION]->(rev)
OPTIONAL MATCH (top)-[:OF_PART]->(tp:Part)
RETURN DISTINCT coalesce(top.item_no, tp.part_no) AS item, rev.rev AS rev, rev.status AS status, rev.pdm_revision_id AS revision_id
ORDER BY item, rev, revision_id;

// ---------- 위 개정을 쓰는 작업지시 (외부 읽기 사본) ----------
// @cr_impacted_work_orders ($item_ref)
MATCH (leaf:PdmItem)
WHERE leaf.item_no = $item_ref OR EXISTS { (leaf)-[:OF_PART]->(:Part {part_no: $item_ref}) }
MATCH (leaf) ( (:PdmItem)<-[:CONTAINS]-(r:ItemRevision)<-[:HAS_REVISION]-(:PdmItem) )+ (:PdmItem)
UNWIND r AS rev
MATCH (w:WorkOrder)-[:USES_BOM]->(rev)
RETURN DISTINCT w.wo_no AS wo_no, w.status AS status, w.site AS site, w.lot_no AS lot_no,
       w.serial_from AS serial_from, w.serial_to AS serial_to, w.source_system AS source_system
ORDER BY wo_no;

// ---------- 발주 · 재고는 BOM 을 거치지 않고 품목에 바로 걸린다 ----------
//   미입고 발주(qty_open > 0)와 재고 로트(상태 포함)를 한 줄로 묶어 돌려준다.
// @cr_open_po_and_stock ($item_ref)
MATCH (leaf:PdmItem)
WHERE leaf.item_no = $item_ref OR EXISTS { (leaf)-[:OF_PART]->(:Part {part_no: $item_ref}) }
CALL {
  WITH leaf
  OPTIONAL MATCH (po:PurchaseOrderLine)-[:ORDERS]->(leaf)
  WHERE po.qty_open > 0
  RETURN collect(CASE WHEN po IS NULL THEN null ELSE po.po_line_key + ' open=' + toString(toInteger(po.qty_open)) + ' ' + po.site END) AS open_po
}
CALL {
  WITH leaf
  OPTIONAL MATCH (s:StockLot)-[:STOCK_OF]->(leaf)
  RETURN collect(CASE WHEN s IS NULL THEN null ELSE s.lot_no + ' qty=' + toString(toInteger(s.qty_on_hand)) + ' ' + s.site + ' ' + s.status END) AS stock
}
RETURN open_po, stock;

// ---------- 적용 범위(사업장 · 일련번호)에 걸리는 작업지시 ----------
//   지정하지 않은 차원은 null 로 넘기면 통과한다. 일련번호는 구간이 범위 시작 이후와 겹치면 걸린 것이다:
//   full = 구간 전체가 범위 안 · partial = 일부만 겹침 · unknown = 작업지시에 일련번호가 없다 · pass = 범위가 일련번호를 지정하지 않음.
//   (로트 · 날짜까지 합친 종합 판정은 백엔드 scope.classify 가 한다. 이 질의는 그래프 사본으로 후보를 좁히는 용도다.)
// @cr_scope_work_orders ($item_ref, $site, $serial_from)
MATCH (leaf:PdmItem)
WHERE leaf.item_no = $item_ref OR EXISTS { (leaf)-[:OF_PART]->(:Part {part_no: $item_ref}) }
MATCH (leaf) ( (:PdmItem)<-[:CONTAINS]-(r:ItemRevision)<-[:HAS_REVISION]-(:PdmItem) )+ (:PdmItem)
UNWIND r AS rev
MATCH (w:WorkOrder)-[:USES_BOM]->(rev)
WHERE ($site IS NULL OR w.site = $site)
  AND ($serial_from IS NULL OR w.serial_from IS NULL OR w.serial_to IS NULL OR w.serial_to >= $serial_from)
RETURN DISTINCT w.wo_no AS wo_no, w.serial_from AS serial_from, w.serial_to AS serial_to,
       CASE WHEN $serial_from IS NULL THEN 'pass'
            WHEN w.serial_from IS NULL OR w.serial_to IS NULL THEN 'unknown'
            WHEN w.serial_from >= $serial_from THEN 'full'
            ELSE 'partial' END AS serial_overlap
ORDER BY wo_no;

// ---------- 개정 비교(R00 vs R01 BOM diff) ----------
//   승인 뒤의 이력 비교다. 승인 전 what-if 비교는 백엔드가 ChangeTarget.after 를 덧씌워 계산한다.
//   change: removed(A 에만) · added(B 에만) · qty_changed · same
// @cr_bom_diff ($item_ref, $rev_a, $rev_b)
MATCH (i:PdmItem)
WHERE i.item_no = $item_ref OR EXISTS { (i)-[:OF_PART]->(:Part {part_no: $item_ref}) }
MATCH (i)-[:HAS_REVISION]->(a:ItemRevision {rev: $rev_a})
MATCH (i)-[:HAS_REVISION]->(b:ItemRevision {rev: $rev_b})
CALL {
  WITH a, b
  MATCH (a)-[la:CONTAINS]->(c:PdmItem)
  OPTIONAL MATCH (b)-[lb:CONTAINS]->(c)
  RETURN c, la.quantity AS qty_a, lb.quantity AS qty_b,
         CASE WHEN lb IS NULL THEN 'removed' WHEN la.quantity <> lb.quantity THEN 'qty_changed' ELSE 'same' END AS change
  UNION
  WITH a, b
  MATCH (b)-[lb:CONTAINS]->(c:PdmItem)
  WHERE NOT EXISTS { (a)-[:CONTAINS]->(c) }
  RETURN c, null AS qty_a, lb.quantity AS qty_b, 'added' AS change
}
OPTIONAL MATCH (c)-[:OF_PART]->(p:Part)
RETURN coalesce(c.item_no, p.part_no) AS child, qty_a, qty_b, change
ORDER BY child;

// ---------- 승인된 변경 지시의 영향 (승인 때 본 분석) ----------
//   심각한 것부터. 처분이 있으면 action 을 같이 돌려준다(영향 ≠ 변경 — 영향마다 사람이 정한 처분).
// @cr_change_impact ($order_code)
MATCH (co:ChangeOrder {code: $order_code})-[:HAS_FINDING]->(f:ImpactFinding)
WHERE f.run_id = co.approved_run_id
OPTIONAL MATCH (d:Disposition)-[:DECIDES]->(f)
WHERE d.superseded_by IS NULL
RETURN f.kind AS kind, f.severity AS severity, f.subject_ref AS subject, f.reason_code AS reason_code, d.action AS action
ORDER BY CASE f.severity WHEN 'blocked' THEN 0 WHEN 'affected' THEN 1 WHEN 'review' THEN 2 ELSE 3 END, kind, subject;

// ---------- 이 품목을 바꿨거나 영향받은 변경 지시 ----------
// @cr_changes_of_item ($item_ref)
MATCH (i:PdmItem)
WHERE i.item_no = $item_ref OR EXISTS { (i)-[:OF_PART]->(:Part {part_no: $item_ref}) }
MATCH (co:ChangeOrder)-[:HAS_TARGET]->(t:ChangeTarget)
WHERE EXISTS { (t)-[:CHANGES]->(:ItemRevision)<-[:HAS_REVISION]-(i) }
   OR EXISTS { (t)-[:REPLACES]->(i) }
RETURN DISTINCT co.code AS order_code, t.change_kind AS change_kind, co.status AS status
ORDER BY order_code, change_kind;
