# onto-pdm 백엔드

CAD · BOM · 사양서 관리용 독립 FastAPI 백엔드 (패키지 `onto_pdm`). 설계와 결정 근거는 [docs/backend-plan.md](../docs/backend-plan.md). OPMS(`ernest_hemingway_OPMS`)는 **읽기만 했고 수정하지 않았다**. 규약(계약 모델, 오류 모양, `Page[T]`, 고정 버전)은 OPMS를 따랐다.

지금 단계는 **S1~S4 의 인메모리 구현**이다: 계약 · 저장소 인터페이스 · 라우터 · 규칙 · 매칭 · Neo4j 발행기. PostgreSQL, 실제 OPMS 호출, 인증은 아직 없다 ([한계](#한계-하지-않은-것)).

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
PYTHONUTF8=1 .venv/Scripts/python -m pytest -q               # Docker 없이, 218개
PYTHONUTF8=1 .venv/Scripts/python -m pytest -m neo4j tests/neo4j -q   # 일회용 Neo4j 컨테이너 필요, 12개 (약 2분)
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
| POST | `/bom-sheet/match` | BOM 시트 줄 → 보유 품번 |
| POST | `/assembly/guides` | 부품별 조립 안내 (규칙이 있는 부품만) |
| GET | `/rules` `/rules/validate` `/rules/{id}` | 조립 규칙 목록 · 검증 · 상세 |
| GET/POST/PUT | `/requests` `/requests/{id}` | 등록 요청 임시저장 |
| POST | `/requests/{id}/submit` | 제출 (중복 후보가 붙는다. OPMS 로 보내지는 않는다) |

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
- **OPMS 호출 없음.** 등록 요청 제출은 중복 후보만 붙이고 OPMS 로 보내지 않는다. 품번 예약 · `:Part` 생성도 없다.
- **인증 없음.** 머리 `X-PDM-User` 를 믿는다.
- **웹 HTTP 클라이언트 없음.** `web/src/api/http.ts` 는 만들지 않았다 (웹은 계속 목 API). camelCase ↔ snake_case 변환은 그때 한다.
- MES 패키지 · 발행 API 는 계약 모델만 있고 라우트는 없다.
- 규칙 · 매칭은 웹 목 API 를 Python 으로 옮긴 것이다. 웹 쪽 규칙이 바뀌면 `export_fixtures.mjs` 후 `test_parity.py` 가 어긋남을 알려 준다.
