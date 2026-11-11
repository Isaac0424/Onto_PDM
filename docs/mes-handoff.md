# MES 발행: 제조 BOM + 작업표준 묶음

PDM이 승인한 설계 정보를 제조(MES)로 넘기는 묶음의 형식과 규칙. 화면: `/mes` ([web/src/pages/mes/MesPage.tsx](../web/src/pages/mes/MesPage.tsx)), 만드는 곳: [web/src/api/mock/mesApi.ts](../web/src/api/mock/mesApi.ts). 요구사항은 [PRD.md](PRD.md) 6.6(F-MES-1~4).

## MES가 무엇인가

MES(제조실행시스템)는 공장 현장에서 "지금 무엇을 어떻게 만들고 있나"를 실행하고 기록하는 시스템이다. 작업 지시를 받아 작업자 단말에 **단계별 조립 방법**을 보여 주고, 누가 언제 몇 개 만들었는지, 토크 같은 측정값, 어느 제품에 어느 로트를 썼는지를 남긴다. PDM은 그 재료(무엇을, 어떤 순서로, 무엇에 주의해서)를 설계 쪽에서 승인해 한 묶음으로 넘긴다. CAD 스튜디오의 조립 안내(3D 위의 카드와 자막)는 MES 작업 안내 화면의 시안이다.

## 묶음(JSON)

`MesPackage` ([web/src/api/types.ts](../web/src/api/types.ts)). 한 제품의 한 리비전에 묶음 하나가 나온다.

| 필드 | 설명 |
|---|---|
| `productCode` · `productName` | 제품 코드(HCR3A)와 이름 |
| `rootItemNo` | 최상위 조립품의 품번 |
| `revision` | 발행하는 최상위 조립품 리비전 (예: `R01`) |
| `rule` | BOM 기준: `released`(승인본) · `latest`(최신) |
| `generatedAt` | 묶음을 만든 시각 (ISO) |
| `bom[]` | 제조 BOM. 아래 표 |
| `steps[]` | 작업 단계. 아래 표 |
| `documents[]` | 연결된 문서 `{ docNo, title, docType, rev }` (문서 번호로 중복 제거, 거절된 연결 제외) |
| `warnings[]` | 발행 전에 사람이 확인할 것 (한국어 한 줄씩) |

### `bom[]` (제조 BOM 한 줄)

깊이 우선 순서. 최상위 조립품이 `seq` 1, `level` 0. 같은 품목이 여러 곳에 쓰이면 위치마다 줄이 따로 있다.

| 필드 | 설명 |
|---|---|
| `seq` | 순번 (1부터) |
| `level` | BOM 단계 (최상위 0) |
| `itemNo` · `name` | 품번 · 이름 |
| `quantity` | **부모 1개당** 수량 |
| `totalQuantity` | **최상위 1개당** 총수량 (같은 부품이 J1에 12, J2에 12개 쓰이면 줄마다 12이고 합은 24) |
| `step` | 조립품은 자기를 조립하는 작업 단계, 부품은 그것이 들어가는 부모 조립품의 단계 |
| `ruleIds[]` | 그 품목에 걸린 조립 규칙 번호 (`SP-FAS-01` …) |

### `steps[]` (작업 단계 하나)

조립 순서는 **하위 조립품부터**(깊이 우선 후위 순회). 자식이 있는 조립품마다 한 단계이고, 같은 조립품이 여러 곳에 쓰여도 한 번만 만든다.

| 필드 | 설명 |
|---|---|
| `step` | 단계 번호 (1부터) |
| `title` | `<조립품 이름> 조립` |
| `operationLabel` | 첫 규칙의 공정 (장착 · 커버 조립 …). 규칙이 없으면 없음 |
| `parts[]` | 그 조립품의 직접 자식 `{ itemNo, name, quantity }` (quantity는 부모 1개당) |
| `ruleIds[]` | 자식들에 걸린 규칙의 합집합 (중복 제거) |
| `params[]` | 규칙에서 뽑은 값 `{ label, value }` (같은 쌍은 한 번만) |
| `cautions[]` · `tools[]` | 주의사항 · 공구 (중복 제거) |

## CSV 열

제조 BOM 표만 담는다 (`bom[]`). 첫 줄은 머리줄, 줄바꿈은 CRLF, **맨 앞에 UTF-8 BOM(`EF BB BF`)** 을 붙여 엑셀에서 한글이 깨지지 않게 한다. 쉼표 · 따옴표 · 줄바꿈이 든 칸은 따옴표로 감싸고 안의 따옴표는 두 번 쓴다.

| 열 | 내용 |
|---|---|
| `seq` `level` | 순번, BOM 단계 |
| `item_no` `name` | 품번, 이름 |
| `quantity` `total_quantity` | 부모 1개당, 최상위 1개당 |
| `step` | 작업 단계 번호 (없으면 빈 칸) |
| `rule_ids` | 규칙 번호를 세미콜론으로 이은 것 (`SP-RED-01;SP-FAS-01`) |

파일 이름은 `<제품코드>_<리비전>_mes.json` · `.csv` (예: `HCR3A_R01_mes.json`).

## 발행 규칙

1. **승인본만 발행한다.** 묶음에 작업중 · 검토중 리비전이나 승인 리비전이 없는 품목이 하나라도 있으면 발행하지 않는다 (HTTP 409 상당, `승인된 리비전만 MES로 발행할 수 있습니다`). BOM 기준을 `최신`으로 하면 미리보기와 내려받기는 되지만 경고가 뜨고 발행은 거절된다.
2. **같은 리비전은 한 번만.** 같은 제품 · 리비전 · BOM 기준으로 이미 `sent` 기록이 있으면 409 (`이미 발행한 리비전입니다`). 새 리비전이 승인되면 다시 발행할 수 있다.
3. 승인본 기준인데 최상위 조립품에 승인된 리비전이 없으면 묶음을 만들 수 없다 (409, `승인된 리비전이 없습니다`). 없는 제품은 404.
4. 발행 전 경고: (a) `최신` 기준에 작업중 · 검토중 리비전 포함, (b) 승인되지 않은 품목 이름과 리비전, (c) 폐기된 리비전, (d) 조립 규칙이 없는 작업 단계, (e) 최상위 조립품에 연결된 문서 없음.
5. 공개 범위는 따로 검사하지 않는다. 묶음은 `getItem` · `getBom`으로 읽으므로 이미 사용자에게 보이는 리비전만 들어간다 (남의 작업중 리비전은 관리자 모드가 아니면 보이지 않는다). 실제 서버에서는 발행 권한을 관리자 모드에만 두는 것이 맞다.

## 목 구현과 실제 연동의 차이

| | 지금(목) | 실제 연동 |
|---|---|---|
| 전송 | 없음. 발행 기록(`MesPublication`)만 남긴다 | MES 형식이 정해지면 그 형식으로 내보낸다 (API · 파일 · 메시지) |
| 형식 | JSON · CSV 파일을 내려받아 MES 쪽에서 읽게 한다 | MES가 받는 필드에 맞춰 사상 |
| 이력 | 화면을 다시 열면 사라진다 | PostgreSQL `outbox` ([neo4j-lpg-design.md](neo4j-lpg-design.md) · `db/schema.sql`)와 발행기 |
| 실패 · 재시도 | 항상 성공(`sent`). `pending` · `failed`는 화면만 준비 | 발행기가 `attempts` · `last_error`로 재시도 |
| 실적 환류 | 없음 | MES의 실적 · 불량을 PDM으로 받는다 (PRD F-MES-5, P2) |

MES가 정해지기 전에는 **JSON을 기준 형식**으로 삼는다. 필드는 위 표대로이고, 규칙 번호와 품번으로 PDM의 해당 규칙 · 품목 화면(`/rules/:id`, `/items/:품번`)에 거슬러 갈 수 있다.

## 예시 (HCR3A R01, 일부)

```json
{
  "productCode": "HCR3A",
  "productName": "협동로봇 3 kg",
  "rootItemNo": "P-00000000100",
  "revision": "R01",
  "rule": "released",
  "generatedAt": "2026-11-11T09:53:00.000Z",
  "bom": [
    { "seq": 1, "level": 0, "itemNo": "P-00000000100", "name": "HCR3A 본체", "quantity": 1, "totalQuantity": 1, "step": 4, "ruleIds": [] },
    { "seq": 2, "level": 1, "itemNo": "P-00000000110", "name": "베이스 조립품", "quantity": 1, "totalQuantity": 1, "step": 1, "ruleIds": [] },
    { "seq": 11, "level": 2, "itemNo": "P-00000000001", "name": "볼트 M3x8", "quantity": 12, "totalQuantity": 12, "step": 2, "ruleIds": ["SP-FAS-01"] }
  ],
  "steps": [
    {
      "step": 2,
      "title": "J1 관절 모듈 조립",
      "operationLabel": "장착",
      "parts": [
        { "itemNo": "P-00000000121", "name": "J1 감속기", "quantity": 1 },
        { "itemNo": "P-00000000001", "name": "볼트 M3x8", "quantity": 12 }
      ],
      "ruleIds": ["SP-RED-01", "SP-MOT-01", "SP-HSG-01", "SP-FAS-01"],
      "params": [{ "label": "입력축 방향", "value": "모터 쪽" }, { "label": "체결 토크", "value": "0.6 N·m ±10%" }],
      "cautions": ["입력축 방향이 반대면 조립 후 분해해야 합니다."],
      "tools": ["토크 렌치", "토크 드라이버"]
    }
  ],
  "documents": [{ "docNo": "D-CAD-0100", "title": "HCR3A 본체 3D", "docType": "cad_3d", "rev": "R01" }],
  "warnings": ["조립 규칙이 없는 작업 단계 1개: HCR3A 본체 조립"]
}
```

CSV 예 (BOM 표, 앞 3줄):

```
seq,level,item_no,name,quantity,total_quantity,step,rule_ids
1,0,P-00000000100,HCR3A 본체,1,1,4,
2,1,P-00000000110,베이스 조립품,1,1,1,
```
