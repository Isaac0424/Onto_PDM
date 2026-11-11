-- =====================================================================
-- 설계 변경 영향 분석 권한 — DBA가 schema.sql · changes.sql · roles.sql 다음에 한 번 실행한다 (여러 번 실행해도 된다).
--   비밀번호는 여기에 두지 않는다 (ALTER ROLE … PASSWORD 를 따로 실행하거나 SSO · 인증서를 쓴다).
--   roles.sql 을 공유 DB 에 그대로 다시 실행하면 안 된다는 기존 결정에 따라 따로 둔다.
--
--   역할           읽기                                   쓰기
--   pdm_app        새 표 전체                              변경 요청 · 지시 · 대상 · 범위 · 영향 · 처분 · 검토 · 개정 사양 · 체결 구성,
--                                                          approve_change_order 실행. 외부 사본 4표는 **읽기만**(주인이 ERP · MES)
--   change_feed    없음                                    pub.upsert_work_order · upsert_work_order_bom_ref ·
--                                                          upsert_purchase_order_line · upsert_stock_lot 실행만 (inventory_feed 와 같은 패턴)
--   graph_publisher 승인된 지시 하위 표(읽기 전용)           없음 (outbox 발행 상태는 roles.sql 이 이미 허용)
--
--   RLS 는 걸지 않는다: 변경 요청을 작성자 · 관리자만 보게 하자는 요구가 PRD 에 없다 (설계 3.7).
-- =====================================================================

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['pdm_app', 'change_feed', 'graph_publisher'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r);
    END IF;
  END LOOP;
END $$;

-- 기본으로 열려 있는 실행 권한을 닫는다
REVOKE EXECUTE ON FUNCTION approve_change_order(bigint, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_runs_stale(bigint[], text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pub.upsert_work_order(text, text, text, text, text, text, text, numeric, numeric, text, bigint, bigint, date, date, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pub.upsert_work_order_bom_ref(text, text, text, text, numeric, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pub.upsert_purchase_order_line(text, text, int, text, text, numeric, numeric, date, text, text, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pub.upsert_stock_lot(text, text, text, text, text, text, numeric, numeric, text, timestamptz) FROM PUBLIC;

-- PDM · PLM API 서버: 새 표를 쓰고 읽는다. roles.sql 의 ALTER DEFAULT PRIVILEGES 가 있어도 순서와 상관없이 되도록 명시한다.
GRANT USAGE ON SCHEMA public, pub TO pdm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app_user_function, ontology_impact, change_request, change_order, impact_run, impact_finding,
  change_target, change_scope, revision_spec, fastening_joint, change_disposition, change_review
  TO pdm_app;
GRANT SELECT ON work_order, work_order_bom_ref, purchase_order_line, stock_lot TO pdm_app;
REVOKE INSERT, UPDATE, DELETE ON work_order, work_order_bom_ref, purchase_order_line, stock_lot FROM pdm_app;   -- 외부 사본: 입구 함수로만 쓴다
GRANT USAGE, SELECT ON SEQUENCE change_request_seq, change_order_seq TO pdm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pdm_app;
GRANT EXECUTE ON FUNCTION approve_change_order(bigint, bigint), issue_change_code(text),
                          effective_revision_at(bigint, text, text, bigint, date), change_scope_is_global(bigint),
                          disposition_action_ok(text, text),
                          mark_runs_stale(bigint[], text) TO pdm_app;   -- 대상 · 범위 변경 트리거(낡음 표시)가 부른다

-- 외부(ERP · MES) 연동: 입구 함수만 실행할 수 있고 어떤 표도 읽지 못한다
GRANT USAGE ON SCHEMA pub TO change_feed;
GRANT EXECUTE ON FUNCTION
  pub.upsert_work_order(text, text, text, text, text, text, text, numeric, numeric, text, bigint, bigint, date, date, timestamptz),
  pub.upsert_work_order_bom_ref(text, text, text, text, numeric, numeric),
  pub.upsert_purchase_order_line(text, text, int, text, text, numeric, numeric, date, text, text, text, timestamptz),
  pub.upsert_stock_lot(text, text, text, text, text, text, numeric, numeric, text, timestamptz)
  TO change_feed;

-- 그래프 발행기: 승인된 지시를 그래프에 올리는 데 필요한 표를 읽기만 한다
GRANT USAGE ON SCHEMA public TO graph_publisher;
GRANT SELECT ON change_request, change_order, change_target, change_scope, impact_run, impact_finding,
                change_disposition, change_review, revision_spec, fastening_joint TO graph_publisher;
