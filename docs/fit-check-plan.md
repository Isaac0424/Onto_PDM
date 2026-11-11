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
   - 그래서 1단계는 홈 깊이를 `inferred`로 표시해 넘기고, 측정이 부정확하면 `unknown`/`conditional`로 내릴지는 **OPMS 미결 3번**(사용자 결정 필요)이다.
2. **OPMS API가 구현 전이다.** 경로 · 필드 이름은 초안이고 바뀔 수 있다. mock 어댑터는 초안 응답 형식(OPMS 설계안 4.1절)을 그대로 따르되 바뀌면 어댑터만 고친다.
3. **규칙 숫자는 시연용 가정이다**(나사 끝 여유 2.0 mm, 경고 1.0 mm). 실제 사내 설계 기준이 필요하다.
4. 같은 분류 안의 길이 대체(HexBolt → 더 짧은 HexBolt)를 허용할지는 OPMS 미결 4번이다. 대체 판정 API(`/api/substitution/judge`)는 OPMS 2단계라 이번 범위 밖이다.
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
- 12장 열린 질문에 추가: 홈 깊이 측정 근사를 `unknown`으로 내릴지(OPMS 미결 3), 같은 분류 안 길이 대체 허용 여부(OPMS 미결 4), 적합성 규칙 목록을 OPMS가 내줄지.

## 7. 단계 (구현은 승인 후)

| 단계 | 내용 | 확인 |
|---|---|---|
| F0 | 이 계획 확정, OPMS 초안과 경로 · 응답 필드 합의 | |
| F1 | `FitJudgement` 타입 + `judgeFit` mock + CAD HUD 적합성 줄 + 단위 · 화면 시험 | `pnpm test`, e2e 1건 |
| F2 | CAD 홈 깊이 측정 시험 구현(실제 STEP 필요, PRD 12장 3번) | 실제 파일 몇 개로 오차 확인 |
| F3 | `backend/` `/fit/*` 프록시 + 계약 · 패러티 시험 | `pytest` |
| F4 | OPMS API 구현되면 mock → 실제 전환, 규칙 화면 구분 표시 | OPMS와 합동 시험 |
