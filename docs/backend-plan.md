# PDM 백엔드 구현 계획 (OPMS와 백엔드 · Neo4j 공유)

## 구현 상태 (2026-11-11)

`backend/`(패키지 `onto_pdm`)에 S1~S4 를 **인메모리 저장소 기준으로** 구현했다. 사용법은 [backend/README.md](../backend/README.md). 아래 계획 본문은 구현 전에 쓴 것이라, 어긋나면 이 절이 맞다.

**한 것**
- S1 계약: pydantic 모델(snake_case, `PDM_CONTRACT_VERSION="1"`, OPMS 오류 모양 · `Page[T]`), `onto-pdm contracts export` → `backend/contracts/pdm_api.schema.json` + 예시. 커밋된 생성물이 최신인지 시험이 확인한다.
- S2 저장소: `PdmStore` Protocol + `InMemoryPdmStore`(웹 목 시드에서 생성, 리비전 보임 규칙은 `mockApi.ts` 와 같다).
- S3 API: `/api/v1/pdm` 라우터(품목 · BOM · 사용처 · 문서 · CAD/BOM 시트 매칭 · 조립 안내 · 규칙 · 등록 요청 임시저장/제출), 머리 `X-PDM-User` · `X-PDM-Admin-Mode`. 규칙 · 매칭은 웹 목 API 와 **같은 결과**여야 하며 `test_parity.py`(184건)가 세션 3종으로 비교한다.
- S4 그래프: `onto-pdm graph init | publish`. 모델 B 를 MERGE 로 멱등 발행하고, 같은 트랜잭션에서 `neo4j/checks.cypher` 를 돌려 위반이면 롤백한다. `:Part` 는 만들지 않고 없으면 `part_missing`. 일회용 `neo4j:5.26.32-community` 컨테이너로 시험(멱등 · CURRENT 이동 · 가지치기 · 망가뜨린 입력의 롤백).
- 시험: `pytest` 218개(Docker 없음), `pytest -m neo4j` 12개.

**하지 않은 것 (다음 과제)**
- PostgreSQL `pdm` 스키마 적용 러너(`onto-pdm migrate`) · Alembic · `PgPdmStore` · `uid`(ULID) 열 (결정 4 · 9). 
- 실제 OPMS 호출(등록 요청 전송 · 품번 예약) — 5장 요청 사항이 풀려야 한다.
- 인증(`X-PDM-User` 를 믿는다), MES 패키지 라우트(계약만 있음), 발행 outbox · `--loop`.
- 웹 HTTP 클라이언트(`web/src/api/http.ts`) — 웹은 아직 목 API.
- 결정 1 의 "OPMS `create_app()` 감싸기"는 하지 않았다 (이 패키지는 OPMS 를 import 하지 않는 독립 앱). 의존 버전만 OPMS 와 같게 고정해 같은 환경에 합칠 수 있다.

작성: 2026-11-11. OPMS 저장소(`ernest_hemingway_OPMS`, HEAD 7c19ff9, 계약 버전 "5", Alembic HEAD `0003_doc_plan`)를 **읽고** 정리한 계획이다. 실행해서 확인한 것은 없다. 확인하지 못한 것은 "미확인"으로 적었다.
원칙: 충돌하면 OPMS를 따른다. OPMS 코드를 고쳐야만 풀리는 설계는 피하고, 불가피한 것은 [5장](#5-opms에-요청할-변경)에 따로 모은다.

관련: [neo4j-lpg-design.md](neo4j-lpg-design.md)(그래프 모델) · [pdm-design.md](pdm-design.md) 9장(REST API) · [web/README.md](../web/README.md)(디자인)

> **방향 정리 (2026-11-11, 사용자 확인)**: PDM은 **CAD 파일과 사양서를 관리하는 프로그램**이다. CAD · 부품을 분석해 **OPMS로 등록 요청을 보내고**, 3D 시각화(explode-studio)는 핵심 기능으로 유지한다. 메인 화면은 CAD 3D + 온톨로지다. 따라서 첫 수직 조각의 우선순위는 품목 목록 읽기보다 **① CAD 분석 결과 저장(`cad_product` · `cad_usage`) ② 보유 품번 매칭 API(설계 6장) ③ OPMS 등록 요청 전송**이다. 화면은 이미 목 API(`matchCadParts`, `savePartRequest` · `submitPartRequest`)로 이 흐름을 돌린다 (`web/src/pages/studio/`).

## 1. 먼저 알아둘 점

1. **OPMS에는 "검토 건 없이 `:Part`를 새로 만드는" 공개 경로가 없다.** `:Part` 생성(`UPSERT_PART`)은 `register_part`(`stores/product_repo.py`) 안에만 있고, 그 함수는 review_id · doc_id · 클래스 · 온톨로지 버전 고정 · `:DedupeLock` · `:SourceDoc` 연결을 모두 요구한다. 출처 목록도 `origin.py`의 `review|seed|import` 셋뿐이다. 그래서 "PDM 승인 → 품번 예약 → `:Part` 생성 → `:PdmItem` 연결" 중 `:Part` 생성은 OPMS 수정 없이 정식으로 풀리지 않는다. **첫 구현은 이미 있는 `:Part`에 `:PdmItem`을 붙이는 데까지만 한다.**
2. **OPMS에는 인증이 없다.** 127.0.0.1 전제에서 Host · Origin 검사(`api/guards.py`)만 한다. 검토자는 본문의 `reviewer` 문자열이다. PDM의 `app_user.role` · `SET LOCAL app.user_id` 권한 모델과 다르다. 당분간 요청 머리 `X-PDM-User: <login_id>`로 사용자를 정하고, 인증은 별도 과제로 둔다.
3. 그래프 모델 B(`(:PdmItem)-[:OF_PART]->(:Part)`)는 OPMS와 맞는다. `RESERVED_KEYS`와 sync의 `DELETE_STALE`(라벨별)에 닿지 않는다.

## 2. 정할 것과 추천

| # | 결정 | 추천 | 이유 |
|---|---|---|---|
| 1 | 백엔드 코드 위치 | **이 저장소의 Python 패키지** (`backend/`, 패키지 `onto_pdm`). `registry.api.app.create_app()`을 감싸 PDM 라우터를 `include_router`한 `onto_pdm.api.app:app` | OPMS 수정 0. 대안(OPMS `src/registry/pdm/`)은 `app.py` 수정과, OPMS CLAUDE.md의 "멈추고 물어볼 것"(운영 DB 스키마 · Alembic, 의존성)에 걸린다 |
| 2 | 라우터 prefix | `/api/v1/pdm/*` | OPMS `/api/v1`과 맞고 `/documents` 같은 이름이 충돌하지 않는다. Vite 프록시 `/api`로 통합된다 |
| 3 | 운영 DB 배치 | 같은 DB(`registry`), **별도 PG 스키마 `pdm`** | OPMS가 이미 한 DB 안에서 `public` · `langgraph`를 나눠 쓴다. public에 합치면 OPMS `schema.check`가 PDM 표를 "모델에 없는 표"로 본다. 별도 DB는 `DATABASE_URL`이 하나 더 는다 |
| 4 | 마이그레이션 | OPMS Alembic 체인에 **넣지 않고** PDM 전용 러너 (`onto-pdm migrate [--apply]`, `pdm.schema_migrations`, 기본 dry run) | OPMS 개정은 "방언 분기 없음, SQLite에서도 돈다"가 규칙이라 plpgsql 트리거 개정은 OPMS 테스트를 깬다 |
| 5 | 계약 위치 | PDM 패키지의 `pdm_contracts.py` + `contracts/pdm_api.schema.json`. `ContractModel` · `Reviewer` · `Page` · `ApiError`는 `registry.contracts`에서 import. 별도 `PDM_CONTRACT_VERSION = "1"` | OPMS `contracts.py`에 넣으면 OPMS 계약 생성물 · 예시 · CI 호환 검사에 걸린다 |
| 6 | 발행기 | 별도 CLI `onto-pdm publish [--once\|--loop]` | OPMS 웹 실행기 큐는 `JobKind`가 닫힌 목록이고 `job.review_id`가 NOT NULL이라 새 종류를 붙이려면 OPMS 4곳을 고쳐야 한다. 발행기는 `outbox`를 `FOR UPDATE SKIP LOCKED`로 읽는 독립 프로세스가 맞다 |
| 7 | 데모 백엔드 | 필요. `PdmStore` Protocol에 `InMemoryPdmStore`(데모 · 단위 시험)와 `PgPdmStore`. `REGISTRY_BACKEND=gold`면 메모리, SQLite URL이면 `503 PDM_UNAVAILABLE` | PDM 스키마(트리거 · plpgsql · jsonb · pg_trgm · RLS)는 SQLite에서 안 돈다. OPMS 규약은 "Neo4j · Docker 없이 도는 단위 시험과 데모" |
| 8 | 선(wire) 형식 | OPMS 관례인 snake_case. 웹 `PdmApi`(camelCase)는 유지하고 HTTP 어댑터에서 변환 | 화면 수정 최소화 |
| 9 | 그래프 키 | PG `item.id` · `item_revision.id`(bigint 순번)를 그래프 키로 쓰지 말고 **ULID 열 `uid`를 추가**해 `pdm_item_id` 자리에 쓴다 | OPMS 원칙 13("한 저장소의 순번을 다른 저장소의 멱등 키로 쓰지 않는다"). 지금 `neo4j/schema.cypher`의 제약이 bigint 키라 PDM 쪽 수정이 필요하다. 미루면 PG 이전 · 복원 때 id가 재사용될 위험 |

### `pdm` 스키마로 옮길 때 바꿀 곳 (`db/schema.sql` · `db/roles.sql`)
- `audit_row`의 `SET search_path = public, pg_temp` → `pdm, pg_temp`. 러너는 `CREATE SCHEMA pdm` 후 `SET LOCAL search_path = pdm, public`으로 파일을 실행한다.
- **`roles.sql`을 지금 그대로 공유 DB에 실행하면 안 된다.** `REVOKE ALL ON SCHEMA public FROM PUBLIC`, `GRANT … ON ALL TABLES IN SCHEMA public TO pdm_app`, `ALTER DEFAULT PRIVILEGES IN SCHEMA public`은 OPMS 표에 영향을 준다. 전부 `pdm` · `pub` 스키마 한정으로 바꾼다.
- `SET LOCAL app.user_id`는 바인드가 안 되므로 `SELECT set_config('app.user_id', :id, true)`를 쓴다 (OPMS 원칙 12, 문자열 조립 금지).
- compose의 `registry` 계정이 superuser면 RLS를 우회한다. 행 단위 제한을 살리려면 트랜잭션마다 `SET LOCAL ROLE pdm_app`을 하거나 별도 로그인 역할을 둔다. 운영 계정 권한은 미확인.

## 3. 단계별 계획

**첫 수직 조각(S1~S5)**: 품목 목록 · 상세 읽기(PG `pdm`)와 승인 리비전 1건의 그래프 발행(기존 `:Part`에 `:PdmItem` 연결). 신규 품번 생성 · 파일 · 쓰기 화면은 뒤로 미룬다.

| 단계 | 내용 | 의존 | 검증 |
|---|---|---|---|
| S0 | 위 결정 확정. `pdm-design.md` 11장의 "P+7자리 가정"을 OPMS 형식으로 갱신 | | |
| S1 | `db/schema.sql` · `roles.sql`을 `pdm` 한정으로, ULID `uid` 열 추가(`item` · `item_revision` · `product`). 러너 `onto_pdm/db/migrate.py` | S0 | 기존 `db/test/*.test.mjs`(PGlite)는 `harness.mjs`의 search_path만 맞춰 유지. 새로 testcontainers PostgreSQL에서 `pdm` 적용 시험. 적용 뒤 OPMS `alembic check`가 여전히 통과하는지 |
| S2 | 계약 `pdm_contracts.py`(`ItemSummary` `ItemDetail` `Revision` `ItemPage` …), `onto-pdm contracts export`, 웹 `gen:types` | S0 | 예시 JSON 검증, 생성물 최신 여부 |
| S3 | `PdmStore` Protocol + 메모리 · PG 구현, `GET /api/v1/pdm/items`, `/items/{item_no}`, PG `RAISE`/SQLSTATE → `ApiException` 코드 사상, 합성 앱 | S1, S2 | `TestClient`로 메모리 저장소 분기별, testcontainers로 PG. 분류 · 재료는 `ctx.products.get_part_detail`로 읽어 덧붙임 |
| S4 | 그래프 발행기: `neo4j/schema.cypher` 적용(키는 `uid`), outbox 한 건 처리(한 Neo4j 트랜잭션에서 `MATCH (p:Part {part_no})` → `MERGE` → `checks.cypher` 위반이면 롤백 → `published_at`). `:Part`가 없으면 만들지 않고 `last_error='part_missing'` | S1, S3 | `@pytest.mark.neo4j`: OPMS 시드(P-00000000001~3)를 올린 뒤 발행, 재발행 멱등, OPMS `reconcile`이 새 위반을 내지 않는지 |
| S5 | 웹 `src/api/http.ts`(OPMS `client.ts`의 `request()`/`ApiError` 규약), `createApi()`의 `VITE_API_MODE=http`, `vite.config.ts` 프록시, `X-PDM-User` 머리 | S3 | vitest에서 `fetch` 대역으로 어댑터 단위 시험, `REGISTRY_BACKEND=gold` 서버와 연결해 목록 · 상세 |
| S6~ | 쓰기(품목 · 리비전 · BOM · 승인), 부품 요청 승인 시 품번 예약, 파일 업로드 · 스트리밍, 인증, 분류 에이전트 | S1~S5 | |

### 품번 예약 흐름 (S6)
1. 부품 요청이 생길 때 앱이 `request_key`(ULID)를 만든다.
2. 승인 순간 `ctx.products.reserve_part_no(request_key)`를 부른다. 같은 키면 같은 번호가 나오므로 재시도에 안전하다.
3. PG 트랜잭션에서 `item_no`를 그 번호로 INSERT하고 요청을 approved로 바꾼다. `issue_item_no()`는 PG 단독 시험용으로만 남는다.
4. 실패하면 `void_active_reservation(request_key, "rejected")`로 되돌린다.
5. 승인 뒤 발행기가 `:Part` 생성(5장 1번)과 `:PdmItem` 연결을 한다.

## 4. 위험

- **합성 앱의 한계.** `create_app()`을 감싸 라우터를 붙이면 PDM 쓰기 경로가 OPMS `RequestGuardMiddleware`의 본문 형식 표(생성 시 라우트 스냅샷)에 없어 415 사전 검사를 건너뛴다 (Host · Origin 검사는 모든 경로에 적용). lifespan 합성도 `app.router.lifespan_context`를 감싸는 방식이라 작위적이다. 실제 동작은 읽기만 했고 실행해 보지 않았다.
- **의존성 결합.** `parts-registry`는 `fastapi==0.162.0` `sqlalchemy==2.1.6` `pydantic==2.14.2` `neo4j==6.4.1` 등을 정확히 고정한다. PDM 패키지도 같은 고정을 따라야 한다. 의존 경로(`path`/`git`)와 PC 간 공유 방식은 미정. OPMS 내부(`registry.contracts` `registry.api.errors` `registry.dburl` `registry.stores.neo4j_client`)에 의존하므로 OPMS 개정 때 깨질 수 있다. 공개 이름(`ctx.products` `ctx.neo4j`, `Neo4jClient.read/write/schema`)만 쓴다.
- **그래프 키.** 결정 9를 미루면 `pdm_item_id`(bigint)가 원칙 13 위반으로 남는다.
- **권한.** `registry`가 superuser면 RLS와 `roles.sql`의 행 제한이 무력하다.
- **상태가 둘로 갈린 동시성.** 승인(PG)과 예약(Neo4j)이 분리돼 예약만 남는 누수가 가능하다. 번호가 단조 증가라 구멍이 생길 뿐 중복은 없다. OPMS `reconcile`은 `review_task`가 없는 예약을 보고하지 않으므로(검사 1 · 2 · 4 · 5가 건너뜀) PDM 쪽 정리 점검을 따로 만들어야 한다.
- **포트.** 두 웹이 다 5173이면 동시 실행 시 한쪽이 5174가 된다. 프록시를 쓰면 Host · Origin이 같아 통과하지만 직접 호출은 403.

### 미확인
`scripts/check_contract_compat.py`의 규칙 · OPMS CI 세부 · PDM 저장소 CI 유무 · sync가 `:Part`에 관여하는 다른 경로 · PDM `:PdmItem`이 있는 DB에서 OPMS `reconcile`을 실제로 돌린 결과 · `db/schema.sql` 트리거의 search_path 의존 지점 전수 · PG 18 이미지에서 `pdm` 스키마에 `pg_trgm`을 설치하는 권한 · OPMS의 다른 worktree(`.claude/worktrees/*`)의 진행 중 변경.

## 5. OPMS에 요청할 변경

**첫 수직 조각(S1~S5)에는 필요한 OPMS 변경이 없다.** 합성 앱으로 `app.py`를 건드리지 않고 붙인다. 아래는 이후 단계 또는 선택 사항이다.

1. **신규 `:Part` 생성 경로** (S6의 신규 품번 승인에 필요)
   - `src/registry/origin.py`에 `ORIGIN_PDM = "pdm"` 추가 (예약 출처와 `:Part.record_origin` 모두). `contracts.py`의 `PartOrigin`도 `origin.ORIGINS`와 같게 유지해야 한다 (`test_part_origin_matches_origin_module`).
   - `ProductRepo` Protocol(`product_repo.py`)에 외부 등록 메서드 추가. 예: 예약을 `used`로 바꾸고 `:Part`를 만드는 `register_external_part(part_no, class_code, values, origin)`. Neo4j · 메모리 구현 둘 다. CLAUDE.md상 Protocol 시그니처 변경은 OPMS 담당자 확인 항목이다.
   - 임시 대안(**권장하지 않음**): PDM이 `review_id=request_key`, origin=review로 예약하고 `ctx.neo4j`로 `UPSERT_PART` · `MARK_RESERVATION_USED`를 직접 쓴다. 중복 판정 · 온톨로지 투영 · 고정 버전을 우회하고 `created_by_review`가 존재하지 않는 검토 건을 가리킨다.
2. (선택) 합성 앱 대신 정식 확장 지점: `src/registry/api/app.py`에 PDM 라우터 포함 한 줄 또는 훅. 합성 앱이 불편해지면 요청한다.
3. (S6 파일 업로드 시) `settings.yaml`의 `api.body_limit.routes`에 PDM 업로드 경로 행 추가. 기본 상한이 1 MiB라 CAD 파일이 막힌다.
4. (선택) PDM `item_identifier.scheme='supplier'`를 OPMS `:SupplierPart`와 합치기: `REFERS_TO.source` 어휘에 PDM 값 필요. 지금은 불필요.
