# OPMS 요청서(초안): 설계 변경 영향 분석(볼트 · 너트 체결)을 위한 6건

- 상태: **초안 — 전달 전.** OPMS 팀에 보낼지, 어떤 것을 보낼지는 사용자가 정한다. 이 저장소(Onto PDM)는 OPMS `ontology/` · 코드를 바꾸지 않는다. 적용 여부와 방법은 OPMS 몫이다.
- 기준: **OPMS 저장소의 `PDM` 브랜치, 커밋 `03331ba`**(`PDM: 머리 모양 CR U7(계약 7·읽기 전용 표시)을 병합한다`). 아래 OPMS 파일 · 줄 번호는 모두 이 커밋의 작업 트리에서 2026-11-12에 읽은 것이다. 온톨로지 버전은 **0.19.0**이고 `ontology/`에 미커밋 변경은 없다(0.19.0은 커밋 `58ffed2`에 들어 있다). 이 PC의 OPMS 작업 트리에는 이 요청과 무관한 `settings.yaml` 수정이 있다.
  - 앞서 Onto PDM 문서(`change-impact-*.md`)는 `PDM` `7d1e484`와 "0.19.0 미커밋"이라고 적었다. 그 뒤 OPMS가 앞서 나가 사실이 바뀌었으므로 이 요청서 값이 맞다.
- 작성: 2026-11-12. 근거로 읽은 OPMS 문서(읽기 전용, `D:\ernest_hemingway_OPMS`): `ontology/{rules,classes,constraints,properties,relations}.yaml`, `docs/changes/CR-NEXT-part-relation-rule.md`, `CR-NEXT-mating-rules.md`, `CR-NEXT-parts-match-api.md`, `KAN-124-auth.md`, `docs/PRD.md`, `src/registry/{contracts.py, api/routes_fit.py, api/routes_ontology.py, ontology/rules/mates_with.py, ontology/diff.py}`.
- 원칙: **온톨로지 · 품번 · 판정 규칙은 OPMS가 소유하고 PDM은 읽기만 한다.** 이 요청서는 OPMS가 이미 한 결정을 뒤집자는 것이 아니다. 판단은 모두 OPMS 몫이고, PDM은 어느 쪽으로 정해져도 받아들일 대안을 각 건에 적었다.
- 관련(PDM 쪽, 참고용): `docs/change-impact-prd.md` · `change-impact-ontology.md` · `change-impact-design.md` 5.5절. 이 요청서는 그 문서 없이도 읽히도록 썼다.

## 0. 먼저 알아야 할 것

### 0.1 PDM이 하려는 일

PDM(조립 작업자용 CAD · BOM 화면)에 **설계 변경 영향 분석**을 추가한다. 부품 규격 · 재질 · 공차 · 구성이 바뀔 때 ① 그 부품이 쓰인 BOM · 제품을 찾고 ② 거기에 걸린 작업지시 · 발주 · 재고를 보고 ③ **볼트 · 너트 · 와셔가 여전히 맞는지** 다시 판정한 뒤 ④ 대상마다 처분(허용 · 재작업 · 격리 …)을 사람이 정해 승인한다. 첫 목표 제품은 볼트 4 · 너트 4 · 와셔 8로 판 두 장을 조이는 `BRK-M8` 하나다. OPMS에 쓰지 않고, OPMS의 품번(`:Part`)과 규칙을 **읽기만** 한다.

### 0.2 OPMS에 이미 있어서 이번 요청이 필요 없는 것

| 이미 있는 것 | 근거 |
|---|---|
| 볼트 · 너트 · 와셔 분류: `Bolt`(`HexBolt` `HexFlangeBolt` `SocketHeadBolt` …), `Nut`(`HexNut` …), `Washer`(`FlatWasher` …) | `ontology/classes.yaml:31 Nut`, `:40 HexNut`, `:57 Washer`, `:68 FlatWasher` |
| 속성 `threadSize` `pitch` `length` `strengthGrade` `nutHeight` `thickness` `holeDepth`(단위 mm) | `ontology/properties.yaml:13-22` |
| 짝 규칙 `bolt_nut`(`blocking: threadSize`, `match: [pitch]`), `bolt_washer` · `nut_washer`(`threadSize`) | `ontology/rules.yaml:14-34` |
| 짝 판정 코드: `partners()` · `judge_pair()`가 `fits · mismatch · unknown · unrelated` 4종을 돌려준다 | `src/registry/ontology/rules/mates_with.py:34, 125, 135` |
| 적합성 판정 API `POST /api/v1/fit/judge` · `judge-batch`(참고용, 읽기 전용), 계약 버전 `"7"` | `src/registry/api/routes_fit.py:39, 47`, `contracts.py:25, 1801-1880` |
| 규칙 `bolt_length_vs_hole_depth`(`fit_check`: 볼트 길이 ≥ 홈 깊이 + 2.0, 경고 1.0) — **탭 구멍용**, "시험용 가정, 기준 출처 · 담당자 미지정"이라고 적혀 있다 | `ontology/rules.yaml:176-188` |
| 온톨로지 버전 열람 API A-29 ~ A-32(목록 · 요약 · 스키마 전체 · 두 버전 비교) | `src/registry/api/routes_ontology.py:37-66` |
| 온톨로지 변경 때 기존 `:Part` 재검증 보고 `revalidation_impacts`(보고 전용, sync를 막지 않음) | `src/registry/ontology/diff.py:263` |

### 0.3 6건 한눈에

| # | 제목 | 한 줄 | 없어도 PDM이 막히나 | 우선순위 |
|---|---|---|---|---|
| ① | 짝(`mates_with`) 판정의 서버 제공 재검토 | PDM이 OPMS 규칙을 읽어 **직접 계산**하는 임시 구현을 걷고 싶다 | 아니오(임시 판정) | 중 |
| ② | 관통 체결 그립 길이 규칙과 `nutHeight` | 볼트 + 너트 + 판 두께용 `fit_check` 규칙과 기준 출처 · 담당자 | 아니오(PDM 참고 판정) | 중 |
| ③ | `strengthGrade` 순서 비교 | 너트 등급이 볼트보다 낮은 조합을 거르려면 순서가 필요 | 아니오("검토 필요"로 둠) | 낮음 |
| ④ | PDM 서버용 읽기 경로 · 온톨로지 변경 알림 | 지금은 Neo4j 직접 읽기. API로 바꿀 길과 버전 변경 감지 | 아니오(직접 읽기) | 중 |
| ⑤ | 부품 개정(`:PartRevision`) 계획과 "무엇이 새 품번인가" 합의 | OPMS 개정과 PDM `ItemRevision`의 관계, 식별 속성 목록 | **중장기 선결** | 높음(방향 합의) |
| ⑥ | 판 · 조립품처럼 `:Part`가 없는 품목 | 가공품 · 조립품 분류와 등록 경로 | 아니오(PDM 품목만 둠) | 낮음 |

## 1. 요청 1: 짝(`mates_with`) 판정을 서버에서 받을 수 있는가 — 재검토 요청

- **필요한 이유:** 너트를 바꾸면 볼트와 맞는지(나사 규격 · 피치)를 다시 판정해야 한다. 현재 OPMS에는 짝 판정을 부르는 API가 없어서, PDM이 **OPMS 스냅샷(`:OntologyVersion.snapshot`)에서 `mates_with` 규칙 명세를 읽어 같은 4상태 의미로 직접 계산**한다(`temporary: true`로 표시).
- **OPMS가 이미 정한 것(번복 요청이 아니다):**
  - `CR-NEXT-part-relation-rule.md:200` 결정 5: 판정 API 범위는 `fit_check`(길이 비교)만이고 "`mates_with`·`substitutes` 판정은 **같은 API로** 내지 않는다".
  - `CR-NEXT-mating-rules.md` 8절: 짝 · 대체 판정 API는 `contracts.py`와 저장소 Protocol 변경이 필요해 하지 않았고, `partners` · `judge_pair`가 이미 있어 "A-22 속성 검색으로 후보를 읽고 판정만 더하면 된다"고 남겨 두었다.
  - `CR-NEXT-part-relation-rule.md:151`: "PDM이 규칙을 직접 읽어 계산하지 않는다(**두 곳 구현 방지**). … 위 API만 부른다."
- **그래서 정직하게 밝혀 둔다:** PDM의 임시 계산은 위 151행의 원칙과 **어긋난다.** 짝 판정 API가 없어서 선택한 임시 방편이고, 같은 규칙이 두 곳에서 계산되면 어긋날 수 있다. PDM은 이 어긋남을 줄이려고 OPMS의 `judge_pair`와 같은 의미(blocking이 다르면 `unrelated`, blocking은 같고 match가 다르면 `mismatch`, 한쪽 값이 없으면 `unknown`)만 구현하고 모든 결과에 `temporary: true`를 붙이지만, 근본 해결은 OPMS가 판정을 주는 것이다.
- **요청 내용(판단은 OPMS 몫):** 결정 5의 "같은 API로 내지 않는다"는 `fit/judge`(길이 비교)에 짝 판정을 섞지 않는다는 뜻으로 읽힌다. **별도 엔드포인트로 짝 판정을 읽기 전용으로 내는 것이 필요한지** 재검토해 달라. 필요하다고 보면 아래 모양을 초안으로 제안한다.

```
POST /api/v1/parts/mates/judge      (A-4x 가번호, 참고용 · 읽기 전용 — fit/judge와 같은 성격)
요청  { "a": { "part_no": "P-00000000001" },           // 또는 { "class_code": "HexBolt", "values": { "threadSize": {"value":"M8"}, "pitch": {"value":1.25,"unit":"mm"} } }
        "b": { "part_no": "P-00000000023" },
        "rule_id": "bolt_nut",                          // 선택. 없으면 두 분류에 적용되는 짝 규칙 전부
        "client_ref": "..." }
응답  { "ontology_version": "0.19.0",
        "verdict": "mismatch",                          // fits | mismatch | unknown | unrelated (mates_with.py:34)
        "summary": "피치가 다르다(1.25 ↔ 1.0)",
        "rules": [ { "rule_id": "bolt_nut", "verdict": "mismatch",
                     "props": [ { "prop_key": "pitch", "a": 1.25, "b": 1.0, "unit": "mm", "equal": false } ],
                     "message": "볼트와 너트는 나사 규격과 피치가 같아야 맞물린다" } ],
        "missing": [] }
배치 /parts/mates/judge-batch  (fit_batch_max와 같은 상한)
```

- 새 모델이 `contracts.py`에 들어가므로 계약 버전을 올려야 하고(`"7"` → `"8"`), CLAUDE.md의 "멈추고 물어볼 것"에 해당하는 변경임을 알고 있다. 응답의 4상태 이름은 `judge_pair`의 `Verdict`를 **그대로** 쓰는 것을 제안한다(`ok · no`로 바꾸는 것은 PDM이 한다).
- **OPMS가 하지 않아도 되는 것 / PDM이 이미 하는 것:** 짝 판정 규칙을 새로 만들 필요는 없다(`bolt_nut` 등이 이미 있다). PDM은 지금 스냅샷의 규칙 명세를 읽어 임시 계산을 하고 있다. 대체(`substitutes`) 판정은 이 요청에 포함하지 않는다.
- **수용 기준:** 같은 두 부품 · 같은 온톨로지 버전이면 OPMS 결과와 PDM 화면의 판정이 항상 같고, PDM의 임시 계산 코드를 지울 수 있다. 시험 입력: 볼트 `P-00000000001`(M8, 피치 1.25) × 너트 `P-00000000022`(피치 1.25) → `fits`, × `P-00000000023`(피치 1.0) → `mismatch`(이 PC OPMS 개발 DB의 실제 값, 2026-11-12 읽기 전용 확인).
- **PDM이 받아들일 대안:** (a) OPMS가 "하지 않는다"로 유지 → PDM은 임시 계산을 계속하고 "OPMS 판정 아님"을 화면에 표시한다. (b) `fit/judge`에 `against`로 짝 규칙을 넣는 방식(결정 5와 충돌하므로 선호하지 않는다). (c) OPMS가 `judge_pair`를 `/parts/{part_no}/partners` 같은 **짝 후보 목록 읽기**로만 내는 것도 PDM에는 충분하다.
- **우선순위 · 일정 영향:** 중. OPMS 계약 버전과 시험이 늘어난다. PDM은 이것을 기다리지 않는다.

## 2. 요청 2: 관통 체결 그립 길이 규칙과 `nutHeight`

- **필요한 이유:** 볼트와 너트로 판 두 장을 조일 때 볼트가 충분히 긴지는 `판 두께 합 + 와셔 + 너트 높이 + 나사 끝 여유`로 판단한다. 현재 `fit_check` 규칙은 **탭 구멍(홈 깊이)** 하나뿐이다(`rules.yaml:178-188`, 대상 `Bolt`, `subject: length`, `against: context holeDepth`, `margin.add 2.0`). 관통 체결(볼트 + 너트)에는 쓸 수 없어 PDM이 **"PDM 참고 판정"** 으로 직접 계산한다.
- **PDM의 임시 공식(시연용 가정이다. 기준 출처 · 담당자 없음 — OPMS의 `margin` 값과 같은 성격):**

```
필요 볼트 길이 = Σ 판 두께 + (와셔 두께 × 볼트당 와셔 수) + 너트 높이(nutHeight) + 2 × 볼트 피치
여유 = 볼트 length − 필요 길이    여유 ≥ 1.0 → 통과 · 0 ≤ 여유 < 1.0 → 조건부 · 여유 < 0 → 실패
```

  예: M8 볼트 길이 30, 판 8 + 8, 와셔 1.6 × 2, 너트 6.8, 피치 1.25 → 필요 16 + 3.2 + 6.8 + 2.5 = **28.5**, 여유 1.5 → 통과. 상판을 12로 바꾸면 32.5, 여유 −2.5 → 실패.
- **요청 내용(판단은 OPMS 몫):**
  1. **규칙을 OPMS에 둘 것인가.** 둔다면 형태 두 가지를 제안한다.
     - **안 A(코드 변경 없음):** PDM이 호출 문맥으로 `clampLength`(판 + 와셔 + 너트 높이 합)를 주고, `fit_check` 규칙 `bolt_length_vs_clamp_length`(`subject: length`, `op: ge`, `against: {context: clampLength}`, `margin: {add: <값>}`, `warn_within: 1.0`)로 비교한다. 단점: 나사 끝 여유가 피치와 무관한 고정값이 된다(M8은 2.5, M12는 3.5 …).
     - **안 B(새 기능):** `margin`에 피치 배수 형식(예: `{times_prop: pitch, factor: 2}`)을 더한다. `fit_check` 코드 변경이라 승인이 필요하다.
  2. **기준 출처와 담당자 지정.** `+2.0` · `2 × 피치` · `경고 1.0`은 시연용 가정이다. 사내 기준(나사 끝이 너트 밖으로 몇 산 나와야 하는지)의 출처와 승인자가 필요하다. 이것이 없으면 PDM 화면은 계속 "기준 미지정"을 표시한다.
  3. **`nutHeight`를 너트의 필수 속성으로 할 것인가.** 지금은 `required: false`(`constraints.yaml:27`)라 값이 비면 그립 판정이 `unknown`(`value_missing`)이 된다. 필수로 바꾸면 이미 등록된 너트가 재검증(`revalidation_impacts`)에 걸릴 수 있으니 영향을 OPMS가 판단해야 한다. 이 PC 개발 DB의 `P-00000000022` · `P-00000000023`에는 `nutHeight` 6.8이 들어 있다(읽기 전용 확인).
  4. **너무 긴 볼트**(나사 끝이 길게 튀어나옴)를 판정에 넣을지. PDM은 지금 판정하지 않고 정보로만 보인다.
- **OPMS가 하지 않아도 되는 것 / PDM이 이미 하는 것:** 판 두께는 OPMS 속성이 아니라 PDM이 CAD 분석 · 사람 확정으로 갖는다. 와셔 두께(`Washer.thickness`)와 너트 높이는 OPMS `:Part`에서 읽는다. 합산은 PDM이 한다(안 A).
- **수용 기준:** 위 예시 두 값(28.5 통과, 32.5 실패)을 OPMS 판정이 내놓고, 값이 비면 `unknown` · `value_missing`, 입력이 CAD 추정이면 한 단계 낮춘다(`fit-check-plan`의 기존 결정과 같은 방향).
- **PDM이 받아들일 대안:** OPMS가 "기준이 없어 규칙을 두지 않는다"로 정하면 PDM은 참고 판정을 계속하고 내보내기 · 화면에 "OPMS 규칙 아님 · 기준 미지정"을 표기한다.
- **우선순위 · 일정 영향:** 중. 안 A는 YAML 규칙 하나와 시험이면 끝나지만 온톨로지 버전이 올라가고, `nutHeight` 필수화는 기존 부품 재검증 영향을 본다.

## 3. 요청 3: `strengthGrade` 순서 비교

- **필요한 이유:** 볼트 강도보다 낮은 너트를 쓰면 안 되는 경우가 있어 변경 영향 분석에서 짝의 강도 조합을 보고 싶다. 지금은 `strengthGrade`가 **문자열이고 순서가 없어서** PDM은 값이 다르면 판정하지 않고 "검토 필요"로만 보인다.
- **OPMS에서 확인한 사실:** `CR-NEXT-mating-rules.md` 8절(228행 부근): 강도 등급은 "문자열이고 순서가 정의돼 있지 않다(8.8 < 10.9 < 12.9, A2-70 < A4-80, **두 체계는 서로 비교 불가**). 지금은 `confirm`으로 '다르면 확인'만 한다"고 했고, 볼트–너트 강도 짝은 "같음이 아니라 순서 관계라 `mates_with`로 못 쓴다. … 보류"로 남겼다. 속성은 `properties.yaml:16 strengthGrade`(string)이고 `Nut` 필수(`constraints.yaml:26`)이다.
- **요청 내용(판단은 OPMS 몫, 후보만 제시):**
  - **후보 1:** 강도 등급을 개념 체계(`scheme`)로 만들고 체계마다 순위를 둔다(`ISO898_8.8 < 10.9 < 12.9`, `A2 < A4` 등). 체계가 다른 값끼리는 `unknown`.
  - **후보 2:** 새 규칙 유형(예: `min_grade`)로 "너트 등급 ≥ 볼트 등급"을 판정한다. 너트는 숫자만 있는 등급(데이터에 `"10"` 같은 값이 있다)이 있어 **볼트 등급 ↔ 너트 등급 대응표**가 먼저 필요하다. 대응표의 출처는 OPMS가 정해야 하고 PDM은 정하지 않는다.
  - **후보 3:** 하지 않는다.
- **OPMS가 하지 않아도 되는 것 / PDM이 이미 하는 것:** PDM은 **값 표로 임시 순서를 만들지 않는다**(8.8 < 10.9 같은 표를 PDM이 정하면 OPMS 몫을 침범한다). 두 값이 다르면 `review`("강도 등급 조합은 사람이 확인")만 남긴다.
- **수용 기준:** 같은 체계의 두 값은 비교되고, 체계가 다르거나 값이 없으면 `unknown`이다. 결과에 어느 규칙 · 어느 온톨로지 버전인지가 붙는다.
- **PDM이 받아들일 대안:** 후보 3(하지 않음). PDM은 "검토 필요"를 유지한다.
- **우선순위 · 일정 영향:** 낮음. 새 규칙 유형이면 코드 변경이라 승인이 필요하다.

## 4. 요청 4: PDM 서버용 읽기 경로 · 온톨로지 변경 알림

- **필요한 이유:** PDM 백엔드는 지금 OPMS의 Neo4j를 **읽기 모드로만 직접** 읽는다(`:OntologyVersion {current:true}.snapshot`과 `(:Part)-[:INSTANCE_OF]->(:Class)` 등). OPMS API는 로그인이 필요하고 PDM이 OPMS 계정을 만들 수 없기 때문이다. 직접 읽기는 스냅샷 구조에 PDM이 기대는 것이라 OPMS가 구조를 바꾸면 깨진다. Community 에디션이라 읽기 전용 DB 계정도 없어 PDM 코드가 쓰기를 하지 않도록 지킨다.
- **OPMS에서 확인한 사실:**
  - `/api/v1` 전체가 로그인을 요구하고 공개 경로는 `GET /api/health`와 `/api/auth/*`뿐이다(`api/auth_guard.py:3`, `KAN-124-auth.md:18-22`). 계정은 `registry auth add-user`로만 만들고 가입은 없으며, 세션은 쿠키(`opms_session`)다.
  - `AUTH_DISABLED`는 개발 PC의 루프백 요청에만 적용된다(`KAN-124-auth.md:27`). 바깥 주소에서 부르려면 Host · Origin 검사(`BUG-006`, `api/guards.py`)도 맞아야 한다.
  - 온톨로지 버전 열람은 A-29 ~ A-32가 있다(`routes_ontology.py:37-66`). 그러나 `revalidation_impacts`(`diff.py:263`)의 결과를 **나중에 조회할 방법은 확인하지 못했다**(sync 때 보고로 나오는 것으로 읽었다 — 미확인).
- **요청 내용(판단은 OPMS 몫):**
  1. PDM 서버가 읽기 전용으로 쓸 수 있는 **서비스 계정 · 읽기 전용 토큰** 중 어떤 것이 가능한가. 현재 로그인 방식에서 읽기 전용 역할이 있는지 알려 달라(`AuthUser.role`의 값 목록은 확인하지 못했다).
  2. 온톨로지 버전이 바뀐 것을 PDM이 알 방법: A-29를 주기적으로 읽어도 되는가, 변경 알림(웹훅 등)이 있는가.
  3. `revalidation_impacts`(어떤 `:Part`가 새 규칙으로 error가 되었는가)를 **조회 가능하게** 보관 · 노출할 수 있는가. PDM은 "온톨로지가 바뀌었을 때 어떤 체결 판정이 바뀌는지"를 보고로만 보이려 한다(부품 개정으로 취급하지 않는다).
  4. 스냅샷 JSON의 구조(`classes · properties · rules · relations …`)가 PDM이 의존해도 되는 계약인가. 아니면 A-31 응답을 계약으로 삼을지.
- **OPMS가 하지 않아도 되는 것 / PDM이 이미 하는 것:** PDM은 OPMS에 **쓰지 않는다**(허용 목록 코드로 강제, OPMS 라벨 `Class` `Part` `Concept` `Rule` …에는 쓰지 않는다). 지금은 직접 읽기로 동작한다.
- **수용 기준:** PDM 서버가 인증된 읽기 전용 경로로 `part_no` → 값 · 분류와 온톨로지 스냅샷 · 버전을 읽고, 직접 Neo4j 접속 설정(`PDM_NEO4J_*`)을 지울 수 있다.
- **PDM이 받아들일 대안:** 직접 읽기 유지(스냅샷 구조 변경 시 OPMS가 PDM에 알려 주는 조건). 이 경우 PDM은 스냅샷 키 존재를 시작할 때 검사해 깨지면 "OPMS 연결 안 됨"으로 표시한다.
- **우선순위 · 일정 영향:** 중. 인증 정책은 OPMS 보안 설계(KAN-124)에 걸린다.

## 5. 요청 5: 부품 개정(`:PartRevision`) 계획과 "무엇이 새 품번인가" 합의

- **필요한 이유:** PDM 설계 변경에서 가장 먼저 가르는 것이 "이 변경은 **같은 품번의 개정**인가, **다른 품번(교체)** 인가"다. OPMS에서 이 경계가 정해져 있어야 PDM이 BOM 줄을 올바르게 바꾸고 새 품번을 요구할지 정한다.
- **OPMS에서 확인한 사실:**
  - `:PartRevision`은 **설계만 있고 코드는 없다**. `docs/PRD.md:205`(확장 기능: "등록 후 속성 변경 흐름과 품번별 변경 이력(`:PartRevision`)"), `:2932`: `(:Part)-[:HAS_REVISION]->(:PartRevision {key:"<part_no>#<rev>", before, after, changed_props, …})`, `:Part`는 현재 값과 `rev`를 가진다.
  - 그 설계는 **같은 품번의 속성 값을 바꾸는 것**(`before` → `after`)을 개정으로 본다. 즉 길이나 재질이 같은 `part_no` 안에서 바뀔 수 있다.
- **PDM의 현재 가정(OPMS 설계와 충돌 가능 — 합의 필요):** PDM은 **식별 속성**(`threadSize` `length` `pitch` `material` `strengthGrade`와 분류)이 바뀌면 **다른 품번(교체)**, 같은 품번 안의 도면 · 공차 · 검사 조건 변경은 **개정**으로 본다. 이유: OPMS가 부품을 규격으로 구분하고(`blocking_key`, 예 `Bolt|threadSize=M8`) 중복 검사를 하기 때문이다. 그러나 OPMS의 `:PartRevision` 설계는 같은 `part_no`에서 값 변경을 허용하는 쪽으로 읽힌다.
- **요청 내용(판단은 OPMS 몫):**
  1. **식별 속성 목록 합의.** 어떤 속성이 바뀌면 새 품번이고 어떤 것은 같은 품번의 개정인가? PDM 초안은 위 5개 + 분류다. OPMS가 다르게 정하면 PDM은 그 목록을 읽어 따른다.
  2. `:PartRevision` 구현 계획과 시기. 구현되면 PDM `ItemRevision`과의 역할 분담(아래)을 확인하고 싶다.
  3. 이름 충돌 방지. PDM은 OPMS의 미구현 라벨(`:PartRevision` `:ProductRevision` `:BomLine` `:Product`)을 **쓰지 않고** 자기 라벨(`ItemRevision` `CONTAINS` `ProductModel` 등)을 쓴다. `HAS_REVISION` 관계 이름은 PDM `(:PdmItem)-[:HAS_REVISION]->(:ItemRevision)`과 OPMS 설계 `(:Part)-[:HAS_REVISION]->(:PartRevision)`가 출발 라벨이 달라 공존하는데, 같은 이름이 헷갈리지 않는지 확인 부탁한다. PDM은 `:Part.rev`를 읽지도 쓰지도 않는다.
  4. **온톨로지 버전은 부품 개정이 아니다.** 이 구분이 OPMS 쪽에서도 같은지(온톨로지 버전 변경으로 `:Part`에 개정이 자동으로 생기지 않는다는 `revalidation_impacts` 보고 전용 원칙과 일치하는지) 확인 부탁한다.
- **OPMS가 하지 않아도 되는 것 / PDM이 이미 하는 것:** BOM · 발주 · 작업지시 · 재고는 OPMS 범위 밖으로 알고 있다(`docs/PRD.md:220`: "설계 변경(형상 · 도면 개정), 발주 · 재고는 과제 전체에서 범위 밖이다"; 같은 PRD 2946행은 BOM · 제품 속성 변경도 개정 노드(`:ProductRevision`) 방식으로 보고 "설계 변경 관리(ECO · 도면 개정)"는 범위 밖으로 둔다). PDM이 자기 `ItemRevision`과 BOM을 갖고 `(:PdmItem)-[:OF_PART]->(:Part)`로 품번을 참조한다. OPMS는 아무것도 바꿀 필요가 없다.
- **수용 기준:** 식별 속성 목록이 양쪽 문서에 같은 표로 적히고, "새 품번이 필요한 변경"의 정의가 한 곳에 있다.
- **PDM이 받아들일 대안:** OPMS가 "같은 품번에서 값 변경을 개정으로 허용"하는 쪽으로 정하면, PDM은 규격 변경도 `:PartRevision`에 위임하고 자기 `ItemRevision`은 도면 · BOM 개정에만 쓰도록 모델을 고친다(PDM 문서 개정 필요).
- **우선순위 · 일정 영향:** **높음(방향 합의).** 구현은 중장기여도 이 합의가 없으면 PDM의 변경 종류(교체 · 개정) 분기가 OPMS와 어긋날 수 있다.

## 6. 요청 6: 판 · 조립품처럼 `:Part`가 없는 품목

- **필요한 이유:** `BRK-M8`의 상판 · 하판 브래킷(가공품)과 체결 세트 · 모듈(조립품)은 OPMS에 부품이 없다. PDM 그래프 검사 `item_one_part`는 모든 품목이 `:Part` 하나에 붙어야 한다고 보는데, 이 품목들은 붙을 `:Part`가 없다.
- **OPMS에서 확인한 사실:**
  - `Assembly`(조립품)와 하위 `JointModule`은 클래스로 있다(`classes.yaml:173-178`). 판 · 브래킷 같은 가공품 클래스는 없다. `Washer.thickness`(`properties.yaml:22`)처럼 두께 속성은 있으나 판재 분류에서 쓰지 않는다.
  - 신규 품번은 `record_origin='pdm'` 입구 없이 기존 검토 경로(A-01 ~ A-10)로 받기로 했고(`CR-NEXT-parts-match-api.md:13`), **그 경로 자체가 현재 보류**다(`:3`). `:Part.record_origin` 값은 `review · seed · import`(`contracts.py:43`).
- **요청 내용(판단은 OPMS 몫):** 낮은 우선순위의 방향 문의다.
  1. 조립품 · 가공품을 OPMS 부품으로 등록하는 것이 OPMS 범위에 들어가는가. 들어간다면 `Assembly` 아래에 쓸 수 있는지, 판재 가공품 클래스(예 `Plate`: 필수 `thickness` `material`)가 필요한지.
  2. 범위 밖이라면 "OPMS에 없는 품목은 PDM이 `:Part` 없이 품목으로만 둔다"는 PDM의 처리를 OPMS가 받아들이는지.
- **OPMS가 하지 않아도 되는 것 / PDM이 이미 하는 것:** PDM은 이 품목에 OPMS 품번을 **발급하지 않고** 화면에 "OPMS 미등록"으로 표시한다. PDM의 `item_one_part` 검사를 이 품목에 한해 완화한다(PDM 쪽 결정, `change-impact-design.md` 10.3-1). 신규 부품 등록 요청은 PDM에서 삭제된 기능이라 보내지 않는다.
- **수용 기준:** "OPMS에 등록할 것인가 / PDM 품목만 둘 것인가"가 한 줄로 정해진다.
- **PDM이 받아들일 대안:** 둘 다 가능하다. 지금은 PDM 품목만 두는 안으로 진행한다.
- **우선순위 · 일정 영향:** 낮음. 등록 경로가 보류라 답이 늦어도 PDM은 막히지 않는다.

## 7. 요청하지 않는 것과 이유

| 항목 | 이유 |
|---|---|
| OPMS에 PO · 작업지시 · 재고 · 변경 요청 객체를 만드는 것 | 이 데이터는 ERP · MES 소유다. PDM이 읽기 사본으로 받는다. OPMS가 갖지 않아도 된다 |
| `strengthGrade` 순서표를 PDM이 정하는 것 | OPMS 몫이다(요청 3) |
| 대체(`substitutes`) 판정 API | 이번 요청 범위 밖. 규칙은 이미 있다(`rules.yaml:99-143`) |
| 신규 품번 발급 · 등록 요청 입구 | 이미 "만들지 않는다"로 정해진 것을 뒤집지 않는다(`CR-NEXT-parts-match-api.md:13`) |
| `POST /parts/match` | 보류 상태이고 이 요청과 용도가 다르다(중복 부품 찾기) |

## 8. PDM이 하는 일 (OPMS가 알아야 할 부분)

1. OPMS 스냅샷 · `:Part`를 **읽기 모드로만** 읽는다(`onto_pdm.opms`, 쓰기 금지를 코드로 강제). PDM은 OPMS 라벨에 쓰지 않고 자기 라벨(`PdmItem` `ItemRevision` `ProductModel` `PartIdentifier` `MaterialProfile`, 이번에 `ChangeOrder` 등 변경 객체)에만 쓴다. `:Part`에는 라벨도 속성도 달지 않는다.
2. 변경 영향 분석에서 OPMS 값으로 **판정을 읽는다**: 짝(요청 1), 그립 길이(요청 2), 강도(요청 3). OPMS가 주지 않는 판정은 PDM이 **임시 · 참고**로 계산하고 화면 · 내보내기에 `temporary`로 표시한다. 임시 판정이 OPMS 판정과 같은 것으로 읽히지 않게 한다.
3. 입력이 CAD 추정값이면 판정을 한 단계 낮추고 "추정"을 표시한다. PDM은 OPMS 판정을 바꾸거나 다시 계산하지 않는다는 원칙을 유지한다(`fit-check-plan.md`).
4. 온톨로지 버전이 바뀌면 PDM이 승인 BOM의 체결 판정을 새 스냅샷으로 다시 계산해 **보고(`OntologyImpact`)** 만 만든다. 부품 개정이나 변경 요청을 자동으로 만들지 않는다.
5. 시연용 데이터는 시험 픽스처로만 쓰고 화면에는 가짜 데이터를 넣지 않는다.

### 이 PC에서 읽기 전용으로 확인한 값 (2026-11-12, OPMS 개발 DB, 온톨로지 0.19.0)

| 확인한 것 | 값 |
|---|---|
| 스냅샷 `rules` | `bolt_nut` `bolt_washer` `nut_washer` `bolt_length_vs_hole_depth`와 `substitutes` 규칙들이 있다 |
| `P-00000000001` | HexBolt, M8, 길이 30, 피치 1.25, A2-70, SUS304 |
| `P-00000000022` | HexNut, M8, 피치 1.25, `nutHeight` 6.8, A4-80, SUS316 |
| `P-00000000023` | HexNut, M8, 피치 **1.0**, `nutHeight` 6.8, A2-70, SUS304 |
| `P-00000000025` | FlatWasher, M8, 두께 1.6, 외경 16, 내경 8.4, SUS304 |

## 9. OPMS에 확인하고 싶은 것

OPMS 쪽 담당자는 **아직 확인하지 못했다.** 팀 저장소라 적용은 별도 브랜치 · PR이 필요하다. 아래는 전달할 때 함께 물어볼 질문이다.

| # | 질문 | PDM의 기본 가정 |
|---|---|---|
| Q1 | 짝 판정을 읽기 전용 엔드포인트로 낼 의향이 있는가(요청 1). 결정 5의 "같은 API로 내지 않는다"는 `fit/judge`에 섞지 않는다는 뜻인가 | 별도 엔드포인트는 가능하다고 읽는다 |
| Q2 | 관통 체결 그립 길이를 OPMS 규칙으로 둘 것인가. 기준 출처와 승인자는(요청 2) | 규칙이 없으면 PDM 참고 판정으로 계속한다 |
| Q3 | `Nut.nutHeight`를 필수로 바꿔도 기존 `:Part` 재검증에 문제가 없는가 | 선택으로 두고 값이 없으면 `unknown`으로 둔다 |
| Q4 | `strengthGrade` 순서를 정할 의향이 있는가. 있다면 어느 후보인가(요청 3) | 하지 않는다. "검토 필요"로 둔다 |
| Q5 | PDM 서버용 읽기 전용 서비스 계정 · 토큰이 가능한가, 온톨로지 버전 변경을 알릴 방법은(요청 4) | 직접 Neo4j 읽기 유지 |
| Q6 | `revalidation_impacts`의 결과를 나중에 조회할 수 있는가(요청 4) | 조회할 수 없다고 보고 PDM이 새 스냅샷으로 재계산한다 |
| Q7 | **식별 속성 목록**(`threadSize length pitch material strengthGrade` + 분류)이 맞는가. 같은 `part_no`에서 값 변경을 개정으로 허용할 계획인가(요청 5) | 식별 속성 변경은 새 품번 |
| Q8 | 조립품 · 가공품을 OPMS에 등록하는 것이 범위에 들어가는가(요청 6) | 범위 밖. PDM 품목만 둔다 |

## 10. PDM 쪽 일정 (OPMS 응답과 무관하게 먼저 하는 것)

- 영향 탐색 엔진 · 임시 판정(짝 · 그립 길이 · 강도 "검토 필요")은 이미 구현됐다(`backend/src/onto_pdm/changes/`). 모든 판정에 `temporary` · 규칙 id · 온톨로지 버전을 남긴다.
- 응답이 오면: 요청 1이 열리면 임시 짝 판정 코드를 OPMS 호출로 교체하고, 요청 2가 규칙이 되면 "PDM 참고" 표시를 걷고 OPMS 판정을 쓴다. 요청 5의 합의가 나오면 변경 종류(교체 · 개정) 분기 기준을 그 목록으로 맞춘다.
- OPMS 응답을 기다리지 않는다. 6건 모두 없어도 첫 시연(`BRK-M8`)은 가능하다.
