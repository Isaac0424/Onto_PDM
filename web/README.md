# Onto PDM 웹 (프론트엔드)

React 18 + TypeScript + Vite 8 (Node 20.19 이상 또는 22.12 이상). 백엔드 API가 생기기 전까지 **목(mock) 데이터**로 돈다.
화면이 쓰는 API 형태(`src/api/types.ts`의 `PdmApi`)는 [docs/pdm-design.md](../docs/pdm-design.md) 9장의 REST API와 같다.

## Quick Start

패키지는 **pnpm**으로 관리한다. 버전은 `package.json`의 `packageManager`(`pnpm@12.11.2`)에 고정돼 있다.

```bash
npm install -g pnpm@12.11.2   # pnpm이 없을 때 한 번
cd web
pnpm install
pnpm dev                      # http://localhost:5173
```

| 명령 | 하는 일 |
|---|---|
| `pnpm dev` | 개발 서버 (코드를 고치면 바로 반영) |
| `pnpm test` | 목 API 규칙 + 화면 테스트 (Vitest, jsdom) |
| `pnpm e2e` | 실제 브라우저 테스트 (Playwright). Windows는 설치된 Edge, 그 밖의 OS는 `pnpm exec playwright install chromium` 한 번 |
| `pnpm typecheck` | 타입 검사만 |
| `pnpm build` | 타입 검사 + 프로덕션 빌드 (`dist/`) |
| `pnpm preview` | 빌드 결과 확인 http://localhost:4173 |
| `pnpm add <패키지>` · `pnpm add -D <패키지>` | 의존성 추가 (`pnpm-lock.yaml`이 함께 바뀐다) |
| `pnpm install --frozen-lockfile` | CI처럼 lock 파일 그대로 설치 |

- `npm install` · `npm run`은 `devEngines` 설정으로 막혀 있다. 실수로 `package-lock.json`이 다시 생기는 것을 막기 위해서다.
- VS Code의 npm 스크립트 탐색기를 쓰면 설정에서 `"npm.packageManager": "pnpm"`으로 바꾼다.

## 화면

| 경로 | 화면 |
|---|---|
| `/items` | 품목 목록. 품번 · 이름 · 별칭(레거시 · ERP · CAD 이름) 검색, 구분 · 상태 · 제품 필터 |
| `/items/:품번` | 품목 상세: 개요(분류 · 재료 · 질량 · 별칭 · 재고), BOM 정전개(생산 보기 / 설계 보기), 사용처, 문서 · 근거 구절, 3D(분해도 뷰어), 이력 |
| `/products` | 제품과 최상위 조립품 |
| `/requests`, `/requests/new`, `/requests/:id` | 내 등록 요청. 임시저장(빈 칸 허용) → 제출 |
| `/admin/requests` | 관리자 모드: 등록 요청 승인(품번 발급) · 반려 |
| `/admin/proposals` | 관리자 모드: 분류 에이전트의 분류 제안 승인 · 기존 분류에 합치기 · 거절 |
| `/admin/publish` | 관리자 모드: 그래프 발행 대기열(outbox) 상태 |

## 목 데이터와 권한

- 데이터는 [src/api/mock/seed.ts](src/api/mock/seed.ts)의 설명용 협동로봇 예시(HCR3A · HCR5A)다. 실제 품번 · 공급사 · 문서가 아니다.
- 브라우저 localStorage에 저장돼서 새로고침해도 임시저장이 남는다. 처음 상태로 돌리려면 상단의 **데모 초기화**를 누른다.
- 상단에서 사용자를 바꿔 볼 수 있다(김관리 = 관리자, 이설계 = 엔지니어).
- 목 API([src/api/mock/mockApi.ts](src/api/mock/mockApi.ts))는 DB · 서버 규칙을 흉내 낸다.
  - 작업중 · 검토중 리비전과 임시저장은 작성자와 관리자 모드만 본다.
  - 품번 발급과 분류 제안 검토는 관리자 모드만 한다.
  - 분류가 없는 요청은 승인할 수 없다.
  - 별칭이 기존 식별자와 겹치면 승인이 거부된다.

## 3D 뷰어

- 저장소 루트의 explode-studio(`../src`)를 그대로 쓴다. three.js가 커서 3D 탭을 열 때만 따로 받는 청크로 나뉜다.
- STEP · IGES 해석기는 `../assets/occt`를 `/occt/`로 서비스한다(`vite.config.ts`의 `publicDir`).
- 목 데이터에는 실제 CAD 파일이 없어 예시 모델을 연다. 뷰어 안에서 STEP 파일을 직접 열 수 있다.

## 백엔드로 바꾸기

`src/api/client.ts`의 `createApi()`만 바꾸면 된다. `PdmApi`를 `fetch`로 구현하고 `VITE_API_MODE=http`로 고른다.
화면 코드는 그대로 둔다.
