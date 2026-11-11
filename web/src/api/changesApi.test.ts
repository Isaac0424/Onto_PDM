// 설계 변경 API(HTTP): 백엔드에 라우트가 없거나 꺼져 있으면 "연결 전" 빈 상태, 백엔드의 오류는 코드 · 상세까지 전한다.
import { describe, expect, it } from 'vitest';
import { createChangesHttp } from './changesApi';
import { createEmptyApi } from './emptyApi';
import { createHttpApi } from './httpApi';
import { ApiError } from './types';

interface Call { method: string; url: string; body?: unknown }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fake(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? 'GET', url: String(input), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
  return { calls, api: createChangesHttp(fetchImpl, 1000) };
}

const PAGE = { items: [{ code: 'CR-2026-0001', title: 't', status: 'draft', origin: 'design', requested_by: 'e', requested_at: '2026-11-12T00:00:00Z' }], total: 1, page: 1, size: 25 };

describe('읽어 올 곳이 없을 때(연결 전)', () => {
  it('백엔드가 꺼져 있으면 사용 불가 · 빈 값이고 던지지 않는다', async () => {
    const { api } = fake(() => { throw new TypeError('connection refused'); });
    expect(await api.changesAvailable()).toBe(false);
    expect(await api.listChanges()).toEqual({ items: [], total: 0, page: 1, size: 25 });
    expect(await api.getChange('CR-1')).toBeNull();
    expect(await api.getImpact('CR-1')).toBeNull();
    expect(await api.getImpactGraph('CR-1')).toEqual({ nodes: [], edges: [] });
    expect(await api.getOntologyImpact()).toBeNull();
  });

  it('백엔드는 있는데 이 라우트가 없으면(FastAPI 기본 404) 연결 전으로 본다', async () => {
    const { api } = fake(() => json(404, { detail: 'Not Found' }));
    expect(await api.changesAvailable()).toBe(false);
    expect(await api.listChanges()).toMatchObject({ items: [], total: 0 });
  });

  it('프록시의 안내 페이지(HTML 200)도 연결 전이다', async () => {
    const { api } = fake(() => new Response('<html>spa</html>', { status: 200 }));
    expect(await api.changesAvailable()).toBe(false);
  });

  it('OPMS 를 못 읽는 503 은 읽는 길을 빈 값으로 흡수한다', async () => {
    const { api } = fake(() => json(503, { error: { code: 'OPMS_NOT_CONFIGURED', message: 'OPMS 설정 없음' } }));
    expect(await api.getOntologyImpact('0.18.0', '0.19.0')).toBeNull();
    expect(await api.changesAvailable()).toBe(false);
  });

  it('쓰는 길은 거절한다(503)', async () => {
    const { api } = fake(() => { throw new TypeError('down'); });
    await expect(api.createChange({ title: 't', reason: 'r' })).rejects.toMatchObject({ status: 503 });
    await expect(api.approveChange('CR-1')).rejects.toBeInstanceOf(ApiError);
  });

  it('비어 있는 API(emptyApi)는 읽기는 비어 있고 쓰기는 503 이다', async () => {
    const api = createEmptyApi();
    expect(await api.changesAvailable()).toBe(false);
    expect(await api.listChanges()).toMatchObject({ items: [], total: 0 });
    expect(await api.getChange('x')).toBeNull();
    await expect(api.recomputeImpact('x')).rejects.toMatchObject({ status: 503 });
  });
});

describe('연결됐을 때', () => {
  it('목록은 쿼리(상태 · 검색)를 붙여 /api/v1/pdm/changes 를 읽는다', async () => {
    const { api, calls } = fake(() => json(200, PAGE));
    const page = await api.listChanges({ status: 'draft', q: '너트 교체', page: 2 });
    expect(page.items).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/v1/pdm/changes?status=draft&q=%EB%84%88%ED%8A%B8+%EA%B5%90%EC%B2%B4&page=2');
  });

  it('사용 가능 여부는 한 번 닿으면 기억한다', async () => {
    const { api, calls } = fake(() => json(200, PAGE));
    expect(await api.changesAvailable()).toBe(true);
    expect(await api.changesAvailable()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/v1/pdm/changes?size=1');
  });

  it('없는 변경 건(CHANGE_NOT_FOUND)은 null, 분석이 아직 없으면(IMPACT_NOT_COMPUTED 404) null', async () => {
    const { api } = fake(c => json(404, { error: { code: c.url.endsWith('/impact') ? 'IMPACT_NOT_COMPUTED' : 'CHANGE_NOT_FOUND', message: '없음' } }));
    expect(await api.getChange('CR-없음')).toBeNull();
    expect(await api.getImpact('CR-1')).toBeNull();
  });

  it('쓰기는 설계 6장의 경로와 본문으로 부른다', async () => {
    const { api, calls } = fake(c => (c.method === 'DELETE' ? new Response(null, { status: 204 }) : json(200, {})));
    await api.addChangeTarget('CR-1', { change_kind: 'replace', item_no: 'P-1', replacement_item_no: 'P-2' });
    await api.removeChangeTarget('CR-1', 7);
    await api.setChangeScope('CR-1', 7, { scopes: [{ applies: 'new', serial_from: 120 }] });
    await api.recomputeImpact('CR-1');
    await api.getImpact('CR-1', 3);
    await api.setDisposition('CR-1', 14, { action: 'use_as_is', reason: '허용' });
    await api.submitReview('CR-1', { function: 'purchasing', verdict: 'approve' });
    await api.acceptChange('CR-1');
    await api.submitChange('CR-1');
    await api.approveChange('CR-1');
    await api.rejectChange('CR-1', { reason: '피치' });
    await api.getOntologyImpact('0.18.0', '0.19.0');
    expect(calls.map(c => `${c.method} ${c.url.replace('/api/v1/pdm', '')}`)).toEqual([
      'POST /changes/CR-1/targets', 'DELETE /changes/CR-1/targets/7', 'PUT /changes/CR-1/targets/7/scope', 'POST /changes/CR-1/impact', 'GET /changes/CR-1/impact?run_id=3',
      'PUT /changes/CR-1/dispositions/14', 'POST /changes/CR-1/reviews', 'POST /changes/CR-1/accept', 'POST /changes/CR-1/submit', 'POST /changes/CR-1/approve',
      'POST /changes/CR-1/reject', 'GET /changes/ontology-impact?from=0.18.0&to=0.19.0',
    ]);
    expect(calls[0]!.body).toEqual({ change_kind: 'replace', item_no: 'P-1', replacement_item_no: 'P-2' });
    expect(calls[2]!.body).toEqual({ scopes: [{ applies: 'new', serial_from: 120 }] });
    expect(calls[10]!.body).toEqual({ reason: '피치' });
  });

  it('백엔드의 오류는 코드 · 상세 · 상태까지 ApiError 로 전한다', async () => {
    const { api } = fake(() => json(409, { error: { code: 'DISPOSITION_REQUIRED', message: '처분이 없는 영향이 있습니다.', details: { finding_ids: [14, 15] } } }));
    const err = await api.approveChange('CR-1').catch(e => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'DISPOSITION_REQUIRED', message: '처분이 없는 영향이 있습니다.', details: { finding_ids: [14, 15] } });
  });

  it('422 는 400 으로, 403 은 403 으로 옮긴다', async () => {
    const { api: a } = fake(() => json(422, { error: { code: 'SCOPE_INVALID', message: '범위 오류' } }));
    await expect(a.setChangeScope('CR-1', 1, { scopes: [] })).rejects.toMatchObject({ status: 400, code: 'SCOPE_INVALID' });
    const { api: b } = fake(() => json(403, { error: { code: 'FORBIDDEN', message: '권한 없음' } }));
    await expect(b.approveChange('CR-1')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('요청 주소의 변경 코드는 인코딩한다', async () => {
    const { api, calls } = fake(() => json(200, {}));
    await api.getChange('CR/1 2');
    expect(calls[0]!.url).toBe('/api/v1/pdm/changes/CR%2F1%202');
  });
});

describe('createHttpApi 에 끼워진 설계 변경 길', () => {
  it('connected 는 그대로 false 이고(제품 · BOM 은 OPMS 에 없다) 설계 변경 메서드는 HTTP 로 부른다', async () => {
    const urls: string[] = [];
    const api = createHttpApi({ fetchImpl: (async (u: RequestInfo | URL) => { urls.push(String(u)); return json(200, PAGE); }) as typeof fetch });
    expect(api.connected).toBe(false);
    expect(await api.changesAvailable()).toBe(true);
    expect(urls).toEqual(['/api/v1/pdm/changes?size=1']);
  });
});
