// 시험 도우미: 서버 DB(/api/cads)를 메모리로 흉내 내는 가짜 fetch. 서버 API 계약(server/cad-db.mjs)과 같은 모양으로 답한다.
//   const db = createFakeCadDb(); vi.stubGlobal('fetch', db.fetch);   // 화면 시험
//   createCadServer({ fetchImpl: db.fetch })                           // 보관함 시험
// db.down = true 면 서버가 꺼진 것처럼 연결 오류를 낸다. db.calls 에 `METHOD /경로` 가 쌓인다.
import { hashOf } from './cadLibrary';

interface Row {
  id: string; name: string; format: string; size: number; uploadedAt: string;
  lastOpenedAt: string | null; parts: number | null; layers: number | null;
  bytes: Uint8Array; deleted: boolean;
}

export interface FakeCadDb {
  fetch: typeof fetch;
  rows: Map<string, Row>;
  calls: string[];
  /** 요청 전체 주소 (`METHOD /경로?쿼리`) */
  urls: string[];
  /** true 면 서버가 꺼져 있다 */
  down: boolean;
  /** 호출 중 경로가 pathPart 를 포함하는 횟수 */
  count(method: string, pathPart: string): number;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const view = ({ bytes: _b, deleted: _d, ...rest }: Row) => rest;

/** 파일 바이트 (jsdom 의 Blob 에는 arrayBuffer 가 없을 수 있어 FileReader 로 읽는다) */
const bytesOf = (b: Blob): Promise<Uint8Array> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
  r.onerror = () => reject(r.error);
  r.readAsArrayBuffer(b);
});
/** 서버 DB 에 든 바이트를 글자로 (시험 확인용) */
export const textOfRow = (row: { bytes: Uint8Array }) => new TextDecoder().decode(row.bytes);

export function createFakeCadDb(opts: { files?: (url: URL, init?: RequestInit) => Response | undefined } = {}): FakeCadDb {
  const rows = new Map<string, Row>();
  const calls: string[] = [];
  const urls: string[] = [];
  let tick = 0;
  const stamp = () => new Date(Date.now() + (tick += 1)).toISOString();

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url.pathname}`);
    urls.push(`${method} ${url.pathname}${url.search}`);
    if (db.down) throw new TypeError('Failed to fetch');

    if (url.pathname.startsWith('/api/files')) {
      return opts.files?.(url, init) ?? json(404, { error: 'NOT_FOUND', message: '시험용 보관소는 비어 있다' });
    }
    const m = /^\/api\/cads(?:\/([^/]+)(\/content)?)?$/.exec(url.pathname);
    if (!m) return json(404, { error: 'NOT_FOUND', message: '없는 경로' });
    const id = m[1];

    if (!id) {
      if (method === 'GET') return json(200, [...rows.values()].filter(r => !r.deleted).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)).map(view));
      if (method === 'POST') {
        const name = url.searchParams.get('name') ?? 'x';
        const format = (name.split('.').pop() ?? '').toLowerCase();
        if (!['step', 'stp', 'iges', 'igs', 'stl', 'obj', 'glb', 'gltf'].includes(format)) return json(415, { error: 'UNSUPPORTED_FORMAT', message: `${format} 형식은 올릴 수 없어요` });
        const body = init?.body as Blob;
        if (!body || body.size === 0) return json(400, { error: 'EMPTY_BODY', message: '빈 파일이에요' });
        const sha = await hashOf(body);
        const known = rows.get(sha);
        if (known && !known.deleted) return json(200, { ...view(known), duplicate: true, vault: 'duplicate' });
        const row: Row = known ?? { id: sha, name, format, size: body.size, uploadedAt: stamp(), lastOpenedAt: null, parts: null, layers: null, bytes: await bytesOf(body), deleted: false };
        row.deleted = false;
        rows.set(sha, row);
        return json(201, { ...view(row), duplicate: false, vault: 'saved' });
      }
    }
    const row = id ? rows.get(id) : undefined;
    if (!row || row.deleted) return json(404, { error: 'NOT_FOUND', message: '서버 DB 에 없는 CAD' });
    if (m[2]) return new Response(new Uint8Array(row.bytes).buffer, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    if (method === 'GET') return json(200, view(row));
    if (method === 'PATCH') {
      const b = JSON.parse(String(init?.body ?? '{}')) as { parts?: number; layers?: number; opened?: boolean };
      if (typeof b.parts === 'number') row.parts = b.parts;
      if (typeof b.layers === 'number') row.layers = b.layers;
      if (b.opened) row.lastOpenedAt = stamp();
      return json(200, view(row));
    }
    if (method === 'DELETE') { row.deleted = true; return new Response(null, { status: 204 }); }
    return json(405, { error: 'METHOD_NOT_ALLOWED', message: '허용하지 않는 요청' });
  };

  const db: FakeCadDb = {
    fetch: handler as typeof fetch,
    rows, calls, urls, down: false,
    count: (method, part) => calls.filter(c => c.startsWith(`${method} `) && c.includes(part)).length,
  };
  return db;
}
