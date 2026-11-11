# onto-pdm 백엔드

CAD · BOM · 사양서 관리용 독립 FastAPI 백엔드 (패키지 `onto_pdm`). 설계와 결정 근거는 [docs/backend-plan.md](../docs/backend-plan.md). OPMS(`ernest_hemingway_OPMS`)는 **읽기만 했고 수정하지 않았다**. 규약(계약 모델, 오류 모양, `Page[T]`, 고정 버전)은 OPMS를 따랐다.

지금 단계는 **S1~S4 의 인메모리 구현**이다: 계약 · 저장소 인터페이스 · 라우터 · 규칙 · 매칭 · Neo4j 발행기. 여기에 **OPMS 읽기**([아래](#opms-읽기-neo4j-읽기-전용))가 더해졌다: 웹이 이 백엔드를 거쳐 OPMS 의 분류 · 부품을 읽는다. PostgreSQL, 인증은 아직 없다 ([한계](#한계-하지-않은-것)).

## 설치와 실행

Python 3.12 이상, [uv](https://docs.astral.sh/uv/) 필요.

```bash
cd backend
uv sync --group dev                 # .venv/ 에 설치 (고정 버전은 uv.lock)
.venv/Scripts/onto-pdm serve --port 8100     # macOS · Linux: .venv/bin/onto-pdm
# http://127.0.0.1:8100/docs  (OpenAPI)
```

Windows 한글 경로에서는 `PYTHONUTF8=1` 을 붙인다. 저장소는 웹 목 API 시드(`src/onto_pdm/seed/seed.json`)로 채운 `InMemoryPdmStore` 이고, 프로세스가 끝나면 사라진다.

## 시험

```bash
cd backend
PYTHONUTF8=1 .venv/Scripts/python -m pytest -q               # Docker 없이, 303개 (OPMS 읽기 37개 · 조립 규칙 읽기 47개 포함)
PYTHONUTF8=1 .venv/Scripts/python -m pytest -m neo4j tests/neo4j -q   # 일회용 Neo4j 컨테이너 필요, 12개 (약 2분)
# 실제 OPMS Neo4j 를 읽기만 하는 통합 시험 4개 (PDM_NEO4J_* 가 있어야 하고, 없으면 건너뛴다)
PYTHONUTF8=1 .venv/Scripts/python -m pytest -m opms_live tests/opms_live -q
```

- `tests/unit/test_parity.py`: 웹 목 API(`web/src/api/mock`)와 **같은 결과**인지 본다. 목 API 를 번들해 기록한 `tests/fixtures/parity.json` 을 세션 3종(관리자 · 관리자 모드 끔 · 설계자)마다 다시 돌려 비교한다. 웹 규칙 · 시드를 고치면 `node backend/scripts/export_fixtures.mjs` 로 시드와 기준 값을 다시 만든다.
- `test_contracts.py`: 커밋된 `contracts/` 가 최신인지 확인한다.
- `tests/neo4j/`: `docker run neo4j:5.26.32-community` 를 **임의 loopback 포트**로 띄우고 끝나면 지운다. 사용자의 기존 Neo4j 에는 접속하지 않는다. Docker 가 없으면 건너뛴다.

## API (`/api/v1/pdm`)

머리: `X-PDM-User: <login_id>`(없으면 시드 첫 사용자), `X-PDM-Admin-Mode: 1`(관리자 · 승인자에게 작업중 · 검토중 리비전 표시). 인증은 없다. 오류는 OPMS 모양 `{"error": {"code", "message", "details"}}`.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health` · `/api/health` | 상태 · 계약 버전 |
| GET | `/users` `/products` `/classes` `/materials` | 참조 데이터 |
| GET | `/items` | 품목 목록 (검색 · 거르기 · `page` `size`, `Page[T]`) |
| GET | `/items/{item_no}` | 품목 상세 (리비전 · 속성) |
| GET | `/items/{item_id}/where-used` | 사용처 |
| GET | `/revisions/{id}/bom` | 리비전 BOM 트리 |
| GET | `/products/{code}/bom` | 제품 최상위 조립품 + BOM |
| GET | `/documents` | 문서 연결 |
| POST | `/cad/match` | CAD 부품 이름 → 보유 품번 (일치 · 후보 · 없음) |
| POST | `/assembly/guides` | 부품별 조립 안내 (규칙이 있는 부품만) |
| GET | `/rules` `/rules/{id}` | 조립 규칙 목록 · 상세 (읽기 전용) |

`/bom-sheet/match` · `/rules/validate` · `/requests*`(등록 요청)는 삭제됨(사용자 지시, 2026-11-11). `/items*` 조회 라우트는 품목 화면이 없어졌지만 판단 필요로 남겼다.

## OPMS 읽기 (Neo4j 읽기 전용)

웹의 보유 품번 매칭 · 온톨로지 패널이 쓰는 길이다. **온톨로지(분류 · 속성 · 개념 · 규칙)와 부품 마스터(`:Part`)는 OPMS 소유이고 PDM 은 읽기만 한다**(2026-11-11 결정). 이 백엔드는 OPMS 의 Neo4j 에 아무것도 쓰지 않는다.

```bash
# 접속 정보는 OPMS 저장소의 로컬 .env / docker-compose.yml 의 NEO4J_* 와 같다. 비밀번호를 파일에 적지 마라 (backend/.env.example 은 자리표시만)
export PDM_NEO4J_URI=bolt://127.0.0.1:7687 PDM_NEO4J_USER=neo4j PDM_NEO4J_PASSWORD=...
.venv/Scripts/onto-pdm serve --port 8100        # 웹 개발 서버의 /api/v1/pdm 프록시가 가리키는 기본 포트 (PDM_API_PORT 로 바꾼다)
```

| 메서드 | 경로 (`/api/v1/pdm/opms`) | 설명 |
|---|---|---|
| GET | `/status` | 연결 상태. **꺼져 있어도 200**: `state` = `ok` · `opms_down` · `not_configured` · `auth_failed` · `no_ontology` (+ 온톨로지 버전 · 분류 수 · 부품 수) |
| GET | `/classes` · `/classes/{code}` | OPMS 분류 목록(계층은 `path` · `parent`, `head_type`) · 분류 하나(유효 속성 · 핵심 속성 · 고정 값 · **필수 여부와 값 범위(min · max) · 관례로 채워지는 값**: `omitted_default`(예: 나사 방향 → 오른나사), `lookup_default`(피치 = 나사 규격별 보통 나사 값)). 웹의 필수 속성 체크리스트가 읽는다 |
| GET | `/parts` · `/parts/{part_no}` | OPMS 부품 목록(`class_code` · `q` · 쪽 나누기) · 하나. OPMS 부품에는 이름이 없어 `label` 은 분류 + 핵심 속성으로 만든 표시 이름이다 |
| POST | `/match` | 확정한 값(나사 규격 · 길이 · 머리 모양 …)으로 OPMS 부품 후보 찾기 (**임시 판정**, 아래) |

- OPMS 를 못 읽으면(`/status` 제외) **503** + 코드: `OPMS_UNAVAILABLE`(Neo4j 꺼짐) · `OPMS_NOT_CONFIGURED`(PDM_NEO4J_* 없음 — 앱은 설정 없이도 켜진다) · `OPMS_AUTH_FAILED` · `OPMS_NO_ONTOLOGY`. 웹은 이 코드로 "연결 안 됨"의 이유를 구분해 보인다.
- **읽기 전용 강제**: 세션을 `READ_ACCESS` 로 열고 `execute_read` 만 쓰며, 쓰기 문장(CREATE · MERGE · SET · DELETE · REMOVE · DROP · CALL · LOAD …)은 보내기 전에 `assert_read_only` 가 거부한다(단위 시험이 어댑터의 모든 쿼리와 위반 문장을 확인한다). 값은 파라미터로만 넘긴다.
- **왜 Neo4j 직접인가(임시)**: OPMS API(`/api/v1/*`)는 로그인이 필요하고 PDM 이 OPMS 계정을 만들 수 없다. OPMS 의 부품 매칭 API(`POST /parts/match`)는 보류 상태다(OPMS `docs/changes/CR-NEXT-parts-match-api.md`). 어댑터 경계는 `onto_pdm.opms.OpmsReader` 프로토콜이라, 그 API 가 열리면 구현만 OPMS API 호출로 바꾼다.
- 온톨로지는 `:OntologyVersion {current: true}.snapshot`(JSON)에서 읽는다(OPMS 런타임이 읽는 것과 같은 원본). 30초 캐시.
- **`/match` 는 임시 구현이다**: OPMS 의 원칙은 '서버가 준 판정 그대로'라서 PDM 이 점수를 다시 계산하지 않는 것이지만, 그 API 가 보류라 OPMS dedupe(`similarity.score_candidates`)와 같은 방식을 재현한다 — 핵심 속성 가중 일치율, confirmed ≥ 0.95 · suspected ≥ 0.70 · top 5, 값이 없는 속성은 비교에서 제외, CAD 값(근사)이면 최대 suspected(capped), 같은 계열 다른 분류는 최대 suspected(class_capped), 막는 속성(나사 규격)으로 좁혀 읽는다. **머리 모양이 다르면 후보에서 뺀다**(OPMS `CR-NEXT-head-type-ontology` H8 과 같은 취지). OPMS 온톨로지(0.15.0)에는 아직 `headType` 이 없어 임시 표(`opms/ontology.py` 의 `TEMPORARY_HEAD_TYPE_BY_CLASS`)로 대신하고, OPMS 가 클래스에 `fixed` 로 고정하면 그 값을 먼저 쓴다. 응답에 `temporary: true` 와 안내가 실린다.

## 조립 규칙 · 작업표준서 (`rules/` → `/rulebook`)

저장소 루트의 `rules/`(사람이 쓴 YAML, 출처 등급 필수)를 **읽기만** 해서 내보낸다. 정본은 YAML 이고 이 API 에는 쓰는 경로가 없다. 분류 · 속성은 OPMS 소유이고 규칙 · 작업표준은 PDM 소유다. 무엇을 어떤 근거로 썼는지는 [docs/work-standards.md](../docs/work-standards.md).

| 메서드 | 경로 (`/api/v1/pdm/rulebook`) | 설명 |
|---|---|---|
| GET | `/status` | 적재 상태. **읽히지 않아도 200**: `state` = `ok` · `invalid`(검증 오류) · `unavailable`(파일 없음 · YAML 문법 오류) + 개수 · 출처 등급별 값 수 · 검증 결과(`validation.tool` = `check_rules` · `minimal`) |
| GET | `/rules` | 조립 규칙 목록(23). 필터: `class_code` · `role` · `operation` · `model` · `source`(이 등급의 값을 가진 규칙) · `gap`(G-0xx) · `scope`(`part` · `role` · `product`) · `q` |
| GET | `/rules/{id}` | 규칙 하나 (`AR-FAS-001` …). 없으면 404 `RULE_NOT_FOUND` |
| GET | `/operations` | 공정 어휘 트리(18)와 근거가 없어 만들지 않은 공정(`not_covered` 4) |
| GET | `/tools` | 공구(3). 규격이 비어 있는 곳은 `value: null` + `gap_id` |
| GET | `/work-standards` | 작업표준서 목록(10, 요약). 필터: `model` · `kind`(`procedure` · `structure_only`) · `rule` · `tool` · `q` |
| GET | `/work-standards/{id}` | 작업표준서 하나(단계 · 점검 항목 · 확인 항목 · CAD 구조). 없으면 404 `WORK_STANDARD_NOT_FOUND` |
| GET | `/gaps` | 작성이 필요한 공백(19): 필요한 것 · 이유 · 구할 곳 · 막힌 항목 |
| POST | `/select` | 확정한 분류 · 속성으로 **적용되는 규칙 고르기**(계산만 한다, 아무것도 저장하지 않는다) |

- **값을 지어내지 않는다.** `source: unknown` 은 빠지지 않고 `value: null` + `gap_id` 로 나간다. 모든 값 · 문구 · 단계에 `source`(`manual` 사용설명서 · `standard` 공개 표준 참고 · `cad` CAD 도출 · `unknown` 근거 없음), `refs`(문서 · 절 · 쪽 번호 · 화면용 `label` 예 "사용설명서(KR) 3.3절 p.49"), `estimated`, `confirmed` 가 붙는다. **`confirmed` 는 사용설명서 근거이고 추정이 아니고 값이 있을 때만 true** — 작업자 화면에서 확정값처럼 보여도 되는 것은 `confirmed: true` 뿐이다.
- **검증**: 읽을 때마다(서버 시작 · 파일 수정 뒤 첫 요청) `tools/check_rules.py` 를 importlib 로 불러 돌린다(backend 가 그 도구에 import 의존하지 않는다). 그 도구를 못 찾으면 로더가 최소 검사(참조 무결성 · 출처 등급 필수 · unknown 은 값이 비어 있다)만 하고 `validation.tool: "minimal"` + "검증 도구 없음" 이라고 적는다. **오류가 있으면 앱은 살아 있고** `/status` 는 200(`state: invalid`), 나머지 엔드포인트는 **503 `RULEBOOK_INVALID`**(`details.errors` = 오류 목록 최대 100건, `details.total`). 읽지 못하면 503 `RULEBOOK_UNAVAILABLE`.
- **다시 읽기**: 관리 경로(`/reload`)는 없다. 6개 YAML 의 수정 시각 · 크기가 바뀌면 다음 요청에서 자동으로 다시 읽는다(서버를 다시 켤 필요 없음).
- **`/select`**: 요청 `{class_code, class_path?, attributes?, role?, model?, product?, include_inapplicable?}`. 조건마다 `yes` · `no` · `unknown` 으로 평가하고 하나라도 `no` 면 제외, `no` 는 없고 `unknown` 이 있으면 `applicable: "unknown"`(적용된다고 **단정하지 않는다**), 모두 `yes` 면 `"yes"`. 응답 `rules[]` = `{rule(전체), applicable, matched_conditions, unknown_conditions, failed_conditions, lookup, unconfirmed_parameters}`.
  - `class_path`(상위 분류 목록, 예 `[MechanicalPart, Fastener, Bolt, SocketHeadBolt]`; OPMS 읽기 `/opms/classes` 가 준다)가 있으면 상위 분류(`Bolt`)에 걸린 규칙도 맞고, 없으면 `class_code` 정확히 일치만 본다. `product`(`HCR12A` 등)는 로봇 모델로 읽을 수 있을 때만 `model` 로 쓰고 못 읽으면 미확인으로 둔다. `attributes` 의 `length` 는 `length_mm`, 문자열 `"15 mm"` 는 숫자로 읽는다.
  - 평가하는 조건: 분류 · 역할(`context.role`, 요청에 없으면 unknown) · 모델(일부 모델로 **제한된** 규칙만) · `applies_to.where` · 근거 있는 파라미터의 식별 값(`threadSize` · `length_mm` · `length_min_mm`) · **표(lookup)**. 표는 모델을 알면 한 행으로 정해지고(`status: selected`), 모르면 요청 속성과 맞는 행이 후보다(`candidates`; 예: M6 → HCR-3A 30 N·m). 어떤 행과도 안 맞으면 제외.
  - 분류가 대상인 규칙(`scope: part`)과 요청 `role` 이 같은 역할 전용 규칙(`scope: role`)만 고른다. 제품 · 설치 전반 규칙(`scope: product`)은 `/rules` 로 본다.
- 환경 변수: `PDM_RULES_DIR`(기본 저장소 루트의 `rules/`) · `PDM_RULES_CHECKER`(검증 도구 경로, 기본 `<rules 의 부모>/tools/check_rules.py`, 없으면 저장소의 `tools/check_rules.py`) · `PDM_RULES_OPMS_HOME`(분류 이름 대조에 읽는 OPMS 저장소 경로, 읽기만. 기본은 검증 도구의 규칙: `OPMS_HOME` · `.env` · `D:/ernest_hemingway_OPMS`).
- 기존 인메모리 `/rules` · `/rules/{id}` · `/assembly/guides`(삭제한 목업의 이식본)는 **그대로 두었고** 새 경로 `/rulebook/rules` 와 이름이 겹치지 않는다. 웹이 새 경로로 옮겨 가면 옛 라우트와 시드를 지울 수 있다(판단 필요).
- PyYAML 은 `pyproject.toml` 에 직접 적혀 있지 않고 `uvicorn[standard]` 의 의존성으로 설치된다. 이 로더도 그것을 쓴다(새 의존성을 더하지 않았다). 직접 의존성으로 적을지는 판단 필요.

## 계약

```bash
.venv/Scripts/onto-pdm contracts export          # contracts/pdm_api.schema.json + contracts/examples/*.json
.venv/Scripts/onto-pdm contracts export --check  # 최신인지만 확인 (CI 용)
```

선(wire) 형식은 snake_case, `PDM_CONTRACT_VERSION = "1"`. 모델을 바꾸면 export 를 다시 돌려 함께 커밋한다(시험이 막아 준다).

## Neo4j 그래프 발행

모델 B: `(:PdmItem)-[:OF_PART]->(:Part)`. `:Part` · `:Concept` · `:Class` 는 OPMS 소유라 PDM 이 만들지 않는다.

```bash
export NEO4J_URI=bolt://127.0.0.1:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=...
.venv/Scripts/onto-pdm graph init              # neo4j/schema.cypher 적용 (IF NOT EXISTS, 반복 가능)
.venv/Scripts/onto-pdm graph publish HCR3A     # 제품의 승인(released · obsolete) BOM 발행
```

- 승인된 리비전만 나간다 (작업중 · 검토중은 내보내지 않는다). 사용된 하위 품목까지 닫힌 집합이다.
- 전부 MERGE 라 멱등이다. 새 승인이 나면 `CURRENT` 가 옮겨지고, 사라진 BOM 줄 · 식별자는 정리된다.
- 같은 트랜잭션 안에서 `neo4j/checks.cypher` 의 검사(27개 이상)를 돌려 위반이 있으면 **롤백**하고 `GraphPublishError(code="check_failed", details=[...])`.
- 대응하는 `:Part` 가 없는 품목은 만들지 않고 `part_missing` 으로 멈춘다 (OPMS 에 등록 요청이 먼저).

## OPMS 와 합치기

의존 버전은 OPMS `pyproject.toml` 과 같게 고정했다 (fastapi 0.162.0, pydantic 2.14.2, neo4j 6.4.1, typer 0.27.3, uvicorn 0.54.0). OPMS 가상환경에 `onto-pdm` 을 설치하면 충돌하지 않는다. 합치는 방법은 [docs/backend-plan.md](../docs/backend-plan.md) 2장 결정 1 (`registry.api.app.create_app()` 을 감싸 PDM 라우터를 `include_router`). 이 저장소는 OPMS 코드를 import 하지 않으므로 지금은 독립으로 돈다. 계약 기반 모델(`ContractModel`, `Page`, `ApiError`)은 OPMS 것과 같은 모양으로 여기 다시 정의했다.

## 한계 (하지 않은 것)

- **PostgreSQL `pdm` 스키마 · 마이그레이션 러너(`onto-pdm migrate`) · `PgPdmStore`** 없음. 저장은 메모리뿐이라 재시작하면 요청 임시저장 등이 사라진다.
- **OPMS 쓰기 없음.** OPMS 는 읽기만 한다(위). 등록 요청은 삭제됨(사용자 지시, 2026-11-11). 품번 예약 · `:Part` 생성도 없다. OPMS API 호출(match API 등)은 아직 없다.
- **인증 없음.** 머리 `X-PDM-User` 를 믿는다.
- **웹은 `/opms/*` 만 쓴다.** 웹 HTTP 클라이언트(`web/src/api/httpApi.ts`)는 OPMS 읽기(분류 · 부품 · 매칭 · 상태)만 이 백엔드로 읽고, 제품 · BOM · 규칙 · MES 는 쓰지 않는다. 이 백엔드의 인메모리 시드(`/items` · `/rules` 등)는 웹이 호출하지 않는다(시드 자체가 옛 목 데이터에서 나온 것이라 판단 필요).
- MES 패키지 · 발행 API 는 계약 모델만 있고 라우트는 없다.
- 규칙 · 매칭은 웹 목 API 를 Python 으로 옮긴 것이다. 웹 쪽 규칙이 바뀌면 `export_fixtures.mjs` 후 `test_parity.py` 가 어긋남을 알려 준다.
