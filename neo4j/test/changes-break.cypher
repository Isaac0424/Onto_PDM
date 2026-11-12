// =====================================================================
// 일부러 망가뜨린 데이터 — neo4j/test/verify_changes.py 가 changes-sample.cypher 위에 올린 뒤 changes-checks.cypher 가
//   모두 잡는지 본다. 망가뜨린 노드의 키에는 'ZZ' 를 넣어 예시 데이터와 구분한다(verify_changes.py 가 subject 로 확인한다).
//   :Part 쪽을 고치는 문장은 'OPMS 라벨에 PDM 라벨이 섞였을 때 PDM 검사가 잡는가'를 보려는 것이다. 이 파일은 시험 전용이다.
// =====================================================================

// change_order_published_status: 작업중 지시가 그래프에 올라옴
CREATE (:ChangeOrder {code: 'CO-ZZ-DRAFT', status: 'draft'});

// change_order_approval_recorded · change_order_one_request · change_has_target · approved_run_has_findings
// · review_signoff_before_approval: 승인 기록 없는 승인 지시(요청 · 대상 · 분석 · 검토 모두 없음)
CREATE (:ChangeOrder {code: 'CO-ZZ-NOAPPR', status: 'approved'});

// change_request_accepted: 지시의 요청이 접수되지 않음
CREATE (co:ChangeOrder {code: 'CO-ZZ-REQ', status: 'approved', approved_by: 'choi', approved_at: datetime('2026-11-20T10:00:00+09:00'),
                        approved_run_id: 1, ontology_version: '0.19.0'})
CREATE (cr:ChangeRequest {code: 'CR-ZZ-REQ', status: 'draft'})
CREATE (co)-[:ISSUED_FROM]->(cr);

// change_target_valid · target_changes_released_revision · scope_required_before_approval: 종류가 열거값이 아니고 지시도 개정도 범위도 없는 대상
CREATE (:ChangeTarget {target_key: 'CO-ZZ-REQ#1', change_kind: 'weird'});

// released_revision_immutable: 새 개정이 기존 개정과 같은 노드(승인본을 그대로 '고쳤다')
MATCH (r:ItemRevision {pdm_revision_id: 3002})
CREATE (t:ChangeTarget {target_key: 'CO-ZZ-IMM#1', change_kind: 'revise'})
CREATE (t)-[:CHANGES]->(r)
CREATE (t)-[:RESULTED_IN]->(r);

// replace_target_one_new_item: 교체인데 새 품목이 없음 / 교체가 아닌데 새 품목이 있음
CREATE (:ChangeTarget {target_key: 'CO-ZZ-REPL#1', change_kind: 'replace'});
MATCH (n:PdmItem {pdm_item_id: 2105})
CREATE (t:ChangeTarget {target_key: 'CO-ZZ-REPL#2', change_kind: 'revise'})
CREATE (t)-[:REPLACES]->(n);

// replace_target_has_part: 교체할 새 품목에 OPMS :Part 가 없음(하판 브래킷)
MATCH (n:PdmItem {pdm_item_id: 2002})
CREATE (t:ChangeTarget {target_key: 'CO-ZZ-REPL#3', change_kind: 'replace'})
CREATE (t)-[:REPLACES]->(n);

// change_target_replacement_distinct: 교체 전후 품목이 같음
MATCH (r:ItemRevision {pdm_revision_id: 3102}), (n:PdmItem {pdm_item_id: 2102})
CREATE (t:ChangeTarget {target_key: 'CO-ZZ-REPL#4', change_kind: 'replace'})
CREATE (t)-[:CHANGES]->(r)
CREATE (t)-[:REPLACES]->(n);

// no_opms_value_shadow: OPMS 규격 값(length)을 PDM 수치로 흉내 냄
CREATE (:RevisionAttribute {attr_key: 'ZZ|length', key: 'length', value: 30.0, unit: 'mm', source: 'manual'});

// revision_attribute_valid: 음수 · 주인 없는 수치
CREATE (:RevisionAttribute {attr_key: 'ZZ|thickness', key: 'thickness', value: -1.0, unit: 'mm', source: 'manual'});

// finding_has_basis: 판정 근거(온톨로지 버전 · 시각 · 임시 여부)가 없는 영향
CREATE (:ImpactFinding {finding_key: 'ZZ#1#1', severity: 'bogus', kind: 'fit_pair'});

// finding_verdict_valid: 작업지시 영향에 판정이 붙음
CREATE (:ImpactFinding {finding_key: 'ZZ#1#2', severity: 'none', kind: 'work_order', verdict: 'ok', reason_code: 'x',
                        basis_ontology_version: '0.19.0', basis_as_of: datetime('2026-11-18T09:00:00+09:00'), temporary: false});

// disposition_one_finding: 영향도 지시도 없는 처분
CREATE (:Disposition {disposition_key: 'ZZ-D1', action: 'acknowledge', reason: 'x', decided_by: 'lee', decided_at: datetime('2026-11-19T15:00:00+09:00')});

// disposition_action_allowed: 작업지시 영향에 재고 처분(quarantine)
MATCH (f:ImpactFinding {finding_key: 'ZZ#1#2'})
CREATE (d:Disposition {disposition_key: 'ZZ-D2', action: 'quarantine', reason: 'x', decided_by: 'lee', decided_at: datetime('2026-11-19T15:00:00+09:00'),
                       finding_severity: 'none', finding_reason_code: 'x'})
CREATE (d)-[:DECIDES]->(f);

// finding_immutable_after_decision: 결정 때(none)와 지금(affected)의 severity 가 다름
CREATE (f:ImpactFinding {finding_key: 'ZZ#1#3', severity: 'affected', kind: 'stock_lot', reason_code: 'stock_on_hand',
                         basis_ontology_version: '0.19.0', basis_as_of: datetime('2026-11-18T09:00:00+09:00'), temporary: false})
CREATE (d:Disposition {disposition_key: 'ZZ-D3', action: 'use_up', reason: 'x', decided_by: 'park', decided_at: datetime('2026-11-19T15:00:00+09:00'),
                       finding_severity: 'none', finding_reason_code: 'stock_on_hand'})
CREATE (d)-[:DECIDES]->(f);

// disposition_required_for_affected · blocked_not_approvable · blocked_no_accept_risk: 승인된 분석에 처분 없는 affected · 남은 blocked · blocked 에 위험 수용
CREATE (co:ChangeOrder {code: 'CO-ZZ-AFF', status: 'approved', approved_by: 'choi', approved_at: datetime('2026-11-20T10:00:00+09:00'),
                        approved_run_id: 5, ontology_version: '0.19.0'})
CREATE (fa:ImpactFinding {finding_key: 'CO-ZZ-AFF#5#1', finding_id: 1, run_id: 5, severity: 'affected', kind: 'purchase_order_line',
                          reason_code: 'open_po_line', summary: 'ZZ 발주', basis_ontology_version: '0.19.0',
                          basis_as_of: datetime('2026-11-18T09:00:00+09:00'), temporary: false})
CREATE (fb:ImpactFinding {finding_key: 'CO-ZZ-AFF#5#2', finding_id: 2, run_id: 5, severity: 'blocked', kind: 'fit_pair', verdict: 'no',
                          reason_code: 'pair_mismatch', summary: 'ZZ 짝 불일치', basis_ontology_version: '0.19.0',
                          basis_as_of: datetime('2026-11-18T09:00:00+09:00'), temporary: true})
CREATE (co)-[:HAS_FINDING]->(fa)
CREATE (co)-[:HAS_FINDING]->(fb)
CREATE (d:Disposition {disposition_key: 'CO-ZZ-AFF#1', action: 'accept_risk', reason: 'ZZ 그냥 쓴다', decided_by: 'choi',
                       decided_at: datetime('2026-11-19T15:00:00+09:00'), finding_severity: 'blocked', finding_reason_code: 'pair_mismatch'})
CREATE (d)-[:DECIDES]->(fb)
CREATE (co)-[:HAS_DISPOSITION]->(d);

// scope_valid: 일련번호 구간 거꾸로 · applies 가 열거값이 아님 · 빈 로트 목록 · 주인 없음
CREATE (:ApplicabilityScope {scope_key: 'ZZ-S1', serial_from: 10, serial_to: 5, applies: 'sometimes', lot_nos: []});

// review_signoff_valid: 열거값이 아닌 부서 · 판정, 지시에 속하지 않음
CREATE (:ReviewSignoff {review_key: 'ZZ-R1', function: 'qa', verdict: 'maybe', reviewer: 'x'});

// no_ontology_version_as_revision: 개정에 온톨로지 버전 속성 · 버전 꼴의 개정 번호 / 변경 대상이 온톨로지 보고를 가리킴
//   (released_coexist_needs_partial_scope: 이 개정과 R00 이 함께 released 인데 일부 범위 적용으로 만든 것이 아님)
MATCH (i:PdmItem {pdm_item_id: 2002})
CREATE (i)-[:HAS_REVISION]->(:ItemRevision {pdm_revision_id: 9101, rev: '0.19.0', rev_seq: 5, status: 'released', ontology_version: '0.19.0'});
MATCH (oi:OntologyImpact {oi_key: '0.18.0>0.19.0'})
CREATE (t:ChangeTarget {target_key: 'CO-ZZ-OI#1', change_kind: 'revise'})
CREATE (t)-[:CHANGES]->(oi);

// ontology_impact_no_revision: 온톨로지 보고가 개정을 만들고(RESULTED_IN) · 보고에서 열린 요청의 origin 이 다름
MATCH (oi:OntologyImpact {oi_key: '0.18.0>0.19.0'}), (r:ItemRevision {pdm_revision_id: 3002})
CREATE (oi)-[:RESULTED_IN]->(r);
MATCH (oi:OntologyImpact {oi_key: '0.18.0>0.19.0'})
CREATE (cr:ChangeRequest {code: 'CR-ZZ-OI', status: 'accepted', origin: 'design'})
CREATE (cr)-[:TRIGGERED_BY]->(oi);

// external_copy_has_source · external_copy_links: 출처도 적용 BOM 도 없는 작업지시
CREATE (:WorkOrder {wo_no: 'WO-ZZ-1', status: 'planned', qty_planned: 1.0});

// external_copy_valid: 상태 열거값이 아니고 미입고가 음수인 발주 항목
CREATE (:PurchaseOrderLine {po_line_key: 'ZZ/1', po_no: 'ZZ', line_no: 1, qty_ordered: 5.0, qty_open: -1.0, status: 'weird',
                            source_system: 'fixture', as_of: datetime('2026-11-12T09:00:00+09:00')});

// new_labels_disjoint_from_opms: OPMS :Part 에 PDM 라벨이 같이 붙음
MATCH (p:Part {part_no: 'P-00000000003'}) SET p:WorkOrder;

// unregistered_item_consistent: OPMS 미등록 표시는 있는데 item_no 가 없음
CREATE (:PdmItem {pdm_item_id: 9201, item_type: 'part', name: 'ZZ unregistered', uom: 'EA', opms_registered: false});

// joint_complete: 아무것도 연결되지 않은 접합부
CREATE (:FastenedJoint {joint_key: 'ZZ-J1', name: 'ZZ', bolt_count: 0});

// joint_clamp_order: 조이는 판의 순서가 겹침
MATCH (a:PdmItem {pdm_item_id: 2001}), (b:PdmItem {pdm_item_id: 2002})
CREATE (j:FastenedJoint {joint_key: 'ZZ-J2', name: 'ZZ', bolt_count: 1, washers_per_bolt: 0})
CREATE (j)-[:CLAMPS {stack_order: 1}]->(a)
CREATE (j)-[:CLAMPS {stack_order: 1}]->(b);
