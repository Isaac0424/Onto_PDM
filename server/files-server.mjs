// PDM 파일 서버: CAD · BOM · 사양서를 파일 보관소(vault)에 올리고 내려받는다. 의존성 없음 (Node 20.19+).
//   POST /api/files?name=<파일명>[&kind=cad|bom|spec]   본문 = 파일 바이트  → 201/200 {sha256, size, name, format, kind, duplicate}
//   GET  /api/files                                     올린 기록 전체
//   GET  /api/files/:sha256                             한 파일의 메타데이터
//   GET  /api/files/:sha256/content                     파일 내려받기
// 실행: node server/files-server.mjs   (.env 의 PDM_VAULT_DIR · FILES_PORT 를 읽는다)
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVault, keyOf, VaultError } from './vault.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(repoRoot, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }

export function createFilesServer(vault, { allowOrigin = '*' } = {}) {
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);       // ['api', 'files', ...]
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
      if (e instanceof VaultError) return send(res, e.status, { error: e.code, message: e.message });
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
  createFilesServer(vault, { allowOrigin: process.env.ALLOW_ORIGIN || '*' })
    .listen(port, '127.0.0.1', () => console.log(`PDM file vault ${root}\n  http://127.0.0.1:${port}/api/files`));
}
