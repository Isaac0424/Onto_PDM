import { describe, expect, it } from 'vitest';
import { createHttpApi } from './httpApi';
import { ApiError } from './types';
import { fakeBackend } from './testBackend';

const SOCKET_M4_15 = { threadSize: 'M4', length: 15, headType: 'Socket', fastenerClass: 'SocketHeadBolt' };

describe('PDM 백엔드 HTTP API', () => {
  it('OPMS 를 읽는 길(opms)이 있고, 제품 · 규칙 · MES 는 OPMS 에 없는 데이터라 connected 는 false 이다', async () => {
    const api = createHttpApi({ fetchImpl: fakeBackend().fetch });
    expect(api.connected).toBe(false);
    expect(api.opms).toBeDefined();
    expect(await api.listProducts()).toEqual([]);
    expect(await api.listAssemblyRules()).toEqual([]);
  });

  describe('연결 상태', () => {
    it('OPMS 를 읽으면 ok + 온톨로지 버전 · 개수', async () => {
      const api = createHttpApi({ fetchImpl: fakeBackend().fetch });
      expect(await api.opms!.status()).toEqual({ state: 'ok', ontologyVersion: '0.15.0', classes: 3, parts: 3 });
    });

    it('백엔드가 꺼져 있으면 backend_down + 켜는 방법', async () => {
      const s = await createHttpApi({ fetchImpl: fakeBackend({ backend: 'down' }).fetch }).opms!.status();
      expect(s.state).toBe('backend_down');
      expect(s.message).toContain('onto-pdm serve');
    });

    it('프록시가 백엔드 오류 페이지(HTML · 빈 본문)를 돌려줘도 backend_down 이다', async () => {
      const html = (async () => new Response('<html>Bad Gateway</html>', { status: 502 })) as typeof fetch;
      expect((await createHttpApi({ fetchImpl: html }).opms!.status()).state).toBe('backend_down');
      const ok200 = (async () => new Response('<html>spa</html>', { status: 200 })) as typeof fetch;   // 프록시가 없어 index.html 이 온 경우
      expect((await createHttpApi({ fetchImpl: ok200 }).opms!.status()).state).toBe('backend_down');
    });

    it.each([
      ['OPMS_UNAVAILABLE', 'opms_down'],
      ['OPMS_NOT_CONFIGURED', 'not_configured'],
      ['OPMS_AUTH_FAILED', 'auth_failed'],
      ['OPMS_NO_ONTOLOGY', 'no_ontology'],
    ] as const)('백엔드는 떠 있고 OPMS 만 문제면 %s → %s (이유를 구분한다)', async (code, state) => {
      const s = await createHttpApi({ fetchImpl: fakeBackend({ opms: code }).fetch }).opms!.status();
      expect(s.state).toBe(state);
      expect(s.message).toMatch(/OPMS/);
    });

    it('응답이 제한시간을 넘으면 backend_down 이다', async () => {
      const hang = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
      expect((await createHttpApi({ fetchImpl: hang, timeoutMs: 20 }).opms!.status()).state).toBe('backend_down');
    });
  });

  describe('분류', () => {
    it('OPMS 분류를 TaxonomyClass 로 읽는다 (계층은 parentIri)', async () => {
      const rows = await createHttpApi({ fetchImpl: fakeBackend().fetch }).listClasses();
      expect(rows.map(r => r.code)).toEqual(['Bolt', 'HexBolt', 'SocketHeadBolt']);
      expect(rows[2]).toMatchObject({ iri: 'cls:SocketHeadBolt', labelKo: '육각구멍붙이볼트', parentIri: 'cls:Bolt', kind: 'part' });
    });

    it('분류를 한 번만 읽어 둔다', async () => {
      const b = fakeBackend();
      const api = createHttpApi({ fetchImpl: b.fetch });
      await api.listClasses();
      await api.listClasses();
      expect(b.calls.filter(c => c.path === '/opms/classes')).toHaveLength(1);
    });

    it('읽지 못하면 비어 있다(던지지 않는다): 연결 상태는 opms.status 가 말한다', async () => {
      expect(await createHttpApi({ fetchImpl: fakeBackend({ backend: 'down' }).fetch }).listClasses()).toEqual([]);
      expect(await createHttpApi({ fetchImpl: fakeBackend({ opms: 'OPMS_UNAVAILABLE' }).fetch }).listClasses()).toEqual([]);
    });
  });

  describe('보유 품번 매칭 (확정한 규격으로)', () => {
    it('규격이 같은 OPMS 부품이 후보로 온다: 이름 · 일치 근거 · 점수, 확정 전이라 matched 가 아니라 suggested', async () => {
      const b = fakeBackend();
      const [m] = await createHttpApi({ fetchImpl: b.fetch }).matchCadParts(['PRT-S1'], { 'PRT-S1': SOCKET_M4_15 });
      expect(m).toMatchObject({
        name: 'PRT-S1', status: 'suggested', itemNo: 'P-00000000048', itemName: '육각구멍붙이볼트 M4 · 15 mm · SUS304', method: 'attributes', score: 1,
        classLabel: '육각구멍붙이볼트', classPath: ['기계 부품', '체결 부품', '볼트', '육각구멍붙이볼트'],
      });
      expect(m!.candidates!.map(c => c.itemNo)).toEqual(['P-00000000048', 'P-00000000050']);               // 재질만 다른 둘: 사람이 고른다
      expect(m!.candidates![0]).toMatchObject({ capped: true, classCapped: false });
      expect(m!.candidates![0]!.matched).toEqual([
        { label: '나사 규격', hit: true, doc: 'M4', part: 'M4' },
        { label: '길이', hit: true, doc: '15 mm', part: '15 mm' },
        { label: '재질', hit: null, part: 'SUS304' },                                                    // 값이 없어 비교하지 않았다
      ]);
      expect(b.calls.find(c => c.path === '/opms/match')?.body).toEqual({ class_code: 'SocketHeadBolt', head_type: 'Socket', values: { threadSize: 'M4', length: 15 } });
    });

    it('후보가 없으면 none + no_candidate, 확정한 OPMS 분류가 있으면 분류 이름은 남긴다', async () => {
      const [m] = await createHttpApi({ fetchImpl: fakeBackend().fetch }).matchCadParts(['PRT-S1'], { 'PRT-S1': { ...SOCKET_M4_15, length: 40 } });
      expect(m).toMatchObject({ status: 'none', reason: 'no_candidate', classLabel: '육각구멍붙이볼트' });
      expect(m!.candidates).toBeUndefined();
    });

    it('머리 모양이 다르면(OPMS 에 없는 버튼 헤드) 같은 규격이어도 후보가 아니다', async () => {
      const b = fakeBackend();
      const [m] = await createHttpApi({ fetchImpl: b.fetch }).matchCadParts(['PRT-B1'], { 'PRT-B1': { threadSize: 'M4', length: 10, headType: 'Button' } });
      expect(m).toMatchObject({ status: 'none', reason: 'no_candidate' });
      expect(b.calls.find(c => c.path === '/opms/match')?.body).toEqual({ head_type: 'Button', values: { threadSize: 'M4', length: 10 } });   // 클래스는 보내지 않는다
    });

    it('규격을 확정하지 않은 부품은 찾지 않는다: "미보유"가 아니라 규격 확정 필요 (이름으로는 찾을 수 없다)', async () => {
      const b = fakeBackend();
      const rows = await createHttpApi({ fetchImpl: b.fetch }).matchCadParts(['하우징', 'PRT-S1'], { 'PRT-S1': { headType: 'Socket' } });
      expect(rows).toEqual([{ name: '하우징', status: 'none', reason: 'needs_values' }, { name: 'PRT-S1', status: 'none', reason: 'needs_values' }]);
      expect(b.calls).toEqual([]);                                                                         // 서버를 부르지도 않는다
    });

    it('OPMS 를 읽지 못하면 던지지 않고 unreachable 로 돌려준다', async () => {
      for (const state of [{ backend: 'down' as const }, { opms: 'OPMS_UNAVAILABLE' as const }]) {
        const rows = await createHttpApi({ fetchImpl: fakeBackend(state).fetch }).matchCadParts(['PRT-S1'], { 'PRT-S1': SOCKET_M4_15 });
        expect(rows).toEqual([{ name: 'PRT-S1', status: 'none', reason: 'unreachable' }]);
      }
    });

    it('같은 규격으로 묻는 부품이 여럿이어도 OPMS 에는 한 번만 묻고 결과를 나눠 쓴다 (12A 의 같은 볼트 수십 개)', async () => {
      const b = fakeBackend();
      const api = createHttpApi({ fetchImpl: b.fetch });
      const names = Array.from({ length: 40 }, (_, i) => `BOLT-M4X15 ${i}`);
      const hints = Object.fromEntries(names.map(n => [n, SOCKET_M4_15]));
      const rows = await api.matchCadParts(names, hints);
      expect(rows).toHaveLength(40);
      expect(rows.every(r => r.status === 'suggested' && r.candidates?.length === 2)).toBe(true);
      expect(rows.map(r => r.name)).toEqual(names);                                                       // 결과는 부품 이름별로 돌려준다
      expect(b.calls.filter(c => c.path === '/opms/match')).toHaveLength(1);
      await api.matchCadParts(['또 다른 볼트'], { '또 다른 볼트': SOCKET_M4_15 });                       // 나중에 물어도 기억한 결과를 쓴다
      expect(b.calls.filter(c => c.path === '/opms/match')).toHaveLength(1);
    });

    it('규격이 다르면 따로 묻고(클래스 · 머리 모양 · 나사 규격 · 길이), clearMatchCache 를 부르면 다시 묻는다', async () => {
      const b = fakeBackend();
      const api = createHttpApi({ fetchImpl: b.fetch });
      await api.matchCadParts(['a', 'b', 'c'], { a: SOCKET_M4_15, b: { ...SOCKET_M4_15, length: 10 }, c: { ...SOCKET_M4_15, headType: 'Hex' } });
      expect(b.calls.filter(c => c.path === '/opms/match')).toHaveLength(3);
      api.clearMatchCache?.();
      await api.matchCadParts(['a'], { a: SOCKET_M4_15 });
      expect(b.calls.filter(c => c.path === '/opms/match')).toHaveLength(4);
    });

    it('OPMS 를 못 읽은 결과는 기억하지 않는다: 연결이 돌아오면 다시 물어 찾는다', async () => {
      const b = fakeBackend({ opms: 'OPMS_UNAVAILABLE' });
      const api = createHttpApi({ fetchImpl: b.fetch });
      expect((await api.matchCadParts(['a'], { a: SOCKET_M4_15 }))[0]).toMatchObject({ status: 'none', reason: 'unreachable' });
      b.state.opms = null;
      expect((await api.matchCadParts(['a'], { a: SOCKET_M4_15 }))[0]).toMatchObject({ status: 'suggested' });
    });
  });

  describe('부품 상세', () => {
    it('속성 이름(한글) · 단위 · 개념 값의 이름을 붙여 읽는다', async () => {
      const p = await createHttpApi({ fetchImpl: fakeBackend().fetch }).opms!.getPart('P-00000000048');
      expect(p).toMatchObject({ partNo: 'P-00000000048', classCode: 'SocketHeadBolt', classLabel: '육각구멍붙이볼트', valueLabels: { material: 'SUS304', surfaceTreatment: '아연도금' } });
      expect(p.properties).toEqual(expect.arrayContaining([
        { key: 'threadSize', label: '나사 규격', text: 'M4' }, { key: 'length', label: '길이', text: '15 mm' },
        { key: 'surfaceTreatment', label: '표면처리', text: '아연도금' }, { key: 'socketSize', label: '육각구멍 크기', text: '3 mm' },
      ]));
    });

    it('없는 부품은 404, 연결이 안 되면 503 ApiError', async () => {
      await expect(createHttpApi({ fetchImpl: fakeBackend().fetch }).opms!.getPart('P-99999999999')).rejects.toMatchObject({ status: 404 });
      const down = createHttpApi({ fetchImpl: fakeBackend({ backend: 'down' }).fetch }).opms!.getPart('P-00000000048');
      await expect(down).rejects.toBeInstanceOf(ApiError);
      await expect(down).rejects.toMatchObject({ status: 503 });
    });
  });
});
