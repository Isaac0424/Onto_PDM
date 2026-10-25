# Onto PDM

CAD 파일 · 사양서 · 설명서 · BOM을 **품번** 기준으로 묶어 관리하는 PDM이에요. 승인된 데이터는 ERP · MES가 보는 통합 DB와 GraphDB 온톨로지로 공개하고, 3D 분해도 뷰어(explode-studio)로 부품을 확인해요.

| 구성 | 위치 | 상태 |
|---|---|---|
| PDM 웹 화면 | [web/](web/) | React + TypeScript + Vite. 지금은 목(mock) 데이터로 동작 |
| DB 스키마 · 권한 | [db/](db/) | PostgreSQL 15 이상. 테스트 포함 |
| 온톨로지 · 검사 규칙 | [ontology/](ontology/) | GraphDB용 TBox, SHACL, 예시 데이터. 검사 스크립트 포함 |
| 3D 분해도 뷰어 | [src/](src/) | explode-studio 라이브러리. 웹 화면의 3D 탭이 이걸 쓴다 ([아래](#분해도-스튜디오-explode-studio)) |
| AI 이름 · 설명 서버 | [server/](server/) | Claude API를 부르는 예제 서버 (선택) |
| 설계 문서 | [docs/](docs/) | PDM, 통합 품번 · 온톨로지 · 분류 에이전트 |

## Quick Start

준비물: Node.js 20.19 이상(또는 22.12 이상), pnpm 12. 테스트까지 하려면 Python 3(3.12에서 확인).

패키지는 **pnpm**으로 관리해요. pnpm이 없으면 한 번 설치해요.

```bash
npm install -g pnpm@12.11.2
```

PDM 웹 화면은 백엔드 없이 바로 돌아가요.

```bash
cd web
pnpm install
pnpm dev             # http://localhost:5173
```

- 상단에서 사용자를 바꿔 볼 수 있어요(김관리 = 관리자, 이설계 = 엔지니어). **데모 초기화**로 목 데이터를 처음 상태로 돌려요.
- `web/`과 `db/`에서는 `npm install` · `npm run`이 막혀 있어요(`package.json`의 `devEngines`). 실수로 `package-lock.json`이 다시 생기지 않게 하려는 거예요.

| 명령 (`web/`) | 하는 일 |
|---|---|
| `pnpm dev` | 개발 서버 |
| `pnpm build` | 타입 검사 + 프로덕션 빌드 (`web/dist`) |
| `pnpm preview` | 빌드 결과 확인 http://localhost:4173 |

자세한 내용은 [web/README.md](web/README.md)에 있어요.

## 테스트

| 대상 | 위치 | 명령 | 준비 |
|---|---|---|---|
| 웹 단위 · 화면 | `web/` | `pnpm test` | 없음 |
| 웹 E2E (실제 브라우저) | `web/` | `pnpm e2e` | Windows는 설치된 Edge를 씀. 그 밖의 OS는 `pnpm exec playwright install chromium` 한 번 |
| DB 스키마 · 권한 | `db/` | `pnpm install` 후 `pnpm test` | 없음 (메모리 안 PostgreSQL인 PGlite로 돈다) |
| DB + 실제 서버 · 동시성 | `db/` | `PGTEST_URL=… pnpm test` | PostgreSQL 15 이상, 슈퍼유저 계정 |
| 온톨로지 | 저장소 루트 | `python ontology/tests/check_ontology.py` | Python 패키지 설치 (아래) |

**웹**: 단위 · 화면 테스트는 목 API의 권한 규칙과 주요 화면을 확인해요. E2E는 다음을 확인해요.

- 모든 화면이 오류 없이 열린다
- 3D 뷰어가 그려진다
- 승인하면 품번이 발급된다
- 분류 제안 승인이 반영된다
- 임시저장이 새로고침 뒤에도 남는다
- 모바일(390px)에서 화면이 가로로 넘치지 않는다

```bash
cd web
pnpm test
pnpm e2e
```

**DB**: 기본은 PGlite에서 스키마 기능과 권한을 확인해요. 실제 PostgreSQL 서버 주소를 주면 같은 테스트를 서버에서도 돌리고, 연결 두 개가 필요한 **동시성 테스트**(순환 BOM · 승인 중 변경 · 삭제 경쟁)도 돌려요.

- 서버에는 임시 DB를 만들었다가 끝나면 지워요.
- `roles.sql`의 역할은 서버 전체에 만들어지므로 **테스트용 서버**에서만 돌려요.

```bash
cd db
pnpm install
pnpm test                                                              # PGlite
PGTEST_URL=postgres://postgres@localhost:5432/postgres pnpm test       # + 실제 서버 (bash)
```

```powershell
$env:PGTEST_URL = "postgres://postgres:비밀번호@localhost:5432/postgres"; pnpm test   # PowerShell
```

**온톨로지**: SHACL 데이터 규칙, 분류 제안 규칙, OWL 2 RL 추론 질의를 확인해요. `--qudt`를 붙이면 QUDT 공개본(v3.5.3)을 `ontology/.cache/`에 받아 단위와 IEC 단위 IRDI까지 대조해요.

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r ontology/requirements.txt      # Windows (macOS · Linux 는 .venv/bin/python)
.venv/Scripts/python ontology/tests/check_ontology.py
.venv/Scripts/python ontology/tests/check_ontology.py --qudt
```

## 데이터베이스 설치

```bash
createdb onto_pdm
psql -v ON_ERROR_STOP=1 -d onto_pdm -f db/schema.sql
psql -v ON_ERROR_STOP=1 -d onto_pdm -f db/roles.sql    # 시스템별 접근 권한, DBA가 한 번 실행
```

- `schema.sql`은 `pg_trgm` 확장을 만들고 `roles.sql`은 역할을 만들어요. 그래서 `postgres` 같은 관리자 계정으로 실행해요.
- 역할 비밀번호는 파일에 없어요. `ALTER ROLE … PASSWORD`로 따로 정해요.
- Windows에서는 `psql`이 PATH에 없을 수 있어요. 그때는 `C:\Program Files\PostgreSQL\<버전>\bin`에서 실행해요.

## AI 이름 · 설명 서버 (선택)

```bash
cd server
pnpm add @anthropic-ai/sdk
ANTHROPIC_API_KEY=sk-ant-... node claude-endpoint.mjs          # bash
```

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."; node claude-endpoint.mjs   # PowerShell
```

`http://localhost:8787/api/explode-ai`로 열려요. 옵션은 [AI 서버 연결](#ai-서버-연결)에 있어요.

## 폴더 구성

```
web/              PDM 웹 화면 (React + TypeScript + Vite, 지금은 목 데이터)
  src/            화면 · 목 API (src/api/mock) · 단위 테스트
  e2e/            Playwright 실제 브라우저 테스트
db/               PostgreSQL 스키마(schema.sql) · 접근 권한(roles.sql)
  test/           스키마 · 권한 · 동시성 테스트 (node:test)
ontology/         GraphDB용 핵심 온톨로지(core.ttl) · SHACL 규칙 · 예시 데이터
  tests/          온톨로지 검사 스크립트
docs/             PDM · 통합 품번 · 온톨로지 · 분류 에이전트 설계 문서
standards/        ECLASS · IEC CDD 원본을 두는 곳 (git 제외, README만 올림)
src/              explode-studio (3D 분해도 뷰어) — 아래 절 참고
assets/occt/      STEP · IGES 해석기 (occt-import-js, WebAssembly 약 7.6MB) + 라이선스
examples/         explode-studio 예제 (vanilla HTML, React)
server/           AI 호출용 Node 서버 예제 (Claude API)
tools/            explode-studio 소스 생성 스크립트
```

## 설계 문서와 표준

- [docs/pdm-design.md](docs/pdm-design.md): 기능 · 프로세스 · 매칭 규칙 · DB · 트랜잭션과 동시성 · API
- [docs/integration-ontology-design.md](docs/integration-ontology-design.md): 통합 품번 · ERP/MES 공개 · GraphDB 온톨로지 · 분류 에이전트
- [standards/README.md](standards/README.md): ECLASS 무료판 받기, IEC CDD 무료 범위

---

## 분해도 스튜디오 (explode-studio)

CAD 파일(STEP · IGES · STL · OBJ · GLB)을 올리면 3D로 띄우고, 조립 구조를 따라 분해 모션으로 보여 주는 웹 컴포넌트예요. claude.ai에서 쓰던 "분해도 스튜디오"와 **같은 코드**에서 만들어져서 기능이 똑같아요.

- 조립 구조 분해 모션: 하위 조립품 사슬, 맞닿은 축 방향 분리, 볼트는 박힌 방향으로 빠짐, 층 1~최대
- 기준 부품으로 X·Y·Z 축 정렬, 시점 고정, 시점 정렬
- 도면 번호 표시 + 층·부품 목록 하나로 연동, 부품 클릭 → 정보 패널
- 모델명·부품명·조립품명으로 사양서(PDF·TXT)를 검색해 부품 정의와 결합 대상별 조립·분해 절차를 추리고, 근거 구절을 함께 표시
- 선택적으로 AI를 연결해 한글 부품 이름과 설명을 생성 (`원래이름 [한글]`)

언어는 **JavaScript (ES 모듈)** 이고, TypeScript 타입(`src/index.d.ts`)이 들어 있어요. React · Vue · Svelte · 순수 HTML 어디에나 붙일 수 있어요.

```
src/
  index.js        진입점: mountExplodeStudio, core
  index.d.ts      타입 정의
  studio.js       화면·모션·상호작용 (컨테이너 하나에 마운트)
  core.js         형상 해석·조립 구조·모션 계획·사양서 검색 (DOM·three.js 없이도 동작)
  styles.js       스타일 (.xs-root 아래로만 적용, 호스트 페이지에 새지 않음)
  template.js     화면 마크업
```

### 설치

```bash
pnpm add three@0.147.0          # 0.147 이상이면 동작해요 (테스트는 0.147.0)
# 이 폴더를 프로젝트에 복사하거나, 사내 레지스트리에 올린 뒤 pnpm add explode-studio
```

`assets/occt/` 의 파일 세 개(`occt-import-js.js`, `occt-import-js.wasm`, `occt-import-js-worker.js`)는 **정적 파일로 서비스**해야 해요. Vite·Next.js라면 `public/occt/` 에 복사하고 `assetsBase: '/occt/'` 로 두면 돼요. `web/`은 Vite 설정의 `publicDir`로 `assets/`를 그대로 서비스해요.

### 사용

#### 순수 JavaScript

```js
import { mountExplodeStudio } from 'explode-studio';

const studio = mountExplodeStudio(document.getElementById('studio'), {
  assetsBase: '/occt/',
  aiEndpoint: '/api/explode-ai',   // 선택: AI 이름·설명 기능
});

await studio.loadUrl('/models/Body_HCR3A_R00_3D.stp');
studio.explode();
studio.on('select', d => console.log(d.name));
```

#### React

```jsx
import ExplodeStudio from './ExplodeStudio';   // examples/react/ExplodeStudio.jsx

<ExplodeStudio options={{ assetsBase: '/occt/', aiEndpoint: '/api/explode-ai' }}
               onReady={api => api.loadUrl('/models/robot.stp')} />
```

#### Vue

```js
onMounted(() => { api = mountExplodeStudio(el.value, { assetsBase: '/occt/' }); });
onBeforeUnmount(() => api.destroy());
```

### 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `assetsBase` | `'/occt/'` | STEP 해석기 파일이 있는 경로 |
| `pdfjsBase` | cdnjs pdf.js 3.11.174 | `pdf.min.js`, `pdf.worker.min.js` 가 있는 경로. 사내망이면 직접 호스팅하세요 |
| `aiEndpoint` | 없음 | `POST {prompt, tier}` → `{text}` 를 돌려주는 주소 |
| `ai` | 없음 | 직접 만든 AI 함수 `({prompt, tier, signal}) => JSON 또는 텍스트` |
| `initial` | `'watch'` | 처음 보여 줄 예시: `'watch'`, `'box'`, `null`(빈 화면) |
| `fonts` | `true` | IBM Plex 글꼴을 Google Fonts에서 불러올지 |
| `title` | `'분해도 스튜디오'` | 상단 제목 |
| `sampleStepUrl` | `null` | 예시 STEP 버튼에 연결할 파일 주소 (없으면 버튼 숨김) |

AI 연결 없이도 사양서에서 부품별 설명·조립 절차와 근거 구절을 찾을 수 있어요. AI 연결은 한글 이름과 생성형 설명이 필요할 때 선택해서 설정하면 돼요.

### API

| 메서드 | 설명 |
|---|---|
| `loadFile(file)` / `loadUrl(url, name?)` | 모델 열기 (조립 상태로 열림) |
| `loadSpec(file)` | 사양서 PDF·TXT 읽기 → 모델·부품별 정의 및 결합 대상별 조립·분해 절차와 근거 구절 검색 |
| `explode()` / `assemble()` / `next()` / `prev()` / `go(step)` / `play()` | 분해·조립·단계 이동 |
| `setLayerCount(n)` | 층 개수 (1 ~ 최대) |
| `selectPart(이름 또는 id)` | 부품 선택 + 시점 이동 + 정보 패널 |
| `alignView()` | 시점 정렬 |
| `runAi()` | AI 이름·설명 한 번에 붙이기 (제품별 캐시) |
| `getState()` | 현재 상태 |
| `on('model' \| 'step' \| 'select', fn)` | 이벤트 구독 (해제 함수 반환) |
| `destroy()` | 정리 (렌더러·워커·이벤트 해제) |

`core` 로는 화면 없이 계산만 쓸 수 있어요. 예: 서버에서 STEP 구조를 미리 분석하거나 시험 세트를 자동 점검할 때.

### AI 서버 연결

브라우저에 API 키를 넣으면 안 되기 때문에, AI는 회사 서버를 거쳐 부르게 되어 있어요.

```bash
cd server
pnpm add @anthropic-ai/sdk
ANTHROPIC_API_KEY=sk-ant-... ALLOW_ORIGIN=https://your.site node claude-endpoint.mjs
```

- `tier: 'default'` 는 AI 정리 버튼의 한 번짜리 호출이에요(부품 전체 이름·설명). `tier: 'quick'` 은 목록에 없는 부품을 눌렀을 때 그 부품만 설명하는 짧은 호출이에요.
- 사용할 모델은 환경 변수 `MODEL_DEFAULT`, `MODEL_QUICK` 으로 바꿀 수 있어요.

### 라이선스 확인이 필요한 부분

- **occt-import-js / OpenCASCADE**: LGPL-2.1 (OCCT는 LGPL-2.1 + 예외). `assets/occt/` 의 라이선스 파일을 함께 배포하고, 해석기 파일을 수정 없이 별도 파일로 쓰는 지금 방식을 유지하세요. 상용 배포 전에는 법무 확인을 권장해요.
- **pdf.js**: Apache-2.0. **IBM Plex** 글꼴: SIL OFL. **QUDT**(온톨로지 검사에 쓰는 단위 사전): CC BY 4.0.
- 이 패키지의 나머지 코드는 사내용으로 표시해 두었어요(`package.json` 의 `license`). 필요에 맞게 바꾸세요.

### 알려진 한계

- SolidWorks·CATIA 원본은 직접 못 읽어요. STEP(AP203/AP214)으로 내보내서 쓰세요.
- 하위 조립 구조가 없는 파일은 부품 하나하나를 묶음으로 취급해요.
- 관절 축이 X·Y·Z에 평행하지 않은 설계는 가장 가까운 축으로 맞춰져요.
- 스캔 이미지 PDF는 글자를 못 뽑아요.
- 테스트한 환경: Chrome · Edge(데스크톱 · 모바일 크기). Safari는 아직 확인하지 못했어요.

### 소스 다시 만들기

이 패키지는 아티팩트와 같은 원본(`core.js`, `app.js`, `demo.js`, `body.html`, `head.html`)에서 `tools/build_module.py` 로 생성돼요. 원본을 고친 뒤 다시 생성하면 두 버전이 항상 같은 동작을 해요.

```bash
python3 tools/build_module.py <occt-import-js dist 폴더>
```
