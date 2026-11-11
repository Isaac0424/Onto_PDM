import { describe, expect, it, vi } from 'vitest';
import { CadServerError, CadServerUnavailable, createCadServer } from './cadServer';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const row = { id: 'a'.repeat(64), name: 'a.step', format: 'step', size: 3, uploadedAt: '2026-11-11T09:00:00Z', lastOpenedAt: null, parts: null, layers: null };
const serverOf = (impl: (url: string, init?: RequestInit) => Promise<Response>, timeoutMs?: number) =>
  createCadServer({ fetchImpl: vi.fn(impl) as unknown as typeof fetch, ...(timeoutMs ? { timeoutMs } : {}) });

describe('CAD 서버 DB 클라이언트', () => {
  it('목록 · 올리기 · 내려받기 · 수정 · 삭제 요청을 서버 계약대로 보낸다', async () => {
    const seen: [string, RequestInit | undefined][] = [];
    const server = serverOf(async (url, init) => {
      seen.push([url, init]);
      if (url === '/api/cads' && !init?.method) return json(200, [row]);
      if (url.startsWith('/api/cads?name=')) return json(201, { ...row, duplicate: false, vault: 'saved' });
      if (url.endsWith('/content')) return new Response('BYTES', { status: 200 });
      if (init?.method === 'PATCH') return json(200, { ...row, parts: 3, layers: 2 });
      return new Response(null, { status: 204 });
    });

    expect(await server.list()).toEqual([row]);
    const saved = await server.upload(new File(['abc'], '브래킷 1.step'));
    expect(saved).toMatchObject({ duplicate: false, vault: 'saved' });
    expect(await (await server.content(row.id)).text()).toBe('BYTES');
    expect(await server.patch(row.id, { parts: 3, layers: 2, opened: true })).toMatchObject({ parts: 3 });
    await server.remove(row.id);

    expect(seen.map(([u, i]) => `${i?.method ?? 'GET'} ${u}`)).toEqual([
      'GET /api/cads',
      `POST /api/cads?name=${encodeURIComponent('브래킷 1.step')}`,
      `GET /api/cads/${row.id}/content`,
      `PATCH /api/cads/${row.id}`,
      `DELETE /api/cads/${row.id}`,
    ]);
    expect(seen[1]![1]!.body).toBeInstanceOf(File);                                       // 본문은 파일 바이트 그대로
    expect(JSON.parse(String(seen[3]![1]!.body))).toEqual({ parts: 3, layers: 2, opened: true });
  });

  it('서버가 없으면(연결 실패) CadServerUnavailable: 사람이 읽는 이유와 함께', async () => {
    const server = serverOf(async () => { throw new TypeError('Failed to fetch'); });
    const err = await server.list().catch(e => e);
    expect(err).toBeInstanceOf(CadServerUnavailable);
    expect(err.message).toContain('서버에 연결하지 못했습니다');
    await expect(server.upload(new File(['x'], 'a.step'))).rejects.toBeInstanceOf(CadServerUnavailable);
    await expect(server.remove('x')).rejects.toBeInstanceOf(CadServerUnavailable);
  });

  it('서버의 응답이 아닌 것(프록시 오류 · HTML)도 서버가 꺼진 것으로 본다', async () => {
    const proxyDown = serverOf(async () => new Response('', { status: 500 }));
    await expect(proxyDown.list()).rejects.toBeInstanceOf(CadServerUnavailable);
    const html = serverOf(async () => new Response('<!doctype html>', { status: 200 }));
    await expect(html.list()).rejects.toBeInstanceOf(CadServerUnavailable);
    const notArray = serverOf(async () => json(200, { ok: true }));
    await expect(notArray.list()).rejects.toBeInstanceOf(CadServerUnavailable);
  });

  it('서버가 이유를 적어 거절하면 CadServerError (상태 · 코드 · 메시지)', async () => {
    const server = serverOf(async () => json(415, { error: 'UNSUPPORTED_FORMAT', message: 'pdf 형식은 올릴 수 없어요' }));
    const err = await server.upload(new File(['x'], 'a.pdf')).catch(e => e);
    expect(err).toBeInstanceOf(CadServerError);
    expect(err).toMatchObject({ status: 415, code: 'UNSUPPORTED_FORMAT', message: 'pdf 형식은 올릴 수 없어요' });
    const missing = serverOf(async () => json(404, { error: 'NOT_FOUND', message: '없어요' }));
    await expect(missing.content('x')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('이미 없는 CAD 를 지우는 것(404)은 지운 것으로 본다', async () => {
    await expect(serverOf(async () => json(404, { error: 'NOT_FOUND', message: '없어요' })).remove('x')).resolves.toBeUndefined();
  });

  it('응답이 제한시간 안에 오지 않으면 서버가 꺼진 것으로 본다', async () => {
    const hang = serverOf((_url, init) => new Promise<Response>((_res, rej) => {
      init!.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }), 30);
    await expect(hang.list()).rejects.toBeInstanceOf(CadServerUnavailable);
  });
});
