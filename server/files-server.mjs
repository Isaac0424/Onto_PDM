// PDM 파일 서버: CAD · BOM · 사양서를 파일 보관소(vault)에 올리고 내려받는다. 의존성 없음 (Node 20.19+).
//   POST /api/files?name=<파일명>[&kind=cad|bom|spec]   본문 = 파일 바이트  → 201/200 {sha256, size, name, format, kind, duplicate}
//   GET  /api/files                                     올린 기록 전체
//   GET  /api/files/:sha256                             한 파일의 메타데이터
//   GET  /api/files/:sha256/content                     파일 내려받기
//   /api/cads ...                                       CAD 파일 DB(SQLite, server/cad-db.mjs): 목록 · 저장 · 내려받기 · 속성 갱신 · 삭제
// 실행: node --disable-warning=ExperimentalWarning server/files-server.mjs   (.env 의 PDM_VAULT_DIR · PDM_DB_PATH · FILES_PORT 를 읽는다)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVault, keyOf, VaultError } from './vault.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(repoRoot, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }

export function createFilesServer(vault, { allowOrigin = '*', cads } = {}) {
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);       // ['api', 'files', ...]
      if (parts[0] === 'api' && parts[1] === 'cads') {
        if (!cads) return send(res, 503, { error: 'CAD_DB_UNAVAILABLE', message: 'CAD 파일 DB 가 켜져 있지 않아요' });
        return await cads.handle(req, res, url, parts, (status, body) => send(res, status, body));
      }
      if (parts[0] !== 'api' || parts[1] !== 'files') return send(res, 404, { error: 'NOT_FOUND' });

      if (parts.length === 2 && req.method === 'POST') {
        const name = url.searchParams.get('name');
        if (!name) throw new VaultError('BAD_NAME', 'name 쿼리가 필요해요');
        const saved = await vault.put(req, { name, kind: url.searchParams.get('kind') ?? undefined });
        return send(res, saved.duplicate ? 200 : 201, saved);
      }
      if (parts.length === 2 && req.method === 'GET') return send(res, 200, await vault.list());

      if (parts.length >= 3 && req.method === 'GET') {
        const sha256 = parts[2];
        keyOf(sha256);                                              // 형식이 틀리면 400
        const meta = await vault.meta(sha256);
        if (!meta) return send(res, 404, { error: 'NOT_FOUND' });
        if (parts.length === 3) return send(res, 200, meta);
        if (parts[3] === 'content' && parts.length === 4) {
          const stream = await vault.open(sha256);
          if (!stream) return send(res, 404, { error: 'FILE_MISSING' });
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(meta.size),
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
          });
          stream.pipe(res);
          return;
        }
      }
      send(res, 404, { error: 'NOT_FOUND' });
    } catch (e) {
      if (e instanceof VaultError) {
        if (e.status === 413) {                                       // 상한을 넘은 본문은 더 받지 않고 연결을 닫는다
          res.setHeader('connection', 'close');
          res.once('finish', () => req.destroy());
        }
        return send(res, e.status, { error: e.code, message: e.message });
      }
      console.error(e);
      send(res, 500, { error: 'INTERNAL' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(repoRoot, process.env.PDM_VAULT_DIR || 'data/vault');
  const port = Number(process.env.FILES_PORT || 8788);
  const maxBytes = Number(process.env.PDM_MAX_UPLOAD_MB || 200) * 1024 * 1024;
  const vault = createVault(root, { maxBytes });
  let cads;
  try {
    const { createCadDb } = await import('./cad-db.mjs');            // node:sqlite 가 없는 Node 면 /api/cads 만 꺼진다
    cads = createCadDb(path.resolve(repoRoot, process.env.PDM_DB_PATH || 'data/pdm.sqlite'), { maxBytes, vault });
  } catch (e) { console.error(`CAD 파일 DB 를 열지 못했어요 (/api/cads 꺼짐): ${e.message}`); }
  createFilesServer(vault, { allowOrigin: process.env.ALLOW_ORIGIN || '*', cads })
    .listen(port, '127.0.0.1', () => console.log(`PDM file vault ${root}\n  CAD DB ${cads?.path ?? '(꺼짐)'}\n  http://127.0.0.1:${port}/api/files  /api/cads`));
}
