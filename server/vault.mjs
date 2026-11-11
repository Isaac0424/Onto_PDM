// File vault: 올린 CAD · BOM · 사양서 원본을 DB와 따로 둔다 (db/schema.sql 의 file_object.storage_key 규칙).
//   <root>/ab/cd/<sha256>   내용 기준 이름. 같은 파일을 다시 올려도 저장은 한 번.
//   <root>/manifest.jsonl   올린 기록(원래 파일명 · 종류 · 시각). 줄 단위로 덧붙이기만 한다.
// OPMS 는 이 폴더를 읽기 전용으로 본다. 쓰는 쪽은 PDM 하나뿐이고, 삭제는 하지 않는다.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const FORMATS = {
  step: 'cad', stp: 'cad', iges: 'cad', igs: 'cad', stl: 'cad', obj: 'cad', glb: 'cad', gltf: 'cad',
  xlsx: 'bom', csv: 'bom',
  pdf: 'spec', txt: 'spec', md: 'spec',
};
export const KINDS = ['cad', 'bom', 'spec'];
const SHA256 = /^[0-9a-f]{64}$/;

export class VaultError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function formatOf(fileName) {
  const ext = path.extname(String(fileName)).slice(1).toLowerCase();
  if (!(ext in FORMATS)) throw new VaultError('UNSUPPORTED_FORMAT', `지원하지 않는 파일 형식이에요: .${ext || '(없음)'}`, 415);
  return ext;
}

// 사용자가 준 이름에서 경로를 떼고 길이를 줄인다. 저장 경로에는 쓰지 않고 기록에만 남긴다.
export function cleanName(fileName) {
  const base = String(fileName).replace(/\\/g, '/').split('/').pop().replace(/[\u0000-\u001f]/g, '').trim();
  if (!base || base === '.' || base === '..') throw new VaultError('BAD_NAME', '파일 이름이 비어 있어요');
  return base.slice(0, 255);
}

export function keyOf(sha256) {
  if (!SHA256.test(sha256)) throw new VaultError('BAD_HASH', 'sha256 형식이 아니에요');
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

export function createVault(root, { maxBytes = 200 * 1024 * 1024 } = {}) {
  const base = path.resolve(root);
  const manifestPath = path.join(base, 'manifest.jsonl');
  const tmpDir = path.join(base, '.tmp');
  const pathOf = sha256 => path.join(base, ...keyOf(sha256).split('/'));

  async function readManifest() {
    let text;
    try { text = await readFile(manifestPath, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  // body: 읽을 수 있는 스트림(HTTP 요청 · fs 스트림). 크기 제한을 넘으면 413 으로 멈춘다.
  async function put(body, { name, kind }) {
    const fileName = cleanName(name);
    const format = formatOf(fileName);
    const realKind = kind ?? FORMATS[format];
    if (!KINDS.includes(realKind)) throw new VaultError('BAD_KIND', `kind 는 ${KINDS.join(' · ')} 중 하나예요`);

    await mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, randomBytes(8).toString('hex'));
    const hash = createHash('sha256');
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        const out = createWriteStream(tmp, { flags: 'wx' });
        out.on('error', reject).on('finish', resolve);
        body.on('error', reject);
        body.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) { body.destroy(); out.destroy(); reject(new VaultError('TOO_LARGE', `파일이 너무 커요 (최대 ${Math.floor(maxBytes / 1024 / 1024)}MB)`, 413)); return; }
          hash.update(chunk);
        });
        body.pipe(out);
      });
      if (size === 0) throw new VaultError('EMPTY', '빈 파일이에요');

      const sha256 = hash.digest('hex');
      const final = pathOf(sha256);
      let duplicate = true;
      try { await stat(final); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        duplicate = false;
        await mkdir(path.dirname(final), { recursive: true });
        await rename(tmp, final);
      }
      const record = { sha256, size, name: fileName, format, kind: realKind, uploadedAt: new Date().toISOString() };
      await appendFile(manifestPath, JSON.stringify(record) + '\n', 'utf8');
      return { ...record, duplicate, key: keyOf(sha256) };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async function list() { return readManifest(); }

  async function meta(sha256) {
    const rows = (await readManifest()).filter(r => r.sha256 === sha256);
    if (!rows.length) return undefined;
    return { ...rows[0], names: [...new Set(rows.map(r => r.name))], uploads: rows.length };
  }

  async function open(sha256) {
    const file = pathOf(sha256);
    try { await stat(file); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
    return createReadStream(file);
  }

  // 저장된 내용이 이름(sha256)과 같은지 다시 계산한다. 어긋난 해시 목록을 돌려준다.
  async function verify() {
    const bad = [];
    for (const sha256 of new Set((await readManifest()).map(r => r.sha256))) {
      const hash = createHash('sha256');
      try { for await (const chunk of createReadStream(pathOf(sha256))) hash.update(chunk); } catch { bad.push(sha256); continue; }
      if (hash.digest('hex') !== sha256) bad.push(sha256);
    }
    return bad;
  }

  return { root: base, put, list, meta, open, verify };
}
