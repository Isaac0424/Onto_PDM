# explode-studio

CAD 파일(STEP · IGES · STL · OBJ · GLB)을 올리면 3D로 띄우고, 조립 구조를 따라 분해 모션으로 보여 주는 웹 컴포넌트예요. claude.ai에서 쓰던 "분해도 스튜디오"와 **같은 코드**에서 만들어져서 기능이 똑같아요.

- 조립 구조 분해 모션: 하위 조립품 사슬, 맞닿은 축 방향 분리, 볼트는 박힌 방향으로 빠짐, 층 1~최대
- 기준 부품으로 X·Y·Z 축 정렬, 시점 고정, 시점 정렬
- 도면 번호 표시 + 층·부품 목록 하나로 연동, 부품 클릭 → 정보 패널
- 모델명·부품명·조립품명으로 사양서(PDF·TXT)를 검색해 부품 정의와 결합 대상별 조립·분해 절차를 추리고, 근거 구절을 함께 표시
- 선택적으로 AI를 연결해 한글 부품 이름과 설명을 생성 (`원래이름 [한글]`)

언어는 **JavaScript (ES 모듈)** 이고, TypeScript 타입(`src/index.d.ts`)이 들어 있어요. React · Vue · Svelte · 순수 HTML 어디에나 붙일 수 있어요.

## 폴더 구성

```
src/
  index.js        진입점: mountExplodeStudio, core
  index.d.ts      타입 정의
  studio.js       화면·모션·상호작용 (컨테이너 하나에 마운트)
  core.js         형상 해석·조립 구조·모션 계획·사양서 검색 (DOM·three.js 없이도 동작)
  styles.js       스타일 (.xs-root 아래로만 적용, 호스트 페이지에 새지 않음)
  template.js     화면 마크업
assets/occt/      STEP·IGES 해석기 (occt-import-js, WebAssembly 약 7.6MB) + 라이선스
examples/vanilla  번들러 없는 HTML 예제
examples/react    React 컴포넌트
server/           AI 호출용 Node 서버 예제 (Claude API)
```

## 설치

```bash
npm install three@0.147.0          # 0.147 이상이면 동작해요 (테스트는 0.147.0)
# 이 폴더를 프로젝트에 복사하거나, 사내 레지스트리에 올린 뒤 npm install explode-studio
```

`assets/occt/` 의 파일 세 개(`occt-import-js.js`, `occt-import-js.wasm`, `occt-import-js-worker.js`)는 **정적 파일로 서비스**해야 해요. Vite·Next.js라면 `public/occt/` 에 복사하고 `assetsBase: '/occt/'` 로 두면 돼요.

## 사용

### 순수 JavaScript

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

### React

```jsx
import ExplodeStudio from './ExplodeStudio';   // examples/react/ExplodeStudio.jsx

<ExplodeStudio options={{ assetsBase: '/occt/', aiEndpoint: '/api/explode-ai' }}
               onReady={api => api.loadUrl('/models/robot.stp')} />
```

### Vue

```js
onMounted(() => { api = mountExplodeStudio(el.value, { assetsBase: '/occt/' }); });
onBeforeUnmount(() => api.destroy());
```

## 옵션

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

## API

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

## AI 서버 연결

브라우저에 API 키를 넣으면 안 되기 때문에, AI는 회사 서버를 거쳐 부르게 되어 있어요.

```bash
cd server
npm install @anthropic-ai/sdk
ANTHROPIC_API_KEY=sk-ant-... ALLOW_ORIGIN=https://your.site node claude-endpoint.mjs
```

- `tier: 'default'` 는 AI 정리 버튼의 한 번짜리 호출이에요(부품 전체 이름·설명). `tier: 'quick'` 은 목록에 없는 부품을 눌렀을 때 그 부품만 설명하는 짧은 호출이에요.
- 사용할 모델은 환경 변수 `MODEL_DEFAULT`, `MODEL_QUICK` 으로 바꿀 수 있어요.

## 라이선스 확인이 필요한 부분

- **occt-import-js / OpenCASCADE**: LGPL-2.1 (OCCT는 LGPL-2.1 + 예외). `assets/occt/` 의 라이선스 파일을 함께 배포하고, 해석기 파일을 수정 없이 별도 파일로 쓰는 지금 방식을 유지하세요. 상용 배포 전에는 법무 확인을 권장해요.
- **pdf.js**: Apache-2.0. **IBM Plex** 글꼴: SIL OFL.
- 이 패키지의 나머지 코드는 사내용으로 표시해 두었어요(`package.json` 의 `license`). 필요에 맞게 바꾸세요.

## 알려진 한계

- SolidWorks·CATIA 원본은 직접 못 읽어요. STEP(AP203/AP214)으로 내보내서 쓰세요.
- 하위 조립 구조가 없는 파일은 부품 하나하나를 묶음으로 취급해요.
- 관절 축이 X·Y·Z에 평행하지 않은 설계는 가장 가까운 축으로 맞춰져요.
- 스캔 이미지 PDF는 글자를 못 뽑아요.
- 테스트한 환경: Chrome(데스크톱·모바일 크기). Safari는 아직 확인하지 못했어요.

## 소스 다시 만들기

이 패키지는 아티팩트와 같은 원본(`core.js`, `app.js`, `demo.js`, `body.html`, `head.html`)에서 `tools/build_module.py` 로 생성돼요. 원본을 고친 뒤 다시 생성하면 두 버전이 항상 같은 동작을 해요.

```bash
python3 tools/build_module.py <occt-import-js dist 폴더>
```
