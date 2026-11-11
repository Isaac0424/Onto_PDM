// CAD 서버 DB 클라이언트: CAD 파일 자체는 서버 DB(/api/cads)가 정본이다. 개발 서버는 /api/cads 를 FILES_PORT(8788)로 넘긴다 (vite.config.ts).
//   GET /api/cads · POST /api/cads?name= (본문 = 파일 바이트) · GET /api/cads/:id/content · PATCH /api/cads/:id · DELETE /api/cads/:id
// 서버가 꺼져 있거나 응답이 서버의 것이 아니면(프록시 오류 · HTML) CadServerUnavailable, 서버가 이유를 적어 거절하면 CadServerError 를 던진다.

export interface ServerCad {
  /** 내용의 sha256 */
  id: string;
  name: string;
  format: string;
  size: number;
  uploadedAt: string;
  lastOpenedAt: string | null;
  parts: number | null;
  layers: number | null;
}

export interface ServerCadSaved extends ServerCad {
  /** 같은 내용이 이미 DB 에 있었다 */
  duplicate: boolean;
  /** 서버가 파일 보관소(OPMS 공유)에도 복사한 결과 */
  vault: 'saved' | 'duplicate' | 'unavailable';
}

/** 서버가 꺼져 있다 (연결 실패 · 제한시간 · 프록시 오류) */
export class CadServerUnavailable extends Error {
  constructor(detail?: string) {
    super(`CAD 보관 서버에 연결하지 못했습니다${detail ? ` (${detail})` : ''}. \`node server/files-server.mjs\`를 켜 주세요.`);
    this.name = 'CadServerUnavailable';
  }
}

/** 서버가 이유를 적어 거절했다 (형식 · 크기 · 없음 …) */
export class CadServerError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'CadServerError';
  }
}

export interface CadServer {
  list(): Promise<ServerCad[]>;
  upload(file: File): Promise<ServerCadSaved>;
  content(id: string): Promise<Blob>;
  patch(id: string, body: { parts?: number; layers?: number; opened?: true }): Promise<ServerCad>;
  /** 이미 없는 것(404)도 지운 것으로 본다 */
  remove(id: string): Promise<void>;
}

export interface CadServerOptions {
  fetchImpl?: typeof fetch;
  /** 가벼운 요청(목록 · 수정 · 삭제)의 응답 제한시간 */
  timeoutMs?: number;
  /** 파일을 올리고 내려받는 요청의 제한시간 (큰 파일이라 더 길다) */
  transferTimeoutMs?: number;
}

export function createCadServer(opts: CadServerOptions = {}): CadServer {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const light = opts.timeoutMs ?? 3000;
  const heavy = opts.transferTimeoutMs ?? 60_000;

  async function call(path: string, init: RequestInit = {}, timeoutMs = light): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await doFetch(path, { ...init, signal: ctl.signal }); }
    catch { throw new CadServerUnavailable(); }
    finally { clearTimeout(timer); }
  }

  /** 성공이 아니면 던진다. 서버의 오류 본문({error, message})이 있으면 CadServerError, 없으면(프록시 오류 등) 서버가 꺼진 것으로 본다 */
  async function check(res: Response): Promise<Response> {
    if (res.ok) return res;
    const body = await res.json().catch(() => null) as { error?: string; message?: string } | null;
    if (!body || typeof body.error !== 'string') throw new CadServerUnavailable(`HTTP ${res.status}`);
    throw new CadServerError(res.status, body.error, body.message ?? `CAD 서버가 요청을 처리하지 못했습니다 (${body.error})`);
  }

  async function json<T>(res: Response): Promise<T> {
    try { return await res.json() as T; } catch { throw new CadServerUnavailable('서버의 응답이 아닙니다'); }
  }

  return {
    async list() {
      const rows = await json<unknown>(await check(await call('/api/cads')));
      if (!Array.isArray(rows)) throw new CadServerUnavailable('서버의 응답이 아닙니다');
      return rows as ServerCad[];
    },
    async upload(file) {
      const res = await check(await call(`/api/cads?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file }, heavy));
      return json<ServerCadSaved>(res);
    },
    async content(id) {
      return (await check(await call(`/api/cads/${encodeURIComponent(id)}/content`, {}, heavy))).blob();
    },
    async patch(id, body) {
      const res = await check(await call(`/api/cads/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }));
      return json<ServerCad>(res);
    },
    async remove(id) {
      const res = await call(`/api/cads/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.status === 404) return;
      await check(res);
    },
  };
}
