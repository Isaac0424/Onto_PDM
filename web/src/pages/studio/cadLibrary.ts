// CAD 보관함: CAD 파일 자체는 서버 DB(/api/cads)가 정본이고, 이 브라우저(IndexedDB)는 10분짜리 캐시다.
//   1) 올리면 먼저 이 브라우저에 넣고(synced=false) 서버 DB 에 보낸다. 보내지 못하면(서버가 꺼짐) 이 브라우저에만 남고, 서버가 돌아오면 syncPending 이 올린다.
//   2) 연 CAD 는 마지막으로 쓴 때부터 10분(CACHE_TTL_MS) 동안 캐시에서 바로 열린다. 지나면 파일 내용(blob)만 비우고 목록용 정보는 남긴다.
//      서버에 아직 못 보낸 것(synced=false)은 유일한 사본이라 절대 비우지 않는다.
//   3) 캐시가 없으면 열 때 서버 DB 에서 받아 다시 캐시에 올린다. 다른 브라우저에서 올린 CAD 도 서버 목록으로 보인다.
//   4) 파일 보관소 서버(/api/files)에만 있는 CAD 는 사용자가 "보관소에서 가져오기"를 눌렀을 때만 조회한다.
//   5) 지금 열어 둔 CAD 와, CAD 마다 사람이 정한 것(확정한 매칭 · 속성 결정 · 볼트 종류)도 기억한다 (localStorage).
// 파일 이름이 같아도 내용이 다르면 다른 CAD 이고, 내용이 같으면 한 번만 등록된다 (sha256 이 id).
import { CadServerError, CadServerUnavailable, createCadServer, type CadServer, type ServerCad } from './cadServer';
import { CACHE_TTL_MS, clearSession } from './sessionCache';

/** CAD 가 어디에 있는가: server = 서버 DB 에 저장됨 / browser-only = 서버에 못 보내 이 브라우저에만 있음 / cache-expired = 캐시가 만료돼 서버에서 받아야 함 */
export type CadStorage = 'server' | 'browser-only' | 'cache-expired';

export interface CadEntry {
  /** 내용의 sha256 (crypto.subtle 이 없는 환경은 FNV 해시) */
  id: string;
  name: string;
  format: string;
  size: number;
  addedAt: string;
  /** 분석이 끝난 뒤 알게 된 부품 · 단계 수 (목록에 보이려고 기억) */
  parts?: number;
  layers?: number;
  storage: CadStorage;
  /** 지금 이 브라우저 캐시에 파일 내용이 있다 (열면 서버를 부르지 않는다) */
  cached: boolean;
  /** 캐시가 비워지는 시각. 서버에 저장된 것 중 캐시에 있는 것만 가진다 */
  cacheExpiresAt?: string;
  /** 서버가 거절한 이유 (형식 · 크기 …). 이 브라우저에만 남은 이유를 설명한다 */
  syncNote?: string;
}

/** 마지막에 열어 둔 CAD. 예시(목업) 모델은 없다 */
export type ActiveCad = { kind: 'cad'; id: string };

export interface VaultCadRecord { sha256: string; name: string; size: number; format: string; kind: string; uploadedAt?: string }

export interface AddResult {
  entry: CadEntry;
  /** 같은 내용이 이미 등록돼 있었다 */
  duplicate: boolean;
  /** 서버 DB 저장 결과: 저장됨 / 서버에 이미 있음 / 서버가 꺼져 있어 이 브라우저에만 보관 / 서버가 거절 */
  server: 'saved' | 'duplicate' | 'unavailable' | 'rejected';
  serverMessage?: string;
  /** 서버가 파일 보관소(OPMS 공유)에도 복사한 결과 */
  vault?: 'saved' | 'duplicate' | 'unavailable';
}

export interface RemoveResult {
  /** 서버 DB 의 사본도 목록에서 뺐다. false 면 서버가 돌아올 때 자동으로 뺀다 */
  serverDeleted: boolean;
  serverMessage?: string;
}

export interface SyncResult { uploaded: number; deleted: number }

interface Rec {
  id: string;
  name: string;
  format: string;
  size: number;
  addedAt: string;
  parts?: number;
  layers?: number;
  /** 파일 내용. null 이면 캐시가 비어 있다 (목록용 정보만 있음) */
  blob: Blob | null;
  /** 서버 DB 에 저장돼 있다 */
  synced: boolean;
  /** 마지막으로 쓴 시각 (ms). 0 이면 이 브라우저는 내용을 받아 본 적이 없다 */
  cachedAt: number;
  /** 서버가 거절한 이유. 있으면 자동 재전송하지 않는다 */
  rejected?: string;
}

interface Store {
  put(rec: Rec): Promise<void>;
  get(id: string): Promise<Rec | undefined>;
  all(): Promise<Rec[]>;
  del(id: string): Promise<void>;
}

// ---------- 저장소: IndexedDB, 없으면(시험 · 사생활 보호 창) 메모리 ----------
const memory = new Map<string, Rec>();
const memoryStore: Store = {
  async put(rec) { memory.set(rec.id, rec); },
  async get(id) { return memory.get(id); },
  async all() { return [...memory.values()]; },
  async del(id) { memory.delete(id); },
};

const DB_NAME = 'onto-pdm-cad';
const STORE = 'cads';

function idbStore(): Promise<Store> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => { open.result.createObjectStore(STORE, { keyPath: 'id' }); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const run = <T,>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
        new Promise((res, rej) => {
          const req = fn(db.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
      resolve({
        put: async rec => { await run('readwrite', s => s.put(rec)); },
        get: id => run<Rec | undefined>('readonly', s => s.get(id)),
        all: () => run<Rec[]>('readonly', s => s.getAll()),
        del: async id => { await run('readwrite', s => s.delete(id)); },
      });
    };
  });
}

/** 시험 · 초기화용: 메모리 저장소를 비운다 */
export function resetMemoryCadStore() { memory.clear(); }

async function openStore(): Promise<Store> {
  if (typeof indexedDB === 'undefined') return memoryStore;
  try { return await idbStore(); } catch { return memoryStore; }
}

/**
 * 저장소에서 읽은 기록을 다듬는다. 서버 DB 이전 버전이 남긴 기록(synced · cachedAt 없음)은
 * "서버에 아직 못 보낸 것"으로 보고, 마지막 사용은 올린 시각으로 본다.
 */
function norm(r: Rec): Rec {
  const t = Date.parse(r.addedAt);
  return { ...r, blob: r.blob ?? null, synced: r.synced === true, cachedAt: typeof r.cachedAt === 'number' ? r.cachedAt : (Number.isNaN(t) ? 0 : t) };
}

// ---------- 해시 ----------
function readBuffer(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

export async function hashOf(file: Blob): Promise<string> {
  const buf = await readBuffer(file);
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (subtle) {
    const d = new Uint8Array(await subtle.digest('SHA-256', buf));
    return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
  }
  // 최후 수단: FNV-1a 64비트 두 번(다른 시드). 충돌 가능성이 있어 접두어로 구분한다
  const bytes = new Uint8Array(buf);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const b of bytes) { h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ b, 0x811c9dc5) >>> 0; }
  return `fnv-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}-${bytes.length}`;
}

const formatOf = (name: string) => (name.split('.').pop() ?? '').toLowerCase();

// ---------- localStorage 도우미 (막혀 있어도 화면은 돌아간다) ----------
const ACTIVE_KEY = 'onto-pdm.cad.active';
/** 목록에서 뺐지만 서버 DB 에 아직 알리지 못한 것 (서버가 돌아오면 지운다. 그때까지 목록에 다시 나오지 않게 숨긴다) */
const HIDDEN_KEY = 'onto-pdm.cad.hidden';
const STATE_PREFIX = 'onto-pdm.cad.state.';

function lsGet(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } }
function lsSet(key: string, value: string) { try { window.localStorage.setItem(key, value); } catch { /* 저장 못 해도 동작에는 지장 없음 */ } }
function lsDel(key: string) { try { window.localStorage.removeItem(key); } catch { /* 무시 */ } }

export function readActive(): ActiveCad | null {
  try {
    const v = JSON.parse(lsGet(ACTIVE_KEY) ?? 'null') as ActiveCad | null;
    if (v?.kind === 'cad' && typeof v.id === 'string') return v;
  } catch { /* 깨진 값은 없는 것으로 */ }
  return null;
}
export const writeActive = (a: ActiveCad) => lsSet(ACTIVE_KEY, JSON.stringify(a));

function readHidden(): Set<string> {
  try { return new Set(JSON.parse(lsGet(HIDDEN_KEY) ?? '[]') as string[]); } catch { return new Set(); }
}
const writeHidden = (h: Set<string>) => lsSet(HIDDEN_KEY, JSON.stringify([...h]));

/** CAD 마다 사람이 정한 것. 값은 JSON 으로 직렬화할 수 있는 모양으로 받는다 */
export interface PersistedAnalysis {
  confirmed: [string, unknown][];
  decisions: [string, [string, string][]][];
  /** 부품 이름 → 사람이 이 종류로 확정한 볼트 클래스 코드(형상 분류). 예전에 저장된 것에는 없다 */
  fastener?: [string, string][];
}

export function readAnalysis(key: string): PersistedAnalysis | null {
  try {
    const v = JSON.parse(lsGet(STATE_PREFIX + key) ?? 'null') as PersistedAnalysis | null;
    return v && Array.isArray(v.confirmed) && Array.isArray(v.decisions) ? v : null;                 // 예전에 저장된 값의 specCands 는 읽지 않고 버린다
  } catch { return null; }
}
export const writeAnalysis = (key: string, v: PersistedAnalysis) => lsSet(STATE_PREFIX + key, JSON.stringify(v));

// ---------- 보관함 ----------
export interface CadLibrary {
  /** 목록. server: false 면 서버를 부르지 않고 이 브라우저에 있는 것만 (기본은 서버 목록과 합친다. 서버가 꺼져 있으면 조용히 이 브라우저 것만) */
  list(opts?: { server?: boolean }): Promise<CadEntry[]>;
  /** 가장 최근에 올린 CAD (없으면 undefined) */
  latest(): Promise<CadEntry | undefined>;
  add(file: File): Promise<AddResult>;
  /** 캐시에 있으면 바로, 없으면(만료 포함) 서버 DB 에서 받아 캐시에 올려서 연다 */
  open(id: string): Promise<File>;
  /** 캐시에 있는 CAD 를 "방금 썼다"고 표시한다 (마지막 사용에서 10분이 다시 시작) */
  touch(id: string): Promise<void>;
  remove(id: string): Promise<RemoveResult>;
  setMeta(id: string, meta: { parts: number; layers: number }): Promise<boolean>;
  /** 서버에 못 보낸 것(올리기 · 지우기)을 다시 보낸다. 서버가 꺼져 있으면 조용히 0 */
  syncPending(): Promise<SyncResult>;
  /** 보관소 서버에만 있는 CAD (이 브라우저에 없는 것). 서버가 없으면 던진다 */
  vaultCads(): Promise<VaultCadRecord[]>;
  importFromVault(rec: VaultCadRecord): Promise<AddResult>;
}

export interface CadLibraryDeps {
  /** 서버 DB 클라이언트 (시험에서 바꾼다) */
  server?: CadServer;
  /** 보관소(/api/files) 조회용 fetch */
  fetchImpl?: typeof fetch;
  /** 현재 시각 ms (시험에서 10분을 건너뛰려고 바꾼다) */
  now?: () => number;
}

/** 서버가 거절한 것(4xx)은 다시 보내도 같다. 그 밖(꺼짐 · 5xx)은 나중에 다시 보낸다 */
const isRejection = (e: unknown): e is CadServerError => e instanceof CadServerError && e.status >= 400 && e.status < 500;

export function createCadLibrary(deps: CadLibraryDeps = {}): CadLibrary {
  const server = deps.server ?? createCadServer(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
  const doFetch = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? (() => Date.now());
  let store: Promise<Store> | undefined;
  const db = () => (store ??= openStore());

  // 읽고 → 고치고 → 쓰는 일을 한 줄로 세운다 (서버 응답을 기다리는 동안 다른 쓰기가 덮어써지지 않게, 서버 호출은 이 줄 밖에서 한다)
  let queue: Promise<unknown> = Promise.resolve();
  function update(id: string, fn: (cur: Rec | undefined) => Rec | null | undefined): Promise<Rec | undefined> {
    const job = queue.then(async () => {
      const s = await db();
      const raw = await s.get(id);
      const cur = raw ? norm(raw) : undefined;
      const next = fn(cur);
      if (next === null) { await s.del(id); return undefined; }
      if (next === undefined) return cur;
      await s.put(next);
      return next;
    });
    queue = job.catch(() => undefined);
    return job;
  }

  // 서버에 올린 순서: 목록을 받아 오는 사이에 막 올라간 CAD 를 "서버에서 사라졌다"고 잘못 보지 않으려고 쓴다
  let seq = 0;
  const syncedSeq = new Map<string, number>();
  const markSynced = (id: string) => { syncedSeq.set(id, ++seq); };

  const expired = (r: Rec, t: number) => r.synced && r.blob !== null && t - r.cachedAt >= CACHE_TTL_MS;

  /** 서버에 저장된 것 중 10분 넘게 안 쓴 캐시의 내용(blob)을 비운다. 목록용 정보는 남긴다 */
  async function purge() {
    const t = now();
    const s = await db();
    for (const raw of await s.all()) {
      const r = norm(raw);
      if (expired(r, t)) await update(r.id, cur => (cur && expired(cur, t) ? { ...cur, blob: null } : undefined));
    }
  }

  function entryOf(r: Rec, t: number): CadEntry {
    const cached = r.blob !== null && !expired(r, t);
    const storage: CadStorage = !r.synced ? 'browser-only' : cached || r.cachedAt === 0 ? 'server' : 'cache-expired';
    return {
      id: r.id, name: r.name, format: r.format, size: r.size, addedAt: r.addedAt,
      ...(r.parts !== undefined ? { parts: r.parts } : {}),
      ...(r.layers !== undefined ? { layers: r.layers } : {}),
      storage, cached,
      ...(cached && r.synced ? { cacheExpiresAt: new Date(r.cachedAt + CACHE_TTL_MS).toISOString() } : {}),
      ...(!r.synced && r.rejected ? { syncNote: r.rejected } : {}),
    };
  }

  const metaOf = (c: ServerCad): Rec => ({
    id: c.id, name: c.name, format: c.format, size: c.size, addedAt: c.uploadedAt,
    ...(typeof c.parts === 'number' ? { parts: c.parts } : {}),
    ...(typeof c.layers === 'number' ? { layers: c.layers } : {}),
    blob: null, synced: true, cachedAt: 0,
  });

  /** 서버 목록을 이 브라우저 기록과 맞춘다: 서버에만 있는 것은 목록용 정보로 더하고, 서버에서 사라진 것은 정리한다 */
  async function mergeServer(remote: ServerCad[], startedAt: number) {
    const hidden = readHidden();
    const remoteIds = new Set(remote.map(r => r.id));
    for (const c of remote) {
      if (hidden.has(c.id)) continue;                                    // 지우려고 했는데 서버에 못 알린 것: 돌아오게 하지 않는다 (syncPending 이 지운다)
      let patchMeta = undefined as { parts: number; layers: number } | undefined;
      await update(c.id, cur => {
        if (!cur) return metaOf(c);
        const { rejected: _r, ...rest } = cur;
        const parts = cur.parts ?? (typeof c.parts === 'number' ? c.parts : undefined);
        const layers = cur.layers ?? (typeof c.layers === 'number' ? c.layers : undefined);
        if (cur.synced && cur.parts !== undefined && cur.layers !== undefined && (c.parts === null || c.layers === null)) patchMeta = { parts: cur.parts, layers: cur.layers };
        return {
          ...rest, synced: true, addedAt: c.uploadedAt,
          ...(parts !== undefined ? { parts } : {}),
          ...(layers !== undefined ? { layers } : {}),
        };
      });
      if (patchMeta) void server.patch(c.id, patchMeta).catch(() => undefined);   // 서버가 모르는 분석 결과를 알려 준다
    }
    for (const raw of await (await db()).all()) {
      const r = norm(raw);
      if (r.synced && !remoteIds.has(r.id) && (syncedSeq.get(r.id) ?? 0) <= startedAt) {
        // 서버에서 사라졌다: 내용이 캐시에 있으면 다시 올릴 수 있게 되돌리고(데이터를 잃지 않는다), 없으면 목록에서도 뺀다
        await update(r.id, cur => (cur && cur.synced && !remoteIds.has(cur.id) ? (cur.blob ? { ...cur, synced: false } : null) : undefined));
      }
    }
  }

  async function list(opts: { server?: boolean } = {}) {
    await purge();
    if (opts.server !== false) {
      const startedAt = seq;
      const remote = await server.list().catch(() => undefined);         // 서버가 안 닿으면 조용히 이 브라우저 것만
      if (remote) await mergeServer(remote, startedAt);
    }
    const hidden = readHidden();
    const t = now();
    return (await (await db()).all()).map(norm).filter(r => !hidden.has(r.id)).map(r => entryOf(r, t))
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  async function add(file: File): Promise<AddResult> {
    const id = await hashOf(file);
    const hidden = readHidden();
    const wasHidden = hidden.has(id);
    if (wasHidden) { hidden.delete(id); writeHidden(hidden); }
    const t = now();
    let known: Rec | undefined;
    const rec = (await update(id, cur => {
      known = cur;
      if (cur) { const { rejected: _r, ...rest } = cur; return { ...rest, blob: cur.blob ?? file, cachedAt: t }; }   // 다시 올리면 캐시를 새로 채우고, 거절 기록은 지워 다시 시도한다
      return { id, name: file.name, format: formatOf(file.name), size: file.size, addedAt: new Date(t).toISOString(), blob: file, synced: false, cachedAt: t };
    }))!;
    const duplicate = !!known && !wasHidden;
    if (rec.synced && !wasHidden) return { entry: entryOf(rec, t), duplicate, server: 'duplicate' };      // 서버 DB 에 이미 있다

    try {
      const saved = await server.upload(file);
      markSynced(id);
      const done = (await update(id, cur => cur && {
        ...cur, synced: true, addedAt: saved.uploadedAt ?? cur.addedAt,
        ...(cur.parts === undefined && typeof saved.parts === 'number' ? { parts: saved.parts } : {}),
        ...(cur.layers === undefined && typeof saved.layers === 'number' ? { layers: saved.layers } : {}),
      })) ?? rec;
      return {
        entry: entryOf(done, now()), duplicate, server: saved.duplicate ? 'duplicate' : 'saved',
        ...(saved.vault ? { vault: saved.vault } : {}),
      };
    } catch (e) {
      const message = String((e as Error).message ?? e);
      if (isRejection(e)) {
        const done = (await update(id, cur => cur && { ...cur, rejected: message })) ?? rec;
        return { entry: entryOf(done, now()), duplicate, server: 'rejected', serverMessage: message };
      }
      return { entry: entryOf(rec, now()), duplicate, server: 'unavailable', serverMessage: message };
    }
  }

  async function open(id: string): Promise<File> {
    let t = now();
    const raw = await (await db()).get(id);
    let rec = raw ? norm(raw) : undefined;
    if (rec?.blob && !expired(rec, t)) {                                  // 캐시에 있다: 서버를 부르지 않고 바로 연다
      const blob = rec.blob;
      await update(id, cur => cur && { ...cur, cachedAt: t });
      if (rec.synced) void server.patch(id, { opened: true }).catch(() => undefined);   // 서버에는 "열었다"만 알린다 (실패해도 무관)
      return new File([blob], rec.name, { type: blob.type || 'application/octet-stream' });
    }

    if (rec?.blob) rec = await update(id, cur => (cur && expired(cur, t) ? { ...cur, blob: null } : undefined)) ?? rec;   // 만료: 비운다
    let meta: Rec | undefined = rec;
    if (!meta) {                                                          // 이 브라우저는 모르는 CAD: 서버 목록에서 이름 · 형식을 찾는다
      let remote: ServerCad[] | undefined;
      try { remote = await server.list(); } catch { /* 아래에서 알린다 */ }
      const found = remote?.find(c => c.id === id);
      if (!found) throw new Error(`이 CAD 는 보관함에 없습니다. ${remote ? '목록에서 다시 올려 주세요.' : '서버에 연결하지 못해 서버 DB 도 확인하지 못했습니다.'}`);
      meta = metaOf(found);
    }
    let blob: Blob;
    try { blob = await server.content(id); }
    catch (e) {
      if (e instanceof CadServerUnavailable) throw new Error(`캐시가 만료돼 서버 DB 에서 받아야 하는데 서버에 연결하지 못했습니다. 서버를 켠 뒤 다시 눌러 주세요.`);
      if (e instanceof CadServerError && e.status === 404) throw new Error('서버 DB 에 이 CAD 가 없습니다. 다른 곳에서 지웠을 수 있어요. 목록에서 제거하고 다시 올려 주세요.');
      throw e;
    }
    t = now();
    const base = meta;
    await update(id, cur => ({ ...(cur ?? base), blob, synced: true, cachedAt: t }));           // 받은 것은 다시 10분 동안 캐시에 올린다
    void server.patch(id, { opened: true }).catch(() => undefined);
    return new File([blob], meta.name, { type: blob.type || 'application/octet-stream' });
  }

  async function touch(id: string) {
    const t = now();
    const raw = await (await db()).get(id);
    if (!raw?.blob) return;                                              // 캐시에 없으면 새로 시작할 것이 없다
    await update(id, cur => (cur?.blob ? { ...cur, cachedAt: t } : undefined));
  }

  async function remove(id: string): Promise<RemoveResult> {
    await update(id, () => null);
    lsDel(STATE_PREFIX + `cad:${id}`);
    clearSession(id);
    const active = readActive();
    if (active?.kind === 'cad' && active.id === id) lsDel(ACTIVE_KEY);
    try { await server.remove(id); return { serverDeleted: true }; }
    catch (e) {
      const hidden = readHidden();
      hidden.add(id);                                                    // 서버에 못 알렸다: 돌아올 때까지 목록에서 숨기고, 서버가 돌아오면 지운다
      writeHidden(hidden);
      return { serverDeleted: false, serverMessage: String((e as Error).message ?? e) };
    }
  }

  async function setMeta(id: string, meta: { parts: number; layers: number }) {
    let changed = false as boolean;
    const rec = await update(id, cur => {
      if (!cur || (cur.parts === meta.parts && cur.layers === meta.layers)) return undefined;
      changed = true;
      return { ...cur, ...meta };
    });
    if (changed && rec?.synced) void server.patch(id, meta).catch(() => undefined);
    return changed;
  }

  async function syncPending(): Promise<SyncResult> {
    const out: SyncResult = { uploaded: 0, deleted: 0 };
    const hidden = readHidden();
    for (const id of [...hidden]) {                                      // 1) 서버에 못 알린 삭제
      try { await server.remove(id); }
      catch (e) { if (isRejection(e)) { hidden.delete(id); writeHidden(hidden); continue; } return out; }
      hidden.delete(id); writeHidden(hidden); out.deleted += 1;
    }
    for (const raw of await (await db()).all()) {                        // 2) 서버에 못 올린 CAD
      const r = norm(raw);
      if (r.synced || !r.blob || r.rejected || hidden.has(r.id)) continue;
      const file = new File([r.blob], r.name, { type: r.blob.type || 'application/octet-stream' });
      try {
        const saved = await server.upload(file);
        markSynced(r.id);
        await update(r.id, cur => cur && { ...cur, synced: true, addedAt: saved.uploadedAt ?? cur.addedAt });
        out.uploaded += 1;
      } catch (e) {
        if (isRejection(e)) { await update(r.id, cur => cur && { ...cur, rejected: String(e.message) }); continue; }
        return out;                                                       // 서버가 꺼져 있다: 나머지는 다음에
      }
    }
    return out;
  }

  async function vaultCads(): Promise<VaultCadRecord[]> {
    let res: Response;
    try { res = await doFetch('/api/files'); } catch { throw new Error('파일 보관소 서버에 연결하지 못했어요. `node server/files-server.mjs`를 켜 주세요.'); }
    if (!res.ok) throw new Error(`파일 보관소 목록을 읽지 못했어요 (HTTP ${res.status})`);
    const rows = (await res.json()) as VaultCadRecord[];
    const mine = new Set((await (await db()).all()).map(r => r.id));
    const hidden = readHidden();
    const seen = new Set<string>();
    return rows.filter(r => r.kind === 'cad' && !seen.has(r.sha256) && !!seen.add(r.sha256) && (!mine.has(r.sha256) || hidden.has(r.sha256)));
  }

  async function importFromVault(rec: VaultCadRecord) {
    let res: Response;
    try { res = await doFetch(`/api/files/${rec.sha256}/content`); } catch { throw new Error('파일 보관소 서버에 연결하지 못했어요.'); }
    if (!res.ok) throw new Error(`보관소에서 파일을 받지 못했어요 (HTTP ${res.status})`);
    const blob = await res.blob();
    return add(new File([blob], rec.name));                              // 서버 DB 에도 저장한다
  }

  const latest = async () => (await list())[0];

  return { list, latest, add, open, touch, remove, setMeta, syncPending, vaultCads, importFromVault };
}
