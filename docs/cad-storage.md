# CAD 파일 저장 (DB 정본)

올린 CAD 파일 자체는 **SQLite DB 한 파일**에 BLOB 으로 저장한다. 브라우저를 닫아도, 다른 컴퓨터에서 열어도 같은 CAD 가 남는다.

## 저장 구조

| 계층 | 역할 | 수명 |
|---|---|---|
| **DB** (`server/cad-db.mjs`, `data/pdm.sqlite`) | CAD 파일의 **정본**. 목록의 근거 | 영구 (소프트 삭제 외에는 지우지 않는다) |
| **파일 보관소** (`server/vault.mjs`, `PDM_VAULT_DIR`) | OPMS 가 읽기 전용으로 보는 **미러**. 저장에 성공하면 같은 바이트를 best-effort 로 한 번 더 둔다 | 영구, 삭제하지 않음 |
| **브라우저 캐시** (IndexedDB, 웹 쪽) | 열어 본 CAD 를 빨리 다시 열기 위한 **캐시**. 창을 닫은 뒤 10분 동안 보던 CAD 를 복원한다 | 10분 |

- id 는 파일 이름이 아니라 **내용의 sha256** 이다: 이름이 달라도 내용이 같으면 한 행이다.
- 이는 `db/schema.sql` 의 "파일 본체는 DB 에 넣지 않는다"(`file_object.storage_key`) 원칙과 다르다. 사용자 요구(CAD 파일 자체를 DB 에 저장)로 **CAD 에 한해** 예외를 둔다. 아직 PostgreSQL 에는 연결하지 않았으며, 이전은 `docs/backend-plan.md` 의 pdm 스키마가 PostgreSQL 에 올라간 뒤에 한다 (아래 "한계").
- 표 `cad_file`:

| 열 | 형 | 설명 |
|---|---|---|
| `id` | TEXT PK | 내용의 sha256 (소문자 hex 64자) |
| `name` | TEXT | 파일 이름 (경로 제거, 255자) |
| `format` | TEXT | 확장자: `step stp iges igs stl obj glb gltf` |
| `size` | INTEGER | 바이트 수 |
| `data` | BLOB | 파일 내용 |
| `uploaded_at` | TEXT | 올린 시각 (ISO 8601). 목록은 이 값의 내림차순 |
| `last_opened_at` | TEXT | 마지막으로 열었다고 알려 온 시각 (없으면 NULL) |
| `parts` · `layers` | INTEGER | 분석이 끝난 뒤 알게 된 부품 · 단계 수 (없으면 NULL) |
| `deleted_at` | TEXT | 소프트 삭제 시각 (NULL 이면 살아 있음) |

## 실행

```bash
node --disable-warning=ExperimentalWarning server/files-server.mjs     # http://127.0.0.1:8788/api/cads  (+ /api/files)
node --disable-warning=ExperimentalWarning --test server/vault.test.mjs server/cad-db.test.mjs
```

`node:sqlite` 를 쓰므로 Node 22.13 이상이 필요하다 (새 의존성 없음). 이 모듈이 아직 "실험적"이라는 경고가 뜨는데 `--disable-warning=ExperimentalWarning` 으로 끈다. 웹 개발 서버(vite)는 `/api/cads` 를 이 서버로 넘긴다.

## API

오류 본문은 `{ error: CODE, message }`. id 는 64자리 소문자 hex(sha256) — 아니면 `400 BAD_ID`.

| 요청 | 응답 |
|---|---|
| `GET /api/cads` | `200 [{id, name, format, size, uploadedAt, lastOpenedAt, parts, layers}]` 삭제 안 된 것만, 최근에 올린 순. `lastOpenedAt` · `parts` · `layers` 는 없으면 `null`. BLOB 은 읽지 않는다 |
| `POST /api/cads?name=<파일명>` (본문 = 파일 바이트) | 새로 저장 `201`, 이미 있음 `200`: `{id, name, format, size, uploadedAt, lastOpenedAt, parts, layers, duplicate, vault}` · `vault` 는 `'saved' \| 'duplicate' \| 'unavailable'` |
| `GET /api/cads/:id/content` | `200 application/octet-stream` (`content-length`, `content-disposition: attachment; filename*=UTF-8''…`). 없거나 삭제됨 `404 NOT_FOUND`. 열람 시각은 바꾸지 않는다 |
| `PATCH /api/cads/:id` JSON `{parts?, layers?, opened?}` | `200` 위의 필드(`duplicate` · `vault` 제외). `parts` · `layers` 는 0 이상 정수, `opened: true` 면 `lastOpenedAt` 을 지금으로. 그 외 값은 `400 BAD_BODY`. 없는 id `404` |
| `DELETE /api/cads/:id` | `204` (소프트 삭제, 이미 삭제된 것도 `204`). 없는 id `404` |

`POST` 오류: `415 UNSUPPORTED_FORMAT`(CAD 확장자가 아님), `400 EMPTY`(빈 본문), `400 BAD_NAME`(name 없음 · 빈 이름), `413 TOO_LARGE`(상한 초과: `content-length` 로 먼저 거르고, 모르면 받는 도중 끊는다).

- **중복**: 같은 내용을 다시 올리면 새 행을 만들지 않는다. 이미 살아 있으면 `200`, `duplicate: true`, 이름은 먼저 등록된 것을 유지.
- **되살림**: 소프트 삭제된 내용을 다시 올리면 같은 행을 되살리고 이름을 갱신하고 `uploadedAt` 을 지금으로 한다. 목록에서는 새로 등록한 것과 같으므로 `201`, `duplicate: false`.
- **vault 미러**: DB 저장이 끝난 뒤 `vault.put` 을 부른다. vault 가 없거나 실패해도 DB 저장은 성공이고 `vault` 만 `'unavailable'`. vault 에 이미 있으면 `'duplicate'`.

## 환경 변수

| 이름 | 기본 | 설명 |
|---|---|---|
| `PDM_DB_PATH` | `data/pdm.sqlite` (저장소 루트 기준) | SQLite 파일. 상위 폴더는 자동으로 만든다 |
| `PDM_VAULT_DIR` | `data/vault` | 미러(OPMS 공유) 폴더 |
| `PDM_MAX_UPLOAD_MB` | `200` | 업로드 상한 (vault 와 같다) |
| `FILES_PORT` | `8788` | 서버 포트 (vite 프록시도 이 값을 읽는다) |

`data/*.sqlite*` 는 `.gitignore` 에 있다.

## 소프트 삭제의 뜻

`DELETE` 는 `deleted_at` 만 기록한다. 파일 내용은 DB 에 그대로 남고, 같은 내용을 다시 올리면 되살아난다. 목록 · 내용 · `PATCH` 에서는 보이지 않는다(`404`). 실제로 비우려면 DB 에서 `DELETE FROM cad_file WHERE deleted_at IS NOT NULL` 을 직접 실행하고 `VACUUM` 한다 — 이 기능은 API 로 열지 않았다. vault 쪽 파일은 어떤 경우에도 지우지 않는다.

## 백업

DB 는 WAL 모드라 `pdm.sqlite` 옆에 `-wal` · `-shm` 이 생긴다. 파일만 복사하면 최근 쓰기를 놓칠 수 있으므로 다음 중 하나로 한다.

- 서버를 끄고 세 파일(`pdm.sqlite`, `-wal`, `-shm`)을 함께 복사한다.
- 켠 채로: `sqlite3 data/pdm.sqlite "VACUUM INTO 'backup/pdm-2026-11-11.sqlite'"` (일관된 스냅숏, 새 파일이 없어야 한다).

## 한계

- 업로드 · 내려받기 모두 **파일 전체를 메모리에 올린다**: 상한 200MB(`PDM_MAX_UPLOAD_MB`). 큰 파일을 자주 다루면 스트리밍(BLOB 열기)이나 PostgreSQL large object 로 바꾼다.
- **인증이 없다**: `127.0.0.1` 에만 연다. 팀에 열려면 인증 · 접근 제어를 먼저 붙인다.
- SQLite 는 단일 서버 · 쓰기 한 번에 하나다. 여러 서버가 같은 파일을 공유하는 구성은 지원하지 않는다.
- **PostgreSQL 이전은 `docs/backend-plan.md` 의 pdm 스키마 이후**다. 그때 `cad_file` 을 `bytea` 또는 `file_object` + large object 로 옮기고, 이 API 의 모양은 그대로 둔다.
- `last_opened_at` · `parts` · `layers` 는 클라이언트가 `PATCH` 로 알려 주는 값이라 서버는 파일을 분석하지 않는다.
