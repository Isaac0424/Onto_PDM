# 조립 규칙 · 작업표준서 (출처가 있는 내용)

PDM 이 가지는 **조립 규칙과 작업표준서의 내용**을 `rules/` 에 YAML 로 작성했다. 이전의 가짜(목업, '온토전자') 규칙은 모두 지웠고, 이번 내용은 **근거를 댈 수 있는 것만** 담았다.
근거는 한화로보틱스 **HCR-2G(HCR-A Series) 사용설명서 V2.2**(KR · EN)와 **HCR-3A · 5A · 12A · 컨트롤러 STEP** 이고, 근거가 없는 값은 **비워 두고 공백 목록**(`rules/gaps.yaml`)에 적었다.
설계 구조는 [assembly-rules-spec.md](assembly-rules-spec.md) 4장(Operation · AssemblyRule · Condition · Parameter · Caution · Tool)을 따른다. 상태는 모두 `unreviewed`(작성만 됨, 사람이 검토하지 않음)다.

## 1. 가장 먼저 알아둘 것

- **사용설명서는 "설치 · 운영 설명서"다. 공장에서 로봇 암 본체를 조립하는 절차는 어디에도 없다.** 그래서 작업표준서는 **설치 · 점검 작업**(사용설명서 3 · 7 · 15장)에 대해서만 절차를 썼다.
  본체 조립은 STEP 조립 계층에서 "어느 조립품에 어떤 부품이 몇 개"(구조)만 옮겼고, 순서 · 토크 · 공구 · 시간은 **쓰지 않았다**(공백 G-005).
- **용접 · 압입은 근거가 없어 만들지 않았다.** 이 로봇 자료에서 '용접'은 사용 환경 주의(전자기 방출이 높은 곳에서 사용 금지, 2.3 p.40)뿐이다(OPMS 문서 12장과 같은 결론).
  `operations.yaml` 의 `not_covered` 에 이유와 함께 적었다.
- **작업 시간(표준 시간)은 모두 비웠다.** 근거 자료가 전혀 없다(G-006).
- **일반 체결 토크 표준값은 쓰지 않았다.** ISO 898-1 강도 등급과 마찰 조건에 따라 달라지는 값이라 단일 숫자를 확정값처럼 적지 않았고, 원문을 확인할 수 없어 `standard` 등급은 한 건도 쓰지 않았다(G-016).
- **M6 볼트의 30 N·m 는 "HCR-3A 로봇 암 베이스 고정"에만 해당한다.** 같은 M6 인 툴 고정 볼트에는 토크 근거가 없다. 그래서 규칙은 나사 규격만이 아니라 **부품이 하는 일(`context.role`)** 로 나눴다(AR-FAS-001 대 AR-FAS-004).

## 2. 파일

| 파일 | 내용 |
|---|---|
| `rules/sources.yaml` | 출처 등급 4가지와 출처 문서 목록(사용설명서 KR · EN, STEP 4개, CAD 구조표, 형상 분류기, OPMS 온톨로지) |
| `rules/operations.yaml` | 공정 어휘 18개(설치 · 결합 · 점검 트리)와 **근거 없음** 4개(용접 · 압입 · 컨트롤러 내부 조립 · 영점 설정) |
| `rules/tools.yaml` | 공구 3개(토크 렌치 · 육각 렌치 · 진공 청소기/공기 압축기). 필요하다는 사실만 근거가 있고 규격은 비어 있다 |
| `rules/rules.yaml` | **조립 규칙 23개**. 값 · 주의 문구마다 출처 등급과 쪽 번호 |
| `rules/work-standards.yaml` | **작업표준서 10개**(설치 5 · 점검 3 · CAD 구조 2), 단계 31개, 점검 항목 8건 |
| `rules/gaps.yaml` | 작성이 필요한 공백 19건 |
| `tools/check_rules.py` | 검증 스크립트(독립, PyYAML 만 필요) |
| `rules/tests/test_rules.py` | pytest 32개 |

## 3. 출처 등급

| 등급 | 뜻 | 쓴 개수(값 · 문구 · 항목 단위) |
|---|---|---|
| `manual` | 사용설명서의 수치 · 문구 그대로. 절 · **쪽 번호 필수**(PDF 쪽 = 인쇄 쪽, 총 276쪽) | **170** |
| `cad` | STEP 구조(이름 · 수량 · 계층)와 형상 분류기 결과. 추정이면 `estimated: true` | **36** |
| `unknown` | 근거 없음. `value: null` + `gap` 번호 | **19** (작업 시간 10 · 토크 · 공구 규격 등 9) |
| `standard` | 공개 표준 참고값. 표준 번호 + `approval_required: true`(설계 승인 전 사용 금지) | **0** |

## 4. 사용설명서에서 확정한 수치와 주의 문구

| 내용 | 값 · 문구 | 쪽 | 규칙 |
|---|---|---|---|
| **로봇 암 베이스 고정 볼트 · 토크 · 위치 결정 핀** | HCR-3A **M6 15 mm 30 N·m Φ5** · HCR-5A **M8 15 mm 45 N·m Φ8** · HCR-12A **M12 25 mm 140 N·m Φ5**. 볼트 4개, 위치 결정 핀 2개 | 49 (EN 에서도 같은 값 확인) | AR-FAS-001, AR-LOC-001 |
| 접지 라인 볼트 | M4×10 mm (토크는 없다, G-003) | 49 | AR-FAS-002 |
| 로봇 고정 볼트 커버 | HCR-3A · 5A 에 4개 동봉 | 15, 49 | AR-FAS-003 |
| 툴 고정 | **M6 볼트 4개**, 툴 플랜지 ISO 9409-1-50-4-M6. 볼트 길이 · 토크는 툴 제조사 설명서(G-002) | 50, 260 | AR-FAS-004 |
| 컨트롤러 고정 | **M14 45 mm 이상** 볼트 + 평와셔(토크 없음, G-004) | 55 | AR-FAS-005 |
| 전원 | 100 ~ 240 VAC · 외부 전원 퓨즈 8 ~ 16 A · 50 ~ 60 Hz · 표준 IEC 플러그 | 54 | AR-CON-002 |
| 설치 각도 | 바닥 0° · 벽 90° · 천장 180°. HCR-12A 는 바닥 · 천장만, X · Y ±30° 이내 | 94, 95 | AR-CFG-001 |
| 무게 | 암 13 / 20.8 / 52.5 kg (3A / 5A / 12A), 컨트롤러 17.6 / 17.6 / 19.8 kg | 43 | AR-SIT-003 |
| 점검 | 8항목 · 매일 / 3개월 / 6개월 (15.1 표). 암 · 컨트롤러 검사는 최소 6개월마다 | 229, 230 | AR-MNT-001~003, WS-HCR-MNT-01 |
| 충돌 후 | 120°/sec 이상 속도의 충돌 · 비상정지 뒤 관절 영점 확인 | 44 | AR-MNT-004 |

**주의 · 경고 문구(원문 그대로 규칙의 `cautions[].text`)**

| 표시 | 문구 | 쪽 |
|---|---|---|
| 경고 | 로봇을 고정할 때에는 볼트가 풀리지 않도록 단단히 고정하세요. | 49 |
| 경고 | 로봇의 무게와 로봇이 작동할 때 발생하는 하중을 견딜 수 있는 견고한 면에 설치하세요. | 49 |
| 경고 | 로봇 암의 설치면이 로봇 암의 베이스면과 완전히 밀착되었는지 확인하세요. | 49 |
| 경고 | 로봇에 조립되어 있는 볼트는 절대 임의로 분해하지 마세요. … 볼트 조립부를 이용하여 브라켓 등을 설치할 경우 제품이 파손되거나 안전에 심각한 영향을 미칠 수 있습니다. | 50 (p.49 경고 상자의 연속으로 읽었다) |
| 경고 | 로봇을 대차에 설치했을 경우 로봇을 작동할 때에는 반드시 대차를 지면에 고정해야 합니다. | 48 |
| 경고 | 운송 및 운반 중 제품이 떨어져 파손되지 않도록 주의하십시오. … 파손될 경우 품질 보증에서 제외됩니다. | 43 |
| 경고 | 로봇 암의 베이스가 설치된 바닥면의 기울기와 작업 공간을 시스템이 자동으로 인식하지 못하므로 로봇을 가동하기 전에 … 정확한 값을 입력해야 합니다. | 93 |
| 경고 | TCP 프로파일을 잘못 입력하면 로봇 구동 중에 충돌 및 협착 등이 발생할 수 있으며 … 반드시 정확한 값을 입력해야 합니다. | 96 |
| 경고 | 로봇 설치 각도, 툴 설정, 안전 설정 등의 값이 올바르게 입력되었는지 확인하십시오. | 38 |
| 주의 | 로봇이 켜져 있는 상태에서는 로봇 커넥터, 전원 커넥터, 티칭 펜던트 커넥터 등을 뽑지 마세요. | 54 |
| 주의 | I/O 배선 체결 시 제어기 전원을 끈 후 I/O 커넥터에 사전 배선하여 작업을 하도록 합니다. … 하자보증에서 제외됩니다. | 56 |
| 주의 | HCR-12A 모델은 제어기와 로봇바디의 시리얼 번호가 일치되어야 합니다. … | 14 |
| 주의 | 권장하는 장소에 시스템을 설치하지 않을 경우 로봇의 성능 및 수명이 감소될 수 있습니다. | 47 |
| 주의 | 120°/sec 이상의 속도로 구동 중 충돌 또는 비상정지가 발생하였을 경우 로봇 관절의 영점을 확인하여 … | 44 |

`level` 은 사용설명서의 안전 표시(위험 · 경고 · 주의 · 참고)이고, 표시 없이 본문에 적힌 지시는 `안내`다.

## 5. 조립 규칙 23개

(`근거 쪽` 은 사용설명서 KR V2.2 의 PDF 쪽. 부품에 걸리는 규칙은 OPMS 분류 이름과 부품 역할을 `applies_to` 에 쓰고, 부품이 아닌 규칙은 모델(HCR-3A · 5A · 12A)만 쓴다.)

| 번호 | 이름 | 공정 | 적용 대상 | 출처 등급(항목 수) | 근거 쪽 |
|---|---|---|---|---|---|
| AR-FAS-001 | 로봇 암 베이스 고정 볼트 체결 | BoltFastening | Bolt · robot_base_mount | manual 11 | 49-50, 257 |
| AR-FAS-002 | 접지 라인 볼트(M4×10) 체결 | BoltFastening | Bolt · ground_line | manual 4 · unknown 1 | 49 |
| AR-FAS-003 | 로봇 고정 볼트 커버 덮기 (3A · 5A) | CoverFitting | robot_base_mount | manual 3 · cad 1 | 15, 49 |
| AR-FAS-004 | 툴 고정 볼트(M6) 체결 | BoltFastening | Bolt · tool_mount | manual 7 · unknown 2 | 50, 260 |
| AR-FAS-005 | 컨트롤러 고정 볼트(M14)와 평와셔 | BoltFastening | Bolt, FlatWasher · controller_mount | manual 6 · unknown 1 | 55 |
| AR-FAS-006 | 로봇 암 본체 소켓 헤드 볼트(M3 · M4) 체결 | BoltFastening | SocketHeadBolt · arm_assembly_bolt | cad 1 · unknown 2 | (CAD) |
| AR-SAF-001 | 조립되어 있는 볼트는 분해하지 않는다 | BoltFastening | Bolt | manual 2 | 50 |
| AR-LOC-001 | 위치 결정 핀 2개로 설치 위치 맞추기(선택) | PinLocating | robot_base_mount | manual 6 | 49 |
| AR-CON-001 | 티칭 펜던트 · 로봇 암 케이블 연결과 걸쇠 | ConnectorMating | — | manual 3 | 52-53 |
| AR-CON-002 | 컨트롤러 전원 연결 | ConnectorMating | — | manual 8 | 54 |
| AR-CON-003 | I/O 배선은 전원을 끈 뒤에 | ConnectorMating | — | manual 2 | 56 |
| AR-CON-004 | 툴 고정 후 툴 I/O · EtherCAT 케이블 연결 | ConnectorMating | tool_mount | manual 4 | 50-51, 263 |
| AR-SIT-001 | 설치 장소 권장 조건 | SiteCheck | — | manual 3 | 47 |
| AR-SIT-002 | 설치 유형(바닥 · 벽면 · 천장 · 대차) | SiteCheck | — | manual 6 | 48 |
| AR-SIT-003 | 로봇 암 · 컨트롤러 운반 | Handling | — | manual 6 | 43 |
| AR-CFG-001 | 로봇 설치 각도 설정 | Configuration | — | manual 7 | 93-95 |
| AR-CFG-002 | 툴 장착 후 TCP 설정 | Configuration | tool_mount | manual 3 | 96-97 |
| AR-CFG-003 | HCR-12A 제어기 · 로봇바디 시리얼 일치 확인 | Configuration | — | manual 3 | 14 |
| AR-CFG-004 | 설치 직후 값 확인과 위험성 평가 | Configuration | — | manual 4 | 38, 46 |
| AR-MNT-001 | 점검 항목과 주기 | PeriodicInspection | — | manual 4 | 229 |
| AR-MNT-002 | 로봇 암 확인 및 청소 | Cleaning | — | manual 4 | 230 |
| AR-MNT-003 | 컨트롤러 확인 · 먼지 제거 · 필터 청소 | Cleaning | — | manual 4 | 230, 232 |
| AR-MNT-004 | 빠른 속도의 충돌 · 비상 정지 뒤 영점 확인 | PostCollisionCheck | — | manual 3 | 44 |

OPMS 분류 이름은 모두 OPMS **PDM 브랜치**(`ontology/classes.yaml`, 0.15.0)에 있는 것이다: `Bolt` · `FlatWasher` · `SocketHeadBolt`. OPMS 에 없는 분류(`ButtonHeadBolt` · `CountersunkHeadBolt`)는 이번 규칙에 쓰지 않았다(쓰게 되면 `applies_to.proposed_classes` 에 적고 검증이 "이미 OPMS 에 있으면 경고"를 낸다).
`Bolt` 는 리프가 아니다: 매뉴얼이 로봇 고정 · 툴 고정 · 접지 볼트의 머리 모양 · 강도 등급 · 재질을 말하지 않아 리프 분류로 좁히지 않았다(G-008).

## 6. 작업표준서 10개

| 번호 | 제목 | 모델 | 단계 | 구성 | 출처 | 근거 쪽 |
|---|---|---|---|---|---|---|
| WS-HCR-INS-01 | 설치 장소 · 유형 확인과 운반 | 3A · 5A · 12A | 4 | | manual 5 | 43, 47-48 |
| WS-HCR-INS-02 | 로봇 암 베이스 고정 | 3A · 5A · 12A | 5 | | manual 8 | 49-50 |
| WS-HCR-INS-03 | 툴 장착과 TCP 설정 | 3A · 5A · 12A | 3 | | manual 5 | 50-51, 96-97, 263 |
| WS-HCR-INS-04 | 컨트롤러 고정과 케이블 · 전원 · I/O 연결 | 3A · 5A · 12A | 6 | | manual 8 | 14, 52-56 |
| WS-HCR-INS-05 | 설치 후 설치 각도 설정 · 값 확인 · 위험성 평가 | 3A · 5A · 12A | 3 | | manual 4 | 38, 46, 93-95 |
| WS-HCR-MNT-01 | 정기 점검 항목과 주기 | 3A · 5A · 12A | 0 | 점검 항목 8건 + 사건 뒤 확인 1건 | manual 9 | 44, 229 |
| WS-HCR-MNT-02 | 로봇 암 확인 및 청소 | 3A · 5A · 12A | 4 | | manual 4 | 230 |
| WS-HCR-MNT-03 | 로봇 컨트롤러 확인 · 먼지 제거 · 필터 청소 | 3A · 5A · 12A | 6 | | manual 6 | 230, 232 |
| WS-HCR12A-ASM-01 | HCR-12A 서브 조립별 체결 부품(구조만) | 12A | 0 | 조립품 7 | cad 28 | — |
| WS-HCR3A5A-ASM-01 | HCR-3A · 5A 커버 볼트(구조만) | 3A · 5A | 0 | 조립품 2 | cad 5 | — |

- **단계 순서는 사용설명서의 절 순서**다. 매뉴얼이 "이 순서로"를 못박은 곳만 `order_binding: manual` 로 표시했다(툴 고정 뒤 케이블 연결, 전원을 끈 뒤 I/O 배선, 설치 뒤 각도 설정, 설치 직후 위험성 평가, 점검 절차 15.2 의 1~4 · 15.3 의 1~5). 나머지 순서는 공백(G-015).
- 값(토크 · 볼트 규격)의 정본은 규칙이고 단계는 규칙 번호를 가리킨다. WS-HCR-INS-02 단계 3 에 읽기 쉽게 옮겨 적은 수치는 시험이 규칙과 같은지 비교한다.
- **점검 항목 8건**은 15.1 표(p.229)다. 알려져 있던 "정기 점검 11건"은 사용설명서에 없고(다른 자료의 수치), 이 표는 8행이다. 컨트롤러 3행(케이블 · 내부 · 필터)의 "6개월"은 병합 셀을 텍스트 추출로 읽은 해석이라 원본 표로 확인해야 한다(`cycle_note`).
- **CAD 구조 문서**의 수량은 STEP 에서 센 값이다: 12A 의 `BOLT-M3X15` 21(= J3·J4 13 + J5·J6 8) · `M3X8` 12 · `M4` 23(= J2 16 + 툴 I/O 7) · `M4X15` 18 · `M4X25` 20. 3A 커버 볼트 `HCR_COVER_BOLT_1` 9 · `_3` 9, 5A `_1` 16 · `_2` 8.
  **3A · 5A 는 볼트가 들어가는 조립품 계층을 옮기지 않았다**(STEP 전체 합계만). 소켓 헤드 판정은 STEP 문자열이 명시한 것(12A `BOLT-M4X15` 18 · 3A/5A 커버 볼트 42)과 OPMS 시연 README 의 가정 + ISO 4762 머리 치수 일치(12A 나머지 59)로 나뉜다([fastener-classification.md](fastener-classification.md) 11.2). 규격 · 길이는 추정 표시를 달았다.

## 7. 공백(작성이 필요한 곳) 19건

`rules/gaps.yaml` 에 필요한 것 · 이유 · 구할 곳 · 막힌 항목을 적었다.

| 번호 | 공백 | 막힌 곳 |
|---|---|---|
| G-001 | 소켓 헤드 볼트(M3 · M4) 체결 토크 | AR-FAS-006 |
| G-002 | 툴 고정 M6 볼트의 길이 · 토크(툴 제조사) | AR-FAS-004 |
| G-003 | 접지 라인 M4×10 볼트 토크 | AR-FAS-002 |
| G-004 | 컨트롤러 고정 M14 볼트 토크 | AR-FAS-005 |
| G-005 | **로봇 암 공장 조립 절차**(서브 조립 순서 · 체결 순서 · 공구 · 지그) | AR-FAS-006, 두 CAD 구조 문서 |
| G-006 | 단계별 표준 작업 시간 | 모든 작업표준서 |
| G-007 | 공구 사양(토크 렌치 범위 · 육각 렌치 크기 · 청소 도구) | tools.yaml 3개 |
| G-008 | 볼트의 머리 모양 · 강도 등급 · 재질 · 표면처리 · 나사 방향(OPMS 필수 속성) | AR-FAS-001, 006 |
| G-009 | HCR-5A STEP 에 로봇 고정 볼트 커버 부품이 없다 | AR-FAS-003 |
| G-010 | 3A 베이스 커버 볼트 형상 분류가 불확실(접시머리 · 십자 0.6) | AR-FAS-003 |
| G-011 | 위치 결정 핀의 길이 · 공차 · 재질 · 부품 번호 | AR-LOC-001 |
| G-012 | 위험성 평가의 사내 절차 | WS-HCR-INS-05 |
| G-013 | 점검 합격 기준(수치) | WS-HCR-MNT-01 |
| G-014 | 용접 · 압입(이 로봇에 근거 없음) | not_covered |
| G-015 | 설치 · 연결 단계의 필수 순서 | WS-HCR-INS-02~04 |
| G-016 | 일반 체결 토크 표준값(ISO 898-1 · VDI 2230 원문 확인과 설계 승인 필요) | AR-FAS-006 |
| G-017 | 영점 설정(캘리브레이션) 절차 — 매뉴얼은 구매처 문의(p.44, p.89) | not_covered, AR-MNT-004 |
| G-018 | 컨트롤러 내부 조립 절차와 "커버 잠금 나사" 규격 | not_covered |
| G-019 | `BOLT-M4`(12A 23개)의 길이 — 이름에 없고 모델이 머리만 있다 | WS-HCR12A-ASM-01 |

## 8. 검증

```bash
backend/.venv/Scripts/python.exe tools/check_rules.py            # 사람이 읽는 보고서 (오류가 있으면 종료 코드 1)
backend/.venv/Scripts/python.exe tools/check_rules.py --json     # JSON
backend/.venv/Scripts/python.exe -m pytest rules/tests -q -p no:cacheprovider --rootdir rules
```

`tools/check_rules.py` 가 보는 것(PyYAML 만 필요, backend 와 무관):

- **구조 · 참조 무결성**: 필수 필드, 번호 형식, 규칙 → 공정 · 공구, 작업표준 → 규칙 · 공정 · 공구, 단계 번호 1부터 연속, 모델 · 역할(role) 어휘, 공백 번호 존재.
- **출처 등급**: 모든 값에 `source`. `manual` 은 문서 · 쪽 번호(쪽 수 안), `cad` 는 CAD · 파생 자료 출처, `standard` 는 표준 번호 + 승인 필요 표시, `unknown` 은 **값이 비어 있고** gap 이 있어야 한다.
- **작업 시간은 비어 있어야 한다**, 절차를 쓰지 않는 문서(`structure_only`)에는 단계가 없어야 한다.
- **OPMS 분류 이름**: OPMS PDM 브랜치 `ontology/classes.yaml` 에 있어야 하고(없으면 `proposed_classes`), OPMS 경로가 없으면 건너뛰고 경고한다. OPMS 저장소는 **읽기만** 한다.

결과: **오류 0 · 경고 0**, 공정 18(근거 없음 4) · 공구 3 · 규칙 23 · 작업표준 10(단계 31 · 점검 8) · 공백 19, 등급별 값 manual 170 · cad 36 · unknown 19 · standard 0. pytest 32개 통과.
시험은 실제 파일을 통과시키는 것 말고도 **일부러 깨뜨린 사본이 잡히는지**(쪽 번호 · 출처 · gap 누락, 지어낸 값, 모르는 분류 · 공정 · 공구, 끊긴 단계 번호, 채워진 작업 시간 등)와 **매뉴얼 수치**(3.3 표 · 점검 8행 · CAD 수량 합계)를 확인한다.
Windows 에서 pytest 의 `tmp_path` 는 한글 사용자 폴더 때문에 권한 오류가 나서, 임시 폴더가 필요한 시험은 `tempfile` 을 쓴다.

## 9. 다음 연결(이 작업 범위 밖)

1. ~~**백엔드가 `rules/` 를 읽어 서빙**~~ → **했다(2026-11-12)**: `GET /api/v1/pdm/rulebook/{rules, rules/{id}, operations, tools, work-standards, work-standards/{id}, gaps, status}` 와 `POST /rulebook/select`(`backend/src/onto_pdm/rulebook/`, 라우트 `api/rulebook_routes.py`). 읽을 때마다 `check_rules.check()` 를 불러 오류가 있으면 앱은 살리고 해당 엔드포인트가 503 `RULEBOOK_INVALID`(오류 목록 포함)를 돌려주며, 파일을 고치면 다음 요청에서 다시 읽는다(읽기 전용, 저장소 파일이 정본). 사용법 · 응답 모양 · 환경 변수는 [backend/README.md](../backend/README.md) "조립 규칙 · 작업표준서".
   경로를 `/rules` 가 아니라 `/rulebook/rules` 로 둔 것은 기존 인메모리 `backend/src/onto_pdm/rules.py` 의 `/rules`(삭제한 목업의 이식본)와 겹치지 않게 하려는 것이다. 웹이 새 경로로 옮겨 가면 옛 라우트 · 시드를 지운다(판단 필요).
2. ~~**웹**~~ → **했다(2026-11-12)**: `PdmApi.rulebook`(`web/src/api/httpApi.ts`) → 규칙 목록(`/rules`: 필터 · 출처 배지 · 작성 필요) · 작업 표준(`/mes`: 작업표준서 목록 · 상세 · 작성 필요 목록 · 인쇄) · 스튜디오 HUD(확정 기준 / CAD 추정 기준, 역할은 사람이 고름, 모델은 파일 이름에서). 사용법은 [web/README.md](../web/README.md). (원래 계획: `PdmApi` 의 규칙 · 작업표준 메서드를 위 엔드포인트에 연결 — 규칙 목록 화면(공정 칩 · 쪽 번호 · **출처 등급 배지** · "작성 필요" 표시), 작업 표준 화면(단계 · 점검 항목 · 근거), 스튜디오 HUD(확정한 분류 + `context.role` 로 규칙 선택, 값이 `unknown` 이면 "값이 아직 없어요 — 작성 필요(G-0xx)").
   `manual` 은 "사용설명서 p.49", `cad` 는 "CAD 추정", `unknown` 은 "근거 없음" 으로 보여 준다. **추정이나 근거 없는 값을 작업자 화면에서 확정값처럼 보이지 않게 한다**([worker-view-proposal.md](worker-view-proposal.md) 의 원칙). 웹은 확정값(`confirmed`)만 실선 · 초록 배지로, CAD 추정 · 표준 참고는 점선 · 호박색, 근거 없음은 회색 점선 "작성 필요 G-0xx"로 구분한다.)
3. **OPMS 와의 경계**: 분류 · 속성은 **OPMS 소유로 읽기만** 한다(`classes` 이름 검증). 규칙 · 작업표준서는 **PDM 소유**로 작성했다. OPMS 문서(`CR-NEXT-onto-pdm-merge-prep` 10.5 · 11장)는 공정 어휘 · 조건표를 OPMS(`concepts.csv`)에 둘지 PDM 의 `Operation` · `AssemblyRule` 에 둘지를 **아직 열린 질문**으로 두었다(제조 공정 지식으로 범위를 넓히는 것은 허용, 품목관리에 영향이 없다는 조건). 정해지기 전까지 PDM 안에서 쓰고, `operations.yaml` 의 `opms_code`(`BoltFastening` · `Inspection`)로 OPMS 공정 개념 후보와 이름만 맞춰 두었다.
4. **공백 채우기**: 사내 작업표준서나 제조사 자료가 생기면 해당 항목의 `source` 를 바꾸고 gaps.yaml 에서 지운다. 검증이 "unknown 인데 값이 있다 / manual 인데 쪽이 없다"를 막는다.

### spec 변경 제안 ([assembly-rules-spec.md](assembly-rules-spec.md) 는 고치지 않았다)

| 제안 | 이유 |
|---|---|
| `applies_to.context`(`role` · `model`)를 Condition 에 추가 | 같은 M6 볼트라도 로봇 고정(30 N·m)과 툴 고정(근거 없음)이 다르다. 분류 + 나사 규격만으로는 규칙을 고를 수 없다 |
| 모든 Parameter · Caution 에 `source` · `ref`(문서 · 절 · 쪽) | 화면이 확정값과 추정을 구분해 보이게 하고, 근거 없는 숫자를 막는다 |
| Caution `level` 에 `안내`(안전 표시 없는 본문 지시)를 추가 | 매뉴얼의 위험 · 경고 · 주의 · 참고에 들어가지 않는 지시문이 많다 |
| `lookup` 의 키로 `model` · `mounting` 허용, 행마다 `source` | 3.3 표가 로봇 모델별이다 |
| 작업표준서 문서형(`WorkStandard`: 단계 · 점검 항목 · `structure_only` · `procedure_gap`) | spec 에는 규칙만 있고 작업표준서 자체의 모양이 없다 |
| `status: unreviewed` 를 `draft` 와 구분 | 사람이 아직 보지 않은 추출본임을 화면에 보이기 위해 |

## 10. 한계

- 쪽 번호는 PDF 쪽이다(인쇄된 쪽 번호와 같음을 확인). 텍스트 추출 기준으로 읽었으므로 **표 모양 · 경고 상자 경계 · 병합 셀**(p.49-50 경고 연속, p.229 주기)은 원본 PDF 로 한 번 확인해야 한다. 해당 항목에 `level_note` · `cycle_note` 를 남겼다.
- 사용설명서 원문은 저장소에 넣지 않았다(제조사 자료). 인용 문구는 규칙 · 작업표준에 필요한 만큼만 옮겼다.
- 형상 분류기 결과(소켓 헤드, M3 · M4, 길이 12 등)는 추정이고, 실제 STEP 4개로 검증했지만 몇 개는 가정에 기댄다(6장).
- 모든 규칙 · 작업표준서는 **초안(unreviewed)**이다. 실제 작업에 쓰기 전에 설계 · 공정 담당의 검토와 승인이 필요하다.
