-- =====================================================================
-- Onto PDM — PostgreSQL 스키마 (PostgreSQL 15 이상)
--   실행: psql -d onto_pdm -f db/schema.sql
--   설계 설명: docs/pdm-design.md
--
-- 규칙
--   * 파일 본체는 DB에 넣지 않는다. 파일 저장소(vault)에 sha256 이름으로 두고 DB는 메타데이터만 가진다.
--   * 승인(released)된 리비전과 그 BOM·주 파일은 바꿀 수 없다. 바꾸려면 새 리비전을 만든다.
--   * 품목·문서는 소프트 삭제(deleted_at). 리비전은 작업중(wip)일 때만 실제 삭제할 수 있다.
--   * 앱은 트랜잭션마다 SET LOCAL app.user_id = '<사용자 id>' 를 실행해 감사 로그에 작업자를 남긴다.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- 품번·이름·본문 부분 일치/유사도 검색


-- ---------------------------------------------------------------------
-- 공통 함수
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_app_user() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::bigint
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- 품번·CAD 이름 비교용 키: 대문자, 공백·_·-·. 제거  ('Body_HCR3A' = 'body-hcr3a')
CREATE OR REPLACE FUNCTION norm_key(s text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT upper(regexp_replace(coalesce(s, ''), '[\s_\-\.]+', '', 'g'))
$$;


-- ---------------------------------------------------------------------
-- 1. 사용자
-- ---------------------------------------------------------------------
CREATE TABLE app_user (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login_id       text NOT NULL UNIQUE,
  name           text NOT NULL,
  email          text,
  password_hash  text,                                  -- 사내 SSO를 쓰면 비워 둔다
  role           text NOT NULL DEFAULT 'engineer'
                 CHECK (role IN ('admin', 'engineer', 'approver', 'viewer')),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);


-- PDM 관리자 모드 권한 검사: 앱이 SET LOCAL app.user_id 로 알려 준 사용자의 역할을 본다.
--   품번 발급 · 품번 변경처럼 관리자 모드에서만 하는 일을 DB 함수가 스스로 확인한다.
CREATE OR REPLACE FUNCTION require_app_role(p_roles text[]) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = current_app_user() AND is_active AND role = ANY (p_roles)) THEN
    RAISE EXCEPTION '권한이 없습니다. % 역할만 할 수 있습니다 (app.user_id=%)',
      array_to_string(p_roles, ', '), coalesce(current_app_user()::text, '없음');
  END IF;
END $$;


-- ---------------------------------------------------------------------
-- 2. 제품(모델) — 사양서·설명서 검색의 "모델명" 기준
-- ---------------------------------------------------------------------
CREATE TABLE product (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          text NOT NULL,                         -- 모델명 예: HCR3A
  name          text NOT NULL,
  description   text,
  root_item_id  bigint,                                -- 최상위 조립품 (FK는 item 생성 뒤 추가)
  created_by    bigint REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE UNIQUE INDEX product_code_uq ON product (code) WHERE deleted_at IS NULL;


-- ---------------------------------------------------------------------
-- 3. 품목(Part/Assembly)과 리비전
-- ---------------------------------------------------------------------
CREATE TABLE item (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_no     text NOT NULL,                           -- 품번
  name        text NOT NULL,                           -- 원래 이름 (CAD 이름)
  name_ko     text,                                    -- 한글 이름 (뷰어 표시: 원래이름 [한글])
  item_type   text NOT NULL DEFAULT 'part'
              CHECK (item_type IN ('assembly', 'part', 'standard', 'purchased')),
  unit        text NOT NULL DEFAULT 'EA',
  material    text,
  category    text,
  product_id  bigint REFERENCES product(id),           -- 등록 기준 제품(목록 필터용). 실제 사용처는 역전개로 본다
  class_iri     text,                                  -- 분류: 그래프 DB TBox 클래스 IRI
  material_iri  text,                                  -- 재료 등급: 그래프 DB ABox 개체 IRI (SUS304 …)
  iri_key       text UNIQUE,                           -- 그래프 IRI 끝부분. 발급 당시 품번으로 한 번 정하고 바꾸지 않는다
                                                       --   (품번 체계가 바뀌어 번호를 바꿔도 그래프 IRI와 그 참조는 그대로)
  attributes  jsonb NOT NULL DEFAULT '{}'::jsonb,      -- 분류별 속성 값 (규격, 길이 …). 속성 정의는 TBox
  created_by  bigint REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX item_no_uq      ON item (item_no) WHERE deleted_at IS NULL;
CREATE INDEX item_norm_no_idx       ON item (norm_key(item_no));
CREATE INDEX item_norm_name_idx     ON item (norm_key(name));
CREATE INDEX item_no_trgm           ON item USING gin (item_no gin_trgm_ops);
CREATE INDEX item_name_trgm         ON item USING gin (name gin_trgm_ops);
CREATE INDEX item_name_ko_trgm      ON item USING gin (name_ko gin_trgm_ops);
CREATE INDEX item_product_idx       ON item (product_id);
CREATE INDEX item_class_idx         ON item (class_iri);
CREATE INDEX item_material_idx      ON item (material_iri);

-- 대표 품번 발급: PLM·PDM 공동 등록이 같은 순번을 쓴다.
--   의미 없는 일련번호라 분류가 바뀌어도 번호는 그대로다. (순번은 롤백돼도 되돌지 않아 빈 번호가 생길 수 있다)
--   형식 'P' + 7자리는 잠정이다. 다른 시스템과 합치며 형식이 바뀌면 이 함수와
--   ontology/shapes-data.ttl 의 sh:pattern 두 곳만 바꾼다. 이미 발급된 번호는 renumber_item() 으로 옮긴다.
CREATE SEQUENCE item_no_seq;
CREATE OR REPLACE FUNCTION issue_item_no() RETURNS text
LANGUAGE sql AS $$
  SELECT 'P' || lpad(nextval('item_no_seq')::text, 7, '0')
$$;

-- 품번 별칭: 레거시 번호, ERP·MES 코드, 공급사 품번, CAD 이름 … → 대표 품번 하나로 모은다
CREATE TABLE item_identifier (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     bigint NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  scheme      text NOT NULL
              CHECK (scheme IN ('legacy', 'erp', 'mes', 'supplier', 'customer', 'drawing', 'cad_name')),
  value       text NOT NULL,                           -- supplier 는 '공급사코드:품번' 형식
  note        text,
  created_by  bigint REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- 식별자는 체계 안에서 유일. CAD 이름은 제품마다 겹칠 수 있어("Body") 유일하지 않다
CREATE UNIQUE INDEX item_identifier_uq ON item_identifier (scheme, value) WHERE scheme <> 'cad_name';
CREATE INDEX item_identifier_norm_idx  ON item_identifier (norm_key(value));
CREATE INDEX item_identifier_item_idx  ON item_identifier (item_id);

-- iri_key: 넣을 때 비어 있으면 품번으로 정하고, 그 뒤로는 바꿀 수 없다
CREATE OR REPLACE FUNCTION guard_item_iri_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.iri_key := coalesce(NEW.iri_key, NEW.item_no);
  ELSIF NEW.iri_key IS DISTINCT FROM OLD.iri_key THEN
    RAISE EXCEPTION '그래프 키(iri_key)는 바꿀 수 없습니다 (item.id=%)', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER item_iri_key
  BEFORE INSERT OR UPDATE OF iri_key ON item
  FOR EACH ROW EXECUTE FUNCTION guard_item_iri_key();

-- 품번 변경 (다른 시스템과 합치며 번호 체계를 바꿀 때). 관리자 모드 전용.
--   옛 번호는 legacy 별칭으로 남고 그래프 IRI(iri_key)는 그대로다. 새 번호나 옛 번호 별칭이 겹치면 전체가 롤백된다.
--   ERP · MES는 pub.part_identifier 에서 옛 번호 → 새 번호를 찾을 수 있다.
CREATE OR REPLACE FUNCTION renumber_item(p_item bigint, p_new_no text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_old text;
BEGIN
  PERFORM require_app_role(ARRAY['admin']);
  SELECT item_no INTO v_old FROM item WHERE id = p_item AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '품목(id=%)이 없습니다', p_item;
  END IF;
  IF v_old = p_new_no THEN
    RETURN;
  END IF;
  INSERT INTO item_identifier (item_id, scheme, value, note, created_by)
  VALUES (p_item, 'legacy', v_old, coalesce(p_note, '품번 변경 전 번호'), current_app_user());
  UPDATE item SET item_no = p_new_no WHERE id = p_item;
END $$;

ALTER TABLE product
  ADD CONSTRAINT product_root_item_fk FOREIGN KEY (root_item_id) REFERENCES item(id);

CREATE TABLE item_revision (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id      bigint NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  rev          text NOT NULL,                          -- 표시용: R00, R01 … 또는 A, B …
  rev_seq      int  NOT NULL,                          -- 정렬용 일련번호 (0, 1, 2 …)
  status       text NOT NULL DEFAULT 'wip'
               CHECK (status IN ('wip', 'in_review', 'released', 'obsolete')),
  description  text,
  change_note  text,                                   -- 이 리비전에서 바뀐 점
  released_at  timestamptz,
  released_by  bigint REFERENCES app_user(id),
  created_by   bigint REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, rev),
  UNIQUE (item_id, rev_seq)
);
-- 품목마다 열린(작업중·검토중) 리비전은 하나만
CREATE UNIQUE INDEX item_revision_one_open ON item_revision (item_id) WHERE status IN ('wip', 'in_review');


-- ---------------------------------------------------------------------
-- 4. 문서(CAD·도면·사양서·설명서·BOM 시트)와 리비전·파일
-- ---------------------------------------------------------------------
CREATE TABLE document (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_no      text NOT NULL,                           -- 문서 번호
  title       text NOT NULL,
  doc_type    text NOT NULL
              CHECK (doc_type IN ('cad_3d', 'drawing', 'spec', 'manual', 'bom_sheet', 'other')),
  language    text,                                    -- ko, en …  (제품 연결은 product_document)
  created_by  bigint REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX document_no_uq  ON document (doc_no) WHERE deleted_at IS NULL;
CREATE INDEX document_title_trgm    ON document USING gin (title gin_trgm_ops);
CREATE INDEX document_type_idx      ON document (doc_type);

CREATE TABLE document_revision (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id     bigint NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  rev             text NOT NULL,
  rev_seq         int  NOT NULL,
  status          text NOT NULL DEFAULT 'wip'
                  CHECK (status IN ('wip', 'in_review', 'released', 'obsolete')),
  change_note     text,
  checked_out_by  bigint REFERENCES app_user(id),      -- 체크아웃(편집 잠금)한 사람
  checked_out_at  timestamptz,
  released_at     timestamptz,
  released_by     bigint REFERENCES app_user(id),
  created_by      bigint REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, rev),
  UNIQUE (document_id, rev_seq),
  UNIQUE (id, document_id)                             -- item_document_link 의 복합 FK 대상
);
CREATE UNIQUE INDEX document_revision_one_open ON document_revision (document_id) WHERE status IN ('wip', 'in_review');

-- 제품 ↔ 문서 (다대다): 설명서 한 권이 여러 제품(HCR3A, HCR5A …)에 쓰일 수 있다
--   document_revision_id 가 NULL 이면 최신 승인 리비전을 따라감, 값이 있으면 그 리비전에 고정.
CREATE TABLE product_document (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id            bigint NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  document_id           bigint NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  document_revision_id  bigint,
  is_primary            boolean NOT NULL DEFAULT false,  -- 이 제품의 대표 사양서·설명서
  created_by            bigint REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (document_revision_id, document_id) REFERENCES document_revision (id, document_id) ON DELETE CASCADE,
  UNIQUE (product_id, document_id)
);
CREATE INDEX product_document_doc_idx ON product_document (document_id);

-- 물리 파일 (내용 기준 중복 제거: 같은 파일을 두 번 올려도 저장은 한 번)
CREATE TABLE file_object (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256       char(64) NOT NULL UNIQUE,
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  mime_type    text,
  storage_key  text NOT NULL UNIQUE,                   -- 저장소 안 경로 예: ab/cd/abcd…(sha256)
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 문서 리비전에 붙은 파일
CREATE TABLE document_file (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_revision_id  bigint NOT NULL REFERENCES document_revision(id) ON DELETE CASCADE,
  file_object_id        bigint NOT NULL REFERENCES file_object(id),
  file_name             text NOT NULL,                 -- 올릴 때의 원래 파일명
  file_format           text NOT NULL,                 -- step, iges, stl, obj, glb, pdf, txt, xlsx, csv, native …
  role                  text NOT NULL DEFAULT 'primary'
                        CHECK (role IN ('primary', 'derived', 'attachment')),  -- derived: 미리보기 GLB·썸네일 등
  parse_status          text NOT NULL DEFAULT 'pending'
                        CHECK (parse_status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  parse_error           text,
  analysis              jsonb,                         -- 뷰어 캐시: 부품 수, 크기, 층 계획, 기준 부품 …
  uploaded_by           bigint REFERENCES app_user(id),
  uploaded_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX document_file_one_primary ON document_file (document_revision_id) WHERE role = 'primary';
CREATE INDEX document_file_object_idx ON document_file (file_object_id);
CREATE INDEX document_file_parse_idx  ON document_file (parse_status) WHERE parse_status IN ('pending', 'running');


-- ---------------------------------------------------------------------
-- 5. 매칭: 품목 ↔ 문서
--    document_revision_id 가 NULL 이면 "최신 승인 리비전을 따라감", 값이 있으면 그 리비전에 고정.
--    CAD 모델은 보통 고정, 사양서·설명서는 보통 따라감.
-- ---------------------------------------------------------------------
CREATE TABLE item_document_link (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_revision_id      bigint NOT NULL REFERENCES item_revision(id) ON DELETE CASCADE,
  document_id           bigint NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  document_revision_id  bigint,
  link_type             text NOT NULL
                        CHECK (link_type IN ('cad_model', 'drawing', 'spec', 'manual', 'reference')),
  is_primary            boolean NOT NULL DEFAULT false,
  match_method          text NOT NULL DEFAULT 'manual'
                        CHECK (match_method IN ('manual', 'filename', 'step_product', 'bom_import', 'text_search', 'ai')),
  confidence            numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  status                text NOT NULL DEFAULT 'confirmed'
                        CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  confirmed_by          bigint REFERENCES app_user(id),
  confirmed_at          timestamptz,
  created_by            bigint REFERENCES app_user(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (document_revision_id, document_id) REFERENCES document_revision (id, document_id) ON DELETE CASCADE,
  UNIQUE (item_revision_id, document_id, link_type)
);
CREATE UNIQUE INDEX item_document_link_one_primary
  ON item_document_link (item_revision_id, link_type) WHERE is_primary AND status = 'confirmed';
CREATE INDEX item_document_link_doc_idx ON item_document_link (document_id);
CREATE INDEX item_document_link_suggested ON item_document_link (status) WHERE status = 'suggested';


-- ---------------------------------------------------------------------
-- 6. BOM — 부모는 리비전, 자식은 품목(리비전은 조회 규칙으로 결정: effective_revision)
-- ---------------------------------------------------------------------
CREATE TABLE bom_line (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_revision_id  bigint NOT NULL REFERENCES item_revision(id) ON DELETE CASCADE,
  child_item_id       bigint NOT NULL REFERENCES item(id),
  quantity            numeric(12,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  find_no             int,                             -- 도면 번호(풍선 번호) = 뷰어의 번호 표시
  ref_designator      text,
  sort_order          int NOT NULL DEFAULT 0,
  note                text,
  source              text NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('manual', 'cad', 'import')),
  created_by          bigint REFERENCES app_user(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_revision_id, child_item_id)           -- 같은 자식은 한 줄, 수량으로 합친다
);
CREATE UNIQUE INDEX bom_line_find_no_uq ON bom_line (parent_revision_id, find_no) WHERE find_no IS NOT NULL;
CREATE INDEX bom_line_child_idx ON bom_line (child_item_id);   -- 역전개(where-used)


-- ---------------------------------------------------------------------
-- 7. CAD 구조 추출 결과 (STEP PRODUCT / NEXT_ASSEMBLY_USAGE_OCCURRENCE)
--    core.parseStepProducts() 결과를 그대로 저장하고, 제품명마다 품목을 매칭한다.
-- ---------------------------------------------------------------------
CREATE TABLE cad_product (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_file_id  bigint NOT NULL REFERENCES document_file(id) ON DELETE CASCADE,
  product_name      text NOT NULL,                     -- STEP에 적힌 이름 그대로
  is_root           boolean NOT NULL DEFAULT false,
  matched_item_id   bigint REFERENCES item(id) ON DELETE SET NULL,
  match_method      text CHECK (match_method IN ('exact', 'normalized', 'fuzzy', 'manual', 'created')),
  match_score       numeric(4,3),
  match_status      text NOT NULL DEFAULT 'unmatched'
                    CHECK (match_status IN ('unmatched', 'suggested', 'confirmed', 'ignored')),
  UNIQUE (document_file_id, product_name)
);
CREATE INDEX cad_product_item_idx ON cad_product (matched_item_id);

CREATE TABLE cad_usage (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id  bigint NOT NULL REFERENCES cad_product(id) ON DELETE CASCADE,
  child_id   bigint NOT NULL REFERENCES cad_product(id) ON DELETE CASCADE,
  quantity   int NOT NULL CHECK (quantity > 0),        -- 같은 부모 아래 등장 횟수
  UNIQUE (parent_id, child_id)
);


-- ---------------------------------------------------------------------
-- 8. 사양서·설명서 구절과 부품별 근거 구절
-- ---------------------------------------------------------------------
CREATE TABLE doc_chunk (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_file_id  bigint NOT NULL REFERENCES document_file(id) ON DELETE CASCADE,
  chunk_index       int NOT NULL,                      -- core.chunkText() 의 i
  page_no           int,
  body              text NOT NULL,
  tsv               tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED,
  UNIQUE (document_file_id, chunk_index)
);
CREATE INDEX doc_chunk_tsv_idx  ON doc_chunk USING gin (tsv);
CREATE INDEX doc_chunk_trgm_idx ON doc_chunk USING gin (body gin_trgm_ops);

-- 구절이 특정 제품에만 해당할 때 (여러 제품 공용 설명서의 "HCR5A 전용" 절 등)
--   행이 없으면 그 문서에 연결된 모든 제품 공통 구절.
CREATE TABLE doc_chunk_product (
  doc_chunk_id  bigint NOT NULL REFERENCES doc_chunk(id) ON DELETE CASCADE,
  product_id    bigint NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  source        text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),  -- auto: 모델명 검출, manual: 사람이 지정
  PRIMARY KEY (doc_chunk_id, product_id)
);
CREATE INDEX doc_chunk_product_product_idx ON doc_chunk_product (product_id);

CREATE TABLE item_passage_link (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_revision_id  bigint NOT NULL REFERENCES item_revision(id) ON DELETE CASCADE,
  doc_chunk_id      bigint NOT NULL REFERENCES doc_chunk(id) ON DELETE CASCADE,
  purpose           text NOT NULL
                    CHECK (purpose IN ('definition', 'assembly', 'disassembly', 'reference')),
  mate_item_id      bigint REFERENCES item(id) ON DELETE CASCADE,   -- 결합 대상 (조립·분해 절차일 때)
  score             real,                              -- BM25 점수
  hit_terms         text[],                            -- 일치한 단어 (근거 강조 표시용)
  status            text NOT NULL DEFAULT 'suggested'
                    CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  confirmed_by      bigint REFERENCES app_user(id),
  confirmed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (item_revision_id, doc_chunk_id, purpose, mate_item_id)
);
CREATE INDEX item_passage_link_chunk_idx ON item_passage_link (doc_chunk_id);


-- ---------------------------------------------------------------------
-- 9. AI 이름·설명 (뷰어 aiCache 를 영구 저장: 같은 파일·사양서면 AI를 다시 부르지 않는다)
-- ---------------------------------------------------------------------
CREATE TABLE ai_annotation (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_file_id  bigint NOT NULL REFERENCES document_file(id) ON DELETE CASCADE,  -- 기준 CAD 파일
  spec_file_id      bigint REFERENCES document_file(id) ON DELETE CASCADE,           -- 참고한 사양서
  part_name         text NOT NULL,                     -- 뷰어의 부품 이름 (CAD 원래 이름)
  kind              text NOT NULL DEFAULT 'part' CHECK (kind IN ('part', 'group')),
  item_id           bigint REFERENCES item(id) ON DELETE SET NULL,
  name_ko           text,
  description       text,
  ref_chunk_ids     bigint[],                          -- 근거 구절 doc_chunk.id
  model             text NOT NULL,                     -- 예: claude-sonnet-5-5
  status            text NOT NULL DEFAULT 'suggested'
                    CHECK (status IN ('suggested', 'accepted', 'rejected')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (document_file_id, spec_file_id, kind, part_name)
);
CREATE INDEX ai_annotation_item_idx ON ai_annotation (item_id);


-- ---------------------------------------------------------------------
-- 10. 통합 품번 등록 · 분류 제안 · 재고 · 그래프 발행
-- ---------------------------------------------------------------------

-- 분류 에이전트의 새 분류(클래스) 제안. 승인 전에는 그래프 운영 저장소에 들어가지 않는다.
CREATE TABLE class_proposal (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status            text NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed', 'approved', 'rejected', 'merged')),
  parent_class_iri  text NOT NULL,                     -- 기존 분류 아래에만 붙인다 (단일 상속 트리)
  label_ko          text NOT NULL,
  label_en          text,
  definition        text NOT NULL,
  properties        jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{property_iri} | {new: {label, quantity_kind, unit}}, required]
  standard_match    jsonb,                             -- 표준 분류 대응 후보 (ECLASS · IEC CDD 코드, 일치 정도)
  evidence          jsonb NOT NULL,                    -- [{doc_chunk_id | cad_product_id | bom_row, quote}]
  turtle            text,                              -- 승인 시 그래프에 넣을 TBox 변경분
  validation        jsonb,                             -- SHACL · 중복 · 세분화 검사 결과
  approved_iri      text UNIQUE,                       -- 승인되어 확정된 클래스 IRI
  merged_into_iri   text,                              -- 기존 분류와 같다고 판단해 합친 경우
  agent_run_id      text,                              -- LangGraph thread id / LangSmith run id
  model             text,
  reviewed_by       bigint REFERENCES app_user(id),
  reviewed_at       timestamptz,
  review_note       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'approved') = (approved_iri IS NOT NULL)),
  CHECK (status <> 'merged' OR merged_into_iri IS NOT NULL),
  CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) > 0)   -- 근거 없는 제안은 받지 않는다
);
CREATE INDEX class_proposal_open_idx ON class_proposal (created_at) WHERE status = 'proposed';

-- 품번 등록 요청 (PLM · PDM · 에이전트 공동). draft = 임시저장: 빈 칸이 있어도 저장되고, 작성자와 관리자만 본다.
CREATE TABLE part_request (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_system      text NOT NULL CHECK (source_system IN ('PDM', 'PLM', 'AGENT')),
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled')),
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
                     -- {name, name_ko, item_type, unit, class_iri, material_iri, attributes{}, aliases[{scheme, value}], evidence[]}
  class_proposal_id  bigint REFERENCES class_proposal(id),   -- 분류가 새 분류 제안을 기다리는 경우
  duplicate_check    jsonb,                                  -- 제출 때 중복 후보 검사 결과
  issued_item_id     bigint REFERENCES item(id),             -- 승인되어 발급된 품목
  requested_by       bigint REFERENCES app_user(id),
  reviewed_by        bigint REFERENCES app_user(id),
  reviewed_at        timestamptz,
  review_note        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('draft', 'cancelled') OR payload ? 'name'),               -- 제출부터는 이름 필수
  CHECK ((status = 'approved') = (issued_item_id IS NOT NULL))
);
CREATE INDEX part_request_status_idx ON part_request (status, source_system);

-- 등록 요청 승인 = 품번 발급. PLM·PDM이 같은 함수를 불러 같은 규칙·같은 순번으로 발급한다.
--   요청 행을 잠그므로 같은 요청을 두 번 승인할 수 없다. 별칭이 기존 식별자와 겹치면 전체가 롤백된다.
CREATE OR REPLACE FUNCTION approve_part_request(p_request bigint, p_note text DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  r       part_request%ROWTYPE;
  v_item  bigint;
BEGIN
  PERFORM require_app_role(ARRAY['admin', 'approver']);   -- 관리자 모드에서만 승인
  SELECT * INTO r FROM part_request WHERE id = p_request FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '등록 요청(id=%)이 없습니다', p_request;
  END IF;
  IF r.status <> 'submitted' THEN
    RAISE EXCEPTION '제출된 요청만 승인할 수 있습니다 (id=%, status=%)', p_request, r.status;
  END IF;
  IF coalesce(r.payload ->> 'class_iri', '') = '' THEN
    RAISE EXCEPTION '분류가 정해지지 않았습니다. 새 분류 제안이면 먼저 승인하세요 (id=%)', p_request;
  END IF;

  INSERT INTO item (item_no, name, name_ko, item_type, unit, class_iri, material_iri, attributes, created_by)
  VALUES (issue_item_no(),
          r.payload ->> 'name',
          r.payload ->> 'name_ko',
          coalesce(r.payload ->> 'item_type', 'part'),
          coalesce(r.payload ->> 'unit', 'EA'),
          r.payload ->> 'class_iri',
          r.payload ->> 'material_iri',
          coalesce(r.payload -> 'attributes', '{}'::jsonb),
          r.requested_by)
  RETURNING id INTO v_item;

  INSERT INTO item_identifier (item_id, scheme, value, created_by)
  SELECT v_item, a ->> 'scheme', a ->> 'value', r.requested_by
  FROM jsonb_array_elements(coalesce(r.payload -> 'aliases', '[]'::jsonb)) a;

  INSERT INTO item_revision (item_id, rev, rev_seq, created_by) VALUES (v_item, 'R00', 0, r.requested_by);

  UPDATE part_request
  SET status = 'approved', issued_item_id = v_item,
      reviewed_by = current_app_user(), reviewed_at = now(), review_note = p_note
  WHERE id = p_request;
  RETURN v_item;
END $$;

-- 재고 현황: 주인은 ERP · MES. 통합 DB는 품번 기준 최신 값을 받아 둔다 (pub.upsert_inventory 로만 쓴다)
CREATE TABLE inventory_balance (
  item_id        bigint NOT NULL REFERENCES item(id),
  source_system  text NOT NULL CHECK (source_system IN ('ERP', 'MES')),
  site           text NOT NULL,                        -- 공장 · 사업장
  location       text NOT NULL DEFAULT '',             -- 창고 · 공정
  qty_on_hand    numeric(14,3) NOT NULL,
  qty_allocated  numeric(14,3) NOT NULL DEFAULT 0,
  unit           text NOT NULL,
  as_of          timestamptz NOT NULL,                 -- 원래 시스템 기준 시각
  received_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, source_system, site, location)
);

-- 그래프 DB 발행 대기열 (outbox). 승인과 같은 트랜잭션에서 트리거가 기록하고, 발행기가 GraphDB에 반영한다.
--   내용은 싣지 않는다: 발행기가 발행 시점의 승인본을 읽어 named graph 를 통째로 바꾼다 (여러 번 반영해도 결과가 같다).
CREATE TABLE outbox (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate     text NOT NULL CHECK (aggregate IN ('item', 'item_revision', 'class')),
  aggregate_id  bigint NOT NULL,
  event         text NOT NULL,                         -- released, obsolete, updated, deleted, approved
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX outbox_pending_idx ON outbox (id) WHERE published_at IS NULL;


-- ---------------------------------------------------------------------
-- 11. 감사 로그
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name  text NOT NULL,
  row_id      bigint,
  action      text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  changed_by  bigint,                                  -- FK 없음: 사용자가 지워져도 기록은 남긴다
  changed_at  timestamptz NOT NULL DEFAULT now(),
  old_data    jsonb,
  new_data    jsonb
);
CREATE INDEX audit_log_row_idx ON audit_log (table_name, row_id, changed_at DESC);


-- =====================================================================
-- 트리거
-- =====================================================================

-- updated_at 자동 갱신
CREATE TRIGGER app_user_touch          BEFORE UPDATE ON app_user          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER product_touch           BEFORE UPDATE ON product           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER item_touch              BEFORE UPDATE ON item              FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER item_revision_touch     BEFORE UPDATE ON item_revision     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER document_touch          BEFORE UPDATE ON document          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER document_revision_touch BEFORE UPDATE ON document_revision FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER bom_line_touch          BEFORE UPDATE ON bom_line          FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 리비전 상태 전이와 승인 후 잠금 (item_revision · document_revision 공용)
--   wip → in_review → released → obsolete,  in_review → wip (반려)
CREATE OR REPLACE FUNCTION guard_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'wip' THEN
      RAISE EXCEPTION '작업중(wip) 리비전만 삭제할 수 있습니다 (%.id=%, status=%)', TG_TABLE_NAME, OLD.id, OLD.status;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status, NEW.status) NOT IN (('wip', 'in_review'), ('in_review', 'wip'),
                                          ('in_review', 'released'), ('released', 'obsolete')) THEN
    RAISE EXCEPTION '허용되지 않는 상태 변경입니다: % → % (%.id=%)', OLD.status, NEW.status, TG_TABLE_NAME, OLD.id;
  END IF;

  IF OLD.status IN ('released', 'obsolete')
     AND (to_jsonb(NEW) - 'status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at') THEN
    RAISE EXCEPTION '승인된 리비전은 수정할 수 없습니다. 새 리비전을 만드세요 (%.id=%)', TG_TABLE_NAME, OLD.id;
  END IF;

  IF NEW.status = 'released' AND OLD.status <> 'released' THEN
    NEW.released_at := coalesce(NEW.released_at, now());
    NEW.released_by := coalesce(NEW.released_by, current_app_user());
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER item_revision_guard     BEFORE UPDATE OR DELETE ON item_revision     FOR EACH ROW EXECUTE FUNCTION guard_revision();
CREATE TRIGGER document_revision_guard BEFORE UPDATE OR DELETE ON document_revision FOR EACH ROW EXECUTE FUNCTION guard_revision();

-- 승인된 리비전에 딸린 행(BOM 줄, 주 파일)은 바꿀 수 없다
--   인자: (부모 테이블, 부모 id 컬럼)
--   부모 행을 FOR SHARE 로 잠근 뒤 상태를 본다. 다른 트랜잭션이 그 리비전을 승인하는 중이면
--   커밋될 때까지 기다렸다가 최신 상태로 판단한다 (잠그지 않으면 승인 직전 상태를 보고 통과한다).
CREATE OR REPLACE FUNCTION guard_locked_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ids    bigint[] := '{}';
  locked bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN ids := ids || (to_jsonb(OLD) ->> TG_ARGV[1])::bigint; END IF;
  IF TG_OP <> 'DELETE' THEN ids := ids || (to_jsonb(NEW) ->> TG_ARGV[1])::bigint; END IF;
  EXECUTE format(
    'SELECT min(id) FILTER (WHERE status IN (''released'', ''obsolete''))
       FROM (SELECT id, status FROM %I WHERE id = ANY($1) ORDER BY id FOR SHARE) p', TG_ARGV[0])
    INTO locked USING ids;
  IF locked IS NOT NULL THEN
    RAISE EXCEPTION '승인된 리비전(%.id=%)의 내용은 바꿀 수 없습니다. 새 리비전을 만드세요', TG_ARGV[0], locked;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bom_line_lock
  BEFORE INSERT OR UPDATE OR DELETE ON bom_line
  FOR EACH ROW EXECUTE FUNCTION guard_locked_parent('item_revision', 'parent_revision_id');
-- 파일: 주 파일 추가·교체·삭제만 막는다 (미리보기 등 파생 파일과 해석 결과 갱신은 승인 뒤에도 허용)
CREATE TRIGGER document_file_lock_ins
  BEFORE INSERT ON document_file
  FOR EACH ROW WHEN (NEW.role = 'primary')
  EXECUTE FUNCTION guard_locked_parent('document_revision', 'document_revision_id');
CREATE TRIGGER document_file_lock_upd_del
  BEFORE UPDATE OF file_object_id, document_revision_id, role OR DELETE ON document_file
  FOR EACH ROW EXECUTE FUNCTION guard_locked_parent('document_revision', 'document_revision_id');

-- BOM 자식은 삭제되지 않은 품목이어야 한다
--   FOR SHARE: 같은 품목을 지우는 트랜잭션과 순서를 맞춘다 (guard_item_soft_delete 와 짝)
CREATE OR REPLACE FUNCTION guard_bom_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  gone timestamptz;
BEGIN
  SELECT deleted_at INTO gone FROM item WHERE id = NEW.child_item_id FOR SHARE;
  IF gone IS NOT NULL THEN
    RAISE EXCEPTION '삭제된 품목(id=%)은 BOM에 넣을 수 없습니다', NEW.child_item_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bom_line_child_alive
  BEFORE INSERT OR UPDATE OF child_item_id ON bom_line
  FOR EACH ROW EXECUTE FUNCTION guard_bom_child();

-- 품목 소프트 삭제: 승인 리비전이 있거나 폐기되지 않은 BOM에서 쓰이면 거부
--   UPDATE 는 행을 잠근 뒤 이 트리거를 실행하므로, BOM 추가가 먼저 진행 중이면 그 커밋을 기다렸다가 검사한다.
CREATE OR REPLACE FUNCTION guard_item_soft_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM item_revision WHERE item_id = NEW.id AND status IN ('in_review', 'released')) THEN
    RAISE EXCEPTION '검토중·승인된 리비전이 있는 품목은 삭제할 수 없습니다. 폐기(obsolete)하세요 (item.id=%)', NEW.id;
  END IF;
  IF EXISTS (SELECT 1 FROM bom_line b JOIN item_revision r ON r.id = b.parent_revision_id
             WHERE b.child_item_id = NEW.id AND r.status <> 'obsolete') THEN
    RAISE EXCEPTION '다른 조립품의 BOM에서 쓰이는 품목은 삭제할 수 없습니다 (item.id=%)', NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER item_soft_delete_guard
  BEFORE UPDATE OF deleted_at ON item
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION guard_item_soft_delete();

-- BOM 순환 방지: 자식 아래(모든 리비전의 BOM)에 부모 품목이 있으면 거부
--   동시에 들어온 BOM 변경은 서로의 커밋 전 행을 못 보므로(P→Q 와 Q→P 가 둘 다 통과),
--   트랜잭션 단위 권고 잠금으로 BOM 구조 변경을 한 줄로 세운 뒤 검사한다.
--   READ COMMITTED(기본값)를 전제로 한다: 잠금을 얻은 뒤의 검사 쿼리가 새 스냅샷으로 앞 트랜잭션의 커밋을 본다.
CREATE OR REPLACE FUNCTION guard_bom_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_item bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pdm:bom_structure'));
  SELECT item_id INTO parent_item FROM item_revision WHERE id = NEW.parent_revision_id;
  IF NEW.child_item_id = parent_item THEN
    RAISE EXCEPTION 'BOM 순환: 품목(id=%)을 자기 자신의 하위로 넣을 수 없습니다', parent_item;
  END IF;
  IF EXISTS (
    WITH RECURSIVE down(item_id) AS (
      SELECT NEW.child_item_id
      UNION
      SELECT b.child_item_id
      FROM down d
      JOIN item_revision r ON r.item_id = d.item_id
      JOIN bom_line b      ON b.parent_revision_id = r.id
    )
    SELECT 1 FROM down WHERE item_id = parent_item
  ) THEN
    RAISE EXCEPTION 'BOM 순환: 품목(id=%) 아래에 이미 품목(id=%)이 있습니다', NEW.child_item_id, parent_item;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bom_line_no_cycle
  BEFORE INSERT OR UPDATE OF parent_revision_id, child_item_id ON bom_line
  FOR EACH ROW EXECUTE FUNCTION guard_bom_cycle();

-- 상위 리비전 승인 = 그 BOM 공개. 하위 품목이 모두 승인돼 있어야 공개 BOM이 공개되지 않은 품번을 가리키지 않는다.
CREATE OR REPLACE FUNCTION guard_release_children() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(i.item_no, ', ' ORDER BY i.item_no) INTO missing
  FROM bom_line b
  JOIN item i ON i.id = b.child_item_id
  WHERE b.parent_revision_id = NEW.id
    AND NOT EXISTS (SELECT 1 FROM item_revision c WHERE c.item_id = b.child_item_id AND c.status = 'released');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '하위 품목이 아직 승인되지 않아 승인할 수 없습니다: %', missing;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER item_revision_release_children
  BEFORE UPDATE OF status ON item_revision
  FOR EACH ROW WHEN (NEW.status = 'released' AND OLD.status IS DISTINCT FROM 'released')
  EXECUTE FUNCTION guard_release_children();

CREATE TRIGGER part_request_touch BEFORE UPDATE ON part_request FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 그래프 발행 대기열 기록 (outbox). 같은 트랜잭션이라 승인은 됐는데 발행만 빠지는 일이 없다.
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
  -- item · item_identifier: 이미 공개된(승인 리비전이 있었던) 품목만 다시 발행
  --   (식은 테이블마다 따로 준비되므로 컬럼 이름이 다른 NEW/OLD 접근은 IF 로 나눈다)
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

CREATE TRIGGER item_revision_publish
  AFTER UPDATE OF status ON item_revision
  FOR EACH ROW WHEN (NEW.status IN ('released', 'obsolete') AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION enqueue_publish();
CREATE TRIGGER item_publish
  AFTER UPDATE OF item_no, name, name_ko, item_type, unit, class_iri, material_iri, attributes, deleted_at ON item
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION enqueue_publish();
CREATE TRIGGER item_identifier_publish
  AFTER INSERT OR UPDATE OR DELETE ON item_identifier
  FOR EACH ROW EXECUTE FUNCTION enqueue_publish();
CREATE TRIGGER class_proposal_publish
  AFTER UPDATE OF status ON class_proposal
  FOR EACH ROW WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved')
  EXECUTE FUNCTION enqueue_publish();

-- 감사 로그 (SECURITY DEFINER: 어느 역할이 바꿔도 기록되고, 역할들에 audit_log 쓰기 권한을 줄 필요가 없다)
CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO audit_log (table_name, row_id, action, changed_by, old_data, new_data)
  VALUES (
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
    TG_OP,
    current_app_user(),
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END
  );
  RETURN NULL;
END $$;

CREATE TRIGGER product_audit            AFTER INSERT OR UPDATE OR DELETE ON product            FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER item_audit               AFTER INSERT OR UPDATE OR DELETE ON item               FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER item_revision_audit      AFTER INSERT OR UPDATE OR DELETE ON item_revision      FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER document_audit           AFTER INSERT OR UPDATE OR DELETE ON document           FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER document_revision_audit  AFTER INSERT OR UPDATE OR DELETE ON document_revision  FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER product_document_audit   AFTER INSERT OR UPDATE OR DELETE ON product_document   FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER document_file_audit      AFTER INSERT OR DELETE           ON document_file      FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER item_document_link_audit AFTER INSERT OR UPDATE OR DELETE ON item_document_link FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER bom_line_audit           AFTER INSERT OR UPDATE OR DELETE ON bom_line           FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER item_identifier_audit    AFTER INSERT OR UPDATE OR DELETE ON item_identifier    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER part_request_audit       AFTER INSERT OR UPDATE OR DELETE ON part_request       FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER class_proposal_audit     AFTER INSERT OR UPDATE OR DELETE ON class_proposal     FOR EACH ROW EXECUTE FUNCTION audit_row();


-- =====================================================================
-- 조회 함수·뷰
-- =====================================================================

-- 품목의 "지금 쓸" 리비전
--   'released': 최신 승인본, 없으면 최신 작업본 (생산 보기)
--   'latest'  : 최신 리비전 (설계 보기)
CREATE OR REPLACE FUNCTION effective_revision(p_item bigint, p_rule text DEFAULT 'released') RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT id FROM item_revision
  WHERE item_id = p_item AND status <> 'obsolete'
  ORDER BY CASE WHEN p_rule = 'released' AND status = 'released' THEN 0 ELSE 1 END, rev_seq DESC
  LIMIT 1
$$;

-- BOM 정전개: 루트 리비전 아래 전체 트리 (total_quantity = 루트 1개당 필요 수량)
CREATE OR REPLACE FUNCTION bom_explode(p_root_revision bigint, p_rule text DEFAULT 'released', p_max_depth int DEFAULT 30)
RETURNS TABLE (depth int, bom_line_id bigint, parent_revision_id bigint, child_item_id bigint,
               child_revision_id bigint, find_no int, quantity numeric, total_quantity numeric, item_path bigint[])
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE tree (depth, bom_line_id, parent_revision_id, child_item_id, child_revision_id,
                       find_no, quantity, total_quantity, item_path, sort_path) AS (
    SELECT 1, b.id, b.parent_revision_id, b.child_item_id, effective_revision(b.child_item_id, p_rule),
           b.find_no, b.quantity::numeric, b.quantity::numeric,
           ARRAY[r.item_id, b.child_item_id],
           ARRAY[lpad(coalesce(b.find_no, 0)::text, 6, '0') || lpad(b.sort_order::text, 6, '0') || lpad(b.id::text, 12, '0')]
    FROM bom_line b
    JOIN item_revision r ON r.id = b.parent_revision_id
    WHERE b.parent_revision_id = p_root_revision
    UNION ALL
    SELECT t.depth + 1, b.id, b.parent_revision_id, b.child_item_id, effective_revision(b.child_item_id, p_rule),
           b.find_no, b.quantity::numeric, t.total_quantity * b.quantity,
           t.item_path || b.child_item_id,
           t.sort_path || (lpad(coalesce(b.find_no, 0)::text, 6, '0') || lpad(b.sort_order::text, 6, '0') || lpad(b.id::text, 12, '0'))
    FROM tree t
    JOIN bom_line b ON b.parent_revision_id = t.child_revision_id
    WHERE t.depth < p_max_depth
      AND b.child_item_id <> ALL (t.item_path)
  )
  SELECT depth, bom_line_id, parent_revision_id, child_item_id, child_revision_id,
         find_no, quantity, total_quantity, item_path
  FROM tree
  ORDER BY sort_path
$$;

-- BOM 역전개(where-used): 이 품목을 쓰는 상위 조립품 전체 (폐기 리비전 제외)
CREATE OR REPLACE FUNCTION where_used(p_item bigint, p_max_depth int DEFAULT 30)
RETURNS TABLE (depth int, parent_item_id bigint, parent_revision_id bigint, quantity numeric, item_path bigint[])
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up (depth, parent_item_id, parent_revision_id, quantity, item_path) AS (
    SELECT 1, r.item_id, r.id, b.quantity::numeric, ARRAY[p_item, r.item_id]
    FROM bom_line b
    JOIN item_revision r ON r.id = b.parent_revision_id
    WHERE b.child_item_id = p_item AND r.status <> 'obsolete'
    UNION ALL
    SELECT u.depth + 1, r.item_id, r.id, b.quantity::numeric, u.item_path || r.item_id
    FROM up u
    JOIN bom_line b      ON b.child_item_id = u.parent_item_id
    JOIN item_revision r ON r.id = b.parent_revision_id
    WHERE u.depth < p_max_depth AND r.status <> 'obsolete'
      AND r.item_id <> ALL (u.item_path)
  )
  SELECT * FROM up
$$;

-- CAD 제품명 · BOM 행 품번 → 품목 후보
--   exact 1.0 · alias 1.0 (레거시·ERP 등 유일 식별자) > cad_name 0.97 (겹칠 수 있음) > normalized · alias 정규화 0.95 > fuzzy
--   점수 1.0 이고 후보가 하나일 때만 자동 확정한다.
CREATE OR REPLACE FUNCTION match_item_candidates(p_name text, p_limit int DEFAULT 5)
RETURNS TABLE (item_id bigint, item_no text, name text, method text, score real)
LANGUAGE sql STABLE AS $$
  SELECT d.id, d.item_no, d.name, d.method, d.score
  FROM (
    SELECT DISTINCT ON (c.id) c.id, c.item_no, c.name, c.method, c.score
    FROM (
    SELECT x_i.id, x_i.item_no, x_i.name,
           CASE WHEN x.scheme = 'cad_name' THEN 'cad_name' ELSE 'alias' END AS method,
           CASE WHEN x.value <> p_name THEN 0.95
                WHEN x.scheme = 'cad_name' THEN 0.97
                ELSE 1.0 END::real AS score
    FROM item_identifier x
    JOIN item x_i ON x_i.id = x.item_id
    WHERE x_i.deleted_at IS NULL
      AND (x.value = p_name OR norm_key(x.value) = norm_key(p_name))
    UNION ALL
    SELECT i.id, i.item_no, i.name,
           CASE WHEN i.item_no = p_name OR i.name = p_name THEN 'exact'
                WHEN norm_key(i.item_no) = norm_key(p_name) OR norm_key(i.name) = norm_key(p_name) THEN 'normalized'
                ELSE 'fuzzy' END AS method,
           CASE WHEN i.item_no = p_name OR i.name = p_name THEN 1.0
                WHEN norm_key(i.item_no) = norm_key(p_name) OR norm_key(i.name) = norm_key(p_name) THEN 0.95
                ELSE greatest(similarity(i.item_no, p_name), similarity(i.name, p_name)) END::real AS score
    FROM item i
    WHERE i.deleted_at IS NULL
      AND (i.item_no = p_name OR i.name = p_name
           OR norm_key(i.item_no) = norm_key(p_name) OR norm_key(i.name) = norm_key(p_name)
           OR i.item_no % p_name OR i.name % p_name)
    ) c
    ORDER BY c.id, c.score DESC
  ) d
  ORDER BY d.score DESC, d.item_no
  LIMIT p_limit
$$;

-- 이 제품에 해당하는 구절: 공통 구절(제품 지정 없음) + 이 제품 전용 구절
CREATE OR REPLACE FUNCTION chunks_for_product(p_product bigint, p_document_file bigint)
RETURNS SETOF doc_chunk
LANGUAGE sql STABLE AS $$
  SELECT c.*
  FROM doc_chunk c
  WHERE c.document_file_id = p_document_file
    AND (NOT EXISTS (SELECT 1 FROM doc_chunk_product s WHERE s.doc_chunk_id = c.id)
         OR EXISTS (SELECT 1 FROM doc_chunk_product s WHERE s.doc_chunk_id = c.id AND s.product_id = p_product))
  ORDER BY c.chunk_index
$$;

-- 목록 화면용: 품목 + 최신 리비전 + 최신 승인 리비전
CREATE OR REPLACE VIEW item_current AS
SELECT i.*,
       lr.id     AS latest_revision_id,
       lr.rev    AS latest_rev,
       lr.status AS latest_status,
       rr.id     AS released_revision_id,
       rr.rev    AS released_rev
FROM item i
LEFT JOIN LATERAL (
  SELECT id, rev, status FROM item_revision WHERE item_id = i.id ORDER BY rev_seq DESC LIMIT 1
) lr ON true
LEFT JOIN LATERAL (
  SELECT id, rev FROM item_revision WHERE item_id = i.id AND status = 'released' ORDER BY rev_seq DESC LIMIT 1
) rr ON true
WHERE i.deleted_at IS NULL;


-- =====================================================================
-- 통합 DB 공개 영역 (pub 스키마) — ERP · MES 등 다른 시스템은 여기만 본다
--   승인본만 보인다. 임시저장(part_request draft)과 작업중 리비전은 PDM 안에서만 보이고,
--   PDM 화면에서는 작성자와 관리자 모드(app_user.role = admin · approver)만 본다 (API가 거른다).
--   권한은 db/roles.sql 참고.
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS pub;

-- 승인된 리비전이 있는 품목
CREATE OR REPLACE VIEW pub.part WITH (security_barrier) AS
SELECT i.item_no, i.iri_key, i.name, i.name_ko, i.item_type, i.unit, i.class_iri, i.material_iri,
       r.rev AS released_rev, r.released_at
FROM item i
JOIN LATERAL (
  SELECT rev, released_at FROM item_revision
  WHERE item_id = i.id AND status = 'released'
  ORDER BY rev_seq DESC LIMIT 1
) r ON true
WHERE i.deleted_at IS NULL;

-- 공개 품목의 별칭 (레거시 · ERP · 공급사 품번으로 대표 품번 찾기)
CREATE OR REPLACE VIEW pub.part_identifier WITH (security_barrier) AS
SELECT i.item_no, x.scheme, x.value
FROM item_identifier x
JOIN item i ON i.id = x.item_id
WHERE i.deleted_at IS NULL
  AND x.scheme <> 'cad_name'
  AND EXISTS (SELECT 1 FROM item_revision r WHERE r.item_id = i.id AND r.status = 'released');

-- 현재 승인 BOM (부모 품목마다 최신 승인 리비전의 BOM)
CREATE OR REPLACE VIEW pub.bom WITH (security_barrier) AS
SELECT pi.item_no AS parent_item_no, r.rev AS parent_rev,
       ci.item_no AS child_item_no, b.find_no, b.quantity, ci.unit, b.ref_designator
FROM bom_line b
JOIN item_revision r ON r.id = b.parent_revision_id
JOIN item pi ON pi.id = r.item_id
JOIN item ci ON ci.id = b.child_item_id
WHERE pi.deleted_at IS NULL
  AND r.id = (SELECT id FROM item_revision
              WHERE item_id = r.item_id AND status = 'released'
              ORDER BY rev_seq DESC LIMIT 1);

-- 재고 현황 (ERP · MES가 보낸 최신 값)
CREATE OR REPLACE VIEW pub.inventory WITH (security_barrier) AS
SELECT i.item_no, v.source_system, v.site, v.location,
       v.qty_on_hand, v.qty_allocated, v.qty_on_hand - v.qty_allocated AS qty_available,
       v.unit, v.as_of
FROM inventory_balance v
JOIN item i ON i.id = v.item_id
WHERE i.deleted_at IS NULL;

-- ERP · MES 재고 연동 입구. 늦게 도착한 옛 값(as_of 가 더 이른 것)은 무시한다.
CREATE OR REPLACE FUNCTION pub.upsert_inventory(
  p_item_no text, p_source text, p_site text, p_location text,
  p_qty_on_hand numeric, p_qty_allocated numeric, p_unit text, p_as_of timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_item bigint;
BEGIN
  SELECT id INTO v_item FROM item WHERE item_no = p_item_no AND deleted_at IS NULL;
  IF v_item IS NULL THEN
    RAISE EXCEPTION '등록되지 않은 품번입니다: %', p_item_no;
  END IF;
  INSERT INTO inventory_balance (item_id, source_system, site, location, qty_on_hand, qty_allocated, unit, as_of)
  VALUES (v_item, p_source, p_site, coalesce(p_location, ''), p_qty_on_hand, coalesce(p_qty_allocated, 0), p_unit, p_as_of)
  ON CONFLICT (item_id, source_system, site, location) DO UPDATE
    SET qty_on_hand = EXCLUDED.qty_on_hand, qty_allocated = EXCLUDED.qty_allocated,
        unit = EXCLUDED.unit, as_of = EXCLUDED.as_of, received_at = now()
    WHERE inventory_balance.as_of <= EXCLUDED.as_of;
END $$;
