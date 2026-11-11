// E2E 가짜 서버: 서버 DB(/api/cads)와 파일 보관소(/api/files)를 메모리로 흉내 낸다.
// 이 컴퓨터에 실제 서버(8788)가 떠 있어도 시험 CAD 가 실제 DB · 보관소에 쌓이지 않게, 모든 시험이 이것을 거친다 (cad-fixtures.ts 의 test 가 자동으로 건다).
// 서버 API 계약은 server/cad-db.mjs 와 같다. server.down = true 로 서버가 꺼진 것처럼(연결 거부) 만들 수 있다.
import { createHash } from 'node:crypto';
import type { BrowserContext, Route } from '@playwright/test';

export interface FakeRow {
  id: string; name: string; format: string; size: number; uploadedAt: string;
  lastOpenedAt: string | null; parts: number | null; layers: number | null;
  bytes: Buffer; deleted: boolean;
}

export interface FakeServer {
  /** 서버 DB 의 행 (id = sha256) */
  rows: Map<string, FakeRow>;
  /** 받은 요청: `METHOD /경로` (서버 DB 와 보관소 모두) */
  calls: string[];
  /** true 면 서버가 꺼져 있다 (연결 거부) */
  down: boolean;
  /** 지금까지의 호출 중 메서드가 같고 경로가 pathPart 를 포함하는 횟수 */
  count(method: string, pathPart: string): number;
}

const CAD_FORMATS = new Set(['step', 'stp', 'iges', 'igs', 'stl', 'obj', 'glb', 'gltf']);
const view = ({ bytes: _b, deleted: _d, ...rest }: FakeRow) => rest;
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

export async function fakeServer(context: BrowserContext): Promise<FakeServer> {
  const rows = new Map<string, FakeRow>();
  const calls: string[] = [];
  let tick = 0;
  const server: FakeServer = {
    rows, calls, down: false,
    count: (method, part) => calls.filter(c => c.startsWith(`${method} `) && c.includes(part)).length,
  };
  const stamp = () => new Date(Date.now() + (tick += 1)).toISOString();

  // 파일 보관소: 올리면 201, 그 밖에는 빈 목록
  await context.route('**/api/files**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    calls.push(`${req.method()} ${url.pathname}`);
    if (server.down) return route.abort('connectionrefused');
    if (req.method() === 'POST') {
      const name = url.searchParams.get('name') ?? 'x';
      return route.fulfill(json(201, { sha256: 'f'.repeat(64), size: 1, name, format: name.split('.').pop() ?? '', kind: url.searchParams.get('kind') ?? 'cad', duplicate: false }));
    }
    return route.fulfill(json(200, []));
  });

  // 서버 DB
  await context.route('**/api/cads**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    calls.push(`${method} ${url.pathname}`);
    if (server.down) return route.abort('connectionrefused');

    const m = /^\/api\/cads(?:\/([^/]+)(\/content)?)?$/.exec(url.pathname);
    if (!m) return route.fulfill(json(404, { error: 'NOT_FOUND', message: '없는 경로' }));
    const id = m[1];

    if (!id) {
      if (method === 'GET') return route.fulfill(json(200, [...rows.values()].filter(r => !r.deleted).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)).map(view)));
      if (method === 'POST') {
        const name = url.searchParams.get('name') ?? 'x';
        const format = (name.split('.').pop() ?? '').toLowerCase();
        if (!CAD_FORMATS.has(format)) return route.fulfill(json(415, { error: 'UNSUPPORTED_FORMAT', message: `${format} 형식은 올릴 수 없어요` }));
        const body = req.postDataBuffer();
        if (!body || body.length === 0) return route.fulfill(json(400, { error: 'EMPTY_BODY', message: '빈 파일이에요' }));
        const sha = createHash('sha256').update(body).digest('hex');
        const known = rows.get(sha);
        if (known && !known.deleted) return route.fulfill(json(200, { ...view(known), duplicate: true, vault: 'duplicate' }));
        const row: FakeRow = known ?? { id: sha, name, format, size: body.length, uploadedAt: stamp(), lastOpenedAt: null, parts: null, layers: null, bytes: body, deleted: false };
        row.deleted = false;
        rows.set(sha, row);
        return route.fulfill(json(201, { ...view(row), duplicate: false, vault: 'saved' }));
      }
    }
    const row = id ? rows.get(id) : undefined;
    if (!row || row.deleted) return route.fulfill(json(404, { error: 'NOT_FOUND', message: '서버 DB 에 없는 CAD' }));
    if (m[2]) return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: row.bytes });
    if (method === 'GET') return route.fulfill(json(200, view(row)));
    if (method === 'PATCH') {
      const b = JSON.parse(req.postData() ?? '{}') as { parts?: number; layers?: number; opened?: boolean };
      if (typeof b.parts === 'number') row.parts = b.parts;
      if (typeof b.layers === 'number') row.layers = b.layers;
      if (b.opened) row.lastOpenedAt = stamp();
      return route.fulfill(json(200, view(row)));
    }
    if (method === 'DELETE') { row.deleted = true; return route.fulfill({ status: 204 }); }
    return route.fulfill(json(405, { error: 'METHOD_NOT_ALLOWED', message: '허용하지 않는 요청' }));
  });

  return server;
}
