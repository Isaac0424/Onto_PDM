// =====================================================================
// 변경 영향 분석 데이터 검사 — docs/change-impact-ontology.md 9장을 Cypher 로 옮긴 것. neo4j/checks.cypher 와 같은 규칙이다.
//   검사마다 위반을 한 줄씩 (rule, subject, message) 로 돌려준다. 결과가 없으면 통과다.
//   발행기는 승인된 변경 지시를 쓴 같은 트랜잭션에서 checks.cypher 와 이 파일을 모두 돌리고, 한 줄이라도 나오면 롤백한다.
//   "// @이름" 줄이 검사 하나의 시작이다 (neo4j/test/verify_changes.py 가 이 표지로 나눈다).
//
//   null 안전: 속성이 없거나 타입이 다르면 비교가 null 이 되어 WHERE 에서 빠진다. 그래서 '맞아야 한다'는
//   NOT coalesce(x, false) 로 쓴다 (checks.cypher 와 같은 원칙).
//
//   발행된 변경 지시 = status 가 approved 또는 implemented. 그래프에는 승인된 지시만 있다(작업중 · 검토중은 PG 정본).
//   '지금의 영향 발견' = 지시가 승인될 때 본 분석(ChangeOrder.approved_run_id)의 발견(ImpactFinding.run_id).
//     이전 분석의 발견은 이력이다(SUPERSEDES). 그래서 blocked 검사는 승인된 분석의 발견만 본다.
//   열거값은 backend/src/onto_pdm/changes/models.py 와 같다: severity none | review | affected | blocked ·
//     change_kind replace | revise | bom_edit | attribute_edit · 처분 action 은 ALLOWED_ACTIONS.
//
//   소유 구분: OPMS 소유 라벨(:Part · :Class · :Concept …)의 값은 보지 않는다. PDM 이 OPMS 라벨에 쓰지 않았는지만 본다.
// =====================================================================

// ---------- 변경 지시 · 요청 ----------

// 그래프에는 승인된 지시만 있다 (작업중 · 검토중 · 반려는 PG 에만)
// @change_order_published_status
MATCH (co:ChangeOrder)
WHERE NOT coalesce(co.status IN ['approved', 'implemented'], false)
RETURN 'change_order_published_status' AS rule, coalesce(co.code, '(code 없음)') AS subject, '발행된 변경 지시는 approved 또는 implemented 만: ' + coalesce(co.status, 'null') AS message;

// 승인 기록: 누가 · 언제 · 어느 분석을 보고 · 어느 온톨로지 버전으로 승인했는가 (F-CHG-11)
// @change_order_approval_recorded
MATCH (co:ChangeOrder)
WHERE coalesce(co.status IN ['approved', 'implemented'], false)
  AND ( NOT coalesce(trim(co.approved_by) <> '', false)
     OR co.approved_at IS NULL
     OR co.approved_run_id IS NULL
     OR NOT coalesce(trim(co.ontology_version) <> '', false) )
RETURN 'change_order_approval_recorded' AS rule, co.code AS subject, '승인자 · 승인 시각 · 승인 때 본 분석(approved_run_id) · 온톨로지 버전이 모두 있어야 한다' AS message;

// 지시는 정확히 한 요청에서 나온다
// @change_order_one_request
MATCH (co:ChangeOrder)
WHERE COUNT { (co)-[:ISSUED_FROM]->(:ChangeRequest) } <> 1
RETURN 'change_order_one_request' AS rule, co.code AS subject, '지시는 정확히 한 변경 요청에서 나온다(ISSUED_FROM)' AS message;

// 지시가 만들어진 요청은 접수(accepted)된 것이다
// @change_request_accepted
MATCH (co:ChangeOrder)-[:ISSUED_FROM]->(cr:ChangeRequest)
WHERE NOT coalesce(cr.status = 'accepted', false)
RETURN 'change_request_accepted' AS rule, cr.code AS subject, '승인된 지시의 요청은 accepted 여야 한다: ' + coalesce(cr.status, 'null') AS message;

// 변경 지시는 대상이 하나 이상
// @change_has_target
MATCH (co:ChangeOrder)
WHERE COUNT { (co)-[:HAS_TARGET]->(:ChangeTarget) } = 0
RETURN 'change_has_target' AS rule, co.code AS subject, '변경 지시에는 변경 대상이 하나 이상 있어야 한다' AS message;

// 변경 대상은 정확히 한 지시에 속하고 종류가 열거값이다
// @change_target_valid
MATCH (t:ChangeTarget)
WHERE COUNT { (:ChangeOrder)-[:HAS_TARGET]->(t) } <> 1
   OR NOT coalesce(t.change_kind IN ['replace', 'revise', 'bom_edit', 'attribute_edit'], false)
RETURN 'change_target_valid' AS rule, coalesce(t.target_key, '(key 없음)') AS subject, '변경 대상은 한 지시에 속하고 change_kind 는 replace · revise · bom_edit · attribute_edit' AS message;

// ---------- 개정 vs 교체 · 승인본 불변 ----------

// CHANGES 는 승인 이력이 있는 개정 하나를 가리킨다 (작업중 개정을 바꾸려는 것이 아니다). 전체 범위로 승인되면 이전 개정은 obsolete 가 되어 있다
// @target_changes_released_revision
MATCH (t:ChangeTarget)
OPTIONAL MATCH (t)-[:CHANGES]->(r:ItemRevision)
WITH t, count(r) AS n, collect(r.status) AS statuses
WHERE n <> 1 OR NOT coalesce(statuses[0] IN ['released', 'obsolete'], false)
RETURN 'target_changes_released_revision' AS rule, t.target_key AS subject, 'CHANGES 는 승인(released · obsolete)된 개정 하나를 가리켜야 한다' AS message;

// 승인본을 고치지 않고 새 개정을 만든다: 결과 개정은 같은 품목의 더 큰 rev_seq 를 가진 다른 노드여야 한다.
//   replace · bom_edit 은 바뀌는 조립품(IN_PARENT)의 새 개정, revise · attribute_edit 은 대상 품목(CHANGES)의 새 개정이다
// @released_revision_immutable
MATCH (t:ChangeTarget)-[:RESULTED_IN]->(nr:ItemRevision)
OPTIONAL MATCH (t)-[:IN_PARENT]->(p:ItemRevision)
OPTIONAL MATCH (t)-[:CHANGES]->(c:ItemRevision)
WITH t, nr, coalesce(p, c) AS br
WHERE br IS NULL
   OR nr = br
   OR NOT coalesce(nr.rev_seq > br.rev_seq, false)
   OR NOT EXISTS { (i:PdmItem)-[:HAS_REVISION]->(nr), (i)-[:HAS_REVISION]->(br) }
RETURN 'released_revision_immutable' AS rule, t.target_key AS subject, '새 개정은 기존 승인 개정과 다른 노드이고 같은 품목의 더 큰 rev_seq 여야 한다' AS message;

// 교체는 새 품목 정확히 하나, 교체가 아닌 종류에는 새 품목이 없다
// @replace_target_one_new_item
MATCH (t:ChangeTarget)
OPTIONAL MATCH (t)-[:REPLACES]->(n:PdmItem)
WITH t, count(n) AS cnt
WHERE (t.change_kind = 'replace' AND cnt <> 1) OR (coalesce(t.change_kind, '') <> 'replace' AND cnt > 0)
RETURN 'replace_target_one_new_item' AS rule, t.target_key AS subject, 'replace 는 REPLACES 새 품목이 정확히 하나, 다른 종류에는 없다' AS message;

// 교체할 새 품목에는 OPMS 부품이 있다 (규격은 OPMS 소유라 PDM 이 :Part 를 만들 수 없다)
// @replace_target_has_part
MATCH (t:ChangeTarget)-[:REPLACES]->(n:PdmItem)
WHERE NOT EXISTS { (n)-[:OF_PART]->(:Part) }
RETURN 'replace_target_has_part' AS rule, t.target_key AS subject, '교체할 새 품목은 OPMS :Part 에 OF_PART 로 붙어 있어야 한다' AS message;

// 교체 전후 품목은 다르다 (같은 품번으로 규격을 바꾸는 것은 개정이 아니라 원칙 위반)
// @change_target_replacement_distinct
MATCH (t:ChangeTarget)-[:REPLACES]->(n:PdmItem)
MATCH (t)-[:CHANGES]->(:ItemRevision)<-[:HAS_REVISION]-(o:PdmItem)
WHERE n = o
RETURN 'change_target_replacement_distinct' AS rule, t.target_key AS subject, '교체 전후 품목이 같다' AS message;

// OPMS 규격 값을 PDM 이 RevisionAttribute 로 흉내 내지 않는다 (규격이 바뀌면 새 품번)
// @no_opms_value_shadow
MATCH (ra:RevisionAttribute)
WHERE ra.key IN ['threadSize', 'length', 'pitch', 'material', 'surfaceTreatment', 'strengthGrade', 'threadDirection', 'headType']
RETURN 'no_opms_value_shadow' AS rule, coalesce(ra.attr_key, '(key 없음)') AS subject, 'OPMS 규격 값은 RevisionAttribute 로 두지 않는다: ' + ra.key AS message;

// 개정 수치: 한 개정이 가진 양수 · mm · 출처 열거 · attr_key 형식
// @revision_attribute_valid
MATCH (ra:RevisionAttribute)
WHERE COUNT { (:ItemRevision)-[:HAS_ATTR]->(ra) } <> 1
   OR NOT coalesce(ra.value > 0, false)
   OR NOT coalesce(trim(ra.key) <> '', false)
   OR NOT coalesce(trim(ra.unit) <> '', false)
   OR NOT coalesce(ra.source IN ['drawing', 'opms', 'cad_estimate', 'manual'], false)
RETURN 'revision_attribute_valid' AS rule, coalesce(ra.attr_key, '(key 없음)') AS subject, '개정 수치는 한 개정에 속하고 양수 · 단위 · 출처(drawing · opms · cad_estimate · manual)가 있어야 한다' AS message;

// ---------- 영향 발견 · 처분 ----------

// 모든 영향 발견은 한 지시에 속하고 열거값 · 판정 근거(온톨로지 버전 · 시각 · 임시 여부)를 가진다 (F-CHG-11)
// @finding_has_basis
MATCH (f:ImpactFinding)
WHERE COUNT { (:ChangeOrder)-[:HAS_FINDING]->(f) } <> 1
   OR NOT coalesce(f.severity IN ['none', 'review', 'affected', 'blocked'], false)
   OR NOT coalesce(f.kind IN ['bom_usage', 'product', 'work_order', 'purchase_order_line', 'stock_lot',
                              'fit_pair', 'fit_grip', 'strength_grade', 'substitute'], false)
   OR NOT coalesce(trim(f.reason_code) <> '', false)
   OR NOT coalesce(trim(f.basis_ontology_version) <> '', false)
   OR f.basis_as_of IS NULL
   OR NOT f.temporary IS :: BOOLEAN
RETURN 'finding_has_basis' AS rule, coalesce(f.finding_key, '(key 없음)') AS subject, '영향 발견은 한 지시에 속하고 severity · kind · reason_code · basis_ontology_version · basis_as_of · temporary 가 있어야 한다' AS message;

// 판정(verdict)은 적합성 발견에만 있고 열거값이다
// @finding_verdict_valid
MATCH (f:ImpactFinding)
WHERE (f.verdict IS NOT NULL AND NOT coalesce(f.verdict IN ['ok', 'conditional', 'no', 'unknown'], false))
   OR (f.kind IN ['fit_pair', 'fit_grip', 'strength_grade', 'substitute'] AND f.verdict IS NULL)
   OR (NOT coalesce(f.kind IN ['fit_pair', 'fit_grip', 'strength_grade', 'substitute'], false) AND f.verdict IS NOT NULL)
RETURN 'finding_verdict_valid' AS rule, f.finding_key AS subject, '적합성 발견(fit_pair · fit_grip · strength_grade · substitute)만 verdict(ok · conditional · no · unknown)를 가진다' AS message;

// 처분은 영향 하나를 결정한다
// @disposition_one_finding
MATCH (d:Disposition)
WHERE COUNT { (d)-[:DECIDES]->(:ImpactFinding) } <> 1
   OR COUNT { (:ChangeOrder)-[:HAS_DISPOSITION]->(d) } <> 1
RETURN 'disposition_one_finding' AS rule, coalesce(d.disposition_key, '(key 없음)') AS subject, '처분은 한 지시에 속하고 영향 발견 하나를 DECIDES 한다' AS message;

// 처분의 선택지는 영향 종류별로 정해져 있다 (models.ALLOWED_ACTIONS)
// @disposition_action_allowed
WITH {
  work_order: ['continue_old', 'change_in_progress', 'cancel_reissue', 'use_as_is', 'apply_new', 'no_action_needed'],
  purchase_order_line: ['receive_and_use', 'amend', 'cancel', 'accept_risk', 'no_action_needed'],
  stock_lot: ['use_up', 'quarantine', 'return', 'scrap', 'accept_risk', 'no_action_needed'],
  fit_pair: ['block_change', 'choose_substitute', 'review_with_design', 'accept_risk', 'no_action_needed'],
  fit_grip: ['block_change', 'choose_substitute', 'review_with_design', 'accept_risk', 'no_action_needed'],
  strength_grade: ['block_change', 'choose_substitute', 'review_with_design', 'accept_risk', 'no_action_needed'],
  substitute: ['block_change', 'choose_substitute', 'review_with_design', 'accept_risk', 'no_action_needed'],
  bom_usage: ['acknowledge', 'no_action_needed'],
  product: ['acknowledge', 'no_action_needed']
} AS allowed
MATCH (d:Disposition)-[:DECIDES]->(f:ImpactFinding)
WHERE NOT coalesce(d.action IN allowed[f.kind], false)
   OR NOT coalesce(trim(d.reason) <> '', false)
   OR NOT coalesce(trim(d.decided_by) <> '', false)
   OR d.decided_at IS NULL
RETURN 'disposition_action_allowed' AS rule, d.disposition_key AS subject, '처분 action 은 영향 종류별 선택지 안에 있어야 하고 사유 · 결정자 · 결정 시각이 있어야 한다: ' + coalesce(d.action, 'null') + ' ↔ ' + coalesce(f.kind, 'null') AS message;

// 결정된 영향은 바꾸지 않는다: 처분이 달릴 때 본 severity · reason_code 가 그대로여야 한다 (재분석은 SUPERSEDES 로 새 노드를 만든다)
// @finding_immutable_after_decision
MATCH (d:Disposition)-[:DECIDES]->(f:ImpactFinding)
WHERE NOT coalesce(f.severity = d.finding_severity AND f.reason_code = d.finding_reason_code, false)
RETURN 'finding_immutable_after_decision' AS rule, d.disposition_key AS subject, '결정된 영향의 severity · reason_code 가 결정 때와 다르다(finding_severity · finding_reason_code 스냅샷 필요): ' + coalesce(f.finding_key, '?') AS message;

// 승인된 분석의 affected 영향은 처분을 받는다 (영향이 있다 ≠ 변경해야 한다 — 어떻게 할지 결정이 있어야 한다)
// @disposition_required_for_affected
MATCH (co:ChangeOrder)-[:HAS_FINDING]->(f:ImpactFinding {severity: 'affected'})
WHERE coalesce(co.status IN ['approved', 'implemented'], false)
  AND f.run_id = co.approved_run_id
  AND NOT EXISTS { (d:Disposition)-[:DECIDES]->(f) WHERE d.superseded_by IS NULL }
RETURN 'disposition_required_for_affected' AS rule, co.code AS subject, '처분이 없는 affected 영향: ' + f.finding_key AS message;

// blocked 가 남은 지시는 승인할 수 없다
// @blocked_not_approvable
MATCH (co:ChangeOrder)-[:HAS_FINDING]->(f:ImpactFinding {severity: 'blocked'})
WHERE coalesce(co.status IN ['approved', 'implemented'], false)
  AND f.run_id = co.approved_run_id
RETURN 'blocked_not_approvable' AS rule, co.code AS subject, 'blocked 영향이 남아 있다: ' + coalesce(f.summary, f.message, f.finding_key) AS message;

// blocked 영향에는 위험 수용(accept_risk)을 쓸 수 없다 (design 10.3-2 기본: 막는다)
// @blocked_no_accept_risk
MATCH (d:Disposition {action: 'accept_risk'})-[:DECIDES]->(f:ImpactFinding {severity: 'blocked'})
RETURN 'blocked_no_accept_risk' AS rule, d.disposition_key AS subject, 'blocked 영향에는 accept_risk 처분을 쓸 수 없다: ' + f.finding_key AS message;

// 승인된 분석이 있고 그 분석의 발견이 있다 (분석 없이 승인할 수 없다)
// @approved_run_has_findings
MATCH (co:ChangeOrder)
WHERE coalesce(co.status IN ['approved', 'implemented'], false)
  AND NOT EXISTS { (co)-[:HAS_FINDING]->(f:ImpactFinding) WHERE f.run_id = co.approved_run_id }
RETURN 'approved_run_has_findings' AS rule, co.code AS subject, '승인된 분석(approved_run_id)의 영향 발견이 없다' AS message;

// ---------- 적용 범위 · 검토 ----------

// 승인 전에 적용 범위가 있다: 범위가 없으면 '전체 · 즉시'가 아니라 미정이다
// @scope_required_before_approval
MATCH (t:ChangeTarget)
WHERE NOT EXISTS { (t)-[:SCOPED_BY]->(:ApplicabilityScope) }
RETURN 'scope_required_before_approval' AS rule, t.target_key AS subject, '변경 대상에 적용 범위가 없다' AS message;

// 범위가 앞뒤가 맞는다
// @scope_valid
MATCH (s:ApplicabilityScope)
WHERE coalesce(s.effective_from > s.effective_to, false)
   OR coalesce(s.serial_from > s.serial_to, false)
   OR coalesce(s.serial_from < 0, false)
   OR NOT coalesce(s.applies IN ['new', 'old'], false)
   OR (s.site IS NOT NULL AND NOT coalesce(trim(s.site) <> '', false))
   OR (s.lot_nos IS NOT NULL AND NOT coalesce(size(s.lot_nos) > 0, false))
   OR COUNT { (s)<-[:SCOPED_BY]-() } = 0
RETURN 'scope_valid' AS rule, coalesce(s.scope_key, '(key 없음)') AS subject, '적용 범위가 맞지 않는다(기간 · 일련번호 구간 · applies · 사업장 · 로트 목록 · 주인 없음)' AS message;

// 승인에는 필요한 부서의 검토가 있다: 설계는 늘, 구매는 발주 · 재고 영향이 affected 일 때, 생산은 작업지시 영향이 affected 일 때. 승인된 분석에 대한 approve 여야 한다
// @review_signoff_before_approval
MATCH (co:ChangeOrder)
WHERE coalesce(co.status IN ['approved', 'implemented'], false)
UNWIND ['design', 'purchasing', 'production'] AS fn
WITH co, fn,
  CASE fn
    WHEN 'design' THEN true
    WHEN 'purchasing' THEN EXISTS { (co)-[:HAS_FINDING]->(f:ImpactFinding)
                                    WHERE f.run_id = co.approved_run_id AND f.severity = 'affected' AND f.kind IN ['purchase_order_line', 'stock_lot'] }
    ELSE EXISTS { (co)-[:HAS_FINDING]->(f:ImpactFinding)
                  WHERE f.run_id = co.approved_run_id AND f.severity = 'affected' AND f.kind = 'work_order' }
  END AS needed
WHERE needed
  AND NOT EXISTS { (co)-[:HAS_REVIEW]->(r:ReviewSignoff) WHERE r.function = fn AND r.verdict = 'approve' AND r.run_id = co.approved_run_id }
RETURN 'review_signoff_before_approval' AS rule, co.code AS subject, fn + ' 검토의 approve 가 없다' AS message;

// 검토 서명은 한 지시에 속하고 열거값이다
// @review_signoff_valid
MATCH (r:ReviewSignoff)
WHERE COUNT { (:ChangeOrder)-[:HAS_REVIEW]->(r) } <> 1
   OR NOT coalesce(r.function IN ['design', 'purchasing', 'production'], false)
   OR NOT coalesce(r.verdict IN ['approve', 'reject', 'comment'], false)
   OR NOT coalesce(trim(r.reviewer) <> '', false)
RETURN 'review_signoff_valid' AS rule, coalesce(r.review_key, '(key 없음)') AS subject, '검토 서명은 한 지시에 속하고 function(design · purchasing · production) · verdict(approve · reject · comment) · reviewer 가 있어야 한다' AS message;

// ---------- 온톨로지 버전 ≠ 부품 개정 (F-CHG-10) ----------

// 온톨로지 버전을 부품 개정으로 쓰지 않는다: (가) 개정 속성 (나) 개정 번호가 버전 꼴 (다) 개정과 온톨로지 노드의 직접 연결
// @no_ontology_version_as_revision
MATCH (r:ItemRevision)
WHERE r.ontology_version IS NOT NULL
RETURN 'no_ontology_version_as_revision' AS rule, toString(r.pdm_revision_id) AS subject, 'ItemRevision 에 온톨로지 버전을 달 수 없다' AS message
UNION ALL
MATCH (r:ItemRevision)
WHERE coalesce(r.rev =~ '[0-9]+\\.[0-9]+\\.[0-9]+', false)
RETURN 'no_ontology_version_as_revision' AS rule, toString(r.pdm_revision_id) AS subject, '개정 번호(rev)가 온톨로지 버전 꼴이다: ' + r.rev AS message
UNION ALL
MATCH (x)-[rel]-(y)
WHERE (x:ItemRevision AND (y:OntologyVersion OR y:OntologyImpact))
   OR (x:ChangeTarget AND type(rel) IN ['CHANGES', 'RESULTED_IN', 'CASCADES_TO', 'IN_PARENT', 'REPLACES'] AND (y:OntologyVersion OR y:OntologyImpact))
RETURN DISTINCT 'no_ontology_version_as_revision' AS rule, coalesce(x.target_key, toString(x.pdm_revision_id), '?') AS subject, '개정 · 변경 대상이 온톨로지 버전(보고)을 가리킨다: ' + type(rel) AS message;

// 온톨로지 보고는 개정도 요청도 만들지 않는다: 관계는 REPORTS(→영향 발견)와 TRIGGERED_BY(←사람이 연 요청)뿐이고, 그 요청의 출처 표시는 ontology_impact
// @ontology_impact_no_revision
MATCH (oi:OntologyImpact)-[rel]-(x)
WHERE NOT (type(rel) = 'REPORTS' AND startNode(rel) = oi AND x:ImpactFinding)
  AND NOT (type(rel) = 'TRIGGERED_BY' AND endNode(rel) = oi AND x:ChangeRequest)
RETURN 'ontology_impact_no_revision' AS rule, oi.oi_key AS subject, '온톨로지 보고에 허용되지 않는 연결: ' + type(rel) AS message
UNION ALL
MATCH (cr:ChangeRequest)-[:TRIGGERED_BY]->(oi:OntologyImpact)
WHERE NOT coalesce(cr.origin = 'ontology_impact', false)
RETURN 'ontology_impact_no_revision' AS rule, cr.code AS subject, '온톨로지 보고에서 열린 요청의 origin 은 ontology_impact 여야 한다' AS message;

// ---------- 외부(ERP · MES) 읽기 사본 ----------

// 외부 사본에는 출처와 사본 시각이 있다 (inventory_balance 와 같은 패턴)
// @external_copy_has_source
MATCH (n)
WHERE (n:WorkOrder OR n:PurchaseOrderLine OR n:StockLot)
  AND ( NOT coalesce(n.source_system IN ['ERP', 'MES', 'fixture'], false) OR n.as_of IS NULL )
RETURN 'external_copy_has_source' AS rule, coalesce(n.wo_no, n.po_line_key, n.lot_key, '(key 없음)') AS subject, '외부 사본에는 source_system(ERP · MES · fixture)과 as_of 가 있어야 한다' AS message;

// 외부 사본의 값: 상태 열거 · 음수 아님 · 구간 순서
// @external_copy_valid
MATCH (w:WorkOrder)
WHERE NOT coalesce(w.status IN ['planned', 'released', 'in_progress', 'completed', 'closed', 'cancelled'], false)
   OR NOT coalesce(w.qty_planned >= 0, false)
   OR coalesce(w.qty_done < 0, false)
   OR coalesce(w.serial_from > w.serial_to, false)
RETURN 'external_copy_valid' AS rule, coalesce(w.wo_no, '(key 없음)') AS subject, '작업지시의 상태 · 수량 · 일련번호 구간이 맞지 않는다' AS message
UNION ALL
MATCH (p:PurchaseOrderLine)
WHERE NOT coalesce(p.status IN ['open', 'partial', 'closed'], false)
   OR NOT coalesce(p.qty_ordered >= 0, false)
   OR NOT coalesce(p.qty_open >= 0, false)
   OR NOT coalesce(p.po_line_key = p.po_no + '/' + toString(p.line_no), false)
RETURN 'external_copy_valid' AS rule, coalesce(p.po_line_key, '(key 없음)') AS subject, '발주 항목의 상태 · 수량 · po_line_key 가 맞지 않는다' AS message
UNION ALL
MATCH (s:StockLot)
WHERE NOT coalesce(s.status IN ['available', 'quarantine', 'hold'], false)
   OR NOT coalesce(s.qty_on_hand >= 0, false)
   OR coalesce(s.qty_allocated < 0, false)
RETURN 'external_copy_valid' AS rule, coalesce(s.lot_key, '(key 없음)') AS subject, '재고 로트의 상태 · 수량이 맞지 않는다' AS message;

// 외부 사본은 품목 · 개정에 정확히 하나씩 걸린다: 작업지시 USES_BOM(개정) · 발주 ORDERS(품목) · 재고 STOCK_OF(품목)
// @external_copy_links
MATCH (w:WorkOrder)
WHERE COUNT { (w)-[:USES_BOM]->(:ItemRevision) } <> 1
RETURN 'external_copy_links' AS rule, w.wo_no AS subject, '작업지시는 적용 BOM 개정 하나(USES_BOM)를 가진다' AS message
UNION ALL
MATCH (p:PurchaseOrderLine)
WHERE COUNT { (p)-[:ORDERS]->(:PdmItem) } <> 1
RETURN 'external_copy_links' AS rule, coalesce(p.po_line_key, '(key 없음)') AS subject, '발주 항목은 품목 하나(ORDERS)를 가진다' AS message
UNION ALL
MATCH (s:StockLot)
WHERE COUNT { (s)-[:STOCK_OF]->(:PdmItem) } <> 1
RETURN 'external_copy_links' AS rule, coalesce(s.lot_key, '(key 없음)') AS subject, '재고 로트는 품목 하나(STOCK_OF)를 가진다' AS message;

// ---------- 소유 구분 ----------

// PDM 새 라벨과 OPMS 라벨이 한 노드에 같이 붙지 않는다 (OPMS sync 가 지우거나 OPMS 가 속성으로 읽는다)
// @new_labels_disjoint_from_opms
MATCH (n)
WHERE any(l IN labels(n) WHERE l IN ['ChangeRequest', 'ChangeOrder', 'ChangeTarget', 'ApplicabilityScope', 'ImpactFinding',
                                     'Disposition', 'ReviewSignoff', 'OntologyImpact', 'RevisionAttribute', 'FastenedJoint',
                                     'WorkOrder', 'PurchaseOrderLine', 'StockLot', 'PdmItem', 'ItemRevision', 'ProductModel',
                                     'PartIdentifier', 'MaterialProfile'])
  AND any(l IN labels(n) WHERE l IN ['Class', 'Property', 'Scheme', 'Concept', 'Term', 'Rule', 'OntologyVersion', 'Part',
                                     'Supplier', 'SupplierPart', 'SourceDoc', 'Sequence', 'PartReservation', 'DedupeLock'])
RETURN 'new_labels_disjoint_from_opms' AS rule, toString(elementId(n)) AS subject, 'PDM 라벨과 OPMS 라벨이 한 노드에 같이 있다: ' + reduce(s = '', l IN labels(n) | s + ':' + l) AS message;

// ---------- OPMS :Part 가 없는 PDM 품목 ----------

// OPMS 미등록 품목(opms_registered = false)은 품목 번호(item_no)로 구분하고 :Part 에 붙지 않는다
// @unregistered_item_consistent
MATCH (i:PdmItem {opms_registered: false})
WHERE NOT coalesce(trim(i.item_no) <> '', false)
   OR EXISTS { (i)-[:OF_PART]->(:Part) }
RETURN 'unregistered_item_consistent' AS rule, coalesce(i.item_no, '#' + toString(i.pdm_item_id)) AS subject, 'OPMS 미등록 품목은 item_no 가 있고 OF_PART 가 없다' AS message;

// ---------- 체결 접합부 ----------

// 접합부는 한 조립품 개정에 속하고 볼트 · 너트 하나씩, 조이는 판이 하나 이상, 와셔는 수량과 연결이 맞는다
// @joint_complete
MATCH (j:FastenedJoint)
WHERE COUNT { (:ItemRevision)-[:HAS_JOINT]->(j) } <> 1
   OR COUNT { (j)-[:USES_BOLT]->(:PdmItem) } <> 1
   OR COUNT { (j)-[:USES_NUT]->(:PdmItem) } <> 1
   OR COUNT { (j)-[:CLAMPS]->(:PdmItem) } < 1
   OR NOT coalesce(j.bolt_count >= 1, false)
   OR NOT coalesce(j.washers_per_bolt >= 0, false)
   OR (j.washers_per_bolt > 0 AND COUNT { (j)-[:USES_WASHER]->(:PdmItem) } <> 1)
   OR (coalesce(j.washers_per_bolt, 0) = 0 AND COUNT { (j)-[:USES_WASHER]->(:PdmItem) } > 0)
RETURN 'joint_complete' AS rule, coalesce(j.joint_key, '(key 없음)') AS subject, '접합부는 한 개정에 속하고 볼트 · 너트 하나, 조이는 판 하나 이상, 와셔는 washers_per_bolt 와 맞아야 한다' AS message;

// 조이는 판의 쌓는 순서는 1부터 겹치지 않는 정수
// @joint_clamp_order
MATCH (j:FastenedJoint)-[c:CLAMPS]->(:PdmItem)
WHERE NOT c.stack_order IS :: INTEGER OR c.stack_order < 1
RETURN 'joint_clamp_order' AS rule, j.joint_key AS subject, 'CLAMPS 의 stack_order 는 1 이상 정수여야 한다' AS message
UNION ALL
MATCH (j:FastenedJoint)-[c:CLAMPS]->(:PdmItem)
WITH j, c.stack_order AS o, count(*) AS n
WHERE n > 1
RETURN 'joint_clamp_order' AS rule, j.joint_key AS subject, 'CLAMPS 의 stack_order 가 겹친다: ' + toString(o) AS message;

// ---------- 병행 개정 ----------

// 같은 품목에 승인(released) 개정이 둘 이상 공존하는 것은 '일부 범위로만 새 개정을 적용한' 지시가 만든 경우뿐이다
//   (새 개정을 만든 변경 대상에 새 개정 쪽 범위 제한이 있어야 한다. 전체 범위면 이전 개정은 obsolete 다)
// @released_coexist_needs_partial_scope
MATCH (i:PdmItem)-[:HAS_REVISION]->(a:ItemRevision {status: 'released'})
MATCH (i)-[:HAS_REVISION]->(b:ItemRevision {status: 'released'})
WHERE a.rev_seq < b.rev_seq
  AND NOT EXISTS {
    (t:ChangeTarget)-[:RESULTED_IN|CASCADES_TO]->(b)
    WHERE EXISTS {
      (t)-[:SCOPED_BY]->(s:ApplicabilityScope)
      WHERE s.applies = 'new'
        AND ( s.serial_from IS NOT NULL OR s.serial_to IS NOT NULL OR s.lot_nos IS NOT NULL
              OR s.site IS NOT NULL OR s.effective_from IS NOT NULL OR s.effective_to IS NOT NULL )
    }
  }
RETURN 'released_coexist_needs_partial_scope' AS rule, coalesce(i.item_no, '#' + toString(i.pdm_item_id)) AS subject,
       '승인 개정 ' + a.rev + ' 와 ' + b.rev + ' 가 함께 있다: 일부 범위 적용으로 만든 개정이 아니면 이전 개정은 obsolete 여야 한다' AS message;
