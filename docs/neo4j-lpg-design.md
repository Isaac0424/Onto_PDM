# Neo4j(LPG) 그래프 모델 — RDF에서 옮기기

PDM 본체 설계: [pdm-design.md](pdm-design.md) · 기존 RDF 설계: [integration-ontology-design.md](integration-ontology-design.md)

PDM과 OPMS(`ernest_hemingway_OPMS`)가 **같은 Neo4j를 쓰기로** 해서, GraphDB(RDF · OWL2-RL · SHACL)로 정의했던 `ontology/`를 Neo4j의 속성 그래프(LPG)로 다시 정의했다. 원칙은 **충돌하면 OPMS를 따르고, OPMS 코드를 고쳐야만 풀리는 설계는 피한다**이다.

| 파일 | 내용 |
|---|---|
| [neo4j/schema.cypher](../neo4j/schema.cypher) | 고유 제약 · 인덱스 · 이름 검색 인덱스 |
| [neo4j/sample.cypher](../neo4j/sample.cypher) | `ontology/examples/sample-abox.ttl`을 옮긴 예시 데이터. PDM의 몫만 쓴다 (멱등) |
| [neo4j/checks.cypher](../neo4j/checks.cypher) | `shapes-data.ttl`(SHACL)을 옮긴 검사 규칙 27개 |
| [neo4j/queries.cypher](../neo4j/queries.cypher) | OWL 추론이 하던 일을 대신하는 경로 질의 |
| [neo4j/test/opms-standin.cypher](../neo4j/test/opms-standin.cypher) | OPMS가 이미 만들어 둔 것(분류 · 재료 · `:Part`)의 축소 모사. 시험 전용 |
| [neo4j/test/verify.py](../neo4j/test/verify.py) | 위 전부를 일회용 Neo4j 5.26 컨테이너에서 확인 (49개). `python neo4j/test/verify.py` |

## 1. 같은 DB를 쓸 때의 원칙

OPMS의 `registry ontology sync`는 **YAML에 없는 온톨로지 노드·관계를 지운다** (OPMS PRD 10.4). 그래서 소유자를 라벨로 나눈다.

| 소유 | 라벨 | PDM이 하는 일 |
|---|---|---|
| OPMS | `Class` `Property` `Scheme` `Concept` `Term` `Rule` `OntologyVersion` | **읽기만.** 분류 · 재료 · 동의어는 OPMS의 YAML·CSV가 원본이다 |
| OPMS | `Part` `Supplier` `SupplierPart` `SourceDoc` `Sequence` `PartReservation` `DedupeLock` | **읽기만.** `:Part`에는 라벨도 속성도 달지 않는다. 품번은 OPMS `Sequence` · 예약이 발급한다 |
| PDM | `PdmItem` `ItemRevision` `ProductModel` `PartIdentifier` `MaterialProfile` | 쓰고 지운다. OPMS sync가 건드리지 않는다 |

PDM 노드가 OPMS 노드를 가리키는 연결은 하나뿐이다: `(:PdmItem)-[:OF_PART]->(:Part)`.

`:Part`에 PDM 속성을 달지 않는 이유: OPMS는 `:Part`의 속성을 온톨로지 값으로 읽고(`RESERVED_KEYS`, 영향 보고 `revalidation_impacts`) 메타 필드를 예약 키로만 허용한다. 속성을 달면 OPMS 쪽을 고쳐야 한다.

## 2. RDF → LPG 대응

| RDF (`core.ttl`) | LPG | 이유 |
|---|---|---|
| `opdm:Item` 개체 | `(:PdmItem {pdm_item_id, item_type, name, name_ko, uom, mass_kg, mass_source})-[:OF_PART]->(:Part {part_no})` | PDM의 품목과 OPMS의 품목 마스터를 **두 노드**로 둔다. 품번(`part_no`)은 `:Part`에만 있다 |
| `opdm:Assembly` / `ManufacturedPart` / `PurchasedPart` / `StandardPart` (조달 구분, 다중 `rdf:type`) | `:PdmItem.item_type` = `assembly` `part` `purchased` `standard` | 분류(무엇인가)와 독립인 열거 값이라 라벨 대신 속성 |
| 분류 `cls:C0101 a owl:Class` + `rdfs:subClassOf` | OPMS `(:Class)-[:SUBCLASS_OF]->(:Class)` 와 `(:Part)-[:INSTANCE_OF]->(:Class)` | 분류 트리는 OPMS가 갖고 있다. PDM은 읽기만 한다 |
| 재료 계열(클래스) + 재료 등급(개체) `mat:M000001` | OPMS `(:Concept)-[:IN_SCHEME]->(:Scheme {code:'material'})`, `[:BROADER]` | 스테인리스 → SUS304 가 이미 같은 모양 |
| `skos:altLabel "STS304"` (재료 동의어) | OPMS `(:Term)-[:DENOTES]->(:Concept)` | OPMS `terms.csv` |
| `opdm:hasMaterial` | OPMS `(:Part)-[:HAS_VALUE {prop:'material'}]->(:Concept)` | OPMS가 `:Part`에 둔 값을 `OF_PART`로 건너가 읽는다 |
| `opdm:density` (재료 개체의 속성) | `(:MaterialProfile {concept_code, density_g_cm3})-[:PROFILE_OF]->(:Concept)` | `:Concept`에 속성을 더하면 OPMS sync가 덮어쓰거나 지울 수 있어 PDM 소유 노드로 분리 |
| `opdm:mass` `opdm:massSource` `opdm:uom` | `:PdmItem`의 `mass_kg` `mass_source` `uom` | PDM 값이라 `:PdmItem`에 둔다 |
| `opdm:partNumber` | `:Part.part_no` (OPMS 고유 키) | |
| `opdm:altPartNumber` ⊃ `legacyPartNumber` `erpCode` `mesCode` `supplierPartNumber` `cadName` | `(:PartIdentifier {scheme, value, norm, key})-[:IDENTIFIES]->(:PdmItem)` | 하위 속성 추론이 필요 없다. 별칭이 전부 한 라벨이라 종류와 상관없이 한 번에 찾는다 |
| `opdm:ItemRevision` | `(:ItemRevision {pdm_revision_id, rev, rev_seq, status, released_at, change_note})` | |
| `opdm:hasRevision` ⊃ `opdm:currentRevision` | `(:PdmItem)-[:HAS_REVISION]->(:ItemRevision)` 와 `[:CURRENT_REVISION]` | 하위 속성 추론 대신 발행기가 둘 다 쓴다. "현재는 HAS의 일부"는 검사가 지킨다 |
| `opdm:BomLine` (노드) + `hasBomLine` + `child` + `quantity` + `findNo` | **관계** `(:ItemRevision)-[:CONTAINS {quantity, find_no}]->(:PdmItem)` | RDF는 관계에 속성을 못 달아서 BOM 줄을 노드로 만들었다. LPG는 관계에 단다 |
| `opdm:hasComponent` (속성 사슬) | 경로 `(:PdmItem)-[:CURRENT_REVISION]->(:ItemRevision)-[:CONTAINS]->(:PdmItem)` | 저장하지 않고 질의가 따라간다 |
| `opdm:hasComponentTransitive` | 수량화 경로 `( … )+` (Neo4j 5.9+) | |
| `opdm:Product` + `opdm:rootItem` | `(:ProductModel {code, name})-[:ROOT_ITEM]->(:PdmItem)` | OPMS 웹의 "제품"은 부품 마스터를 뜻해서 라벨을 `ProductModel`로 구분 |
| IRI · `iri_key` | **없어진다.** 노드 자체가 식별자 | 품번이 바뀌어도 관계는 노드에 걸려 있어 그대로. PG와의 연결은 `pdm_item_id` · `pdm_revision_id` |
| 네임스페이스 `ontology.example.com` (미정) | 필요 없다 | 도메인을 정할 일이 하나 줄었다 |
| `owl:versionIRI` | OPMS `(:OntologyVersion)` | |
| `opdm:standardIrdi` `unitIrdi` `qudt:*` | **옮기지 않았다** (7장) | |

## 3. 그래프 한눈에

```
(:ProductModel {code})-[:ROOT_ITEM]->(root:PdmItem)
                                        │
 (:PdmItem {pdm_item_id, item_type, name, …}) ─[:OF_PART]─▶ (:Part {part_no, …})      ← OPMS 품목 마스터
        │                                                      ├─[:INSTANCE_OF]─▶ (:Class)─[:SUBCLASS_OF]▶ …
        │                                                      └─[:HAS_VALUE {prop:'material'}]─▶ (:Concept)─[:BROADER]▶(:Concept)
        │                                                                                          ▲
        │                                       (:MaterialProfile {density_g_cm3})─[:PROFILE_OF]───┘   ← PDM
        ├─◀[:IDENTIFIES]─ (:PartIdentifier {scheme, value, norm})                                    ← PDM
        ├─[:HAS_REVISION]──▶ (r:ItemRevision {rev, status})
        └─[:CURRENT_REVISION]▶ (r)  ─[:CONTAINS {quantity, find_no}]▶ (child:PdmItem)
```

- **승인본만 발행한다.** 작업중(wip) · 검토중 리비전은 그래프에 없다 (`revision_status_valid`). 폐기(obsolete)된 이전 리비전은 이력으로 남고 BOM 전개에서는 `CURRENT_REVISION`만 따라가서 섞이지 않는다.
- **BOM의 부모는 리비전, 자식은 PDM 품목**이다. 자식의 어느 리비전을 쓸지는 조회 때 `CURRENT_REVISION`으로 정한다 (PG `bom_line`과 같다).
- **`:Part`는 PDM이 만들지 않는다.** OPMS 등록 경로가 만든 `:Part`를 PDM이 `:PdmItem`으로 가져간다. 질의가 돌려주는 품번은 `OF_PART`로 건너간 `:Part.part_no`다.

## 4. OWL 추론이 사라진 자리

GraphDB는 OWL2-RL로 추론했지만 Neo4j에는 추론기가 없다. 저장하지 않은 관계는 질의가 따라간다 ([queries.cypher](../neo4j/queries.cypher)).

| 추론 | LPG |
|---|---|
| 하위 클래스 (`?m a cls:M0111` → 상위 클래스 개체도) | `-[:SUBCLASS_OF*0..]->` · `-[:BROADER*0..]->` |
| 하위 속성 (`legacyPartNumber` ⊂ `altPartNumber`) | 별칭이 모두 `:PartIdentifier`라 필요 없음 |
| 속성 사슬 (`hasComponent`) | 경로 패턴 |
| 이행 관계 (`hasComponentTransitive`) | `( … )+` 경로 |
| "추론이 개체를 합치지 않는다" (`owl:sameAs` 금지) | 해당 없음. LPG는 개체를 자동으로 합치지 않는다 |

**좋아진 점**: RDF에서는 SPARQL로 수량을 곱할 수 없어서 누적 수량을 PostgreSQL `bom_explode`가 계산했다. 경로 위에서 `reduce(q, x IN l | q * x.quantity)`로 곱할 수 있다 (`bom_explode` 질의). 다만 **원본은 여전히 PG**다. 그래프는 승인본의 사본이다.

## 5. SHACL이 사라진 자리

Neo4j **Community**에는 고유 제약만 있고 존재 · 타입 · 관계 개수 제약이 없다 (Enterprise 전용. OPMS도 같은 이유로 쓰지 않는다). 그래서:

- 고유 제약은 `schema.cypher`: `pdm_item_id` `pdm_revision_id` `ProductModel.code` `PartIdentifier.key` `MaterialProfile.concept_code`
- 나머지는 `checks.cypher`가 한다. 검사마다 위반을 `(rule, subject, message)`로 돌려주고, **결과가 없으면 통과**다. 발행기가 승인본을 쓴 같은 트랜잭션에서 돌리고 한 줄이라도 나오면 롤백한다 (SHACL의 "커밋 거부" 자리).
- 속성이 없거나 타입이 다르면 비교가 `null`이 되어 `WHERE`에서 조용히 빠진다. 그래서 `NOT coalesce(x > 0, false)`로 쓴다 (OPMS PRD 10.3의 null 안전 비교와 같은 원칙).
- **소유 구분**: 검사는 PDM이 소유한 것과 `OF_PART` 연결만 본다. `:Part` 안의 불변식(재료 속성과 `HAS_VALUE`가 같다, 같은 번호의 사용된 예약이 있다, `record_origin`이 목록에 있다)은 OPMS가 소유하고 OPMS `reconcile`이 검사하므로 여기서 하지 않는다. (앞 판의 `material_value_in_sync`는 그래서 뺐다.)

| SHACL | 검사 |
|---|---|
| (새로 추가) 품목 ↔ 품목 마스터 | `item_one_part` `part_one_item` |
| `ItemShape` 품번 형식 · 이름 · 조달 구분 · 질량 | `part_no_format` `item_name_required` `item_type_valid` `mass_positive` |
| `MaterialRequiredShape` (가공품 · 표준품은 재료) | `material_required` `material_in_scheme` |
| `ItemRevisionShape` · 현재 리비전 하나 | `revision_*` `one_current_revision` `current_is_revision_of_item` `current_is_released` |
| `BomLineShape` | `bom_quantity_positive` `bom_find_no_*` `bom_child_*` **`bom_no_cycle`(새로 추가)** |
| `ProductShape` | `product_root_assembly` `product_one_root` |
| `MaterialShape` | `density_positive` `profile_one_concept` |
| (새로 추가) 별칭 | `identifier_*` |
| `shapes-taxonomy.ttl` (새 분류 제안 검사) | **옮기지 않았다.** 분류는 OPMS의 온톨로지 제안 흐름이 맡는다 |

## 6. 결정한 것과 OPMS에 부탁할 것

### 결정 (OPMS 코드 변경 없이 진행)
1. **품번은 OPMS 형식**(`P-` + 숫자 11자리)이고 발급은 OPMS `Sequence` · `PartReservation`이 한다. PDM이 자체 순번으로 발급하지 않는다. (PDM의 PostgreSQL · SHACL 쪽 형식 정렬은 이 문서의 범위 밖이다.)
2. **모델 B**: `:Part`에 라벨도 속성도 달지 않고 `(:PdmItem)-[:OF_PART]->(:Part)`로 잇는다 (1장).
3. **`:Part`는 OPMS 등록 경로가 만든다.** PDM은 `:Part`를 만들지 않는다. 신규 품번은 OPMS의 기존 검토 경로(A-01 업로드 → A-02 처리 → A-03 상태 → 사람 승인 → A-09 · A-10)로 받고(2026-11-11 확정), 승인된 `:Part`에 PDM이 `:PdmItem`을 잇는다. `sample.cypher`는 `:Part`를 만들지 않고 이미 있는 것을 읽는다.
4. **시험용 `:Part`는 OPMS 시드 규칙**을 따른다: `record_origin = 'seed'`, 예약 `origin = 'seed'` · `used` · `review_id` 없음 (OPMS PRD 10.3). 실제로 검토 경로로 등록된 `:Part`의 출처 값은 OPMS가 정한다(`review`).

### OPMS에 부탁할 선택 사항 (없어도 막히지 않는다)
1. **조립품 분류.** OPMS `classes.yaml`은 체결 부품 중심이라 조립품 · 브래킷 같은 클래스가 없다. 지금 조립품 `:Part`는 `INSTANCE_OF` 없이 둔다. OPMS 온톨로지 제안(`/ontology-proposals`)으로 올리면 분류된다.
2. **공급사 별칭을 `SupplierPart`와 합치기.** PDM `item_identifier.scheme='supplier'`는 `:PartIdentifier`로 옮겼다. OPMS의 중복 검사(`find_by_supplier_part`)에 PDM이 등록한 공급사 품번이 보이려면 `:SupplierPart`로 합쳐야 하고, `REFERS_TO.source` 어휘(`input` `document` `seed`)에 PDM 값이 필요하다.

### 아직 정하지 않은 것
- PDM이 가져가지 않은(OPMS가 문서 검토로 등록한) `:Part`를 PDM이 처음 가져갈 때의 규칙: `:PdmItem`과 R00을 만든다는 것만 정했다.

## 7. 옮기지 못했거나 미정인 것

- **표준 IRDI · 단위 IRDI** (`opdm:standardIrdi` `unitIrdi`, ECLASS · IEC CDD). OPMS 모델에 자리가 없다. 필요하면 PDM 소유 `(:StandardRef {scheme, irdi})-[:MATCHES {kind}]->(:Class)`를 둔다. 지금은 쓰는 곳이 없어 뺐다.
- **QUDT 수량 종류 · 단위 IRI.** OPMS는 속성마다 `canonical_unit`(문자열, 예 `mm`)과 `units.csv`를 쓴다. 단위 변환은 그쪽을 따른다. `mass`(kg) · `density`(g/cm³)는 이름에 단위를 넣었다 (`mass_kg` `density_g_cm3`).
- **발행기 · 읽기 경로 코드.** `outbox` → Neo4j 발행기와 FastAPI 라우터는 아직 없다. 발행기는 승인 리비전을 MERGE로 쓰고(같은 승인본을 다시 써도 결과가 같다 — `verify.py`가 확인), 현재 리비전이 바뀌면 이전 `CURRENT_REVISION` 관계를 지운 뒤 새로 건다. RDF의 "대상 named graph를 통째로 교체"는 LPG에 같은 개념이 없어 이 방식으로 대신한다.
- **GraphDB 전용 설정.** 저장소 규칙셋(OWL2-RL), SHACL 엔진, `tbox/qudt` named graph는 Neo4j에 해당이 없다. `ontology/*.ttl`과 `check_ontology.py`는 지우지 않았다. 옮겨 오기 전의 기준 문서로 남긴다.

## 8. 확인한 것

`python neo4j/test/verify.py` (Docker 필요, 포트를 열지 않는 임시 컨테이너 `neo4j:5.26.32-community`, 끝나면 지움): **49개 통과**.

- 스키마와 예시 데이터가 올라가고, 다시 올려도 노드 · 관계 수가 같다 (멱등)
- `sample.cypher`를 올려도 OPMS `:Part`의 개수 · 속성 수 · 라벨 수가 그대로다 (PDM이 `:Part`를 건드리지 않는다)
- 예시 데이터가 검사 27개를 모두 통과한다
- 질의가 기존 RDF 검사(`check_ontology.py`)와 같은 답을 낸다: 스테인리스가 들어간 제품 = HCR3A, 상위 재료면 HCR3A · HCR5A, 레거시 품번 찾기, 직접 하위 품목
- 수량을 누적하고, obsolete 리비전의 BOM은 섞이지 않는다
- 일부러 망가뜨린 데이터에서 검사 27개가 각각 위반을 잡고, 예상 밖 위반은 없다. 모든 검사에 이 시험이 있는지도 확인한다

확인하지 **못한** 것: 실제 OPMS DB(`ontology sync` · 등록이 만든 `:Class` · `:Concept` · `:Part`)와의 결합. 시험은 그 일부를 흉내 낸 `opms-standin.cypher` 위에서 돌렸다.
