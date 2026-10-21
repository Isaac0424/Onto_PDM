-- =====================================================================
-- 통합 DB 접근 권한 — DBA가 schema.sql 다음에 한 번 실행한다.
--   비밀번호는 여기에 두지 않는다 (ALTER ROLE … PASSWORD 를 따로 실행하거나 SSO · 인증서를 쓴다).
--
--   역할              읽기                                   쓰기
--   pdm_app           전체                                   전체 (PDM · PLM API 서버. 관리자 모드도 이 서버를 거친다)
--   erp_reader        pub (승인본)                            없음
--   mes_reader        pub (승인본)                            없음
--   inventory_feed    없음                                   pub.upsert_inventory 실행만
--   graph_publisher   pub + 발행에 필요한 열                   outbox 발행 상태
--   class_agent       추출 결과 · 품목 · 별칭                   분류 제안(proposed), 등록 요청(AGENT 임시저장)
--
--   관리자 모드: 별도 DB 역할이 아니라 PDM 앱 안의 화면이다. 사용자 역할(app_user.role = admin · approver)은
--   API가 확인하고, 품번 발급 · 품번 변경 함수는 DB에서도 require_app_role() 로 다시 확인한다.
-- =====================================================================

-- 기본으로 열려 있는 권한을 닫는다: 다른 시스템은 pub 만 쓴다
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA pub FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pub.upsert_inventory(text, text, text, text, numeric, numeric, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION approve_part_request(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION renumber_item(bigint, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION issue_item_no() FROM PUBLIC;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['pdm_app', 'erp_reader', 'mes_reader',
                           'inventory_feed', 'graph_publisher', 'class_agent'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r);
    END IF;
  END LOOP;
END $$;

-- PDM · PLM API 서버 (일반 화면 + 관리자 모드)
GRANT USAGE ON SCHEMA public, pub TO pdm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pdm_app;
REVOKE INSERT, UPDATE, DELETE ON audit_log FROM pdm_app;          -- 감사 로그는 트리거만 쓴다
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pdm_app;
GRANT SELECT ON ALL TABLES IN SCHEMA pub TO pdm_app;
GRANT EXECUTE ON FUNCTION approve_part_request(bigint, text), renumber_item(bigint, text, text), issue_item_no() TO pdm_app;

-- ERP · MES: 승인본만
GRANT USAGE ON SCHEMA pub TO erp_reader, mes_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA pub TO erp_reader, mes_reader;

-- 재고 연동
GRANT USAGE ON SCHEMA pub TO inventory_feed;
GRANT EXECUTE ON FUNCTION pub.upsert_inventory(text, text, text, text, numeric, numeric, text, timestamptz) TO inventory_feed;

-- 그래프 발행기: 공개본 + 내려간 품목을 그래프에서 거둘 때 필요한 열
GRANT USAGE ON SCHEMA public, pub TO graph_publisher;
GRANT SELECT ON ALL TABLES IN SCHEMA pub TO graph_publisher;
GRANT SELECT ON outbox, class_proposal TO graph_publisher;
GRANT UPDATE (published_at, attempts, last_error) ON outbox TO graph_publisher;
GRANT SELECT (id, item_no, iri_key, deleted_at) ON item TO graph_publisher;
GRANT SELECT (id, item_id, rev, status) ON item_revision TO graph_publisher;

-- 분류 에이전트: 읽기는 추출 결과와 기존 품목, 쓰기는 제안과 임시저장뿐 (승인 · 품번 발급 불가)
GRANT USAGE ON SCHEMA public TO class_agent;
GRANT SELECT ON product, product_document, document, document_revision, document_file,
                cad_product, cad_usage, doc_chunk, doc_chunk_product, item_identifier TO class_agent;
GRANT SELECT (id, item_no, name, name_ko, item_type, unit, class_iri, material_iri, attributes, deleted_at)
  ON item TO class_agent;
GRANT SELECT, INSERT ON class_proposal, part_request TO class_agent;
GRANT UPDATE (payload, class_proposal_id) ON part_request TO class_agent;

-- 행 단위 제한: 에이전트는 자기(AGENT) 임시저장만 만들고 고친다, 제안은 proposed 로만 넣는다
ALTER TABLE part_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY part_request_app ON part_request TO pdm_app USING (true) WITH CHECK (true);
CREATE POLICY part_request_agent ON part_request TO class_agent
  USING (source_system = 'AGENT' AND status = 'draft')
  WITH CHECK (source_system = 'AGENT' AND status = 'draft');

ALTER TABLE class_proposal ENABLE ROW LEVEL SECURITY;
CREATE POLICY class_proposal_app ON class_proposal TO pdm_app, graph_publisher USING (true) WITH CHECK (true);
CREATE POLICY class_proposal_agent ON class_proposal TO class_agent
  USING (true)
  WITH CHECK (status = 'proposed');

-- 나중에 만드는 테이블에도 같은 기본 권한
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pdm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA pub GRANT SELECT ON TABLES TO pdm_app, erp_reader, mes_reader, graph_publisher;
