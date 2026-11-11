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

## 8. 품번은 OPMS `:Part`에서 읽는다 (사용자 요구, main-07 전달)

원칙: 두 저장소는 품번 형식만 맞추는 것이 아니라 **같은 DB의 OPMS `:Part`를 직접 참조해서** 품번이 맞아야 한다. PDM은 품번을 자기 쪽에 복사 · 입력해 두지 않고 `(:PdmItem)-[:OF_PART]->(:Part)`로 건너가 `:Part.part_no`를 읽는다. 이 장은 현재 상태를 읽기만 해서 정리한 것이고 구현은 하지 않았다.

### 8.1 현재 상태 (읽어서 확인함, 실행은 안 함)

| 항목 | 상태 |
|---|---|
| 그래프의 `:PdmItem` | **품번을 속성으로 갖지 않는다.** 발행기(`backend/src/onto_pdm/graph/publisher.py` `UPSERT_ITEMS`)가 `MATCH (p:Part {part_no: row.item_no})`로 OPMS `:Part`를 찾아 `OF_PART`로 잇는다. 없으면 쓰기 전에 `part_missing`으로 멈춘다 |
| **PDM 쪽 문자열 복사본** | 있다. PG `item.item_no`(`db/schema.sql:89`, 고유 인덱스), 웹 목 API의 `itemNo`, 백엔드 시드(`seed.json`), 테스트 기준값(`parity.json`). 그래프에는 없지만 PDM 자체 저장소는 품번을 문자열로 들고 있다 |
| PDM이 **스스로 품번을 만드는 곳** | 있다. ① `db/schema.sql:124-128` `item_no_seq` + `issue_item_no()` = `'P-'+11자리`(PG 단독 · 시험용이라고 주석에 적힘), 승인 함수 `approve_part_request`가 이를 부른다(`:515`). ② 웹 목 API `mockApi.ts:418` `P-${nextItemNo 11자리}`. 둘 다 OPMS `:Sequence`를 쓰지 않는다 |
| 복사본 값의 출처 | **OPMS `:Part`에서 온 값이 아니다.** 목 시드(`seed.ts`) · `seed.json`의 `P-0000000xxxx`는 PDM이 손으로 정한 값이다. 시험용 `neo4j/test/opms-standin.cypher`가 같은 번호로 `:Part`를 대신 만들어 준다. 실제 OPMS DB의 `:Part`와 번호가 맞는지는 **확인하지 못했다**(그 DB에 질의하지 않았다) |
| 형식 | `P-`+11자리가 문서 · 코드 · 시드 약 1,065곳(1,090곳 중). 형식이 다른 값은 `seed.ts:233` 문장 안의 `P0000001`(옛 7자리) 한 곳, `neo4j/test/break.cypher`(일부러 망가뜨리는 시험 입력)뿐이다 |
| 검사 | `neo4j/checks.cypher`에 `item_one_part`(`:PdmItem`은 `:Part` 정확히 하나에 `OF_PART`), `part_one_item`(한 `:Part`에 PdmItem 하나), `part_no_format`(`^P-[0-9]{11}$`)이 **이미 있다** |

### 8.2 참조 무결성: 있는 것 · 없는 것 · 추가안

**있는 것**: `item_one_part` · `part_one_item`이 발행 트랜잭션 안에서 돌아 위반이면 롤백한다(`backend/README.md`, `docs/backend-plan.md`). Neo4j Community에는 관계 존재 제약이 없어서 이 검사가 그 일을 한다.

**빈 곳 (추가안, 승인 후 구현)**

1. **검사의 시점**: 발행기 밖에서 만들어진 `:PdmItem`(수동 Cypher, 다른 도구)은 막지 못한다. `checks.cypher`를 **정기 점검**(예: `onto-pdm graph check`, OPMS reconcile과 같은 자리)으로도 돌린다.
2. **PDM이 옛 값을 따로 갖지 않는 검사**: `:PdmItem`에 `part_no` 같은 속성이 생기면 위반으로 잡는 검사 `no_part_no_copy`를 더한다. (현재는 없지만 누가 넣어도 막히지 않는다.)
   `MATCH (i:PdmItem) WHERE i.part_no IS NOT NULL OR i.item_no IS NOT NULL RETURN 'no_part_no_copy', ...`
3. **고아 방향 검사**: OPMS가 `:Part`를 지우거나 `part_no`를 바꾸면 `OF_PART`는 같이 지워진다(관계). 그러면 `item_one_part`가 잡는다. 그러나 **PG `item.item_no`가 옛 번호로 남는다.** PG와 그래프의 번호 일치를 보는 검사(발행기의 `MISSING_PARTS`를 정기 실행)를 더한다.
4. **PG 쪽 복사본 해소(가장 큰 변경, 별도 결정)**: PG `item.item_no`를 그래프에서 조회한 값의 **캐시**로 격하하고, 번호 발급은 `issue_item_no()`가 아니라 OPMS 예약을 쓴다(`db/schema.sql:121` 주석이 이미 이 방향을 적고 있다). 이 경우 PG에서 `item_no`가 NOT NULL · UNIQUE인 지금 구조(`:89`, `:108`)는 "OPMS에서 받은 값만 들어온다"로 바꿔야 한다. OPMS 예약 입구가 없어 지금은 못 한다(8.3).

### 8.3 CAD 부품 → 기존 `:Part` 매칭과 신규 품번 요청

현재: `/cad/match`와 웹 목 `matchCadParts`는 **PDM이 가진 품목 · 별칭을 이름으로** 비교한다(일치 · 정규화 일치 · 유사도, `mockApi.ts:247-330`, `backend/.../matching.py`). 같은 DB를 조회하지 않는다.

계획:

1. **같은 DB 조회로 바꾼다.** 후보는 `:Part`에서 직접 찾는다: 품번 · 별칭(`:PartIdentifier`, `:SupplierPart`) · 이름 · 분류(`INSTANCE_OF`)와 속성 값. 결과 항목에 쓰는 품번은 `:Part.part_no` 조회값이다. PDM이 아직 가져가지 않은 `:Part`(`:PdmItem` 없음)도 후보가 될 수 있어야 한다. 그 경우 "OPMS에는 있고 PDM에는 아직 없음"으로 표시하고 `:PdmItem` 생성(가져가기)을 제안한다. 이것은 모델 B의 기존 흐름(`:Part`는 OPMS 것, `:PdmItem`은 PDM 것)과 맞는다.
2. 규격 속성(`threadSize`, `length` 등)으로 같은 규격을 찾는 방식(createonto의 "규격이 연결 고리" 개념)은 이 조회의 후속 개선이다. 속성이 `:Part`에 이미 있는 것만 쓴다. 이름만 있는 CAD 부품(`Bolt_1`)은 못 찾는다.
3. **매칭이 없을 때**: `Part`를 만들지 않고 OPMS에 등록 요청을 보낸다. **현재 OPMS에는 이 입구가 없다**: `:Part` 생성은 검토 건(review_id) 안의 `register_part`뿐이고, 출처 목록(`origin.py`)은 `review|seed|import` 셋이다(`docs/backend-plan.md` 5장 1, `docs/neo4j-lpg-design.md` 6장 1). 그래서 흐름은 다음과 같다.
   - 지금(입구 없음): PDM이 요청 임시저장(`/requests`) → 제출까지만 하고 "OPMS 처리 대기" 상태로 둔다. 승인된 품번이 들어오면 PDM이 `:Part`를 조회해 `:PdmItem`을 붙인다. 번호는 PDM이 만들지 않는다. 지금 목 API가 승인 시 번호를 만드는 동작(`mockApi.ts:418`)은 데모용이며 실제 연동 때 제거 대상이다.
   - OPMS가 `record_origin='pdm'` 입구(외부 등록 메서드)를 열면: 요청 제출 → OPMS가 예약 · 생성 → PDM이 조회해 연결. 이 입구가 정해지기 전에는 PDM이 `:Part`를 직접 쓰지 않는다(임시 대안은 OPMS의 중복 판정 · 온톨로지 투영 우회라 권장하지 않는다고 `backend-plan.md`에 적었다).
4. 적합성 판정(1~2장)도 같은 규칙을 따른다: OPMS에 부품을 알릴 때 품번은 조회값을 쓰고, 미보유 부품만 `class_code` + 값 형태로 보낸다.

### 8.4 같은 DB를 쓰지 못하는 환경(별도 DB)에서의 대안

대안은 OPMS API 조회다. 이때도 **복사본이 아니라 조회값**이라는 원칙을 지키려면:

1. **저장하는 것은 참조 키뿐이다.** 필요한 키는 OPMS가 보장하는 안정된 식별자다. `part_no`가 바뀔 수 있는지(`renumber`)는 OPMS에서 확인해야 한다(**미확인**). 바뀔 수 있다면 `part_no`가 아니라 OPMS 내부 안정 ID가 필요하고, OPMS가 그것을 계약에 노출해야 한다.
2. **PDM이 읽는 품번 · 이름 · 분류는 읽기용 투영(캐시)으로 둔다**: 캐시에는 `fetched_at`, OPMS의 `ontology_version`(또는 항목 버전)을 붙이고, 화면 · 문서 출력 직전에 신선도를 확인한다. 쓰기는 하지 않는다. 오래되면 다시 조회한다.
3. **PDM 안에서 품번을 새로 만들거나 직접 입력하게 하는 경로를 막는다**: PG `issue_item_no()` · 목 API의 번호 생성을 설정으로 끈다(별도 DB 모드에서는 호출하면 오류). 품번 입력란은 OPMS 검색 결과 선택만 받는다.
4. **정기 대조**: PDM이 보유한 참조 키 목록을 OPMS 조회(`judge-batch`처럼 배치)와 대조해, 없어졌거나 번호가 바뀐 것을 찾는 점검을 둔다. 같은 DB의 `item_one_part`를 API 버전으로 옮긴 것이다. 결과는 PDM 화면에서 "OPMS에서 사라진 품번" 경고로 보인다.
5. **OPMS 계약이 필요하다**: 품번 조회 · 검색, 배치 조회, 등록 요청 입구가 모두 읽기 전용 API 또는 정해진 쓰기 API로 있어야 한다. 이 중 어느 것이 이미 있는지는 **확인하지 못했다**(OPMS 쪽 API 목록을 읽지 않았다).

### 8.5 정할 것 (사용자)

1. PG `item.item_no`를 캐시로 격하하고 발급기를 끌지(8.2의 4번). 지금 PG 단독 모드(시험 · 목 서버)와의 호환을 어떻게 할지.
2. `:Part`가 PDM에 없을 때 "가져가기"를 자동으로 할지 사람이 확정할지(기존 원칙: 자동 매칭은 제안까지만).
3. OPMS `record_origin='pdm'` 입구 요청의 담당 · 시점(`backend-plan.md` 5장 1).
