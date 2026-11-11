import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createVault, keyOf } from './vault.mjs';
import { createFilesServer } from './files-server.mjs';

const sha = buf => createHash('sha256').update(buf).digest('hex');
const body = buf => Readable.from([buf]);

async function setup(opts) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pdm-vault-'));
  return { dir, vault: createVault(dir, opts), done: () => rm(dir, { recursive: true, force: true }) };
}

test('저장 경로는 내용 해시이고 같은 파일은 한 번만 저장한다', async () => {
  const { dir, vault, done } = await setup();
  const data = Buffer.from('ISO-10303-21;\nHEADER;');
  const a = await vault.put(body(data), { name: 'bracket.step' });
  const b = await vault.put(body(data), { name: '다른이름.STEP' });
  assert.equal(a.sha256, sha(data));
  assert.equal(a.kind, 'cad');
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.deepEqual(await readFile(path.join(dir, ...keyOf(a.sha256).split('/'))), data);
  assert.equal((await vault.list()).length, 2);            // 기록은 둘, 파일은 하나
  assert.deepEqual((await vault.meta(a.sha256)).names, ['bracket.step', '다른이름.STEP']);
  assert.deepEqual(await vault.verify(), []);
  await done();
});

test('경로가 섞인 이름은 기록에서도 파일명만 남고 보관 경로에 쓰이지 않는다', async () => {
  const { dir, vault, done } = await setup();
  const r = await vault.put(body(Buffer.from('a,b\n1,2')), { name: '..\..\evil/bom.csv' });
  assert.equal(r.name, 'bom.csv');
  assert.equal(r.kind, 'bom');
  assert.match(r.key, /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  await done();
});

test('지원하지 않는 형식 · 빈 파일 · 큰 파일은 거부하고 임시 파일을 남기지 않는다', async () => {
  const { vault, done } = await setup({ maxBytes: 10 });
  await assert.rejects(vault.put(body(Buffer.from('x')), { name: 'run.exe' }), { code: 'UNSUPPORTED_FORMAT' });
  await assert.rejects(vault.put(body(Buffer.alloc(0)), { name: 'a.step' }), { code: 'EMPTY' });
  await assert.rejects(vault.put(body(Buffer.alloc(11, 1)), { name: 'a.step' }), { code: 'TOO_LARGE' });
  assert.deepEqual(await vault.list(), []);
  await done();
});

test('저장된 파일이 바뀌면 verify 가 찾아낸다', async () => {
  const { dir, vault, done } = await setup();
  const r = await vault.put(body(Buffer.from('original')), { name: 'spec.txt' });
  await writeFile(path.join(dir, ...r.key.split('/')), 'tampered');
  assert.deepEqual(await vault.verify(), [r.sha256]);
  await done();
});

test('HTTP: 올리고, 목록을 보고, 그대로 내려받는다', async () => {
  const { vault, done } = await setup();
  const server = createFilesServer(vault);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/files`;
  const data = Buffer.from([0, 1, 2, 250, 251]);

  const up = await fetch(`${base}?name=${encodeURIComponent('도면 A.glb')}`, { method: 'POST', body: data });
  assert.equal(up.status, 201);
  const saved = await up.json();
  assert.equal(saved.sha256, sha(data));
  assert.equal((await fetch(`${base}?name=again.glb`, { method: 'POST', body: data })).status, 200);

  assert.equal((await (await fetch(base)).json()).length, 2);
  const down = await fetch(`${base}/${saved.sha256}/content`);
  assert.deepEqual(Buffer.from(await down.arrayBuffer()), data);
  assert.equal((await fetch(`${base}/${'0'.repeat(64)}/content`)).status, 404);
  assert.equal((await fetch(`${base}?name=x.exe`, { method: 'POST', body: 'x' })).status, 415);
  assert.equal((await fetch(`${base}/not-a-hash`)).status, 400);

  server.closeAllConnections();
  await new Promise(r => server.close(r));
  await done();
});
