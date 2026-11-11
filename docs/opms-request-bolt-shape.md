# OPMS 요청서(초안): CAD 형상으로 볼트 종류를 판단하기 위한 온톨로지

- 상태: **초안(OPMS 팀 검토 전)**. 이 저장소(Onto PDM)는 OPMS `ontology/`·코드를 바꾸지 않는다. 적용은 OPMS 온톨로지 관리자 몫이다.
- 기준: **OPMS 저장소의 `PDM` 브랜치**(커밋 `212430c`, origin/main 병합본, 온톨로지 0.15.0). 아래 OPMS 문서·YAML은 모두 이 브랜치에서 읽었다.
- 작성: 2026-11-11. 근거로 읽은 OPMS 문서(읽기 전용, `D:\ernest_hemingway_OPMS`): `docs/changes/CR-NEXT-head-type-ontology.md`, `docs/changes/onto-pdm-merge/socket-head-bolt-class.md`, `docs/changes/CR-NEXT-onto-pdm-merge-prep.md`, `ontology/*.yaml`.
- 원칙(사용자 결정 11/11): **온톨로지는 OPMS가 소유하고 PDM은 읽기만 한다.** PDM은 CAD에서 잰 값과 분류 후보를 보내고, 새 클래스·값이 필요하면 이 요청서로 부탁한다.

## 0. 먼저 알아야 할 것: OPMS에 이미 있는 것

새 분류 체계를 통째로 요청하는 것이 아니다. 이미 아래가 있어서 **이 설계에 얹는 요청**이다.

| 이미 있는 것 | 상태 |
|---|---|
| `Bolt` 아래 `HexBolt`, `HexFlangeBolt`, `HandTightBolt > WingBolt` | 적용됨 |
| `SocketHeadBolt`(육각구멍붙이볼트) + 속성 `socketSize` | 복사본·`ontology/`에 적용(0.15.0), **커밋·sync 전** |
| `threadSize`, `length`, `pitch`, `threadDirection`, `strengthGrade`, `material`, `surfaceTreatment` | 적용됨 |
| `threadSize`의 `^N mm$` → `M{N}`(추정) 변환 규칙 | 적용됨. CAD에서 잰 나사 지름 "8 mm"를 `M8`(추정)로 받을 수 있다 |
| **`CR-NEXT-head-type-ontology`**: 머리 모양을 개념 속성 `headType`으로 두고 클래스가 값을 `fixed`로 고정해 형제를 구분 | **초안(승인 전)**. 코드 단위 U1~U8과 온톨로지 내용(U9)이 남아 있다 |

CAD 형상으로 볼트 종류를 가르려면 "머리 모양"이 값으로 있어야 하는데, 그 자리가 바로 `headType`이다. 그래서 **핵심 요청은 이 CR의 승인·진행**이고, 아래 요청 1~3은 그 위에 얹는 작은 추가다.

## 1. 요청 1 (핵심): `CR-NEXT-head-type-ontology` 승인과 값 목록 확정

- 필요한 이유: 지금 형제 리프는 "서로 다른 구분 속성의 **존재**"로만 구분된다. 소켓·버튼·접시 머리는 속성 집합이 같아서(모두 육각구멍을 가진다) 클래스를 더 만들면 W4/L5로 걸린다. CAD에서는 머리 윤곽으로 이 셋을 구분하므로 값(`headType`)이 필요하다.
- PDM이 CAD에서 구분할 수 있는 값은 CR 초안 4.9절 목록 중 다음이다.

| `headType` 값 | CAD에서 보이는 모양 | 비고 |
|---|---|---|
| `Hex` | 단면이 육각형, 구동부 없음 | 기존 `HexBolt` |
| `HexFlange` | 육각 머리 아래 원형 플랜지 | 기존 `HexFlangeBolt` |
| `Socket` | 원통 머리, 윗면에 육각 구멍 | `SocketHeadBolt` |
| `Button` | 낮은 돔형 머리, 육각 구멍 | |
| `Countersunk` | 90° 원뿔 머리(윗면이 평평), 육각 구멍 | |
| `Carriage`, `Eye`, `U`, `Anchor` | 가능하나 볼트 외 형상까지 섞인다 | 지금은 CAD 분류 대상에서 제외 |

- 확인 부탁(CR의 Q2와 겹침): 위 값 이름을 그대로 쓰는가. 구동부가 같은 `Socket`·`Button`·`Countersunk`가 머리 윤곽만 다른 값이라는 점이 맞는가.
- PDM 쪽 예의: CR이 승인되기 전에는 PDM이 `headType`을 후보 값으로만 표시하고 OPMS에 쓰지 않는다.

## 2. 요청 2: 새 볼트 클래스 2개 (요청 1 이후에만 가능)

CR 적용 뒤 `ontology/`에 더할 초안이다. **요청 1 없이는 `SocketHeadBolt`와 구분 속성이 같아 W4/L5가 난다**(같은 `own_distinguishing`=[socketSize]).

```yaml
### classes.yaml
  ButtonHeadBolt:
    parent: Bolt
    label: {ko: 버튼헤드볼트, en: Button head cap screw}
    definition: 낮은 돔형 머리에 육각 구멍이 있어 육각 렌치로 조이는 볼트
    distinguishing_properties: [socketSize]
  CountersunkHeadBolt:
    parent: Bolt
    label: {ko: 접시머리볼트, en: Countersunk head cap screw}
    definition: 윗면이 평평한 90도 원뿔 머리에 육각 구멍이 있어 체결면에 묻히는 볼트
    distinguishing_properties: [socketSize]

### constraints.yaml   (요청 1이 적용된 뒤)
  SocketHeadBolt:
    headType:         {fixed: Socket}
  ButtonHeadBolt:
    headType:         {fixed: Button}
    strengthGrade:    {required: true}
    socketSize:       {required: true, min: 1.5}
  CountersunkHeadBolt:
    headType:         {fixed: Countersunk}
    strengthGrade:    {required: true}
    socketSize:       {required: true, min: 1.5}

### vocab/terms.csv
class,ButtonHeadBolt,버튼헤드볼트,ko
class,ButtonHeadBolt,버튼 렌치볼트,ko
class,ButtonHeadBolt,Button head cap screw,en
class,ButtonHeadBolt,BUTTON HEAD SCREW,en
class,CountersunkHeadBolt,접시머리볼트,ko
class,CountersunkHeadBolt,접시 렌치볼트,ko
class,CountersunkHeadBolt,Countersunk head cap screw,en
class,CountersunkHeadBolt,FLAT HEAD CAP SCREW,en
```

- 알림 하나: `socket-head-bolt-class.md`는 컨트롤러 CAD의 `FLAT HEAD CAP SCREW M3*6`을 소켓 헤드 볼트의 근거로 든다. 그런데 "flat head cap screw"는 보통 **접시머리(Countersunk)** 를 뜻한다. 그 부품이 어느 쪽인지는 CAD 형상으로 확인해야 하고, 위 표기 행(`FLAT HEAD CAP SCREW`)을 `CountersunkHeadBolt`에 거는 것이 맞는지 OPMS 쪽에서 봐 주길 부탁한다.
- CR 초안 4.9절의 이름은 `HexSocketBolt`, 이미 적용된 이름은 `SocketHeadBolt`다. **이미 적용된 `SocketHeadBolt`를 쓰고** CR 문서의 예시 이름을 맞춰 주길 부탁한다.

## 3. 요청 3 (후속, 요청 1 이후): 구동부 `driveType`

CAD에서는 머리 윗면의 오목한 모양으로 구동부를 읽을 수 있다. CR은 구동부를 비목표로 두었으므로 **후속 CR로** 요청한다.

- 속성: `driveType`(개념, 체계 `drive_type`), `Bolt`에 `required: false`
- 값 초안: `HexSocket`(육각 구멍), `Torx`(별 구멍), `Phillips`(십자), `Slotted`(일자), `ExternalHex`(외육각, 구멍 없음)
- 쓰임: 같은 `headType`이라도 구동부가 다르면 다른 부품이다(예: 팬헤드 십자 vs 팬헤드 별). 지금 목록에는 팬헤드가 없어 클래스 추가는 요청하지 않고, 값만 먼저 합의하길 부탁한다.
- 우선순위는 낮다. 요청 1~2가 되면 CAD 볼트 대부분(육각볼트·소켓·버튼·접시)이 분류된다.

## 4. 요청하지 않는 것과 이유

| 항목 | 이유 |
|---|---|
| **형상 판정 비율표**(머리 지름/나사 지름 등)를 OPMS 규칙으로 넣는 것 | OPMS 온톨로지에는 기하 조건을 표현하는 규칙 유형이 없다. 새 규칙 유형은 코드 변경(승인 사항)이다. 아래 5절처럼 **PDM 쪽 분류기 설정으로 두고**, 정말 OPMS에 두고 싶으면 별도 CR로 논의한다 |
| `headDiameter`, `headHeight` 속성 | 사양서에서 추출할 속성이 아니라 CAD 측정 근거다. `extract`가 모든 유효 속성을 LLM에 묻기 때문에 `Bolt`에 두면 사양서 추출 비용만 늘어난다. PDM이 근거로만 보관한다 |
| 강도 등급·재질·도금·피치(CAD 형상으로 알 수 없음) | 사양서·BOM에서 온다. 피치는 `threadSize`로 OPMS가 보통 나사 값을 채운다(CAD의 나사산이 있으면 근거로 추가) |
| `Welded` 등 공정 어휘 | 이 요청과 무관 |

## 5. PDM이 하는 일(OPMS가 알아야 할 부분)

1. CAD 부품에서 형상 특징을 뽑는다: 축 방향 지름·길이, 머리 윤곽(육각·원통·돔·원뿔·플랜지), 머리 윗면 오목부(육각구멍 크기 포함), 나사부 비율.
2. **OPMS의 현재 클래스와 `headType` 값을 읽어** 후보를 정한다. OPMS에 없는 클래스는 만들어 쓰지 않고 "OPMS 미등록 후보(제안)"로만 표시한다.
3. 속성 값은 근거·추정 표시와 함께 후보로 만든다(`threadSize`: "8 mm"→`M8` 추정, `length`, `socketSize`, `headType`). 사람이 확정한 뒤에만 등록 요청에 싣는다.
4. 등록 요청은 PDM→OPMS로 보내며, 클래스를 못 정한 부품은 `headType`·`driveType` 후보와 근거를 함께 보내 OPMS의 분류 제안 흐름이 쓰게 한다.
5. PDM의 형상 판정 비율표는 **정본이 아니라 분류기 설정**이다. 형식을 OPMS YAML과 비슷하게 두어 나중에 옮기기 쉽게 하고, 값은 표준 표로 검증하기 전에는 참고치로 표시한다.

### 참고: 머리 윤곽 비율(대략, 표준 표로 검증 필요)

| 계열(규격 예) | 머리 지름/나사 지름 d | 머리 높이/d | 구동부 |
|---|---|---|---|
| 육각볼트(ISO 4014·4017) | 대변 약 1.6~1.7 | 약 0.65 | 없음(외육각) |
| 소켓(ISO 4762) | 약 1.5~1.85 | 약 1.0 | 육각 구멍 |
| 버튼(ISO 7380) | 약 1.75~1.9 | 약 0.55 | 육각 구멍 |
| 접시(ISO 10642) | 약 1.9~2.45 (M8 이론 치수 17.92 mm = 2.24d) | 접시 90° | 육각 구멍 |

## 6. OPMS에 확인하고 싶은 것

| # | 질문 | PDM의 기본 가정 |
|---|---|---|
| Q1 | `CR-NEXT-head-type-ontology`를 진행하는가. 진행한다면 대략 언제 `ontology/`에 들어가는가 | 진행한다. 그 전에는 PDM이 `headType`을 로컬 후보 값으로만 쓴다 |
| Q2 | 값 이름(`Hex`·`HexFlange`·`Socket`·`Button`·`Countersunk`)과 요청 2의 클래스 이름·정의를 승인하는가 | 승인 |
| Q3 | 컨트롤러 CAD의 `FLAT HEAD CAP SCREW M3*6`은 소켓인가 접시인가 | 접시머리(`Countersunk`)로 보고 형상으로 확인한다. **(11/12 확인)** 이 PC 의 컨트롤러 STEP(`Controller HCP2 R00 3D(A Seires).stp`)에는 그 문자열이 없고, 47개 부품을 형상으로 분류해도 볼트가 없었다(손잡이 · 팬 가드 · 고무 · 커넥터 등). 그 부품은 이 STEP 에 없는 다른 파일일 수 있다 |
| Q4 | PDM이 OPMS의 클래스·`fixed` 값을 읽는 길은 무엇인가(OPMS API vs `:OntologyVersion.snapshot` JSON을 Neo4j에서 직접 읽기). 읽기 전용 계정은 Community에서 만들 수 없다 | 가능하면 OPMS API로 읽고, 스냅샷을 PDM에 캐시한다 |
| Q5 | 요청 3(`driveType`)을 별도 CR로 받을 의향이 있는가 | 후속 |
| Q6 | PDM이 보낸 CAD 근거(형상 측정값·추정 표시)를 등록 요청의 evidence로 받아 줄 수 있는가 | 가능하면 받아서 검토 화면에 보여 준다 |

## 7. PDM 쪽 일정(OPMS 승인과 무관하게 먼저 하는 것)

- 분류기: 머리 윤곽·구동부·치수 판정, 결과는 위 OPMS 클래스 이름으로 후보로만 표시(미등록은 "제안" 표시).
- 시험용 볼트 5종(육각·소켓·버튼·접시·플랜지) 형상으로 정확도 확인.
- OPMS 승인 후: 로컬 임시 규칙을 지우고 OPMS에서 읽도록 교체.
