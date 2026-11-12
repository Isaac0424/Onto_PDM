// =====================================================================
// Onto PDM — 변경 영향 분석 라벨의 Neo4j(LPG) 스키마. Neo4j 5.26 Community.
//   설계: docs/change-impact-ontology.md (개념 모델) · docs/change-impact-design.md 8장 · docs/neo4j-lpg-design.md 8장
//   neo4j/schema.cypher 다음에 실행한다. 모두 IF NOT EXISTS 라 여러 번 실행해도 된다.
//
// 규칙
//   * 여기 있는 라벨은 PDM 이 소유한다. OPMS 의 ontology sync 는 YAML 에 없는 :Class :Concept :Scheme … 만 지운다
//     (neo4j-lpg-design.md 1장). OPMS 라벨(Class Property Scheme Concept Term Rule OntologyVersion Part Supplier
//     SupplierPart SourceDoc Sequence PartReservation DedupeLock)에는 라벨도 속성도 달지 않는다.
//   * 승인된 변경 지시(ChangeOrder)만 발행한다. 작업중 · 검토중 지시와 영향 분석은 PG 가 정본이다.
//   * WorkOrder · PurchaseOrderLine · StockLot 은 ERP · MES 가 주인이다. PDM 은 읽기 사본만 두고,
//     모든 사본에 source_system('ERP' | 'MES' | 'fixture') 과 as_of 가 있어야 한다(changes-checks.cypher).
//   * Community 는 고유 제약만 있다. 존재 · 타입 · 관계 개수 규칙은 neo4j/changes-checks.cypher 가 검사한다.
//   * 키 이름은 backend/src/onto_pdm/changes/models.py 의 필드와 맞춘다(code · wo_no · po_no · line_no …).
//     PG 의 정수 id 는 <지시 코드>#<id> 꼴의 *_key 문자열로 만들어 고유 키로 쓴다(지시마다 id 가 다시 시작해도 겹치지 않는다).
// =====================================================================

// ---------- 변경 요청 · 지시 ----------

// 변경 요청: CR-YYYY-NNNN
CREATE CONSTRAINT change_request_code IF NOT EXISTS
  FOR (n:ChangeRequest) REQUIRE n.code IS UNIQUE;

// 변경 지시: CO-YYYY-NNNN. 승인된 것만 그래프에 있다.
CREATE CONSTRAINT change_order_code IF NOT EXISTS
  FOR (n:ChangeOrder) REQUIRE n.code IS UNIQUE;

// 변경 대상 한 가지: '<지시 코드>#<change_target.id>'
CREATE CONSTRAINT change_target_key IF NOT EXISTS
  FOR (n:ChangeTarget) REQUIRE n.target_key IS UNIQUE;

// 적용 범위: '<지시 코드>#<change_scope.id>'
CREATE CONSTRAINT applicability_scope_key IF NOT EXISTS
  FOR (n:ApplicabilityScope) REQUIRE n.scope_key IS UNIQUE;

// 영향 발견: '<지시 코드>#<run id>#<finding id>'. 처분이 달린 것은 바꾸지 않는다(재분석은 SUPERSEDES 로 잇는다)
CREATE CONSTRAINT impact_finding_key IF NOT EXISTS
  FOR (n:ImpactFinding) REQUIRE n.finding_key IS UNIQUE;

// 처분 결정: '<지시 코드>#<disposition id>'
CREATE CONSTRAINT disposition_key IF NOT EXISTS
  FOR (n:Disposition) REQUIRE n.disposition_key IS UNIQUE;

// 부서별 검토 서명: '<지시 코드>#<change_review id>'
CREATE CONSTRAINT review_signoff_key IF NOT EXISTS
  FOR (n:ReviewSignoff) REQUIRE n.review_key IS UNIQUE;

// 온톨로지 버전 변경 보고(읽기 보고. 개정도 요청도 만들지 않는다): '<from>><to>'
CREATE CONSTRAINT ontology_impact_key IF NOT EXISTS
  FOR (n:OntologyImpact) REQUIRE n.oi_key IS UNIQUE;

// ---------- PDM 소유 설계 값 · 체결 접합부 ----------

// 개정이 가진 PDM 소유 수치(판 두께 …): '<pdm_revision_id>|<key>'
CREATE CONSTRAINT revision_attribute_key IF NOT EXISTS
  FOR (n:RevisionAttribute) REQUIRE n.attr_key IS UNIQUE;

// 체결 접합부: '<pdm_revision_id>|<name>'  (조립품 개정이 가진다)
CREATE CONSTRAINT fastened_joint_key IF NOT EXISTS
  FOR (n:FastenedJoint) REQUIRE n.joint_key IS UNIQUE;

// OPMS :Part 가 없는 PDM 품목(판 · 모듈 · 체결 세트)의 품목 번호. :Part 가 있는 품목은 비운다(null 은 겹쳐도 된다).
CREATE CONSTRAINT pdm_item_no IF NOT EXISTS
  FOR (n:PdmItem) REQUIRE n.item_no IS UNIQUE;

// ---------- 외부(ERP · MES) 읽기 사본 ----------

CREATE CONSTRAINT work_order_no IF NOT EXISTS
  FOR (n:WorkOrder) REQUIRE n.wo_no IS UNIQUE;

// '<po_no>/<line_no>'
CREATE CONSTRAINT purchase_order_line_key IF NOT EXISTS
  FOR (n:PurchaseOrderLine) REQUIRE n.po_line_key IS UNIQUE;

// '<lot_no>|<item_no>' — 같은 로트 번호가 다른 품목에 다시 쓰일 수 있다
CREATE CONSTRAINT stock_lot_key IF NOT EXISTS
  FOR (n:StockLot) REQUIRE n.lot_key IS UNIQUE;

// ---------- 목록 · 질의용 인덱스 ----------

CREATE INDEX change_order_status IF NOT EXISTS
  FOR (n:ChangeOrder) ON (n.status);

CREATE INDEX impact_finding_severity IF NOT EXISTS
  FOR (n:ImpactFinding) ON (n.severity);

CREATE INDEX work_order_status IF NOT EXISTS
  FOR (n:WorkOrder) ON (n.status);

CREATE INDEX stock_lot_status IF NOT EXISTS
  FOR (n:StockLot) ON (n.status);

CALL db.awaitIndexes();
