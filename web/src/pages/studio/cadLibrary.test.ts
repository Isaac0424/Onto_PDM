import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCadLibrary, hashOf, readActive, readAnalysis, writeActive, writeAnalysis, type VaultCadRecord } from './cadLibrary';
import { createCadServer } from './cadServer';
import { CACHE_TTL_MS, readSession, writeSession } from './sessionCache';
import { offlineServer } from './testSeed';
import { createFakeCadDb, textOfRow } from './testServer';

const file = (name: string, body: string) => new File([body], name, { type: 'application/octet-stream' });
const offline = { server: offlineServer };

describe('CAD 보관함 (서버가 꺼져 있어도 이 브라우저에는 남는다)', () => {
  beforeEach(() => window.localStorage.clear());

  it('올린 CAD 는 목록에 남고, 원본 그대로 다시 열 수 있다', async () => {
    const lib = createCadLibrary(offline);
    const r = await lib.add(file('base.step', 'ISO-10303 base'));
    expect(r.duplicate).toBe(false);
    expect(r.entry).toMatchObject({ name: 'base.step', format: 'step', size: 14 });

    expect((await lib.list()).map(e => e.name)).toEqual(['base.step']);
    const again = await lib.open(r.entry.id);
    expect(again.name).toBe('base.step');
    expect(await again.text()).toBe('ISO-10303 base');
  });

  it('새 보관함 객체(= 화면을 옮겼다 돌아온 것)도 같은 목록을 본다', async () => {
    await createCadLibrary(offline).add(file('a.step', 'AAA'));
    expect((await createCadLibrary(offline).list()).map(e => e.name)).toEqual(['a.step']);
  });

  it('같은 내용은 한 번만 등록되고(이름이 달라도), 이름이 같아도 내용이 다르면 따로 등록된다', async () => {
    const lib = createCadLibrary(offline);
    const first = await lib.add(file('a.step', 'SAME'));
    const dup = await lib.add(file('copy-of-a.step', 'SAME'));
    const other = await lib.add(file('a.step', 'DIFFERENT'));
    expect(dup.duplicate).toBe(true);
    expect(dup.entry.id).toBe(first.entry.id);
    expect(other.entry.id).not.toBe(first.entry.id);
    expect(await lib.list()).toHaveLength(2);
  });

  it('최근에 올린 것이 먼저 나온다', async () => {
    let t = 1_000;
    const lib = createCadLibrary({ ...offline, now: () => (t += 1_000) });
    await lib.add(file('old.step', '1'));
    await lib.add(file('new.step', '2'));
    expect((await lib.list()).map(e => e.name)).toEqual(['new.step', 'old.step']);
  });

  it('서버가 꺼져 있어도 등록은 되고, "이 브라우저에만 있음"과 사유를 알려 준다', async () => {
    const r = await createCadLibrary(offline).add(file('a.step', 'A'));
    expect(r.server).toBe('unavailable');
    expect(r.serverMessage).toContain('서버에 연결하지 못했습니다');
    expect(r.entry).toMatchObject({ storage: 'browser-only', cached: true });
    expect(r.entry.cacheExpiresAt).toBeUndefined();                                   // 유일한 사본이라 만료되지 않는다
    expect(await createCadLibrary(offline).list()).toHaveLength(1);
  });

  it('제거하면 목록에서 사라지고, 그 CAD 에서 정한 것과 열어 둔 표시 · 세션도 지워진다. 다시 올리면 돌아온다', async () => {
    const lib = createCadLibrary(offline);
    const { entry } = await lib.add(file('a.step', 'A'));
    writeActive({ kind: 'cad', id: entry.id });
    writeSession({ id: entry.id, partName: '하우징' });
    writeAnalysis(`cad:${entry.id}`, { confirmed: [['x', {}]], decisions: [] });

    const removed = await lib.remove(entry.id);
    expect(removed.serverDeleted).toBe(false);                                        // 서버가 꺼져 있어 DB 에는 아직 못 알렸다
    expect(await lib.list()).toEqual([]);
    expect(readActive()).toBeNull();
    expect(readSession()).toBeNull();
    expect(readAnalysis(`cad:${entry.id}`)).toBeNull();
    await expect(lib.open(entry.id)).rejects.toThrow('보관함에 없습니다');

    const back = await lib.add(file('a.step', 'A'));
    expect(back.entry.id).toBe(entry.id);
    expect((await lib.list()).map(e => e.name)).toEqual(['a.step']);
  });

  it('분석이 끝나면 부품 · 단계 수를 목록에 남긴다 (같은 값이면 바꾸지 않는다)', async () => {
    const lib = createCadLibrary(offline);
    const { entry } = await lib.add(file('a.step', 'A'));
    expect(await lib.setMeta(entry.id, { parts: 23, layers: 15 })).toBe(true);
    expect(await lib.setMeta(entry.id, { parts: 23, layers: 15 })).toBe(false);
    expect((await lib.list())[0]).toMatchObject({ parts: 23, layers: 15 });
  });

  it('같은 내용은 같은 해시다', async () => {
    expect(await hashOf(file('x', 'hello'))).toBe(await hashOf(file('y', 'hello')));
    expect(await hashOf(file('x', 'hello'))).not.toBe(await hashOf(file('x', 'hellp')));
  });
});

describe('가장 최근에 올린 CAD', () => {
  beforeEach(() => window.localStorage.clear());

  it('비어 있으면 undefined 이고, 올릴 때마다 가장 최근 것이 바뀐다', async () => {
    let t = 1_000;
    const lib = createCadLibrary({ ...offline, now: () => (t += 1_000) });
    expect(await lib.latest()).toBeUndefined();
    await lib.add(file('old.step', '1'));
    expect((await lib.latest())?.name).toBe('old.step');
    await lib.add(file('new.step', '2'));
    expect((await lib.latest())?.name).toBe('new.step');
  });

  it('제거하면 그 다음으로 최근 것이 되고, 다 지우면 다시 undefined 이다', async () => {
    let t = 1_000;
    const lib = createCadLibrary({ ...offline, now: () => (t += 1_000) });
    const old = await lib.add(file('old.step', '1'));
    const recent = await lib.add(file('new.step', '2'));
    await lib.remove(recent.entry.id);
    expect((await lib.latest())?.name).toBe('old.step');
    await lib.remove(old.entry.id);
    expect(await lib.latest()).toBeUndefined();
  });
});

describe('열어 둔 CAD 와 CAD 별 결정 기억', () => {
  beforeEach(() => window.localStorage.clear());

  it('열어 둔 것을 기억하고, 깨진 값은 없는 것으로 본다', () => {
    expect(readActive()).toBeNull();
    writeActive({ kind: 'cad', id: 'abc' });
    expect(readActive()).toEqual({ kind: 'cad', id: 'abc' });
    window.localStorage.setItem('onto-pdm.cad.active', '{깨짐');
    expect(readActive()).toBeNull();
    // 예전 버전이 남긴 예시(목업) 모델 기록은 이제 없는 것으로 본다
    window.localStorage.setItem('onto-pdm.cad.active', JSON.stringify({ kind: 'example', name: 'watch' }));
    expect(readActive()).toBeNull();
  });

  it('CAD 마다 따로 저장한다', () => {
    writeAnalysis('cad:a', { confirmed: [['볼트', { status: 'matched' }]], decisions: [['볼트', [['length|8', 'confirmed']]]] });
    writeAnalysis('cad:b', { confirmed: [], decisions: [] });
    expect(readAnalysis('cad:a')?.confirmed).toHaveLength(1);
    expect(readAnalysis('cad:b')?.confirmed).toHaveLength(0);
    expect(readAnalysis('cad:none')).toBeNull();
  });
});

describe('서버 DB 가 정본, 브라우저는 10분 캐시', () => {
  const MIN = 60_000;
  const T0 = 1_800_000_000_000;
  beforeEach(() => window.localStorage.clear());

  /** 가짜 서버 DB 와 시계를 가진 보관함. 보관함 객체를 다시 만들어도 같은 브라우저 저장소를 본다 */
  function setup() {
    const db = createFakeCadDb();
    const clock = { t: T0 };
    const server = createCadServer({ fetchImpl: db.fetch });
    const make = () => createCadLibrary({ server, now: () => clock.t });
    return { db, clock, server, lib: make(), make };
  }

  it('올리면 서버 DB 에 저장되고, 브라우저 캐시에도 올라가 10분 뒤 비워질 시각을 알려 준다', async () => {
    const { db, lib } = setup();
    const r = await lib.add(file('a.step', 'AAA'));
    expect(r.server).toBe('saved');
    expect(r.vault).toBe('saved');
    expect(db.rows.size).toBe(1);
    expect(db.count('POST', '/api/cads')).toBe(1);
    expect(r.entry).toMatchObject({ storage: 'server', cached: true, cacheExpiresAt: new Date(T0 + CACHE_TTL_MS).toISOString() });
    expect(textOfRow(db.rows.get(r.entry.id)!)).toBe('AAA');          // 서버 DB 에 파일 바이트가 그대로
  });

  it('같은 내용을 다시 올리면 서버에는 다시 보내지 않는다', async () => {
    const { db, lib } = setup();
    await lib.add(file('a.step', 'AAA'));
    const again = await lib.add(file('copy.step', 'AAA'));
    expect(again).toMatchObject({ duplicate: true, server: 'duplicate' });
    expect(db.count('POST', '/api/cads')).toBe(1);
  });

  it('10분 안에 다시 열면 캐시에서 열리고 서버에서 내용을 받지 않는다. 쓸 때마다 10분이 다시 시작한다', async () => {
    const { db, clock, lib, make } = setup();
    const { entry } = await lib.add(file('a.step', 'AAA'));
    clock.t = T0 + 9 * MIN;                                                           // 창을 닫고 9분 뒤
    const reopened = await make().open(entry.id);                                      // 새 보관함 객체 = 새로 연 창
    expect(await reopened.text()).toBe('AAA');
    expect(db.count('GET', '/content')).toBe(0);
    expect(db.count('PATCH', `/api/cads/${entry.id}`)).toBe(1);                       // 서버에는 "열었다"만 알린다
    clock.t = T0 + 18 * MIN;                                                           // 연 시각(9분)부터 다시 9분: 아직 캐시
    expect((await lib.list({ server: false }))[0]).toMatchObject({ cached: true, storage: 'server' });
    expect(db.count('GET', '/content')).toBe(0);
  });

  it('10분이 지나면 내용만 비우고 목록에는 남긴다. 열면 서버에서 받아 다시 캐시에 올린다', async () => {
    const { db, clock, lib } = setup();
    const { entry } = await lib.add(file('a.step', 'AAA'));
    await lib.setMeta(entry.id, { parts: 5, layers: 3 });

    clock.t = T0 + 10 * MIN;
    const [expired] = await lib.list({ server: false });
    expect(expired).toMatchObject({ name: 'a.step', parts: 5, layers: 3, storage: 'cache-expired', cached: false });   // 목록용 정보는 남는다
    expect(expired!.cacheExpiresAt).toBeUndefined();

    const opened = await lib.open(entry.id);
    expect(await opened.text()).toBe('AAA');
    expect(db.count('GET', '/content')).toBe(1);                                      // 서버에서 받았다
    expect((await lib.list({ server: false }))[0]).toMatchObject({ storage: 'server', cached: true, cacheExpiresAt: new Date(T0 + 20 * MIN).toISOString() });

    clock.t = T0 + 19 * MIN;                                                           // 받은 시각(10분)에서 9분
    await lib.open(entry.id);                                                          // 캐시에서
    expect(db.count('GET', '/content')).toBe(1);
  });

  it('touch 하면 마지막 사용이 갱신돼 캐시가 이어진다 (열려 있는 동안의 하트비트)', async () => {
    const { db, clock, lib } = setup();
    const { entry } = await lib.add(file('a.step', 'AAA'));
    for (let m = 5; m <= 30; m += 5) { clock.t = T0 + m * MIN; await lib.touch(entry.id); }
    expect((await lib.list({ server: false }))[0]).toMatchObject({ cached: true });
    expect(db.count('GET', '/content')).toBe(0);
    clock.t = T0 + 41 * MIN;                                                           // 마지막 touch(30분)에서 11분
    expect((await lib.list({ server: false }))[0]).toMatchObject({ cached: false, storage: 'cache-expired' });
  });

  it('서버에 아직 못 보낸 CAD 는 10분이 지나도 비우지 않는다 (유일한 사본). 서버가 돌아오면 올라간다', async () => {
    const { db, clock, lib } = setup();
    db.down = true;
    const { entry, server } = await lib.add(file('a.step', 'ONLY-COPY'));
    expect(server).toBe('unavailable');

    clock.t = T0 + 60 * MIN;
    expect((await lib.list())[0]).toMatchObject({ storage: 'browser-only', cached: true });   // 서버 목록이 안 닿아도 조용히 이 브라우저 것만
    expect(await (await lib.open(entry.id)).text()).toBe('ONLY-COPY');

    expect(await lib.syncPending()).toEqual({ uploaded: 0, deleted: 0 });              // 아직 꺼져 있다
    db.down = false;
    expect(await lib.syncPending()).toEqual({ uploaded: 1, deleted: 0 });
    expect(db.rows.size).toBe(1);
    expect((await lib.list({ server: false }))[0]).toMatchObject({ storage: 'server', cached: true });
    expect(await lib.syncPending()).toEqual({ uploaded: 0, deleted: 0 });              // 이미 다 올렸다
  });

  it('서버가 안 닿으면 목록은 이 브라우저에 있는 것만 보이고, 캐시가 만료된 CAD 를 열려 하면 이유를 알린다', async () => {
    const { db, clock, lib } = setup();
    const { entry } = await lib.add(file('a.step', 'AAA'));
    clock.t = T0 + 11 * MIN;
    db.down = true;
    expect((await lib.list()).map(e => e.storage)).toEqual(['cache-expired']);         // 던지지 않는다
    await expect(lib.open(entry.id)).rejects.toThrow('서버에 연결하지 못했습니다');
    db.down = false;
    expect(await (await lib.open(entry.id)).text()).toBe('AAA');                       // 돌아오면 열린다
  });

  it('다른 브라우저에서 올린 CAD(서버에만 있음)도 목록에 나오고, 열면 받아서 캐시에 올린다', async () => {
    const { db, server, lib } = setup();
    const remote = await server.upload(file('remote.step', 'REMOTE'));                // 이 브라우저는 모르는 올리기
    const rows = await lib.list();
    expect(rows).toEqual([expect.objectContaining({ id: remote.id, name: 'remote.step', storage: 'server', cached: false })]);

    expect(await (await lib.open(remote.id)).text()).toBe('REMOTE');
    expect(db.count('GET', '/content')).toBe(1);
    expect((await lib.list({ server: false }))[0]).toMatchObject({ cached: true });
  });

  it('목록을 받기 전에 바로 열어도(서버 목록에서 이름을 찾아) 열린다', async () => {
    const { server, lib } = setup();
    const remote = await server.upload(file('remote.step', 'REMOTE'));
    const opened = await lib.open(remote.id);                                          // 이 브라우저는 한 번도 목록을 받지 않았다
    expect(opened.name).toBe('remote.step');
  });

  it('제거하면 서버 DB 에서도 목록에서 빠진다 (내용은 DB 에 남아, 다시 올리면 되살아난다)', async () => {
    const { db, lib } = setup();
    const { entry } = await lib.add(file('a.step', 'AAA'));
    expect(await lib.remove(entry.id)).toEqual({ serverDeleted: true });
    expect(db.rows.get(entry.id)?.deleted).toBe(true);
    expect(await lib.list()).toEqual([]);

    const back = await lib.add(file('a.step', 'AAA'));
    expect(back).toMatchObject({ server: 'saved', duplicate: false });
    expect(db.rows.get(entry.id)?.deleted).toBe(false);
    expect((await lib.list()).map(e => e.name)).toEqual(['a.step']);
  });

  it('서버가 꺼져 있을 때 제거하면 목록에서는 바로 숨기고, 서버가 돌아오면 DB 에서도 지운다 (목록에 되살아나지 않는다)', async () => {
    const { db, lib } = setup();
    const { entry } = await lib.add(file('a.step', 'AAA'));
    db.down = true;
    const r = await lib.remove(entry.id);
    expect(r.serverDeleted).toBe(false);
    expect(r.serverMessage).toContain('서버에 연결하지 못했습니다');
    db.down = false;
    expect(await lib.list()).toEqual([]);                                              // 서버 목록에 아직 있어도 숨겨 둔 것은 나오지 않는다
    expect(await lib.syncPending()).toEqual({ uploaded: 0, deleted: 1 });
    expect(db.rows.get(entry.id)?.deleted).toBe(true);
    expect(await lib.list()).toEqual([]);
  });

  it('다른 곳에서 서버 DB 의 CAD 를 지웠으면: 내용이 없는 것은 목록에서 빠지고, 캐시에 내용이 있는 것은 다시 올릴 수 있게 남는다', async () => {
    const { db, clock, lib } = setup();
    const gone = await lib.add(file('gone.step', 'G'));
    clock.t = T0 + 11 * MIN;
    await lib.list({ server: false });                                                 // gone 의 캐시가 만료돼 내용이 비워짐
    const kept = await lib.add(file('kept.step', 'K'));                                // 이쪽은 방금 올려 캐시에 있다
    db.rows.get(gone.entry.id)!.deleted = true;
    db.rows.get(kept.entry.id)!.deleted = true;

    const rows = await lib.list();
    expect(rows.map(e => e.name)).toEqual(['kept.step']);
    expect(rows[0]).toMatchObject({ storage: 'browser-only', cached: true });
    expect(await lib.syncPending()).toEqual({ uploaded: 1, deleted: 0 });              // 데이터를 잃지 않게 다시 올린다
  });

  it('분석 결과(부품 · 단계 수)는 서버에도 알리고, 서버에 있는 값은 이 브라우저가 모를 때 받아 온다', async () => {
    const { db, lib } = setup();
    const { entry } = await lib.add(file('a.step', 'AAA'));
    await lib.setMeta(entry.id, { parts: 7, layers: 4 });
    expect(db.rows.get(entry.id)).toMatchObject({ parts: 7, layers: 4 });

    const remote = await createCadServer({ fetchImpl: db.fetch }).upload(file('b.step', 'BBB'));
    db.rows.get(remote.id)!.parts = 9; db.rows.get(remote.id)!.layers = 2;
    expect((await lib.list()).find(e => e.id === remote.id)).toMatchObject({ parts: 9, layers: 2 });
  });

  it('서버가 형식 · 크기를 거절한 CAD 는 이 브라우저에만 남고, 자동으로 다시 보내지 않는다', async () => {
    const { db, lib } = setup();
    const r = await lib.add(file('x.xyz', 'BAD'));
    expect(r.server).toBe('rejected');
    expect(r.serverMessage).toContain('올릴 수 없어요');
    expect(r.entry).toMatchObject({ storage: 'browser-only', syncNote: expect.stringContaining('올릴 수 없어요') });
    const before = db.count('POST', '/api/cads');
    expect(await lib.syncPending()).toEqual({ uploaded: 0, deleted: 0 });
    expect(db.count('POST', '/api/cads')).toBe(before);
  });
});

describe('보관소 서버에서 가져오기 (사용자가 눌렀을 때만)', () => {
  const rec = (sha256: string, name: string, kind = 'cad'): VaultCadRecord => ({ sha256, name, size: 5, format: name.split('.').pop() ?? '', kind });
  beforeEach(() => window.localStorage.clear());

  it('CAD 만, 같은 내용은 한 번만 보이고, 이미 목록에 있는 것은 뺀다', async () => {
    const mine = await createCadLibrary(offline).add(file('mine.step', 'MINE'));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      rec('a'.repeat(64), 'a.step'), rec('a'.repeat(64), 'a.step'),              // 두 번 올린 기록
      rec('b'.repeat(64), 'doc.pdf', 'spec'),                                      // CAD 가 아니다
      rec(mine.entry.id, 'mine.step'),                                             // 이미 목록에 있다
    ]), { status: 200 })) as unknown as typeof fetch;
    const rows = await createCadLibrary({ ...offline, fetchImpl }).vaultCads();
    expect(rows.map(r => r.name)).toEqual(['a.step']);
  });

  it('서버가 없으면 이유를 던진다', async () => {
    const fetchImpl = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    await expect(createCadLibrary({ ...offline, fetchImpl }).vaultCads()).rejects.toThrow('보관소 서버에 연결하지 못했어요');
    const notOk = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
    await expect(createCadLibrary({ ...offline, fetchImpl: notOk }).vaultCads()).rejects.toThrow('HTTP 500');
  });

  it('가져오면 내용을 받아 목록에 등록하고 서버 DB 에도 저장한다', async () => {
    const db = createFakeCadDb();
    const fetchImpl = vi.fn(async (url: string) => new Response(url.endsWith('/content') ? 'STEPDATA' : '[]', { status: 200 })) as unknown as typeof fetch;
    const lib = createCadLibrary({ server: createCadServer({ fetchImpl: db.fetch }), fetchImpl });
    const r = await lib.importFromVault(rec('c'.repeat(64), 'remote.step'));
    expect(r.entry.name).toBe('remote.step');
    expect(r.server).toBe('saved');
    expect(db.rows.size).toBe(1);
    expect(await (await lib.open(r.entry.id)).text()).toBe('STEPDATA');
  });
});
