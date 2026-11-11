import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createVault } from './vault.mjs';
import { createCadDb } from './cad-db.mjs';
import { createFilesServer } from './files-server.mjs';

const sha = buf => createHash('sha256').update(buf).digest('hex');

/** 임시 폴더의 DB · vault 로 서버를 실제로 띄운다 (사용자의 data/ 는 건드리지 않는다) */
async function setup({ maxBytes, withVault = true, dir } = {}) {
  const root = dir ?? await mkdtemp(path.join(tmpdir(), 'pdm-cad-'));
  const vault = withVault ? createVault(path.join(root, 'vault'), { maxBytes }) : undefined;
  const cads = createCadDb(path.join(root, 'db', 'pdm.sqlite'), { maxBytes, vault });
  const server = createFilesServer(vault ?? createVault(path.join(root, 'unused')), { cads });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    root, vault, cads, origin, base: `${origin}/api/cads`,
    stop: async ({ keep = false } = {}) => {
      server.closeAllConnections();
      await new Promise(r => server.close(r));
      cads.close();
      if (!keep) await rm(root, { recursive: true, force: true });
    },
  };
}

const post = (base, name, body) => fetch(`${base}?name=${encodeURIComponent(name)}`, { method: 'POST', body });
const patch = (base, id, body) => fetch(`${base}/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bytes = async res => Buffer.from(await res.arrayBuffer());

test('저장 → 목록 → 내용이 바이트까지 같다', async () => {
  const s = await setup();
  const data = Buffer.from([0, 1, 2, 250, 251, 255, 10, 13]);
  const up = await post(s.base, '도면 A.glb', data);
  assert.equal(up.status, 201);
  const saved = await up.json();
  assert.deepEqual(
    { ...saved, uploadedAt: typeof saved.uploadedAt },
    { id: sha(data), name: '도면 A.glb', format: 'glb', size: data.length, uploadedAt: 'string', lastOpenedAt: null, parts: null, layers: null, duplicate: false, vault: 'saved' },
  );

  const list = await (await fetch(s.base)).json();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], (({ duplicate, vault, ...rest }) => rest)(saved));

  const down = await fetch(`${s.base}/${saved.id}/content`);
  assert.equal(down.status, 200);
  assert.equal(down.headers.get('content-type'), 'application/octet-stream');
  assert.equal(down.headers.get('content-length'), String(data.length));
  assert.equal(down.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('도면 A.glb')}`);
  assert.deepEqual(await bytes(down), data);
  await s.stop();
});

test('같은 내용은 이름이 달라도 한 행이다 (두 번째는 200, duplicate)', async () => {
  const s = await setup();
  const data = Buffer.from('solid a\nendsolid a');
  const a = await (await post(s.base, 'a.stl', data)).json();
  const again = await post(s.base, '복사본.STL', data);
  assert.equal(again.status, 200);
  const b = await again.json();
  assert.equal(b.id, a.id);
  assert.equal(b.duplicate, true);
  assert.equal(b.name, 'a.stl');                                   // 먼저 등록된 이름을 유지한다
  assert.equal((await (await fetch(s.base)).json()).length, 1);
  await s.stop();
});

test('목록은 최근에 올린 순이다', async () => {
  const s = await setup();
  await post(s.base, 'old.stl', Buffer.from('1'));
  await new Promise(r => setTimeout(r, 5));
  await post(s.base, 'new.stl', Buffer.from('2'));
  assert.deepEqual((await (await fetch(s.base)).json()).map(r => r.name), ['new.stl', 'old.stl']);
  await s.stop();
});

test('삭제는 소프트: 목록 · 내용에서 사라지고 DB 에는 남으며, 다시 올리면 되살아난다', async () => {
  const s = await setup();
  const data = Buffer.from('ISO-10303-21;');
  const a = await (await post(s.base, 'a.step', data)).json();
  assert.equal((await fetch(`${s.base}/${a.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${s.base}/${a.id}`, { method: 'DELETE' })).status, 204);   // 멱등
  assert.deepEqual(await (await fetch(s.base)).json(), []);
  const gone = await fetch(`${s.base}/${a.id}/content`);
  assert.equal(gone.status, 404);
  assert.equal((await gone.json()).error, 'NOT_FOUND');
  assert.equal((await patch(s.base, a.id, { parts: 1 })).status, 404);
  assert.equal((await fetch(`${s.base}/${'0'.repeat(64)}`, { method: 'DELETE' })).status, 404);

  // 내용은 DB 에 남아 있다 (deleted_at 만 기록)
  const raw = new DatabaseSync(s.cads.path, { readOnly: true });
  const row = raw.prepare('SELECT length(data) AS n, deleted_at FROM cad_file WHERE id = ?').get(a.id);
  raw.close();
  assert.equal(row.n, data.length);
  assert.match(row.deleted_at, /^\d{4}-\d\d-\d\dT/);

  const back = await post(s.base, '새이름.step', data);
  assert.equal(back.status, 201);
  const revived = await back.json();
  assert.equal(revived.id, a.id);
  assert.equal(revived.duplicate, false);
  assert.equal(revived.name, '새이름.step');                       // 이름을 갱신
  assert.deepEqual(await bytes(await fetch(`${s.base}/${a.id}/content`)), data);
  assert.equal((await (await fetch(s.base)).json()).length, 1);
  await s.stop();
});

test('PATCH: parts · layers · opened 를 기록하고 잘못된 값은 400', async () => {
  const s = await setup();
  const a = await (await post(s.base, 'a.obj', Buffer.from('o x\nv 0 0 0'))).json();
  const r = await patch(s.base, a.id, { parts: 23, layers: 15 });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ...(({ duplicate, vault, ...rest }) => rest)(a), parts: 23, layers: 15 });

  const before = (await (await fetch(s.base)).json())[0];
  assert.equal(before.lastOpenedAt, null);
  await fetch(`${s.base}/${a.id}/content`);                         // 내려받기만으로는 열람 시각이 바뀌지 않는다
  assert.equal((await (await fetch(s.base)).json())[0].lastOpenedAt, null);
  const opened = await (await patch(s.base, a.id, { opened: true })).json();
  assert.match(opened.lastOpenedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(opened.parts, 23);                                   // 안 보낸 값은 그대로

  assert.equal((await patch(s.base, a.id, { parts: 0 })).status, 200);
  for (const bad of [{ parts: -1 }, { parts: 1.5 }, { layers: '3' }, { parts: null }, { opened: false }, { opened: 'yes' }, [], 'x']) {
    const res = await patch(s.base, a.id, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await res.json()).error, 'BAD_BODY');
  }
  const notJson = await fetch(`${s.base}/${a.id}`, { method: 'PATCH', body: '{깨짐' });
  assert.equal(notJson.status, 400);
  assert.equal((await patch(s.base, '1'.repeat(64), { parts: 1 })).status, 404);
  assert.equal((await (await fetch(s.base)).json())[0].parts, 0);   // 거부된 요청은 아무것도 바꾸지 않았다
  await s.stop();
});

test('오류: 형식 · 빈 본문 · 이름 · 크기 · id', async () => {
  const s = await setup({ maxBytes: 1024 });
  const unsupported = await post(s.base, 'run.exe', Buffer.from('x'));
  assert.equal(unsupported.status, 415);
  assert.equal((await unsupported.json()).error, 'UNSUPPORTED_FORMAT');
  assert.equal((await post(s.base, 'manual.pdf', Buffer.from('x'))).status, 415);       // vault 형식이지만 CAD 가 아니다
  assert.equal((await post(s.base, 'noext', Buffer.from('x'))).status, 415);

  const empty = await post(s.base, 'a.step', Buffer.alloc(0));
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, 'EMPTY');

  const noName = await fetch(s.base, { method: 'POST', body: 'x' });
  assert.equal(noName.status, 400);
  assert.equal((await noName.json()).error, 'BAD_NAME');
  assert.equal((await post(s.base, '..', Buffer.from('x'))).status, 400);

  const big = await post(s.base, 'big.step', Buffer.alloc(2048, 1));
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, 'TOO_LARGE');

  for (const id of ['abc', 'A'.repeat(64), `${'a'.repeat(63)}`, 'g'.repeat(64)]) {
    for (const [method, suffix] of [['GET', '/content'], ['DELETE', ''], ['PATCH', '']]) {
      const res = await fetch(`${s.base}/${id}${suffix}`, { method, ...(method === 'PATCH' ? { body: '{}' } : {}) });
      assert.equal(res.status, 400, `${method} ${id}`);
      assert.equal((await res.json()).error, 'BAD_ID');
    }
  }
  assert.equal((await fetch(`${s.base}/${'b'.repeat(64)}/content`)).status, 404);
  assert.deepEqual(await (await fetch(s.base)).json(), []);        // 거부된 업로드는 DB 에 남지 않는다
  await s.stop();
});

test('경로가 섞인 이름은 파일명만 남긴다', async () => {
  const s = await setup();
  const r = await (await post(s.base, '..\\..\\evil/bracket.step', Buffer.from('x'))).json();
  assert.equal(r.name, 'bracket.step');
  await s.stop();
});

test('vault 미러: 저장됨 → 이미 있음, 그리고 OPMS 가 읽는 vault 에 같은 바이트가 있다', async () => {
  const s = await setup();
  const data = Buffer.from('mirror me');
  assert.equal((await (await post(s.base, 'm.stl', data)).json()).vault, 'saved');
  assert.equal((await (await post(s.base, 'm2.stl', data)).json()).vault, 'duplicate');
  const rows = await s.vault.list();
  assert.equal(rows[0].sha256, sha(data));
  assert.equal(rows[0].kind, 'cad');
  assert.deepEqual(await s.vault.verify(), []);
  await s.stop();
});

test('vault 가 없거나 실패해도 DB 저장은 성공하고 vault 만 unavailable', async () => {
  const s = await setup({ withVault: false });
  const res = await post(s.base, 'a.stl', Buffer.from('abc'));
  assert.equal(res.status, 201);
  assert.equal((await res.json()).vault, 'unavailable');
  await s.stop();

  const dir = await mkdtemp(path.join(tmpdir(), 'pdm-cad-'));
  const broken = { put: async () => { throw new Error('disk full'); } };
  const cads = createCadDb(path.join(dir, 'pdm.sqlite'), { vault: broken });
  const server = createFilesServer(createVault(path.join(dir, 'v')), { cads });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/cads`;
  const r2 = await post(base, 'b.stl', Buffer.from('abc'));
  assert.equal(r2.status, 201);
  assert.equal((await r2.json()).vault, 'unavailable');
  assert.equal((await (await fetch(base)).json()).length, 1);
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  cads.close();
  await rm(dir, { recursive: true, force: true });
});

test('목록은 BLOB 을 읽지 않아 큰 파일이 많아도 빠르다', async () => {
  const s = await setup();
  for (let i = 0; i < 4; i++) assert.equal((await post(s.base, `big${i}.glb`, randomBytes(8 * 1024 * 1024))).status, 201);
  const t0 = performance.now();
  const rows = await (await fetch(s.base)).json();
  const ms = performance.now() - t0;
  assert.equal(rows.length, 4);
  assert.ok(rows.every(r => r.size === 8 * 1024 * 1024 && !('data' in r)));
  assert.ok(ms < 500, `목록 ${ms.toFixed(0)}ms`);
  await s.stop();
});

test('서버를 다시 띄워도 데이터가 남는다 (영속)', async () => {
  const s1 = await setup();
  const data = randomBytes(5000);
  const a = await (await post(s1.base, '영속.step', data)).json();
  await patch(s1.base, a.id, { parts: 7, layers: 3 });
  await s1.stop({ keep: true });

  const s2 = await setup({ dir: s1.root });
  const rows = await (await fetch(s2.base)).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '영속.step');
  assert.equal(rows[0].parts, 7);
  assert.deepEqual(await bytes(await fetch(`${s2.base}/${a.id}/content`)), data);
  await s2.stop();
});

test('CORS: PATCH · DELETE 를 허용하고, 기존 /api/files 는 그대로 동작한다', async () => {
  const s = await setup();
  const pre = await fetch(s.base, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /PATCH.*DELETE|DELETE.*PATCH/);

  const data = Buffer.from('files api');
  const up = await fetch(`${s.origin}/api/files?name=a.glb`, { method: 'POST', body: data });
  assert.equal(up.status, 201);
  const saved = await up.json();
  assert.deepEqual(await bytes(await fetch(`${s.origin}/api/files/${saved.sha256}/content`)), data);
  assert.equal((await (await fetch(`${s.origin}/api/files`)).json()).length, 1);
  assert.equal((await fetch(`${s.origin}/api/files/not-a-hash`)).status, 400);
  assert.equal((await fetch(`${s.origin}/api/other`)).status, 404);
  assert.equal((await fetch(s.base, { method: 'PUT' })).status, 404);
  await s.stop();
});

test('CAD DB 를 켜지 않은 서버는 /api/cads 에 503 을 돌려준다', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pdm-cad-'));
  const server = createFilesServer(createVault(dir));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/cads`);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'CAD_DB_UNAVAILABLE');
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await rm(dir, { recursive: true, force: true });
});
