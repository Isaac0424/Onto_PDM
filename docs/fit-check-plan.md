# 결합 적합성(fit_check) 연동 계획

상태: **계획만 있다. 구현하지 않았다.** 작성 2026-11-11. 근거: OPMS 설계안 `ernest_hemingway_OPMS/docs/changes/CR-NEXT-part-relation-rule.md`(미커밋, 승인 전 초안)와 이 저장소 코드 읽기. 실행해서 확인한 것은 없다. 확인하지 못한 것은 "미확인"으로 적었다.

## 1. 결정과 역할 분담 (사용자 승인, main-07 전달)

| 질문 | 담당 | 예 |
|---|---|---|
| 이 부품을 여기에 쓸 수 있나 · 대신할 수 있나 | **OPMS** `fit_check`(신규) · `mates_with` · `substitutes` | 볼트 길이 ≥ 홈 깊이 + 여유 |
| 어떻게 조립하나(절차 · 토크 · 공구 · 주의) | **PDM** `Operation` · `AssemblyRule` | M3는 0.6 N·m, 대각선 2회 |

- PDM은 **비교 규칙과 대체 판정을 만들지 않는다.** 규칙을 읽어 직접 계산하지도 않고(두 곳 구현 방지), 같은 Neo4j의 `:Rule` 노드를 해석하지도 않는다. 판정 API만 부른다.
- 홈 깊이는 OPMS 분류 속성이 아니다. **PDM이 CAD에서 잰 값을 호출할 때 넘긴다**(OPMS 설계안의 "문맥 기반 `against.context = holeDepth`").
- 결과는 4가지: `ok`(통과) · `conditional`(조건부) · `no`(실패) · `unknown`(알 수 없음). 이유 코드(`shortfall` · `thin_margin` · `value_missing` · `unit_unconvertible`), 근거 규칙(`rule_id` · `rule_message`), `ontology_version`이 함께 온다.

## 2. 호출 흐름

```
CAD(STEP) ─ 뷰어가 이미 가진 것: 체결 부품 탐지, 박힌 축, 묶인 부품(host), 부품 크기
   │   + 새로 필요: 홈 깊이 측정 (3장 위험 1)
   ▼
PDM 백엔드 ─ 단위·값 모양만 맞춰 보낸다. 판단하지 않는다
   │   POST /api/fit/judge  {subject: {part_no 또는 class_code+length}, against: {context: {holeDepth:{value,unit}}}}
   │   POST /api/fit/judge-batch (BOM · 단계 단위, 상한은 OPMS settings.api)
   ▼
OPMS ─ 읽기 전용 판정 (초안 단계, 구현 전)
   ▼
PDM 화면 ─ 결과를 그대로 보인다 (CAD HUD · 규칙 화면)
```

- 볼트 쪽 값: 보유 품번(`:PdmItem → :Part`)에 `length`가 있으면 품번으로 부른다. 미보유 부품은 CAD 크기에서 잰 길이를 `inferred`로 표시해 부른다.
- **단위 변환은 OPMS가 한다**(`{value, unit}`로 보내면 정규형 mm로 바꾼다). PDM 화면은 단위를 바꾸거나 판정하지 않는다.
- 어댑터는 `web/src/api/types.ts`의 `PdmApi`에 `judgeFit` · `judgeFitBatch`를 더하고, `backend/`의 `/api/v1/pdm/fit/*`가 OPMS를 부르는 얇은 프록시가 된다. OPMS API가 없는 동안은 **mock 어댑터**(아래 4장)로 시작한다.

## 3. 위험과 불확실한 것

1. **홈 깊이를 CAD에서 재는 코드가 없다(확인함).** `src/core.js`는 체결 부품을 이름과 모양으로 찾고(`kind: 'fastener'`), 박힌 축(`dir`)과 묶인 부품(`host`)까지는 구한다. 그러나 host의 **구멍 깊이**를 재지 않는다. 볼트 길이는 부품 bbox에서 나오지만 나사산이 모델링되지 않으면 근사다(OPMS 설계안 3.3절도 같은 경고). 측정 방법 후보 두 가지는 미검증이다.
   - 볼트 축을 따라 host bbox를 지나는 길이(두께)로 근사. 막힌 구멍이면 틀린다.
   - STEP 형상에서 구멍 면을 읽기. 지금 파서(occt-import-js 메시)로 가능한지 **미확인**.
   - **결정됨(2026-11-11, 사용자가 OPMS 쪽 6개 결정을 "추천대로"로 확정, main-07 전달)**: 근사 치수는 PDM이 `inferred` 표시를 붙여 넘기고, OPMS가 판정을 "알 수 없음 · 조건부"로 낮춘다. PDM은 낮추지 않고 받은 결과를 그대로 보인다.
   - 이 결정으로 OPMS 설계안 6.3절 미결 3번이 닫혔다. **나머지 5개 결정의 내용은 이 세션이 전달받지 못했다**(PDM에 영향이 있다고 알려 준 것은 위 항목과 아래 범위뿐). 아래 4번 · 5장의 "미확인"은 그 내용을 확인하기 전까지 그대로 둔다.
2. **OPMS API가 구현 전이다.** 경로 · 필드 이름은 초안이고 바뀔 수 있다. mock 어댑터는 초안 응답 형식(OPMS 설계안 4.1절)을 그대로 따르되 바뀌면 어댑터만 고친다.
3. **규칙 숫자는 시연용 가정이다**(나사 끝 여유 2.0 mm, 경고 1.0 mm). 실제 사내 설계 기준이 필요하다.
4. **판정 API 범위(결정됨)**: 이번에는 `fit_check` **길이 비교만** 부른다(`/api/fit/judge` · `judge-batch`). 짝(`mates_with`) · 대체(`substitutes`, `/api/substitution/judge`) 판정은 후속이다. 같은 분류 안의 길이 대체 허용 여부는 후속 범위라 이 계획에서 다루지 않는다.
5. 판정은 **참고 판정**이다. 승인 가능 여부를 정하지 않는다(OPMS 설계안 4.2절). 화면 문구도 "참고"로 쓴다.

## 4. 현재 mock 규칙 데이터: 남길 것 · 바꿀 것

대상: `web/src/api/mock/assemblyRules.ts`(규칙 8개), `backend/`의 규칙 구현(`test_parity.py`가 웹 목과 같은 결과인지 본다), `docs/assembly-rules-spec.md`.

| 대상 | 처리 | 이유 |
|---|---|---|
| `Operation` · `AssemblyRule` · `Parameter`(토크 · 용접봉) · `Caution` · `Tool`, 규칙 8개의 값 · 주의 · 공구 | **남긴다** | 조립 절차 안내는 PDM 담당(1장) |
| `SP-FAS-01`(M3 체결 토크) 등 절차 규칙 | 남긴다 | 같은 이유 |
| `SP-CVR-01`의 "필요 나사 길이 = 두께 + 1.5×지름" 계산(`assemblyRules.ts:72`) | **바꾼다** | 이것은 "볼트 길이 ≥ 기준" 적합성 비교라서 PDM에 두면 OPMS `fit_check`와 이중 구현이 된다. 계산을 빼고 **안내 문구만** 남긴다("나사 길이는 아래 적합성 판정을 보세요"). 값은 OPMS 판정이 낸다 |
| 이름 패턴 매칭(`match` 정규식) | 이번엔 **그대로** | F-RUL-4(분류 · 속성에 걸기)는 별도 과제. 판정 호출만 분류를 쓴다 |
| 규칙 검증(`/rules/validate`) | 남긴다 | 절차 규칙의 품질 검사. 적합성 규칙은 OPMS가 검증한다 |
| **신규** `FitJudgement` 타입 · `judgeFit` mock | 추가 | 초안 응답 형식. 고정 입력 몇 개(통과 · 조건부 · 실패 · 알 수 없음 각 1개)로 응답. 실제로 비교 계산하지 않는다(계산은 OPMS 몫이므로 mock은 입력별 고정 응답표) |
| `backend/` 패러티 시험 | 갱신 | `SP-CVR-01` 값이 바뀌면 `node backend/scripts/export_fixtures.mjs`로 기준값 다시 생성 |

## 5. 화면

- **CAD 스튜디오(HUD)**: 체결 부품 단계에서 오른쪽 카드 아래에 **적합성 줄** 추가: 배지(통과 / 조건부 / 실패 / 알 수 없음) · 이유 한 줄("길이 16 mm가 필요한 18.0 mm보다 짧다") · 근거 규칙 id · `ontology_version`. 측정값이 `inferred`이면 "CAD 추정값" 표시. 배지 색은 색만 쓰지 않고 글자도 함께 쓴다(접근성). 판정 호출이 실패하거나 OPMS가 없으면 "판정을 받지 못했어요"로 보이고 다른 안내는 막지 않는다.
- **규칙 화면**: 절차 규칙(PDM)과 **적합성 규칙(OPMS 소유, 읽기 전용)**을 구분해 보인다. 적합성 규칙 상세는 OPMS가 내려준 id · 메시지만 표시하고 PDM에서 편집하지 않는다. 규칙 목록 API가 OPMS에 있는지는 **미확인**이라, 1단계에서는 CAD 화면에 뜬 판정에 붙은 `rule_id` · 메시지로만 보이고 목록 화면은 후속이다.
- **연결 그래프 · 온톨로지 3D**: 변경 없음(후속).

## 6. PRD 부록 B · 문서 영향

- PRD 6.4 F-RUL-4 옆에 새 요구 **F-FIT-1~3**(판정 호출 · CAD 화면 표시 · 규칙 화면 구분 표시) 추가, 6.5에 OPMS 판정 호출 항목 추가.
- PRD 4장 데이터 소유 표에 "결합 적합성 판정: OPMS" 한 줄 추가. 현재 "조립 규칙 · 조립 공정: PDM"과 겹치지 않게 "절차"로 한정.
- 부록 B: ⬜ 항목에 **"결합 적합성 판정(OPMS 연동), CAD에서 홈 깊이 측정"** 추가. 🟡로 올리려면 mock 어댑터와 화면이 있어야 한다. 지금은 계획만이라 ⬜.
- `docs/assembly-rules-spec.md` 4장 끝에 "적합성은 OPMS" 문단, `docs/backend-plan.md` 5장에 "OPMS에 부탁할 것: `/api/fit/judge`" 추가.
- 12장 열린 질문에 추가: 적합성 규칙 목록을 OPMS가 내줄지, 짝 · 대체 판정 API를 언제 붙일지. (근사 치수 처리는 결정됨: PDM은 `inferred`만 붙인다.)
- 품번 참조 원칙(8장)은 PRD 4장 데이터 소유 표와 7장에 한 줄씩 더한다.

## 7. 단계 (구현은 승인 후)

| 단계 | 내용 | 확인 |
|---|---|---|
| F0 | 이 계획 확정, OPMS 초안과 경로 · 응답 필드 합의 | |
| F1 | `FitJudgement` 타입 + `judgeFit` mock + CAD HUD 적합성 줄 + 단위 · 화면 시험 | `pnpm test`, e2e 1건 |
| F2 | CAD 홈 깊이 측정 시험 구현(실제 STEP 필요, PRD 12장 3번) | 실제 파일 몇 개로 오차 확인 |
| F3 | `backend/` `/fit/*` 프록시 + 계약 · 패러티 시험 | `pytest` |
| F4 | OPMS API 구현되면 mock → 실제 전환, 규칙 화면 구분 표시 | OPMS와 합동 시험 |

## 8. 품번은 OPMS `:Part`에서 읽는다 (사용자 확정, main-07 전달)

원칙: 두 저장소는 품번 형식만 맞추는 것이 아니라 **OPMS `:Part`를 직접 참조해서** 품번이 맞아야 한다. PDM은 품번을 자기 쪽에 복사 · 입력해 두지 않고 `(:PdmItem)-[:OF_PART]->(:Part)`로 건너가 `:Part.part_no`를 읽는다. 아래는 읽어서 정리한 계획이고 구현은 하지 않았다.

### 8.1 확정된 결정과 삭제 지시의 영향 (2026-11-11)

사용자가 "추천대로"로 확정한 4개 결정이 있었고(아래 표), 그 뒤 **관리 기능 삭제를 지시**했다(부품 · 품목 관리 화면, BOM 가져오기, MES 발행, OPMS 등록 요청, 규칙 편집 · 검증, 관리자 화면). 삭제로 의미가 달라진 부분을 구분하면 다음과 같다.

| # | 결정 | 삭제 지시 뒤 상태 |
|---|---|---|
| 1 | PDM 품번 발급기(PG `issue_item_no()`, 웹 mock의 승인 시 번호 생성)는 연동 모드에서 끄고 단독 시연 모드에만 남긴다. PG `item.item_no`는 OPMS 값을 담는 읽기 전용 캐시 | **일부 삭제됨**: 웹 mock의 승인 시 번호 생성은 승인 흐름(등록 요청)과 함께 **삭제됐다**. PG 쪽 `issue_item_no()` · `approve_part_request` · `item.item_no` 캐시 격하는 DB가 "판단 필요"로 남아 있어 **유효하나 미적용**. 새 발급 경로가 없으므로 "발급기를 모드로 끈다"(8.4)는 DB 쪽에만 해당 |
| 2 | OPMS에는 있고 PDM에는 없는 `:Part`는 사람이 확인한 뒤 가져온다(자동 아님) | **의미가 약해짐(판단 필요)**: "가져오기"는 `:PdmItem`을 만드는 품목 관리 기능이라 삭제 범위와 겹친다. 원칙(자동으로 만들지 않는다)은 그대로 유효 |
| 3 | 신규 품번은 OPMS 검토 경로(A-01 → A-02 → A-03 → 사람 승인 → A-09/A-10)로 받는다. `record_origin='pdm'` 입구는 요청하지 않는다 | **삭제됨(사용자 지시)**: OPMS 등록 요청 흐름 전체가 삭제됐다. 8.6은 기록으로만 남긴다. "OPMS에 `record_origin='pdm'` 입구를 요청하지 않는다"는 여전히 맞다 |
| 4 | OPMS `POST /parts/match`(+ batch)를 쓰고 PDM은 점수를 다시 계산하지 않는다. 계약 버전 5 → 6 예정 | **그대로 유효**: CAD 스튜디오의 보유 품번 칩(`/cad/match`)이 남아 있다. 단 `/cad/match` 자체는 "판단 필요"로 유지 중이다 |

그대로 유효한 것: 품번은 OPMS `:Part.part_no` 조회값이고 PDM은 복사 · 입력하지 않는다(`OF_PART`), 적합성 판정(1~7장)과 판정 표시, 별도 DB 때의 조회 원칙(8.7).

이 저장소 문서에 있던 "OPMS에 `record_origin='pdm'`(또는 외부 등록 메서드)을 요청한다"는 문구는 삭제했다(`backend-plan.md` 5장 · `neo4j-lpg-design.md` 6장 · `PRD.md` 12장 5번).

### 8.2 현재 상태 (읽어서 확인함, 실행은 안 함)

| 항목 | 상태 |
|---|---|
| 그래프의 `:PdmItem` | 품번 속성이 없다. 발행기(`backend/src/onto_pdm/graph/publisher.py` `UPSERT_ITEMS`)가 `MATCH (p:Part {part_no: row.item_no})`로 OPMS `:Part`를 찾아 `OF_PART`로 잇고, 없으면 쓰기 전에 `part_missing`으로 멈춘다 |
| PDM 쪽 문자열 복사본 | 있다: PG `item.item_no`(`db/schema.sql:89`, NOT NULL, 고유), 웹 목 `itemNo`, 백엔드 `seed.json`, 시험 기준값 `parity.json`. **OPMS `:Part`에서 가져온 값이 아니라 PDM이 정한 값**이고, 시험용 `neo4j/test/opms-standin.cypher`가 같은 번호로 `:Part`를 대신 만들어 준다 |
| PDM이 스스로 품번을 만드는 곳 | ① `db/schema.sql:124-128` `item_no_seq` + `issue_item_no()`(= `'P-'+11자리`), 승인 함수 `approve_part_request`가 부른다(`:515`). ② 웹 목 API `mockApi.ts:418`. 둘 다 OPMS를 거치지 않는다 |
| 형식 | 문서 · 코드 · 시드의 `P-…` 약 1,090곳 중 11자리 약 1,065곳. 다른 형식은 `seed.ts:233` 문장 속 옛 `P0000001`과 일부러 망가뜨리는 시험 입력(`neo4j/test/break.cypher`) |
| backend/가 OPMS에 하는 호출 | **없다.** HTTP 클라이언트 사용이 없고 OPMS 코드를 import하지 않는다. 접점은 발행기가 같은 Neo4j에서 `:Part`를 읽고 PDM 라벨에만 쓰는 것뿐 |
| OPMS 개발 DB의 실제 상태 | OPMS 쪽 확인 문서(`ernest_hemingway_OPMS/docs/changes/CR-NEXT-onto-pdm-merge-prep-changes.md` 1장, 읽음): 같은 Neo4j(`bolt://localhost:7687`)이고 `PdmItem` 등 PDM 라벨이 **0개**다(`Part` 45개, 온톨로지 0.13.0). **즉 설정은 공유이지만 PDM은 아직 이 DB에 쓴 적이 없다.** (이 세션이 직접 질의한 것은 아니고 OPMS 쪽 문서를 읽었다) |

### 8.3 참조 무결성: 있는 것 · 없는 것 · 추가안

**있는 것**: `neo4j/checks.cypher`의 `item_one_part`(`:PdmItem`은 `:Part` 정확히 하나에 `OF_PART`), `part_one_item`, `part_no_format`(`^P-[0-9]{11}$`)가 발행 트랜잭션 안에서 돌아 위반이면 롤백한다. Community에는 관계 존재 제약이 없어 이 검사가 그 일을 한다.

**빈 곳 (추가안, 승인 후 구현)**
1. 발행기 밖에서 만들어진 `:PdmItem`은 못 막는다 → `checks.cypher`를 **정기 점검**(예: `onto-pdm graph check`)으로도 돌린다.
2. `:PdmItem`에 `part_no` · `item_no` 복사 속성이 생기면 잡는 `no_part_no_copy`를 더한다(지금은 누가 넣어도 막히지 않는다).
3. OPMS가 `:Part`를 지우거나 번호를 바꾸면 PG `item.item_no`(캐시)가 옛 값으로 남는다 → PG 캐시와 `:Part.part_no` 일치를 정기 대조한다(발행기의 `MISSING_PARTS`를 정기 실행).

### 8.4 발급기를 모드로 끄는 방식 (결정 1, 제안) — 웹 mock 쪽은 승인 흐름과 함께 삭제됨, PG 쪽만 판단 필요

모드 이름은 `PDM_MODE=standalone | linked`로 제안한다(이름과 기본값은 구현 때 정한다). **기본은 `standalone`**이어야 `pnpm dev`와 DB 시험이 OPMS 없이 그대로 돈다. 실제 연동 때 `linked`로 바꾼다.

| 대상 | `standalone`(단독 시연 · 시험) | `linked`(실제 연동) |
|---|---|---|
| 웹 목 API(`mockApi.ts:418`) | 지금처럼 승인 시 번호 생성. 화면에 "데모: 번호는 임시" 표시를 둔다 | 목 API 자체를 쓰지 않는다. 웹은 이미 `VITE_API_MODE=http` 어댑터가 있어(S5) 그 경로로 간다. **http 모드에서 목의 번호 생성이 호출되지 않는다**는 시험을 둔다 |
| PG `issue_item_no()` · `approve_part_request`(`db/schema.sql:124-128, :515`) | 지금처럼 동작(PG 단독 시험 · 목 서버) | `issue_item_no()`는 호출되면 예외. 승인 함수는 번호를 만들지 않고 **OPMS에서 받은 `part_no`를 인자로 받아** 쓴다(함수 시그니처는 읽지 못한 부분이 있어 구현 때 확인) |
| PG `item.item_no` | 일반 컬럼 | **읽기 전용 캐시.** 일반 앱 역할의 `UPDATE (item_no)`와 `renumber_item()` 실행을 막고(`db/roles.sql`), 쓰는 곳은 "OPMS에서 가져오기" 경로 하나로 한정한다. `NOT NULL` · 고유는 유지(OPMS가 고유를 보장하므로 캐시도 고유) |
| 모드 전달 | 앱 설정 + 세션마다 `set_config('pdm.mode', …, true)`(DB 함수가 읽음) | 같음 |
| 모드가 어긋날 때 | — | 시작할 때 `linked`인데 OPMS 설정(`NEO4J_*`, OPMS API 주소)이 없으면 기동을 거부한다 |

관리자 화면의 "승인하면 품번이 발급된다"(웹 e2e)는 **단독 시연 모드 시험으로 한정**한다. `linked`에서 PDM 관리자 화면은 승인하지 않고 OPMS 쪽 진행 상태(8.6)를 보여 준다.

### 8.5 CAD 부품 → 기존 `:Part` 매칭: 이름 mock에서 `/parts/match`로 (결정 4. 결정 2의 "가져오기"는 삭제 지시로 판단 필요)

**지금**: `/cad/match`(웹 `matchCadParts`, 백엔드 `matching.py`)는 PDM이 가진 품목 · 별칭을 이름으로 비교하고 PDM이 직접 유사도 점수를 계산한다(`normKey` · `similarity`). 같은 DB도, OPMS API도 쓰지 않는다.

**바꾸는 방향**: 웹이 부르는 PDM 계약(`/api/v1/pdm/cad/match`)은 유지하고, **백엔드 안쪽 구현만** OPMS `POST /parts/match-batch` 호출로 바꾼다. 같은 DB를 직접 조회해 후보를 찾고 점수를 계산하는 방식(이 문서 이전 판의 계획)은 **채택하지 않는다**: 규칙이 두 곳이 되기 때문이다(OPMS 결정 4). 같은 DB를 직접 읽는 것은 `OF_PART`로 품번을 읽는 데(발행기 · 화면 조회)에만 쓴다.

| 단계 | 내용 |
|---|---|
| 입력 만들기 | CAD 부품 → `PartMatchIn`(OPMS 초안: `class_code`, `values`(속성 키 → 값 · 단위), 선택 `supplier` · `supplier_part_no`). CAD에서 지금 얻는 것은 이름 · 크기 · 이름 속 규격(`M3`, `×12`, PRD 11장 🟡)과 **추정 분류**다. 속성 값은 사람이 확정한 것과 `inferred`를 구분해 보낸다 |
| 호출 | 단계(또는 BOM 시트)의 부품을 모아 `match-batch` 한 번. 상한은 OPMS `settings.api`(미정) |
| 결과 표시 | `part_no`(= **조회값**), `verdict`(`confirmed` → 화면 "같음", `suspected` → "후보"), `score`, `capped` · `class_capped`, 속성별 `matched` · `conflicts`, `ontology_version`을 **그대로** 보인다. PDM이 점수를 바꾸거나 새로 만들지 않는다 |
| 기존 상태와 대응(제안) | `confirmed` → `matched`, `suspected` → `suggested`, 후보 없음 → `none` (기존 `CadPartMatch.status`) |
| PDM이 계속 직접 하는 것 | **사람이 확정해 저장한 연결**(CAD 이름 → 품목 별칭, 거절한 제안 기록)만. 이것은 판정이 아니라 PDM이 소유한 사람의 결정이다. PDM 자체 유사도(`similarity`)는 `linked`에서 쓰지 않고 `standalone`에만 남긴다 |
| 가져오기(결정 2) | OPMS에는 있고 PDM에는 없는 `:Part`가 후보로 나오면 "OPMS에는 있고 PDM에는 아직 없음"으로 표시하고, **사람이 확인한 뒤** `:PdmItem` + `OF_PART`를 만든다(발행기 `UPSERT_ITEMS`와 같은 경로). 품번은 `:Part.part_no` 조회값이고, `item_type` 같은 PDM 소유 속성은 가져올 때 사람이 정한다. 자동 가져오기는 하지 않는다(기존 원칙 "자동 매칭은 제안까지만, 확정은 사람") |

**OPMS API가 구현되기 전**: 초안 응답 형식(OPMS `CR-NEXT-onto-pdm-merge-prep-changes.md` 5장)을 따르는 **고정 응답표 mock 어댑터**로 시작한다(판정 계산은 하지 않는다). 계약 버전이 5 → 6으로 바뀌므로 어댑터는 OPMS가 알려 주는 계약 버전이 기대와 다르면 호출을 막는다(OPMS가 버전을 노출하는 방법은 **미확인**).

**위험(미확인)**
- 초안의 `class_code`가 **필수인지** 확인하지 못했다. 필수라면 분류를 모르는 CAD 부품(`Bolt_1`)은 매칭 요청 자체를 못 만들 수 있다. 그때는 "추정 분류 → 사람 확인 → 호출" 단계가 필요하다.
- 이름만 있는 CAD 부품에서 값을 뽑는 파서(`parseFastenerSpec`)는 미구현이다(PRD 11장). 값이 비면 OPMS가 `capped`(후보까지만)로 낮출 것으로 읽었다. 확정이 아니다.

### 8.6 매칭이 없을 때: OPMS 검토 경로로 신규 품번 받기 (결정 3) — **삭제됨(사용자 지시)**. 기록으로만 남긴다

PDM이 `:Part`를 만들지 않고, OPMS에 `record_origin='pdm'` 입구도 요청하지 않는다. PDM은 OPMS 웹 API의 **클라이언트**다.

| 순서 | 호출 · 담당 | PDM의 일 |
|---|---|---|
| ① | `POST /documents`(A-01) | 등록 요청(CAD 이름 별칭 · 추정 분류 · 출처, F-MAT-2)을 OPMS가 받는 **파일**로 올린다. 허용 형식은 pdf · xlsx · xls · csv다(OPMS 결정 기록 확인). PDM의 요청을 어떤 파일 모양으로 올릴지는 **미정**(사양서 PDF를 그대로 올리거나 부품 목록 CSV를 만든다) |
| ② | `POST /documents/{id}/process`(A-02), 또는 OPMS 자동 시작 | 처리를 시작한다(OPMS는 대기 문서 자동 시작도 있다, D25) |
| ③ | `GET …/status`(A-03) | 폴링으로 "처리 중 · 검토 대기 · 승인 · 반려"를 `내 등록 요청` 화면에 보인다 |
| ④ | **OPMS에서 사람이 검토 · 승인** | PDM은 승인하지 않는다. 지금 PDM의 관리자 승인 화면은 `linked`에서 읽기 전용 진행 상태로 바뀐다(8.4) |
| ⑤ | `GET /parts/{part_no}`(A-09) · `/export`(A-10) | 승인된 부품 · 표준 JSON을 읽어 `part_no`를 받는다 |
| ⑥ | PDM 화면 | 받은 `part_no`를 사람이 확인하고 가져온다(8.5의 가져오기). 이름 · 규격을 보고 확인한다 |

- **요청 ↔ 품번 전달**: 문서 `doc_id` ↔ `part_no` 대응을 PDM이 읽는 약속은 **OPMS가 초안을 작성 중**이다. 정해지기 전에는 PDM이 `doc_id`를 요청 기록에 저장하고 상태만 폴링하며, **문서 내용을 보고 품번을 추측해 연결하지 않는다.**
- **미확인**: OPMS에는 인증이 없고 Host · Origin 검사만 한다(`backend-plan.md` 1장). PDM 서버가 OPMS API를 서버 대 서버로 부를 때 이 검사를 통과하는지는 확인하지 못했다. 업로드 크기 상한(`api.body_limit`, 기본 1 MiB)과 PDM이 올릴 파일 크기의 관계도 같다.
- 지금 웹 목의 "승인하면 번호가 생긴다" 흐름은 `standalone` 시연용으로만 남는다.

### 8.7 같은 DB를 쓰지 못하는 환경(별도 DB)에서의 대안

위 8.5 · 8.6이 모두 **OPMS API**를 쓰므로, 별도 DB 환경에서도 매칭 · 신규 품번 요청 경로는 바뀌지 않는다. 달라지는 것은 `:PdmItem` ↔ `:Part` 연결(`OF_PART`)을 그래프 관계로 못 걸고, 품번을 PDM 쪽에 어떻게 두느냐다. 조회값 원칙을 지키려면:

1. **저장하는 것은 참조 키뿐이다.** OPMS `part_no`가 바뀔 수 있는지(`renumber`)와 안정 ID가 있는지는 **확인하지 못했다.** 바뀔 수 있다면 `part_no`가 아니라 OPMS의 안정 ID를 키로 삼아야 하고, OPMS가 계약에 노출해야 한다.
2. **읽은 품번 · 이름 · 분류는 읽기용 캐시**(8.4의 `item.item_no`와 같은 지위)로 두고 `fetched_at`과 OPMS `ontology_version`을 붙인다. 화면 · 문서 출력 직전에 신선도를 확인하고, 쓰기는 가져오기 경로 하나로 한정한다.
3. **PDM 안에서 품번을 새로 만들거나 직접 입력하는 경로를 막는다.** `linked` 모드(8.4)와 같다. 품번 입력란은 OPMS 검색 결과 선택만 받는다.
4. **정기 대조**: 보유한 키를 A-09(부품 조회) 또는 `/parts/search`(A-22)로 OPMS와 대조해 사라졌거나 번호가 바뀐 것을 "OPMS에서 사라진 품번" 경고로 보인다. 같은 DB의 `item_one_part` · 8.3의 3번과 같은 일이다.

### 8.8 남은 결정 · 미확인

| 항목 | 상태 |
|---|---|
| `doc_id` ↔ `part_no` 전달 약속 | OPMS가 초안 작성 중. 그 문서가 나오면 8.6에 반영 |
| `POST /parts/match`의 `class_code` 필수 여부, 값이 없을 때의 동작 | 미확인(8.5) |
| A-01에 PDM의 요청을 어떤 파일 형식으로 올릴지 | 미정 |
| 서버 대 서버 호출이 OPMS Host · Origin 검사를 통과하는지, 업로드 상한 | 미확인 |
| `PDM_MODE`의 이름 · 기본값, 승인 함수 시그니처 변경 | 구현 때 정한다(8.4) |
| OPMS가 계약 버전을 노출하는 방법(5 → 6) | 미확인 |
| `part_no` 재부여 가능 여부, 안정 ID | 미확인(8.7) |
