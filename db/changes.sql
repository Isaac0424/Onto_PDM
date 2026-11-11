-- =====================================================================
-- Onto PDM — 설계 변경 영향 분석 증분 스키마 (schema.sql 다음에 실행, 여러 번 실행해도 된다)
--   실행: psql -d onto_pdm -f db/schema.sql -f db/changes.sql [-f db/roles.sql -f db/changes-roles.sql]
--   설계: docs/change-impact-design.md 3장 · docs/change-impact-ontology.md 3 · 7장
--
-- 규칙
--   * 승인된 리비전은 guard_revision / guard_locked_parent 가 지킨다. 변경은 언제나 **새 개정**을 만든다.
--   * 승인된(approved · implemented) 지시의 하위 행(대상 · 범위 · 영향 · 처분 · 검토)은 바꿀 수 없다.
--   * 'approved' 로 바꾸는 길은 approve_change_order() 하나다 (다른 UPDATE 는 거부).
--   * 영향 발견(impact_finding)은 **변경해야 한다**는 뜻이 아니다. 처분(change_disposition)은 사람의 결정이다.
--   * 외부(ERP · MES) 객체는 읽기 사본이다: source_system · as_of 가 항상 붙고, 입구는 pub.upsert_* 뿐이다.
--   * schema.sql 의 파일은 고치지 않는다. 기존 객체의 변경(outbox CHECK, enqueue_publish)은 이 파일이 증분으로 한다.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. 변경 코드 발급 (CR-2026-0001 / CO-2026-0001)
-- ---------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS change_request_seq;
CREATE SEQUENCE IF NOT EXISTS change_order_seq;

CREATE OR REPLACE FUNCTION issue_change_code(p_prefix text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  IF p_prefix = 'CR' THEN
    RETURN 'CR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('change_request_seq')::text, 4, '0');
  ELSIF p_prefix = 'CO' THEN
    RETURN 'CO-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('change_order_seq')::text, 4, '0');
  END IF;
  RAISE EXCEPTION '알 수 없는 변경 코드 접두어입니다: %', p_prefix;
END $$;


-- ---------------------------------------------------------------------
-- 1. 사용자 기능 자격 (설계 · 구매 · 생산 검토). app_user.role 의 CHECK 는 건드리지 않는다.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user_function (
  user_id   bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  function  text   NOT NULL CHECK (function IN ('design', 'purchasing', 'production')),
  PRIMARY KEY (user_id, function)
);


-- ---------------------------------------------------------------------
-- 2. 변경 요청 · 지시
--    온톨로지 변경 보고(ontology_impact)는 보고일 뿐 부품 개정도 지시도 만들지 않는다 (F-CHG-10).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ontology_impact (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_version       text NOT NULL,
  to_version         text NOT NULL,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  summary            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {rules_changed: [...], parts_flagged: [...]}
  change_request_id  bigint                                 -- 이 보고에서 요청이 열렸으면 (FK 는 아래에서)
);

CREATE TABLE IF NOT EXISTS change_request (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                text NOT NULL UNIQUE DEFAULT issue_change_code('CR'),
  title               text NOT NULL,
  reason              text NOT NULL,
  origin              text NOT NULL DEFAULT 'design'
                      CHECK (origin IN ('design', 'quality', 'supplier', 'ontology_impact', 'other')),
  ontology_impact_id  bigint REFERENCES ontology_impact(id),
  before_summary      text,
  after_summary       text,
  status              text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'submitted', 'accepted', 'rejected', 'withdrawn')),
  requested_by        bigint REFERENCES app_user(id) DEFAULT current_app_user(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT change_request_origin_ck CHECK (origin <> 'ontology_impact' OR ontology_impact_id IS NOT NULL)
);

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ontology_impact_request_fk') THEN
    ALTER TABLE ontology_impact
      ADD CONSTRAINT ontology_impact_request_fk FOREIGN KEY (change_request_id) REFERENCES change_request(id);
  END IF;
END $do$;

CREATE TABLE IF NOT EXISTS change_order (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code             text NOT NULL UNIQUE DEFAULT issue_change_code('CO'),
  request_id       bigint NOT NULL UNIQUE REFERENCES change_request(id),   -- 요청 1 : 지시 0..1 (10.3 판단 5)
  product_id       bigint REFERENCES product(id),
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'in_review', 'approved', 'rejected', 'implemented', 'cancelled')),
  status_note      text,                                  -- 반려 · 되돌림 사유
  approved_by      bigint REFERENCES app_user(id),
  approved_at      timestamptz,
  approved_run_id  bigint,                                -- 승인 때 본 영향 분석 실행 (FK 는 impact_run 뒤)
  created_by       bigint REFERENCES app_user(id) DEFAULT current_app_user(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------
-- 3. 영향 분석 실행 · 영향 발견 (판단 시점 스냅샷)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS impact_run (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id          bigint NOT NULL REFERENCES change_order(id) ON DELETE CASCADE,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  computed_by       bigint REFERENCES app_user(id) DEFAULT current_app_user(),
  input_hash        text NOT NULL,                        -- 입력의 정규화 JSON sha256. 같은 입력 → 같은 해시
  ontology_version  text,                                 -- 판정에 쓴 OPMS 온톨로지 버전
  temporary         boolean NOT NULL DEFAULT false,       -- 임시 판정(OPMS 서버 판정이 아닌 것)을 썼으면 true
  external_as_of    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"work_order": ts, "purchase_order_line": ts, "stock_lot": ts}
  stale             boolean NOT NULL DEFAULT false,
  stale_reasons     text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS impact_run_order_idx ON impact_run (order_id, id DESC);

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'change_order_approved_run_fk') THEN
    ALTER TABLE change_order
      ADD CONSTRAINT change_order_approved_run_fk FOREIGN KEY (approved_run_id) REFERENCES impact_run(id);
  END IF;
END $do$;

CREATE TABLE IF NOT EXISTS impact_finding (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id                bigint NOT NULL REFERENCES impact_run(id) ON DELETE CASCADE,
  kind                  text NOT NULL
                        CHECK (kind IN ('bom_usage', 'product', 'work_order', 'purchase_order_line',
                                        'stock_lot', 'fit_pair', 'fit_grip', 'strength_grade')),
  subject_type          text NOT NULL,                    -- item · revision · work_order · … (식별은 subject_ref)
  subject_ref           text NOT NULL,
  severity              text NOT NULL CHECK (severity IN ('none', 'review', 'affected', 'blocked')),
  verdict               text CHECK (verdict IN ('ok', 'conditional', 'no', 'unknown')),   -- 적합성 판정일 때만
  rule_id               text,
  reason_code           text,
  message               text,
  inputs                jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 계산에 쓴 값 전부(단위 · inferred · 출처 포함)
  required              numeric,
  actual                numeric,
  gap                   numeric,
  scope_class           text CHECK (scope_class IN ('inside', 'outside', 'partial', 'unknown')),
  suggested_disposition text,                             -- 기본 제안일 뿐 결정이 아니다
  CONSTRAINT impact_finding_verdict_ck CHECK (verdict IS NULL OR kind IN ('fit_pair', 'fit_grip', 'strength_grade'))
);
CREATE INDEX IF NOT EXISTS impact_finding_run_idx ON impact_finding (run_id, severity);


-- ---------------------------------------------------------------------
-- 4. 변경 대상 · 적용 범위
--    kind 에 'ontology' 는 없다: 온톨로지 변경은 ontology_impact(보고)로만 다룬다 (F-CHG-10).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS change_target (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id             bigint NOT NULL REFERENCES change_order(id) ON DELETE CASCADE,
  kind                 text NOT NULL CHECK (kind IN ('revision', 'replacement', 'bom_line')),
  item_id              bigint NOT NULL REFERENCES item(id),          -- 대상 품목 (교체면 이전 품목, bom_line 이면 자식 품목)
  from_revision_id     bigint REFERENCES item_revision(id),          -- revision: 현재 승인본
  to_revision_id       bigint REFERENCES item_revision(id),          -- revision: 새 개정(작업중). 교체 · 줄 변경은 승인 때 만든 부모 새 개정이 채워진다
  replacement_item_id  bigint REFERENCES item(id),                   -- replacement 만. 새 품번
  parent_revision_id   bigint REFERENCES item_revision(id),          -- replacement · bom_line: 줄이 들어 있는 조립품 개정
  new_quantity         numeric(12,3) CHECK (new_quantity > 0),       -- bom_line 만: 바뀐 수량 (설계 3.2 표에 없는 컬럼 — 줄 변경의 이후 값)
  note                 text,
  UNIQUE (order_id, item_id, kind),
  CONSTRAINT change_target_kind_ck CHECK (
    (kind = 'revision'    AND from_revision_id IS NOT NULL AND to_revision_id IS NOT NULL AND replacement_item_id IS NULL)
 OR (kind = 'replacement' AND replacement_item_id IS NOT NULL AND replacement_item_id <> item_id AND parent_revision_id IS NOT NULL)
 OR (kind = 'bom_line'    AND parent_revision_id IS NOT NULL AND new_quantity IS NOT NULL AND replacement_item_id IS NULL))
);
CREATE INDEX IF NOT EXISTS change_target_order_idx  ON change_target (order_id);
CREATE INDEX IF NOT EXISTS change_target_to_rev_idx ON change_target (to_revision_id);

CREATE TABLE IF NOT EXISTS change_scope (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id       bigint NOT NULL REFERENCES change_target(id) ON DELETE CASCADE,
  effective_from  date,                                  -- NULL = 열린 끝
  effective_to    date,
  site            text,                                  -- NULL = 전체 사업장
  lot_nos         text[],                                -- NULL = 전체 로트 (목록으로 시작 — 10.3 판단 4)
  serial_from     bigint,                                -- 제품 일련번호 범위 (양끝 포함)
  serial_to       bigint,
  applies         text NOT NULL CHECK (applies IN ('new', 'old')),   -- new = 새 개정을 쓰는 범위, old = 기존 개정을 계속 쓰는 범위
  CONSTRAINT change_scope_dates_ck   CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  CONSTRAINT change_scope_serials_ck CHECK (serial_to IS NULL OR serial_from IS NULL OR serial_to >= serial_from),
  CONSTRAINT change_scope_lots_ck    CHECK (lot_nos IS NULL OR cardinality(lot_nos) > 0)
);
CREATE INDEX IF NOT EXISTS change_scope_target_idx ON change_scope (target_id);


-- ---------------------------------------------------------------------
-- 5. 개정별 사양 · 체결 구성 (그립 길이 계산의 입력)
-- ---------------------------------------------------------------------
-- 설계 3.3 은 PK(revision_id, key) 이지만 audit_row() 가 NEW.id 를 쓰므로 대리키 id 를 두고 (revision_id, key) 를 UNIQUE 로 지킨다.
CREATE TABLE IF NOT EXISTS revision_spec (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision_id  bigint NOT NULL REFERENCES item_revision(id) ON DELETE CASCADE,
  key          text   NOT NULL,                          -- thickness nutHeight outerDiameter … (OPMS 속성 키와 같은 이름)
  value        numeric NOT NULL,
  unit         text   NOT NULL DEFAULT 'mm',
  source       text   NOT NULL CHECK (source IN ('drawing', 'opms', 'cad_estimate', 'manual')),   -- cad_estimate = 추정값(판정을 낮춘다)
  UNIQUE (revision_id, key)
);

CREATE TABLE IF NOT EXISTS fastening_joint (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assembly_revision_id  bigint NOT NULL REFERENCES item_revision(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  bolt_item_id          bigint NOT NULL REFERENCES item(id),
  nut_item_id           bigint NOT NULL REFERENCES item(id),
  washer_item_id        bigint REFERENCES item(id),
  washers_per_bolt      smallint NOT NULL DEFAULT 2 CHECK (washers_per_bolt >= 0),
  bolt_count            smallint NOT NULL DEFAULT 1 CHECK (bolt_count > 0),
  clamped               jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{"item_id": 상판, "thickness_key": "thickness"}, …] 순서 포함
  UNIQUE (assembly_revision_id, name)
);


-- ---------------------------------------------------------------------
-- 6. 처분 · 검토
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS change_disposition (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id       bigint NOT NULL REFERENCES change_order(id) ON DELETE CASCADE,
  finding_id     bigint NOT NULL REFERENCES impact_finding(id) ON DELETE CASCADE,
  action         text NOT NULL CHECK (action IN (
                   'continue_old', 'change_in_progress', 'cancel_reissue', 'use_as_is', 'apply_new',        -- 작업지시
                   'receive_and_use', 'amend', 'cancel',                                                    -- 발주 항목
                   'use_up', 'quarantine', 'return', 'scrap',                                               -- 재고 로트
                   'block_change', 'choose_substitute', 'review_with_design',                               -- 적합성
                   'acknowledge',                                                                           -- 사용처 · 제품
                   'accept_risk', 'no_action_needed')),
  scope_id       bigint REFERENCES change_scope(id),     -- 이 처분이 적용되는 범위
  reason         text NOT NULL,
  decided_by     bigint REFERENCES app_user(id) DEFAULT current_app_user(),
  decided_at     timestamptz NOT NULL DEFAULT now(),
  superseded_by  bigint REFERENCES change_disposition(id),   -- 재계산으로 finding 이 새로 생기면 새 처분이 가리킨다
  UNIQUE (order_id, finding_id)
);

CREATE TABLE IF NOT EXISTS change_review (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     bigint NOT NULL REFERENCES change_order(id) ON DELETE CASCADE,
  function     text NOT NULL CHECK (function IN ('design', 'purchasing', 'production')),
  run_id       bigint NOT NULL REFERENCES impact_run(id),    -- 어느 분석을 보고 한 검토인지. 분석이 stale 이면 무효
  verdict      text NOT NULL CHECK (verdict IN ('approve', 'reject', 'comment')),
  comment      text,
  reviewer_id  bigint REFERENCES app_user(id) DEFAULT current_app_user(),
  reviewed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS change_review_order_idx ON change_review (order_id, function, id DESC);


-- ---------------------------------------------------------------------
-- 7. 외부(ERP · MES) 객체 읽기 사본. PDM 은 받아 두기만 한다. 입구는 pub.upsert_* 뿐.
--    source_system 의 'fixture' 는 시험 · 시연용이다 (화면에서 "픽스처" 배지, pub 뷰에는 내보내지 않는다).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_order (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system    text NOT NULL CHECK (source_system IN ('ERP', 'MES', 'fixture')),
  wo_no            text NOT NULL,
  site             text,
  product_item_id  bigint REFERENCES item(id),
  bom_revision_id  bigint REFERENCES item_revision(id),     -- 적용 BOM = 조립품 item_revision
  process_rev      text,                                    -- 적용 공정 개정
  status           text NOT NULL CHECK (status IN ('planned', 'released', 'in_progress', 'completed', 'closed')),
  qty_planned      numeric(14,3) NOT NULL DEFAULT 0,
  qty_done         numeric(14,3) NOT NULL DEFAULT 0,
  lot_no           text,
  serial_from      bigint,
  serial_to        bigint,
  start_date       date,
  due_date         date,
  as_of            timestamptz NOT NULL,                    -- 원래 시스템 기준 시각
  received_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, wo_no)
);
CREATE INDEX IF NOT EXISTS work_order_bom_rev_idx ON work_order (bom_revision_id);

CREATE TABLE IF NOT EXISTS work_order_bom_ref (            -- 작업지시가 실제로 쓰는 부품과 개정의 스냅샷
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_order_id  bigint NOT NULL REFERENCES work_order(id) ON DELETE CASCADE,
  item_id        bigint NOT NULL REFERENCES item(id),
  revision_id    bigint REFERENCES item_revision(id),
  qty_required   numeric(14,3) NOT NULL DEFAULT 0,
  qty_issued     numeric(14,3) NOT NULL DEFAULT 0,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_order_id, item_id)
);
CREATE INDEX IF NOT EXISTS work_order_bom_ref_item_idx ON work_order_bom_ref (item_id);

CREATE TABLE IF NOT EXISTS purchase_order_line (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system  text NOT NULL CHECK (source_system IN ('ERP', 'MES', 'fixture')),
  po_no          text NOT NULL,
  line_no        int  NOT NULL,
  item_id        bigint NOT NULL REFERENCES item(id),
  item_rev       text,                                      -- 발주 때의 개정
  qty_ordered    numeric(14,3) NOT NULL,
  qty_received   numeric(14,3) NOT NULL DEFAULT 0,          -- 미입고 = qty_ordered - qty_received
  due_date       date,
  supplier       text,
  site           text,
  status         text NOT NULL CHECK (status IN ('open', 'partial', 'closed', 'cancelled')),
  as_of          timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, po_no, line_no)
);
CREATE INDEX IF NOT EXISTS purchase_order_line_item_idx ON purchase_order_line (item_id);

-- 로트 단위 재고. inventory_balance(품목 · 사업장 · 위치 합계)는 그대로 둔다. 둘의 합계가 맞아야 한다는 불변식은 두지 않는다.
CREATE TABLE IF NOT EXISTS stock_lot (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system  text NOT NULL CHECK (source_system IN ('ERP', 'MES', 'fixture')),
  lot_no         text NOT NULL,
  item_id        bigint NOT NULL REFERENCES item(id),
  item_rev       text,
  site           text NOT NULL,
  location       text NOT NULL DEFAULT '',
  qty_on_hand    numeric(14,3) NOT NULL,
  qty_allocated  numeric(14,3) NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'quarantine', 'hold')),
  as_of          timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, lot_no, item_id, site, location)
);
CREATE INDEX IF NOT EXISTS stock_lot_item_idx ON stock_lot (item_id);


-- =====================================================================
-- 함수 · 트리거
-- =====================================================================

-- ---------------------------------------------------------------------
-- A. 영향 분석 낡음(stale) 표시 (설계 4.6): 입력이 바뀌면 열린 지시의 **최신** 실행을 stale 로 올린다.
--    approve_change_order 가 승인하는 지시는 건드리지 않는다 (승인 당시 분석이 승인 근거로 남아야 한다).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mark_runs_stale(p_orders bigint[], p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE impact_run r
  SET stale = true,
      stale_reasons = array_append(r.stale_reasons, p_reason)
  FROM change_order o
  WHERE o.id = r.order_id
    AND (p_orders IS NULL OR o.id = ANY (p_orders))
    AND o.status IN ('draft', 'in_review')
    AND o.id::text <> coalesce(current_setting('app.approving_order', true), '')
    AND r.id = (SELECT max(x.id) FROM impact_run x WHERE x.order_id = o.id)
    AND NOT (p_reason = ANY (r.stale_reasons));
END $$;

CREATE OR REPLACE FUNCTION stale_on_target_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mark_runs_stale(ARRAY[CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END], 'target_changed');
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION stale_on_scope_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_target bigint := CASE WHEN TG_OP = 'DELETE' THEN OLD.target_id ELSE NEW.target_id END;
BEGIN
  PERFORM mark_runs_stale(ARRAY(SELECT order_id FROM change_target WHERE id = v_target), 'scope_changed');
  RETURN NULL;
END $$;

-- 개정 사양 · 체결 구성이 바뀌면 그 개정을 대상으로 잡은 열린 지시를 stale 로
CREATE OR REPLACE FUNCTION stale_on_revision_input_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_row jsonb;
  v_rev bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); ELSE v_row := to_jsonb(NEW); END IF;
  v_rev := (v_row ->> (CASE TG_TABLE_NAME WHEN 'fastening_joint' THEN 'assembly_revision_id' ELSE 'revision_id' END))::bigint;
  PERFORM mark_runs_stale(ARRAY(
    SELECT order_id FROM change_target
    WHERE v_rev IN (from_revision_id, to_revision_id, parent_revision_id)), TG_TABLE_NAME || '_changed');
  RETURN NULL;
END $$;

-- 영향 품목의 새 개정이 승인되면 그 품목을 대상 · 부모로 잡은 열린 지시를 stale 로
CREATE OR REPLACE FUNCTION stale_on_revision_release() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mark_runs_stale(ARRAY(
    SELECT DISTINCT t.order_id FROM change_target t
    WHERE t.item_id = NEW.item_id
       OR t.parent_revision_id IN (SELECT id FROM item_revision WHERE item_id = NEW.item_id)), 'revision_released');
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION stale_on_external_feed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mark_runs_stale(NULL, 'external_feed:' || TG_TABLE_NAME);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS change_target_stale ON change_target;
CREATE TRIGGER change_target_stale AFTER INSERT OR UPDATE OR DELETE ON change_target
  FOR EACH ROW EXECUTE FUNCTION stale_on_target_change();
DROP TRIGGER IF EXISTS change_scope_stale ON change_scope;
CREATE TRIGGER change_scope_stale AFTER INSERT OR UPDATE OR DELETE ON change_scope
  FOR EACH ROW EXECUTE FUNCTION stale_on_scope_change();
DROP TRIGGER IF EXISTS revision_spec_stale ON revision_spec;
CREATE TRIGGER revision_spec_stale AFTER INSERT OR UPDATE OR DELETE ON revision_spec
  FOR EACH ROW EXECUTE FUNCTION stale_on_revision_input_change();
DROP TRIGGER IF EXISTS fastening_joint_stale ON fastening_joint;
CREATE TRIGGER fastening_joint_stale AFTER INSERT OR UPDATE OR DELETE ON fastening_joint
  FOR EACH ROW EXECUTE FUNCTION stale_on_revision_input_change();
DROP TRIGGER IF EXISTS item_revision_change_stale ON item_revision;
CREATE TRIGGER item_revision_change_stale AFTER UPDATE OF status ON item_revision
  FOR EACH ROW WHEN (NEW.status = 'released' AND OLD.status IS DISTINCT FROM 'released')
  EXECUTE FUNCTION stale_on_revision_release();
DROP TRIGGER IF EXISTS work_order_stale ON work_order;
CREATE TRIGGER work_order_stale AFTER INSERT OR UPDATE ON work_order
  FOR EACH ROW EXECUTE FUNCTION stale_on_external_feed();
DROP TRIGGER IF EXISTS work_order_bom_ref_stale ON work_order_bom_ref;
CREATE TRIGGER work_order_bom_ref_stale AFTER INSERT OR UPDATE ON work_order_bom_ref
  FOR EACH ROW EXECUTE FUNCTION stale_on_external_feed();
DROP TRIGGER IF EXISTS purchase_order_line_stale ON purchase_order_line;
CREATE TRIGGER purchase_order_line_stale AFTER INSERT OR UPDATE ON purchase_order_line
  FOR EACH ROW EXECUTE FUNCTION stale_on_external_feed();
DROP TRIGGER IF EXISTS stock_lot_stale ON stock_lot;
CREATE TRIGGER stock_lot_stale AFTER INSERT OR UPDATE ON stock_lot
  FOR EACH ROW EXECUTE FUNCTION stale_on_external_feed();


-- ---------------------------------------------------------------------
-- B. 요청 · 지시 상태 전이
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_change_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status, NEW.status) NOT IN (('draft', 'submitted'), ('submitted', 'accepted'), ('submitted', 'rejected'),
                                          ('draft', 'withdrawn'), ('submitted', 'withdrawn')) THEN
    RAISE EXCEPTION 'CHANGE_STATE_INVALID: 허용되지 않는 요청 상태 변경입니다: % → % (change_request.id=%)', OLD.status, NEW.status, OLD.id;
  END IF;
  IF OLD.status IN ('accepted', 'rejected', 'withdrawn') AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'CHANGE_STATE_INVALID: 종결된 변경 요청은 수정할 수 없습니다 (change_request.id=%, status=%)', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS change_request_guard ON change_request;
CREATE TRIGGER change_request_guard BEFORE UPDATE ON change_request
  FOR EACH ROW EXECUTE FUNCTION guard_change_request();

-- 지시는 수락된 요청에서만 연다
CREATE OR REPLACE FUNCTION guard_change_order_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM change_request WHERE id = NEW.request_id FOR SHARE;
  IF v_status IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'CHANGE_STATE_INVALID: 수락(accepted)된 요청에서만 지시를 열 수 있습니다 (change_request.id=%, status=%)', NEW.request_id, coalesce(v_status, '없음');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS change_order_insert_guard ON change_order;
CREATE TRIGGER change_order_insert_guard BEFORE INSERT ON change_order
  FOR EACH ROW EXECUTE FUNCTION guard_change_order_insert();

-- 지시 상태 전이 · 승인 뒤 잠금.
--   draft → in_review : 대상 ≥ 1, 모든 대상에 새 개정 범위(applies='new'), 분석이 있고 stale 이 아니어야 한다
--   'approved' · 'implemented' 로 바꾸는 길은 approve_change_order() 하나다 (그 함수가 app.approving_order 를 알린다)
CREATE OR REPLACE FUNCTION guard_change_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_run  impact_run%ROWTYPE;
  v_miss text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'CHANGE_STATE_INVALID: 작성중(draft) 지시만 삭제할 수 있습니다 (change_order.id=%, status=%)', OLD.id, OLD.status;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF (OLD.status, NEW.status) NOT IN (('draft', 'in_review'), ('in_review', 'draft'), ('in_review', 'approved'),
                                        ('in_review', 'rejected'), ('approved', 'implemented'),
                                        ('draft', 'cancelled'), ('in_review', 'cancelled')) THEN
      RAISE EXCEPTION 'CHANGE_STATE_INVALID: 허용되지 않는 지시 상태 변경입니다: % → % (change_order.id=%)', OLD.status, NEW.status, OLD.id;
    END IF;
    IF NEW.status IN ('approved', 'implemented')
       AND coalesce(current_setting('app.approving_order', true), '') <> NEW.id::text THEN
      RAISE EXCEPTION 'CHANGE_STATE_INVALID: 승인은 approve_change_order() 로만 할 수 있습니다 (change_order.id=%)', OLD.id;
    END IF;
    IF (NEW.status = 'rejected' OR (OLD.status = 'in_review' AND NEW.status = 'draft'))
       AND coalesce(NEW.status_note, '') = '' THEN
      RAISE EXCEPTION 'REASON_REQUIRED: 반려 · 되돌림에는 사유(status_note)가 필요합니다 (change_order.id=%)', OLD.id;
    END IF;
    IF OLD.status = 'draft' AND NEW.status = 'in_review' THEN
      IF NOT EXISTS (SELECT 1 FROM change_target WHERE order_id = OLD.id) THEN
        RAISE EXCEPTION 'TARGET_REQUIRED: 변경 대상이 없는 지시는 검토로 보낼 수 없습니다 (change_order.id=%)', OLD.id;
      END IF;
      SELECT string_agg(t.id::text, ',' ORDER BY t.id) INTO v_miss
      FROM change_target t
      WHERE t.order_id = OLD.id
        AND NOT EXISTS (SELECT 1 FROM change_scope s WHERE s.target_id = t.id AND s.applies = 'new');
      IF v_miss IS NOT NULL THEN
        RAISE EXCEPTION 'SCOPE_REQUIRED: 적용 범위가 없는 대상이 있습니다 (target_ids=%)', v_miss;
      END IF;
      SELECT * INTO v_run FROM impact_run WHERE order_id = OLD.id ORDER BY id DESC LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'IMPACT_NOT_COMPUTED: 영향 분석을 먼저 실행하세요 (change_order.id=%)', OLD.id;
      END IF;
      IF v_run.stale THEN
        RAISE EXCEPTION 'IMPACT_STALE: 영향 분석이 낡았습니다. 다시 실행하세요 (impact_run.id=%)', v_run.id;
      END IF;
    END IF;
  ELSIF OLD.status IN ('approved', 'implemented', 'rejected', 'cancelled')
        AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'CHANGE_LOCKED: 승인 · 종결된 지시는 수정할 수 없습니다 (change_order.id=%, status=%)', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS change_order_guard ON change_order;
CREATE TRIGGER change_order_guard BEFORE UPDATE OR DELETE ON change_order
  FOR EACH ROW EXECUTE FUNCTION guard_change_order();

-- 승인된 지시의 하위 행(대상 · 범위 · 영향 · 처분 · 검토)은 바꿀 수 없다.
--   지시 행을 FOR SHARE 로 잠근 뒤 상태를 본다: 다른 트랜잭션이 지시를 승인하는 중이면 그 커밋을 기다렸다가 최신 상태로 판단한다
--   (잠그지 않으면 승인 직전 상태를 보고 통과한다. guard_locked_parent 와 같은 패턴).
CREATE OR REPLACE FUNCTION change_order_of(p_table text, p_row jsonb) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT CASE p_table
    WHEN 'change_scope'   THEN (SELECT order_id FROM change_target WHERE id = (p_row ->> 'target_id')::bigint)
    WHEN 'impact_finding' THEN (SELECT order_id FROM impact_run WHERE id = (p_row ->> 'run_id')::bigint)
    ELSE (p_row ->> 'order_id')::bigint
  END
$$;

CREATE OR REPLACE FUNCTION guard_change_children() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ids    bigint[] := '{}';
  locked bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN ids := ids || change_order_of(TG_TABLE_NAME, to_jsonb(OLD)); END IF;
  IF TG_OP <> 'DELETE' THEN ids := ids || change_order_of(TG_TABLE_NAME, to_jsonb(NEW)); END IF;
  SELECT min(id) FILTER (WHERE status IN ('approved', 'implemented')) INTO locked
  FROM (SELECT id, status FROM change_order WHERE id = ANY (ids) ORDER BY id FOR SHARE) p;
  IF locked IS NOT NULL THEN
    RAISE EXCEPTION 'CHANGE_LOCKED: 승인된 지시(change_order.id=%)의 내용은 바꿀 수 없습니다. 새 변경 요청을 만드세요 (%)', locked, TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS change_target_lock ON change_target;
CREATE TRIGGER change_target_lock BEFORE INSERT OR UPDATE OR DELETE ON change_target
  FOR EACH ROW EXECUTE FUNCTION guard_change_children();
DROP TRIGGER IF EXISTS change_scope_lock ON change_scope;
CREATE TRIGGER change_scope_lock BEFORE INSERT OR UPDATE OR DELETE ON change_scope
  FOR EACH ROW EXECUTE FUNCTION guard_change_children();
DROP TRIGGER IF EXISTS impact_run_lock ON impact_run;
CREATE TRIGGER impact_run_lock BEFORE INSERT OR UPDATE OR DELETE ON impact_run
  FOR EACH ROW EXECUTE FUNCTION guard_change_children();
DROP TRIGGER IF EXISTS impact_finding_lock ON impact_finding;
CREATE TRIGGER impact_finding_lock BEFORE INSERT OR UPDATE OR DELETE ON impact_finding
  FOR EACH ROW EXECUTE FUNCTION guard_change_children();
DROP TRIGGER IF EXISTS change_disposition_lock ON change_disposition;
CREATE TRIGGER change_disposition_lock BEFORE INSERT OR UPDATE OR DELETE ON change_disposition
  FOR EACH ROW EXECUTE FUNCTION guard_change_children();
DROP TRIGGER IF EXISTS change_review_lock ON change_review;
CREATE TRIGGER change_review_lock BEFORE INSERT OR UPDATE OR DELETE ON change_review
  FOR EACH ROW EXECUTE FUNCTION guard_change_children();


-- ---------------------------------------------------------------------
-- C. 대상 검증 · 부품 개정 가드(F-CHG-10)
--    같은 품번 안의 값(도면 · 공차 · 판 두께 · 검사 조건)만 개정으로 바꿀 수 있다.
--    OPMS 가 부품 값으로 갖는 식별 속성(threadSize · length · pitch · material · strengthGrade)이 바뀌면 새 품번(교체)이다.
--    revision_spec 은 숫자만 담으므로 숫자 식별 속성(length · pitch)이 실제로 검사 대상이고, 글자 속성은 API 가 막는다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION change_identity_violation(p_from bigint, p_to bigint) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT string_agg(s.key, ', ' ORDER BY s.key)
  FROM revision_spec s
  WHERE s.revision_id = p_to
    AND lower(s.key) IN ('threadsize', 'length', 'pitch', 'material', 'strengthgrade')
    AND NOT EXISTS (SELECT 1 FROM revision_spec f
                    WHERE f.revision_id = p_from AND f.key = s.key AND f.value = s.value)
$$;

CREATE OR REPLACE FUNCTION guard_change_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  f item_revision%ROWTYPE;
  p item_revision%ROWTYPE;
  n item_revision%ROWTYPE;
  v_keys text;
BEGIN
  IF NEW.kind = 'revision' THEN
    IF TG_OP = 'INSERT' OR NEW.from_revision_id IS DISTINCT FROM OLD.from_revision_id
       OR NEW.to_revision_id IS DISTINCT FROM OLD.to_revision_id THEN
      SELECT * INTO f FROM item_revision WHERE id = NEW.from_revision_id;
      SELECT * INTO n FROM item_revision WHERE id = NEW.to_revision_id;
      IF f.status IS DISTINCT FROM 'released' THEN
        RAISE EXCEPTION 'TARGET_NOT_RELEASED: 개정 대상의 현재 개정은 승인본이어야 합니다 (item_revision.id=%, status=%)', NEW.from_revision_id, coalesce(f.status, '없음');
      END IF;
      IF f.item_id <> NEW.item_id OR n.item_id <> NEW.item_id THEN
        RAISE EXCEPTION 'TARGET_ITEM_MISMATCH: 개정은 대상 품목(id=%)의 개정이어야 합니다', NEW.item_id;
      END IF;
      IF TG_OP = 'INSERT' AND n.status <> 'wip' THEN
        RAISE EXCEPTION 'TARGET_REVISION_STATE: 새 개정은 작업중(wip)으로 등록하세요 (item_revision.id=%, status=%)', n.id, n.status;
      END IF;
      IF n.rev_seq <= f.rev_seq THEN
        RAISE EXCEPTION 'TARGET_REVISION_STATE: 새 개정은 현재 개정보다 뒤여야 합니다 (rev_seq % <= %)', n.rev_seq, f.rev_seq;
      END IF;
      v_keys := change_identity_violation(NEW.from_revision_id, NEW.to_revision_id);
      IF v_keys IS NOT NULL THEN
        RAISE EXCEPTION 'REVISION_CHANGES_IDENTITY: 규격이 바뀌면 새 품번이에요. 교체로 등록하세요 (바뀌는 식별 속성: %)', v_keys;
      END IF;
    END IF;
  ELSE
    IF TG_OP = 'INSERT' OR NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id OR NEW.item_id IS DISTINCT FROM OLD.item_id THEN
      SELECT * INTO p FROM item_revision WHERE id = NEW.parent_revision_id;
      IF p.status IS DISTINCT FROM 'released' THEN
        RAISE EXCEPTION 'TARGET_NOT_RELEASED: 조립품의 현재 개정은 승인본이어야 합니다 (item_revision.id=%, status=%)', NEW.parent_revision_id, coalesce(p.status, '없음');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM bom_line WHERE parent_revision_id = NEW.parent_revision_id AND child_item_id = NEW.item_id) THEN
        RAISE EXCEPTION 'TARGET_NOT_IN_BOM: 이 조립품 개정의 BOM 에 없는 품목입니다 (parent_revision_id=%, item_id=%)', NEW.parent_revision_id, NEW.item_id;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS change_target_check ON change_target;
CREATE TRIGGER change_target_check BEFORE INSERT OR UPDATE ON change_target
  FOR EACH ROW EXECUTE FUNCTION guard_change_target();

-- 개정의 사양이 나중에 들어와도 같은 규칙을 지킨다
CREATE OR REPLACE FUNCTION guard_revision_spec_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t record;
BEGIN
  IF lower(NEW.key) IN ('threadsize', 'length', 'pitch', 'material', 'strengthgrade') THEN
    FOR t IN SELECT from_revision_id FROM change_target WHERE kind = 'revision' AND to_revision_id = NEW.revision_id LOOP
      IF NOT EXISTS (SELECT 1 FROM revision_spec f
                     WHERE f.revision_id = t.from_revision_id AND f.key = NEW.key AND f.value = NEW.value) THEN
        RAISE EXCEPTION 'REVISION_CHANGES_IDENTITY: 규격이 바뀌면 새 품번이에요. 교체로 등록하세요 (바뀌는 식별 속성: %)', NEW.key;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS revision_spec_identity ON revision_spec;
CREATE TRIGGER revision_spec_identity BEFORE INSERT OR UPDATE ON revision_spec
  FOR EACH ROW EXECUTE FUNCTION guard_revision_spec_identity();

-- 승인된 리비전의 사양 · 체결 구성은 잠긴다 (BOM 줄과 같은 규칙)
DROP TRIGGER IF EXISTS revision_spec_lock ON revision_spec;
CREATE TRIGGER revision_spec_lock BEFORE INSERT OR UPDATE OR DELETE ON revision_spec
  FOR EACH ROW EXECUTE FUNCTION guard_locked_parent('item_revision', 'revision_id');
DROP TRIGGER IF EXISTS fastening_joint_lock ON fastening_joint;
CREATE TRIGGER fastening_joint_lock BEFORE INSERT OR UPDATE OR DELETE ON fastening_joint
  FOR EACH ROW EXECUTE FUNCTION guard_locked_parent('item_revision', 'assembly_revision_id');


-- ---------------------------------------------------------------------
-- D. 적용 범위: 같은 대상에서 새 개정 범위(applies='new')끼리 겹치면 거부 (SCOPE_OVERLAP)
--    날짜 · 일련번호는 구간 겹침, 사업장은 같거나 한쪽이 전체, 로트는 목록이 겹치거나 한쪽이 전체.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_change_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  other bigint;
BEGIN
  -- 구간이 거꾸로면 구간 비교가 오류를 내므로 겹침 검사는 건너뛴다 (CHECK 가 더 알기 쉬운 오류를 낸다)
  IF NEW.serial_to < NEW.serial_from OR NEW.effective_to < NEW.effective_from THEN
    RETURN NEW;
  END IF;
  IF NEW.applies = 'new' THEN
    SELECT s.id INTO other
    FROM change_scope s
    WHERE s.target_id = NEW.target_id AND s.applies = 'new' AND s.id IS DISTINCT FROM NEW.id
      AND daterange(s.effective_from, s.effective_to, '[]') && daterange(NEW.effective_from, NEW.effective_to, '[]')
      AND int8range(s.serial_from, s.serial_to, '[]') && int8range(NEW.serial_from, NEW.serial_to, '[]')
      AND (s.site IS NULL OR NEW.site IS NULL OR s.site = NEW.site)
      AND (s.lot_nos IS NULL OR NEW.lot_nos IS NULL OR s.lot_nos && NEW.lot_nos)
    LIMIT 1;
    IF other IS NOT NULL THEN
      RAISE EXCEPTION 'SCOPE_OVERLAP: 같은 대상의 새 개정 적용 범위가 겹칩니다 (change_scope.id=%, 겹치는 id=%)', coalesce(NEW.id, 0), other;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS change_scope_overlap ON change_scope;
CREATE TRIGGER change_scope_overlap BEFORE INSERT OR UPDATE ON change_scope
  FOR EACH ROW EXECUTE FUNCTION guard_change_scope();


-- ---------------------------------------------------------------------
-- E. 처분 · 검토 검증
-- ---------------------------------------------------------------------
-- 영향 종류별로 고를 수 있는 처분 (설계 4.7)
CREATE OR REPLACE FUNCTION disposition_action_ok(p_kind text, p_action text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_action = 'no_action_needed' OR p_action = ANY (CASE p_kind
    WHEN 'work_order'          THEN ARRAY['continue_old', 'change_in_progress', 'cancel_reissue', 'use_as_is', 'apply_new']
    WHEN 'purchase_order_line' THEN ARRAY['receive_and_use', 'amend', 'cancel', 'accept_risk']
    WHEN 'stock_lot'           THEN ARRAY['use_up', 'quarantine', 'return', 'scrap', 'accept_risk']
    WHEN 'fit_pair'            THEN ARRAY['block_change', 'choose_substitute', 'review_with_design', 'accept_risk']
    WHEN 'fit_grip'            THEN ARRAY['block_change', 'choose_substitute', 'review_with_design', 'accept_risk']
    WHEN 'strength_grade'      THEN ARRAY['block_change', 'choose_substitute', 'review_with_design', 'accept_risk']
    WHEN 'bom_usage'           THEN ARRAY['acknowledge']
    WHEN 'product'             THEN ARRAY['acknowledge']
    ELSE ARRAY[]::text[] END)
$$;

CREATE OR REPLACE FUNCTION guard_change_disposition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  f   impact_finding%ROWTYPE;
  r   impact_run%ROWTYPE;
  o   change_order%ROWTYPE;
  v_latest bigint;
BEGIN
  SELECT * INTO f FROM impact_finding WHERE id = NEW.finding_id;
  SELECT * INTO r FROM impact_run WHERE id = f.run_id;
  IF r.order_id <> NEW.order_id THEN
    RAISE EXCEPTION 'DISPOSITION_INVALID: 이 지시의 영향 발견이 아닙니다 (finding_id=%, order_id=%)', NEW.finding_id, NEW.order_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.action = OLD.action AND NEW.finding_id = OLD.finding_id THEN
    RETURN NEW;   -- 승계(superseded_by) 표시 같은 부수 갱신
  END IF;
  SELECT * INTO o FROM change_order WHERE id = NEW.order_id;
  IF o.status NOT IN ('draft', 'in_review') THEN
    RAISE EXCEPTION 'CHANGE_STATE_INVALID: 작성중 · 검토중 지시에서만 처분을 정할 수 있습니다 (status=%)', o.status;
  END IF;
  SELECT max(id) INTO v_latest FROM impact_run WHERE order_id = NEW.order_id;
  IF r.id <> v_latest OR r.stale THEN
    RAISE EXCEPTION 'IMPACT_STALE: 최신 · 낡지 않은 영향 분석의 영향 발견에만 처분을 정할 수 있습니다 (impact_run.id=%)', r.id;
  END IF;
  IF NOT disposition_action_ok(f.kind, NEW.action) THEN
    RAISE EXCEPTION 'DISPOSITION_INVALID: % 영향에는 % 처분을 쓸 수 없습니다', f.kind, NEW.action;
  END IF;
  IF NEW.action = 'accept_risk' AND f.severity = 'blocked' THEN
    RAISE EXCEPTION 'DISPOSITION_INVALID: blocked 영향은 위험 수용으로 닫을 수 없습니다. 변경안을 고쳐 다시 분석하세요 (10.3 판단 필요)';
  END IF;
  IF NEW.action = 'no_action_needed' AND f.severity IN ('affected', 'blocked') THEN
    RAISE EXCEPTION 'DISPOSITION_INVALID: % 영향은 no_action_needed 로 닫을 수 없습니다 (처분을 정하세요)', f.severity;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS change_disposition_check ON change_disposition;
CREATE TRIGGER change_disposition_check BEFORE INSERT OR UPDATE ON change_disposition
  FOR EACH ROW EXECUTE FUNCTION guard_change_disposition();

-- 검토: 해당 기능(function) 자격자만, 검토중 지시에서, 최신 · 낡지 않은 분석을 보고
CREATE OR REPLACE FUNCTION guard_change_review() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r        impact_run%ROWTYPE;
  v_status text;
  v_latest bigint;
BEGIN
  SELECT status INTO v_status FROM change_order WHERE id = NEW.order_id;
  IF v_status IS DISTINCT FROM 'in_review' THEN
    RAISE EXCEPTION 'CHANGE_STATE_INVALID: 검토중(in_review) 지시에서만 검토할 수 있습니다 (status=%)', coalesce(v_status, '없음');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_user_function WHERE user_id = NEW.reviewer_id AND function = NEW.function) THEN
    RAISE EXCEPTION 'FORBIDDEN: % 검토 자격이 없습니다 (app.user_id=%)', NEW.function, coalesce(NEW.reviewer_id::text, '없음');
  END IF;
  SELECT * INTO r FROM impact_run WHERE id = NEW.run_id;
  SELECT max(id) INTO v_latest FROM impact_run WHERE order_id = NEW.order_id;
  IF r.order_id IS DISTINCT FROM NEW.order_id OR r.id <> v_latest OR r.stale THEN
    RAISE EXCEPTION 'IMPACT_STALE: 최신 · 낡지 않은 영향 분석을 보고 검토해야 합니다 (impact_run.id=%)', NEW.run_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS change_review_check ON change_review;
CREATE TRIGGER change_review_check BEFORE INSERT ON change_review
  FOR EACH ROW EXECUTE FUNCTION guard_change_review();


-- ---------------------------------------------------------------------
-- F. 조회: 어느 개정이 유효한가 (부분 적용 범위)
--    범위가 부분이면 같은 품목의 두 개정이 동시에 released 다. 기존 effective_revision(item, rule)은
--    "범위를 무시한 최신"으로 이름 · 동작을 그대로 둔다(schema.sql). 이 함수는 상황(사업장 · 로트 · 일련번호 · 날짜)을 받아 고른다.
--    규칙: 승인(released)된 개정을 새것부터 보면서,
--          * 승인된 지시가 그 개정을 '새 개정'으로 가리키면 → 그 범위(applies='new')가 상황을 덮을 때만 유효
--          * 가리키는 지시가 없으면(처음 개정 등) → 무조건 유효
--          범위가 제한한 차원(사업장 · 로트 · 일련번호)을 호출자가 모르면(NULL) 덮는다고 보지 않는다(보수적: 이전 개정).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION effective_revision_at(
  p_item bigint, p_site text DEFAULT NULL, p_lot text DEFAULT NULL, p_serial bigint DEFAULT NULL,
  p_on date DEFAULT current_date
) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT r.id
     FROM item_revision r
     WHERE r.item_id = p_item AND r.status = 'released'
       AND (
         NOT EXISTS (SELECT 1 FROM change_target t JOIN change_order o ON o.id = t.order_id
                     WHERE t.to_revision_id = r.id AND o.status IN ('approved', 'implemented'))
         OR EXISTS (SELECT 1 FROM change_target t
                    JOIN change_order o ON o.id = t.order_id
                    JOIN change_scope s ON s.target_id = t.id AND s.applies = 'new'
                    WHERE t.to_revision_id = r.id AND o.status IN ('approved', 'implemented')
                      AND (s.effective_from IS NULL OR s.effective_from <= p_on)
                      AND (s.effective_to   IS NULL OR s.effective_to   >= p_on)
                      AND (s.site IS NULL OR s.site = p_site)
                      AND (s.lot_nos IS NULL OR p_lot = ANY (s.lot_nos))
                      AND ((s.serial_from IS NULL AND s.serial_to IS NULL)
                           OR (p_serial IS NOT NULL
                               AND (s.serial_from IS NULL OR p_serial >= s.serial_from)
                               AND (s.serial_to   IS NULL OR p_serial <= s.serial_to))))
       )
     ORDER BY r.rev_seq DESC
     LIMIT 1),
    effective_revision(p_item, 'released'))
$$;

-- 적용 범위가 "전체 · 즉시"인가: 이전 개정을 폐기(obsolete)해도 되는 경우
CREATE OR REPLACE FUNCTION change_scope_is_global(p_target bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM change_scope s
                 WHERE s.target_id = p_target AND s.applies = 'new'
                   AND (s.effective_from IS NULL OR s.effective_from <= current_date)
                   AND s.effective_to IS NULL AND s.site IS NULL AND s.lot_nos IS NULL
                   AND s.serial_from IS NULL AND s.serial_to IS NULL)
     AND NOT EXISTS (SELECT 1 FROM change_scope s WHERE s.target_id = p_target AND s.applies = 'old')
$$;

-- 교체 대상이면 새 품목, 아니면 그대로 (승인 때 부모 새 개정의 BOM · 체결 구성을 복사하면서 쓴다)
CREATE OR REPLACE FUNCTION change_item_after(p_order bigint, p_parent_revision bigint, p_item bigint) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT t.replacement_item_id FROM change_target t
                   WHERE t.order_id = p_order AND t.kind = 'replacement'
                     AND t.parent_revision_id = p_parent_revision AND t.item_id = p_item), p_item)
$$;


-- ---------------------------------------------------------------------
-- G. 승인 = 새 개정 발행 (한 트랜잭션). 승인본은 고치지 않고 새 개정을 만든다 (설계 3.6).
--    p_user 를 주면 그 사용자로 확인 · 감사한다 (SET LOCAL app.user_id 와 같다).
--    오류 메시지는 'CODE: 설명' 형식이라 API 가 앞의 코드로 409 · 422 를 정한다.
--    '검토 필요한 기능'은 design(항상) + purchasing(발주 · 재고 영향이 affected 일 때) + production(작업지시 영향이 affected 일 때).
--    새 개정 번호는 'R' + 두 자리 rev_seq. 개정 대상(kind=revision)의 새 개정은 앞선 단계에서 사람이 작업중으로 만들어 둔 것이다.
--    개정 대상 중 BOM 줄이 적은 개정을 먼저 올린다(하위 먼저, guard_release_children).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION approve_change_order(p_order bigint, p_user bigint DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o        change_order%ROWTYPE;
  req_st   text;
  run      impact_run%ROWTYPE;
  v_ids    text;
  v_func   text;
  v_need   boolean;
  rv       record;
  t        record;
  g        record;
  v_item   bigint;
  v_seq    int;
  v_new    bigint;
  v_state  text;
BEGIN
  IF p_user IS NOT NULL THEN
    PERFORM set_config('app.user_id', p_user::text, true);
  END IF;
  PERFORM require_app_role(ARRAY['admin', 'approver']);

  SELECT * INTO o FROM change_order WHERE id = p_order FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHANGE_NOT_FOUND: 변경 지시(id=%)가 없습니다', p_order;
  END IF;
  IF o.status <> 'in_review' THEN
    RAISE EXCEPTION 'CHANGE_STATE_INVALID: 검토중(in_review) 지시만 승인할 수 있습니다 (id=%, status=%)', p_order, o.status;
  END IF;
  SELECT status INTO req_st FROM change_request WHERE id = o.request_id;
  IF req_st IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'CHANGE_STATE_INVALID: 요청이 수락(accepted)되지 않았습니다 (change_request.id=%, status=%)', o.request_id, coalesce(req_st, '없음');
  END IF;

  -- 영향 분석: 있어야 하고, 최신이며 낡지 않아야 한다
  SELECT * INTO run FROM impact_run WHERE order_id = p_order ORDER BY id DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IMPACT_NOT_COMPUTED: 영향 분석이 없습니다 (change_order.id=%)', p_order;
  END IF;
  IF run.stale THEN
    RAISE EXCEPTION 'IMPACT_STALE: 영향 분석이 낡았습니다. 다시 실행하세요 (impact_run.id=%, 사유=%)', run.id, array_to_string(run.stale_reasons, ',');
  END IF;

  -- blocked 가 남아 있으면 승인 불가 (제안대로면 체결이 성립하지 않는다. 예외 승인은 10.3 판단 필요)
  SELECT string_agg(id::text, ',' ORDER BY id) INTO v_ids FROM impact_finding WHERE run_id = run.id AND severity = 'blocked';
  IF v_ids IS NOT NULL THEN
    RAISE EXCEPTION 'BLOCKED_FINDINGS: 제안대로면 성립하지 않는 영향이 남아 있어 승인할 수 없습니다 (finding_ids=%)', v_ids;
  END IF;

  -- affected 마다 처분이 있어야 한다 (영향 ≠ 변경: 처분은 사람의 결정)
  SELECT string_agg(f.id::text, ',' ORDER BY f.id) INTO v_ids
  FROM impact_finding f
  WHERE f.run_id = run.id AND f.severity = 'affected'
    AND NOT EXISTS (SELECT 1 FROM change_disposition d
                    WHERE d.order_id = p_order AND d.finding_id = f.id AND d.superseded_by IS NULL);
  IF v_ids IS NOT NULL THEN
    RAISE EXCEPTION 'DISPOSITION_REQUIRED: 처분이 없는 영향이 있습니다 (finding_ids=%)', v_ids;
  END IF;

  -- 대상 · 적용 범위
  IF NOT EXISTS (SELECT 1 FROM change_target WHERE order_id = p_order) THEN
    RAISE EXCEPTION 'TARGET_REQUIRED: 변경 대상이 없습니다 (change_order.id=%)', p_order;
  END IF;
  SELECT string_agg(t2.id::text, ',' ORDER BY t2.id) INTO v_ids
  FROM change_target t2
  WHERE t2.order_id = p_order AND NOT EXISTS (SELECT 1 FROM change_scope s WHERE s.target_id = t2.id AND s.applies = 'new');
  IF v_ids IS NOT NULL THEN
    RAISE EXCEPTION 'SCOPE_REQUIRED: 적용 범위가 없는 대상이 있습니다 (target_ids=%)', v_ids;
  END IF;

  -- 설계 · 구매 · 생산 검토: 필요한 기능마다 최신 검토가 이 분석을 보고 approve 해야 한다
  v_ids := NULL;
  FOREACH v_func IN ARRAY ARRAY['design', 'purchasing', 'production'] LOOP
    v_need := v_func = 'design' OR EXISTS (
      SELECT 1 FROM impact_finding f
      WHERE f.run_id = run.id AND f.severity = 'affected'
        AND ((v_func = 'purchasing' AND f.kind IN ('purchase_order_line', 'stock_lot'))
          OR (v_func = 'production' AND f.kind = 'work_order')));
    IF v_need THEN
      SELECT c.verdict || ':' || c.run_id INTO v_state
      FROM change_review c WHERE c.order_id = p_order AND c.function = v_func ORDER BY c.id DESC LIMIT 1;
      IF v_state IS DISTINCT FROM 'approve:' || run.id THEN
        v_ids := concat_ws(',', v_ids, v_func);
      END IF;
    END IF;
  END LOOP;
  IF v_ids IS NOT NULL THEN
    RAISE EXCEPTION 'REVIEW_REQUIRED: 이 분석을 보고 승인(approve)한 검토가 없는 기능이 있습니다 (functions=%)', v_ids;
  END IF;

  -- 여기부터 쓰기. 이 지시의 승인이라는 것을 가드와 낡음 표시에 알린다 (트랜잭션 안에서만 유효).
  PERFORM set_config('app.approving_order', p_order::text, true);

  -- 대상의 현재 개정이 여전히 승인본인지 (다른 지시가 먼저 바꿨을 수 있다)
  FOR t IN SELECT * FROM change_target WHERE order_id = p_order ORDER BY id LOOP
    SELECT status INTO v_state FROM item_revision
    WHERE id = CASE WHEN t.kind = 'revision' THEN t.from_revision_id ELSE t.parent_revision_id END FOR UPDATE;
    IF v_state IS DISTINCT FROM 'released' THEN
      RAISE EXCEPTION 'TARGET_NOT_RELEASED: 대상의 현재 개정이 더는 승인본이 아닙니다 (change_target.id=%, status=%)', t.id, coalesce(v_state, '없음');
    END IF;
  END LOOP;

  -- 1) 교체 · 줄 변경: 부모 조립품마다 새 개정을 만들고 BOM · 체결 구성 · 사양을 복사한다 (교체는 복사하면서 바꾼다)
  FOR g IN SELECT DISTINCT parent_revision_id AS pr FROM change_target
           WHERE order_id = p_order AND kind IN ('replacement', 'bom_line') ORDER BY 1 LOOP
    SELECT item_id INTO v_item FROM item_revision WHERE id = g.pr;
    IF EXISTS (SELECT 1 FROM item_revision WHERE item_id = v_item AND status IN ('wip', 'in_review')) THEN
      RAISE EXCEPTION 'TARGET_REVISION_STATE: 이 조립품에 이미 열린(작업중 · 검토중) 개정이 있어 새 개정을 만들 수 없습니다 (item_id=%)', v_item;
    END IF;
    SELECT coalesce(max(rev_seq), -1) + 1 INTO v_seq FROM item_revision WHERE item_id = v_item;
    INSERT INTO item_revision (item_id, rev, rev_seq, description, change_note, created_by)
    VALUES (v_item, 'R' || lpad(v_seq::text, 2, '0'), v_seq, NULL, '설계변경 ' || o.code, current_app_user())
    RETURNING id INTO v_new;

    INSERT INTO bom_line (parent_revision_id, child_item_id, quantity, find_no, ref_designator, sort_order, note, source, created_by)
    SELECT v_new,
           change_item_after(p_order, g.pr, b.child_item_id),
           coalesce((SELECT bt.new_quantity FROM change_target bt
                     WHERE bt.order_id = p_order AND bt.kind = 'bom_line'
                       AND bt.parent_revision_id = g.pr AND bt.item_id = b.child_item_id), b.quantity),
           b.find_no, b.ref_designator, b.sort_order, b.note, b.source, current_app_user()
    FROM bom_line b WHERE b.parent_revision_id = g.pr;

    INSERT INTO fastening_joint (assembly_revision_id, name, bolt_item_id, nut_item_id, washer_item_id,
                                 washers_per_bolt, bolt_count, clamped)
    SELECT v_new, j.name,
           change_item_after(p_order, g.pr, j.bolt_item_id),
           change_item_after(p_order, g.pr, j.nut_item_id),
           CASE WHEN j.washer_item_id IS NULL THEN NULL ELSE change_item_after(p_order, g.pr, j.washer_item_id) END,
           j.washers_per_bolt, j.bolt_count, j.clamped
    FROM fastening_joint j WHERE j.assembly_revision_id = g.pr;

    INSERT INTO revision_spec (revision_id, key, value, unit, source)
    SELECT v_new, s.key, s.value, s.unit, s.source FROM revision_spec s WHERE s.revision_id = g.pr;

    UPDATE change_target SET to_revision_id = v_new
    WHERE order_id = p_order AND kind IN ('replacement', 'bom_line') AND parent_revision_id = g.pr;
  END LOOP;

  -- 2) 새 개정 올리기: 개정 대상은 BOM 줄이 적은 것(하위)부터, 그다음 부모 새 개정
  FOR rv IN
    SELECT x.rev_id FROM (
      SELECT ct.to_revision_id AS rev_id,
             CASE WHEN ct.kind = 'revision' THEN 0 ELSE 1 END AS grp,
             (SELECT count(*) FROM bom_line b WHERE b.parent_revision_id = ct.to_revision_id) AS lines
      FROM change_target ct WHERE ct.order_id = p_order
    ) x GROUP BY x.rev_id, x.grp, x.lines ORDER BY x.grp, x.lines, x.rev_id LOOP
    SELECT status INTO v_state FROM item_revision WHERE id = rv.rev_id FOR UPDATE;
    IF v_state NOT IN ('wip', 'in_review') THEN
      RAISE EXCEPTION 'TARGET_REVISION_STATE: 올릴 새 개정이 작업중 · 검토중이 아닙니다 (item_revision.id=%, status=%)', rv.rev_id, v_state;
    END IF;
    IF v_state = 'wip' THEN
      UPDATE item_revision SET status = 'in_review' WHERE id = rv.rev_id;
    END IF;
    UPDATE item_revision SET status = 'released' WHERE id = rv.rev_id;
  END LOOP;

  -- 3) 이전 개정은 적용 범위가 "전체 · 즉시"일 때만 폐기한다. 부분 범위면 released 로 남아 기존 사양이 계속 유효하다.
  FOR t IN SELECT DISTINCT CASE WHEN kind = 'revision' THEN from_revision_id ELSE parent_revision_id END AS old_rev
           FROM change_target WHERE order_id = p_order LOOP
    IF NOT EXISTS (SELECT 1 FROM change_target x
                   WHERE x.order_id = p_order
                     AND CASE WHEN x.kind = 'revision' THEN x.from_revision_id ELSE x.parent_revision_id END = t.old_rev
                     AND NOT change_scope_is_global(x.id)) THEN
      UPDATE item_revision SET status = 'obsolete' WHERE id = t.old_rev AND status = 'released';
    END IF;
  END LOOP;

  -- 4) 지시 확정. outbox('change_order', id, 'approved')는 change_order_publish 트리거가 같은 트랜잭션에서 기록한다.
  UPDATE change_order
  SET status = 'approved', approved_by = current_app_user(), approved_at = now(), approved_run_id = run.id
  WHERE id = p_order;
  UPDATE change_order SET status = 'implemented' WHERE id = p_order;
END $$;


-- ---------------------------------------------------------------------
-- H. 외부(ERP · MES) 입구. 늦게 도착한 옛 값(as_of 가 더 이른 것)은 무시한다(false). 등록 안 된 품번은 거부(예외).
--    pub.upsert_inventory 와 같은 패턴이다. 모든 함수가 true(반영) / false(낡은 값이라 무시)를 돌려준다.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pub.upsert_work_order(
  p_source text, p_wo_no text, p_site text, p_product_item_no text, p_bom_rev text, p_process_rev text,
  p_status text, p_qty_planned numeric, p_qty_done numeric, p_lot_no text, p_serial_from bigint, p_serial_to bigint,
  p_start_date date, p_due_date date, p_as_of timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_item bigint;
  v_rev  bigint;
  n      int;
BEGIN
  SELECT id INTO v_item FROM item WHERE item_no = p_product_item_no AND deleted_at IS NULL;
  IF v_item IS NULL THEN
    RAISE EXCEPTION '등록되지 않은 품번입니다: %', p_product_item_no;
  END IF;
  IF p_bom_rev IS NOT NULL THEN
    SELECT id INTO v_rev FROM item_revision WHERE item_id = v_item AND rev = p_bom_rev;
    IF v_rev IS NULL THEN
      RAISE EXCEPTION '등록되지 않은 개정입니다: % %', p_product_item_no, p_bom_rev;
    END IF;
  END IF;
  INSERT INTO work_order (source_system, wo_no, site, product_item_id, bom_revision_id, process_rev, status,
                          qty_planned, qty_done, lot_no, serial_from, serial_to, start_date, due_date, as_of)
  VALUES (p_source, p_wo_no, p_site, v_item, v_rev, p_process_rev, p_status,
          coalesce(p_qty_planned, 0), coalesce(p_qty_done, 0), p_lot_no, p_serial_from, p_serial_to,
          p_start_date, p_due_date, p_as_of)
  ON CONFLICT (source_system, wo_no) DO UPDATE
    SET site = EXCLUDED.site, product_item_id = EXCLUDED.product_item_id, bom_revision_id = EXCLUDED.bom_revision_id,
        process_rev = EXCLUDED.process_rev, status = EXCLUDED.status, qty_planned = EXCLUDED.qty_planned,
        qty_done = EXCLUDED.qty_done, lot_no = EXCLUDED.lot_no, serial_from = EXCLUDED.serial_from,
        serial_to = EXCLUDED.serial_to, start_date = EXCLUDED.start_date, due_date = EXCLUDED.due_date,
        as_of = EXCLUDED.as_of, received_at = now()
    WHERE work_order.as_of <= EXCLUDED.as_of;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

CREATE OR REPLACE FUNCTION pub.upsert_work_order_bom_ref(
  p_source text, p_wo_no text, p_item_no text, p_rev text, p_qty_required numeric, p_qty_issued numeric
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_wo   bigint;
  v_item bigint;
  v_rev  bigint;
  n      int;
BEGIN
  SELECT id INTO v_wo FROM work_order WHERE source_system = p_source AND wo_no = p_wo_no;
  IF v_wo IS NULL THEN
    RAISE EXCEPTION '등록되지 않은 작업지시입니다: % %', p_source, p_wo_no;
  END IF;
  SELECT id INTO v_item FROM item WHERE item_no = p_item_no AND deleted_at IS NULL;
  IF v_item IS NULL THEN
    RAISE EXCEPTION '등록되지 않은 품번입니다: %', p_item_no;
  END IF;
  IF p_rev IS NOT NULL THEN
    SELECT id INTO v_rev FROM item_revision WHERE item_id = v_item AND rev = p_rev;
    IF v_rev IS NULL THEN
      RAISE EXCEPTION '등록되지 않은 개정입니다: % %', p_item_no, p_rev;
    END IF;
  END IF;
  INSERT INTO work_order_bom_ref (work_order_id, item_id, revision_id, qty_required, qty_issued)
  VALUES (v_wo, v_item, v_rev, coalesce(p_qty_required, 0), coalesce(p_qty_issued, 0))
  ON CONFLICT (work_order_id, item_id) DO UPDATE
    SET revision_id = EXCLUDED.revision_id, qty_required = EXCLUDED.qty_required,
        qty_issued = EXCLUDED.qty_issued, received_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

CREATE OR REPLACE FUNCTION pub.upsert_purchase_order_line(
  p_source text, p_po_no text, p_line_no int, p_item_no text, p_item_rev text,
  p_qty_ordered numeric, p_qty_received numeric, p_due_date date, p_supplier text, p_site text,
  p_status text, p_as_of timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_item bigint;
  n      int;
BEGIN
  SELECT id INTO v_item FROM item WHERE item_no = p_item_no AND deleted_at IS NULL;
  IF v_item IS NULL THEN
    RAISE EXCEPTION '등록되지 않은 품번입니다: %', p_item_no;
  END IF;
  INSERT INTO purchase_order_line (source_system, po_no, line_no, item_id, item_rev, qty_ordered, qty_received,
                                   due_date, supplier, site, status, as_of)
  VALUES (p_source, p_po_no, p_line_no, v_item, p_item_rev, p_qty_ordered, coalesce(p_qty_received, 0),
          p_due_date, p_supplier, p_site, p_status, p_as_of)
  ON CONFLICT (source_system, po_no, line_no) DO UPDATE
    SET item_id = EXCLUDED.item_id, item_rev = EXCLUDED.item_rev, qty_ordered = EXCLUDED.qty_ordered,
        qty_received = EXCLUDED.qty_received, due_date = EXCLUDED.due_date, supplier = EXCLUDED.supplier,
        site = EXCLUDED.site, status = EXCLUDED.status, as_of = EXCLUDED.as_of, received_at = now()
    WHERE purchase_order_line.as_of <= EXCLUDED.as_of;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;

CREATE OR REPLACE FUNCTION pub.upsert_stock_lot(
  p_source text, p_lot_no text, p_item_no text, p_item_rev text, p_site text, p_location text,
  p_qty_on_hand numeric, p_qty_allocated numeric, p_status text, p_as_of timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_item bigint;
  n      int;
BEGIN
  SELECT id INTO v_item FROM item WHERE item_no = p_item_no AND deleted_at IS NULL;
  IF v_item IS NULL THEN
    RAISE EXCEPTION '등록되지 않은 품번입니다: %', p_item_no;
  END IF;
  INSERT INTO stock_lot (source_system, lot_no, item_id, item_rev, site, location, qty_on_hand, qty_allocated, status, as_of)
  VALUES (p_source, p_lot_no, v_item, p_item_rev, p_site, coalesce(p_location, ''), p_qty_on_hand,
          coalesce(p_qty_allocated, 0), coalesce(p_status, 'available'), p_as_of)
  ON CONFLICT (source_system, lot_no, item_id, site, location) DO UPDATE
    SET item_rev = EXCLUDED.item_rev, qty_on_hand = EXCLUDED.qty_on_hand, qty_allocated = EXCLUDED.qty_allocated,
        status = EXCLUDED.status, as_of = EXCLUDED.as_of, received_at = now()
    WHERE stock_lot.as_of <= EXCLUDED.as_of;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;


-- ---------------------------------------------------------------------
-- I. 기존 객체의 증분 변경: outbox 와 발행 트리거
-- ---------------------------------------------------------------------
-- outbox.aggregate CHECK 에 'change_order' 를 더한다. 제약 이름은 서버가 정한 것을 찾아 쓴다.
DO $do$
DECLARE
  c text;
BEGIN
  SELECT conname INTO c
  FROM pg_constraint
  WHERE conrelid = 'outbox'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%aggregate%'
  LIMIT 1;
  IF c IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND conrelid = 'outbox'::regclass
                                 AND pg_get_constraintdef(oid) ILIKE '%change_order%') THEN
    RETURN;   -- 이미 반영됨
  END IF;
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE outbox DROP CONSTRAINT %I', c);
  END IF;
  ALTER TABLE outbox ADD CONSTRAINT outbox_aggregate_check
    CHECK (aggregate IN ('item', 'item_revision', 'class', 'change_order'));
END $do$;

-- enqueue_publish: schema.sql 의 함수에 change_order 분기를 더한 것 (나머지는 그대로).
--   schema.sql 의 enqueue_publish 가 바뀌면 이 복사본도 맞춰야 한다.
CREATE OR REPLACE FUNCTION enqueue_publish() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_item bigint;
BEGIN
  IF TG_TABLE_NAME = 'item_revision' THEN
    INSERT INTO outbox (aggregate, aggregate_id, event) VALUES ('item_revision', NEW.id, NEW.status);
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'class_proposal' THEN
    INSERT INTO outbox (aggregate, aggregate_id, event) VALUES ('class', NEW.id, 'approved');
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'change_order' THEN
    INSERT INTO outbox (aggregate, aggregate_id, event) VALUES ('change_order', NEW.id, 'approved');
    RETURN NULL;
  END IF;
  -- item · item_identifier: 이미 공개된(승인 리비전이 있었던) 품목만 다시 발행
  IF TG_TABLE_NAME = 'item' THEN
    v_item := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_item := OLD.item_id;
  ELSE
    v_item := NEW.item_id;
  END IF;
  IF EXISTS (SELECT 1 FROM item_revision WHERE item_id = v_item AND status IN ('released', 'obsolete')) THEN
    INSERT INTO outbox (aggregate, aggregate_id, event)
    SELECT 'item', v_item, CASE WHEN i.deleted_at IS NOT NULL THEN 'deleted' ELSE 'updated' END
    FROM item i WHERE i.id = v_item;
  END IF;
  RETURN NULL;
END $$;

-- 승인된 지시만 발행한다 (작업중 · 검토중 지시는 그래프에 없다)
DROP TRIGGER IF EXISTS change_order_publish ON change_order;
CREATE TRIGGER change_order_publish
  AFTER UPDATE OF status ON change_order
  FOR EACH ROW WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved')
  EXECUTE FUNCTION enqueue_publish();


-- ---------------------------------------------------------------------
-- J. updated_at 자동 갱신 · 감사 로그 (외부 사본 4표는 주인이 외부이고 received_at 이 이력이라 제외)
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS change_request_touch ON change_request;
CREATE TRIGGER change_request_touch BEFORE UPDATE ON change_request FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS change_order_touch ON change_order;
CREATE TRIGGER change_order_touch BEFORE UPDATE ON change_order FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS change_request_audit ON change_request;
CREATE TRIGGER change_request_audit     AFTER INSERT OR UPDATE OR DELETE ON change_request     FOR EACH ROW EXECUTE FUNCTION audit_row();
DROP TRIGGER IF EXISTS change_order_audit ON change_order;
CREATE TRIGGER change_order_audit       AFTER INSERT OR UPDATE OR DELETE ON change_order       FOR EACH ROW EXECUTE FUNCTION audit_row();
DROP TRIGGER IF EXISTS change_target_audit ON change_target;
CREATE TRIGGER change_target_audit      AFTER INSERT OR UPDATE OR DELETE ON change_target      FOR EACH ROW EXECUTE FUNCTION audit_row();
DROP TRIGGER IF EXISTS change_scope_audit ON change_scope;
CREATE TRIGGER change_scope_audit       AFTER INSERT OR UPDATE OR DELETE ON change_scope       FOR EACH ROW EXECUTE FUNCTION audit_row();
DROP TRIGGER IF EXISTS change_disposition_audit ON change_disposition;
CREATE TRIGGER change_disposition_audit AFTER INSERT OR UPDATE OR DELETE ON change_disposition FOR EACH ROW EXECUTE FUNCTION audit_row();
DROP TRIGGER IF EXISTS change_review_audit ON change_review;
CREATE TRIGGER change_review_audit      AFTER INSERT OR UPDATE OR DELETE ON change_review      FOR EACH ROW EXECUTE FUNCTION audit_row();
DROP TRIGGER IF EXISTS revision_spec_audit ON revision_spec;
CREATE TRIGGER revision_spec_audit      AFTER INSERT OR UPDATE OR DELETE ON revision_spec      FOR EACH ROW EXECUTE FUNCTION audit_row();
DROP TRIGGER IF EXISTS fastening_joint_audit ON fastening_joint;
CREATE TRIGGER fastening_joint_audit    AFTER INSERT OR UPDATE OR DELETE ON fastening_joint    FOR EACH ROW EXECUTE FUNCTION audit_row();
