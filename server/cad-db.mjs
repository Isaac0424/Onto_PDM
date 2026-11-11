// CAD 파일 DB: 올린 CAD 의 정본을 SQLite(node:sqlite, 의존성 없음) 한 파일에 BLOB 으로 둔다.
//   표 cad_file: id = 내용의 sha256 → 같은 내용은 이름이 달라도 한 행. 삭제는 deleted_at 만 기록하는 소프트 삭제다.
//   파일 보관소(vault)는 OPMS 가 읽는 미러다: 저장에 성공하면 같은 바이트를 vault 에도 best-effort 로 보낸다.
// HTTP 는 files-server.mjs 가 /api/cads 를 이 모듈의 handle() 로 넘긴다.
//   GET    /api/cads                 삭제 안 된 CAD 목록 (BLOB 은 읽지 않는다)
//   POST   /api/cads?name=<파일명>   본문 = 파일 바이트 → 201(새로) / 200(이미 있음)
//   GET    /api/cads/:id/content     원본 바이트
//   PATCH  /api/cads/:id             {parts?, layers?, opened?}
//   DELETE /api/cads/:id             소프트 삭제 (204)
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { FORMATS, VaultError, cleanName, formatOf } from './vault.mjs';

const ID = /^[0-9a-f]{64}$/;
const MAX_JSON = 4096;

const COLUMNS = 'id, name, format, size, uploaded_at, last_opened_at, parts, layers';
const toRow = r => ({
  id: r.id, name: r.name, format: r.format, size: r.size,
  uploadedAt: r.uploaded_at, lastOpenedAt: r.last_opened_at ?? null, parts: r.parts ?? null, layers: r.layers ?? null,
});

const badId = () => new VaultError('BAD_ID', 'id 는 64자리 소문자 hex(sha256)여야 해요');
const notFound = () => new VaultError('NOT_FOUND', '등록된 CAD 가 아니에요', 404);

/**
 * @param {string} dbPath  SQLite 파일 경로 (상위 폴더는 만든다)
 * @param {{ maxBytes?: number, vault?: { put(body: import('node:stream').Readable, meta: { name: string, kind?: string }): Promise<{ duplicate: boolean }> } }} [opts]
 */
export function createCadDb(dbPath, { maxBytes = 200 * 1024 * 1024, vault } = {}) {
  const file = path.resolve(dbPath);
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS cad_file (
      id             TEXT PRIMARY KEY,          -- 내용의 sha256 (소문자 hex 64자)
      name           TEXT NOT NULL,
      format         TEXT NOT NULL,
      size           INTEGER NOT NULL,
      data           BLOB NOT NULL,
      uploaded_at    TEXT NOT NULL,
      last_opened_at TEXT,
      parts          INTEGER,
      layers         INTEGER,
      deleted_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS cad_file_uploaded ON cad_file (uploaded_at DESC);
  `);

  const q = {
    list: db.prepare(`SELECT ${COLUMNS} FROM cad_file WHERE deleted_at IS NULL ORDER BY uploaded_at DESC, rowid DESC`),
    meta: db.prepare(`SELECT ${COLUMNS}, deleted_at FROM cad_file WHERE id = ?`),
    content: db.prepare('SELECT name, size, data FROM cad_file WHERE id = ? AND deleted_at IS NULL'),
    insert: db.prepare('INSERT INTO cad_file (id, name, format, size, data, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)'),
    revive: db.prepare('UPDATE cad_file SET name = ?, uploaded_at = ?, deleted_at = NULL WHERE id = ?'),
    remove: db.prepare('UPDATE cad_file SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
    parts: db.prepare('UPDATE cad_file SET parts = ? WHERE id = ?'),
    layers: db.prepare('UPDATE cad_file SET layers = ? WHERE id = ?'),
    opened: db.prepare('UPDATE cad_file SET last_opened_at = ? WHERE id = ?'),
  };

  const live = id => {
    const r = q.meta.get(id);
    return r && !r.deleted_at ? r : undefined;
  };

  const list = () => q.list.all().map(toRow);

  /** 본문을 크기 상한까지만 모은다. 넘으면 읽기를 멈추고 TOO_LARGE */
  function collect(body, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      body.on('data', chunk => {
        size += chunk.length;
        if (size > limit) { body.pause(); body.removeAllListeners('data'); reject(new VaultError('TOO_LARGE', `파일이 너무 커요 (최대 ${Math.floor(maxBytes / 1024 / 1024)}MB)`, 413)); return; }
        chunks.push(chunk);
      });
      body.on('end', () => resolve(Buffer.concat(chunks)));
      body.on('error', reject);
    });
  }

  async function mirror(buffer, name) {
    if (!vault) return 'unavailable';
    try { return (await vault.put(Readable.from([buffer]), { name, kind: 'cad' })).duplicate ? 'duplicate' : 'saved'; }
    catch { return 'unavailable'; }
  }

  /** 새로 저장(201) · 이미 있음(200) · 삭제됐던 것을 되살림(201, duplicate=false). 파일 이름은 정규화해 둔다 */
  async function put(body, { name, declaredSize }) {
    if (!name) throw new VaultError('BAD_NAME', 'name 쿼리가 필요해요');
    const fileName = cleanName(name);
    const format = formatOf(fileName);
    if (FORMATS[format] !== 'cad') throw new VaultError('UNSUPPORTED_FORMAT', `CAD 파일이 아니에요: .${format}`, 415);
    if (declaredSize !== undefined && declaredSize > maxBytes) throw new VaultError('TOO_LARGE', `파일이 너무 커요 (최대 ${Math.floor(maxBytes / 1024 / 1024)}MB)`, 413);

    const buffer = await collect(body, maxBytes);
    if (buffer.length === 0) throw new VaultError('EMPTY', '빈 파일이에요');
    const id = createHash('sha256').update(buffer).digest('hex');

    const known = q.meta.get(id);
    const now = new Date().toISOString();
    let duplicate = false;
    if (!known) q.insert.run(id, fileName, format, buffer.length, buffer, now);
    else if (known.deleted_at) q.revive.run(fileName, now, id);
    else duplicate = true;

    const vaultStatus = await mirror(buffer, fileName);
    return { created: !duplicate, entry: { ...toRow(q.meta.get(id)), duplicate, vault: vaultStatus } };
  }

  function content(id) {
    if (!ID.test(id)) throw badId();
    const r = q.content.get(id);
    if (!r) throw notFound();
    return { name: r.name, size: r.size, data: Buffer.from(r.data) };
  }

  function patch(id, body) {
    if (!ID.test(id)) throw badId();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new VaultError('BAD_BODY', '본문은 JSON 객체여야 해요');
    for (const key of ['parts', 'layers']) {
      if (key in body && !(Number.isInteger(body[key]) && body[key] >= 0)) throw new VaultError('BAD_BODY', `${key} 는 0 이상의 정수여야 해요`);
    }
    if ('opened' in body && body.opened !== true) throw new VaultError('BAD_BODY', 'opened 는 true 만 받아요');
    if (!live(id)) throw notFound();
    if ('parts' in body) q.parts.run(body.parts, id);
    if ('layers' in body) q.layers.run(body.layers, id);
    if (body.opened === true) q.opened.run(new Date().toISOString(), id);
    return toRow(q.meta.get(id));
  }

  function remove(id) {
    if (!ID.test(id)) throw badId();
    if (!q.meta.get(id)) throw notFound();
    q.remove.run(new Date().toISOString(), id);              // 이미 삭제된 것은 0행 갱신 = 멱등
  }

  async function readJson(req) {
    const buffer = await collect(req, MAX_JSON).catch(e => { throw e.code === 'TOO_LARGE' ? new VaultError('BAD_BODY', '본문이 너무 커요') : e; });
    try { return JSON.parse(buffer.toString('utf8')); } catch { throw new VaultError('BAD_BODY', '본문이 JSON 이 아니에요'); }
  }

  /** files-server 가 /api/cads 요청을 넘겨준다. send(status, body) 는 JSON 응답 도우미 */
  async function handle(req, res, url, parts, send) {
    if (parts.length === 2) {
      if (req.method === 'GET') return send(200, list());
      if (req.method === 'POST') {
        const declared = req.headers['content-length'] === undefined ? undefined : Number(req.headers['content-length']);
        const out = await put(req, { name: url.searchParams.get('name'), declaredSize: declared });
        return send(out.created ? 201 : 200, out.entry);
      }
    } else if (parts.length === 3) {
      const id = parts[2];
      if (req.method === 'PATCH') {
        if (!ID.test(id)) throw badId();
        return send(200, patch(id, await readJson(req)));
      }
      if (req.method === 'DELETE') { remove(id); res.writeHead(204).end(); return; }
    } else if (parts.length === 4 && parts[3] === 'content' && req.method === 'GET') {
      const c = content(parts[2]);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(c.data.length),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(c.name)}`,
      }).end(c.data);
      return;
    }
    send(404, { error: 'NOT_FOUND' });
  }

  return { path: file, list, put, content, patch, remove, handle, close: () => db.close() };
}
