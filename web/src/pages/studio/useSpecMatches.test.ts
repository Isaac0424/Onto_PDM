import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createEmptyApi } from '../../api/emptyApi';
import type { CadPartHint, CadPartMatch, PdmApi } from '../../api/types';
import { MATCH_CONCURRENCY, useSpecMatches, type SpecMatchOptions, type SpecRequest } from './useSpecMatches';

// 보유 품번 매칭 큐: 규격이 있는 부품만 최대 4개씩 묻고, 고른 부품이 먼저이고, 규격이 바뀐 부품만 다시 묻고,
// 추정 값으로 찾은 결과는 어떤 API 가 확정(matched)을 돌려줘도 후보로만 둔다.
const HINT: CadPartHint = { threadSize: 'M4', length: 15, headType: 'Socket' };
const EST = { threadSize: 'M4', length: 15 };

interface Gate { name: string; hint?: CadPartHint; release(m?: Partial<CadPartMatch>): void }

/** 호출을 붙들어 두었다가 시험이 풀어 주는 가짜 API (동시 요청 수 · 순서를 본다) */
function gatedApi() {
  const started: string[] = [];
  const gates: Gate[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const unhintedCalls: string[][] = [];
  const api: PdmApi = {
    ...createEmptyApi(),
    connected: true,
    clearMatchCache: vi.fn(),
    matchCadParts: (names, hints) => {
      const hinted = names.length === 1 && hints?.[names[0]!];
      if (!hinted) { unhintedCalls.push(names); return Promise.resolve(names.map(name => ({ name, status: 'none' as const, reason: 'needs_values' as const }))); }
      const name = names[0]!;
      started.push(name);
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<CadPartMatch[]>(resolve => {
        gates.push({ name, hint: hints![name]!, release: m => { inFlight -= 1; resolve([{ name, status: 'suggested', itemNo: 'P-1', itemName: '볼트', ...m } as CadPartMatch]); } });
      });
    },
  };
  return { api, started, gates, unhintedCalls, maxInFlight: () => maxInFlight };
}

const opts = (api: PdmApi, names: string[], requests: Map<string, SpecRequest>, over: Partial<SpecMatchOptions> = {}): SpecMatchOptions =>
  ({ api, names, requests, epoch: 0, link: 'none', resetKey: 'cad:1', ...over });

const reqs = (names: string[], est = false) => new Map(names.map(n => [n, { hint: HINT, ...(est ? { estimated: EST } : {}) } as SpecRequest]));

describe('보유 품번 매칭 큐 (useSpecMatches)', () => {
  it(`동시에 묻는 수는 최대 ${MATCH_CONCURRENCY}개이고, 하나가 끝나면 다음을 묻는다`, async () => {
    const g = gatedApi();
    const names = Array.from({ length: 10 }, (_, i) => `b${i}`);
    const { result } = renderHook(() => useSpecMatches(opts(g.api, names, reqs(names))));
    await waitFor(() => expect(g.started).toHaveLength(MATCH_CONCURRENCY));
    expect(g.maxInFlight()).toBe(MATCH_CONCURRENCY);
    act(() => g.gates[0]!.release());
    await waitFor(() => expect(g.started).toHaveLength(MATCH_CONCURRENCY + 1));
    for (let i = 1; i < 10; i++) { await waitFor(() => expect(g.gates[i]).toBeDefined()); act(() => g.gates[i]!.release()); }
    await waitFor(() => expect(result.current.size).toBe(10));
    expect(g.maxInFlight()).toBe(MATCH_CONCURRENCY);
  });

  it('고른 부품(priorityName)을 먼저 묻는다', async () => {
    const g = gatedApi();
    const names = Array.from({ length: 8 }, (_, i) => `b${i}`);
    renderHook(() => useSpecMatches(opts(g.api, names, reqs(names), { priorityName: 'b7' })));
    await waitFor(() => expect(g.started).toHaveLength(MATCH_CONCURRENCY));
    expect(g.started[0]).toBe('b7');
  });

  it('규격이 없는 부품은 한 번에 묶어 묻고(서버를 부르지 않는 길), 규격이 생긴 부품만 큐에 들어간다', async () => {
    const g = gatedApi();
    const names = ['판', '볼트'];
    const { result } = renderHook(() => useSpecMatches(opts(g.api, names, new Map([['볼트', { hint: HINT }]]))));
    await waitFor(() => expect(g.gates).toHaveLength(1));
    expect(g.unhintedCalls).toEqual([['판']]);
    expect(g.started).toEqual(['볼트']);
    act(() => g.gates[0]!.release());
    await waitFor(() => expect(result.current.get('판')).toMatchObject({ reason: 'needs_values' }));
  });

  it('규격이 바뀐 부품만 다시 묻는다 (나머지는 다시 묻지 않는다)', async () => {
    const g = gatedApi();
    const names = ['a', 'b'];
    const { result, rerender } = renderHook((p: { r: Map<string, SpecRequest> }) => useSpecMatches(opts(g.api, names, p.r)), { initialProps: { r: reqs(names) } });
    await waitFor(() => expect(g.gates).toHaveLength(2));
    act(() => g.gates.forEach(x => x.release()));
    await waitFor(() => expect(result.current.size).toBe(2));
    const next = new Map(reqs(names)); next.set('b', { hint: { ...HINT, length: 10 } });
    rerender({ r: next });
    await waitFor(() => expect(g.gates).toHaveLength(3));
    expect(g.gates[2]!.name).toBe('b');
  });

  it('추정 값으로 찾은 결과에는 estimated 를 붙이고, API 가 확정(matched)을 돌려줘도 후보(suggested)로 둔다 (자동 확정 없음)', async () => {
    const g = gatedApi();
    const { result } = renderHook(() => useSpecMatches(opts(g.api, ['a'], reqs(['a'], true))));
    await waitFor(() => expect(g.gates).toHaveLength(1));
    act(() => g.gates[0]!.release({ status: 'matched' }));
    await waitFor(() => expect(result.current.get('a')).toBeDefined());
    expect(result.current.get('a')).toMatchObject({ status: 'suggested', estimated: EST });
  });

  it('확정한 값(estimated 없음)으로 찾은 결과는 그대로 둔다', async () => {
    const g = gatedApi();
    const { result } = renderHook(() => useSpecMatches(opts(g.api, ['a'], reqs(['a']))));
    await waitFor(() => expect(g.gates).toHaveLength(1));
    act(() => g.gates[0]!.release());
    await waitFor(() => expect(result.current.get('a')).toBeDefined());
    expect(result.current.get('a')).not.toHaveProperty('estimated');
  });

  it('OPMS 연결을 확인하는 동안(loading)은 묻지 않고, 끊겼으면(off) 묻지 않고 "연결 안 됨"으로 둔다', async () => {
    const g = gatedApi();
    const { result, rerender } = renderHook((p: { link: SpecMatchOptions['link'] }) => useSpecMatches(opts(g.api, ['a'], reqs(['a'], true), { link: p.link })), { initialProps: { link: 'loading' as SpecMatchOptions['link'] } });
    await act(async () => { await Promise.resolve(); });
    expect(g.started).toEqual([]);
    expect(result.current.get('a')).toBeUndefined();
    rerender({ link: 'off' });
    await waitFor(() => expect(result.current.get('a')).toMatchObject({ status: 'none', reason: 'unreachable' }));
    expect(g.started).toEqual([]);                                                            // 요청이 한 번도 나가지 않았다
  });

  it('연결이 돌아오면(epoch) 처음부터 다시 묻고, 캐시를 비운다', async () => {
    const g = gatedApi();
    const { result, rerender } = renderHook((p: { epoch: number; link: SpecMatchOptions['link'] }) => useSpecMatches(opts(g.api, ['a'], reqs(['a']), p)), { initialProps: { epoch: 0, link: 'off' as SpecMatchOptions['link'] } });
    await waitFor(() => expect(result.current.get('a')).toMatchObject({ reason: 'unreachable' }));
    rerender({ epoch: 1, link: 'ok' });
    await waitFor(() => expect(g.gates).toHaveLength(1));
    expect(g.api.clearMatchCache).toHaveBeenCalled();
    act(() => g.gates[0]!.release());
    await waitFor(() => expect(result.current.get('a')).toMatchObject({ status: 'suggested' }));
  });

  it('CAD 를 바꾸면(resetKey) 이전 CAD 의 늦은 응답은 버린다', async () => {
    const g = gatedApi();
    const { result, rerender } = renderHook((p: { key: string }) => useSpecMatches(opts(g.api, ['a'], reqs(['a']), { resetKey: p.key })), { initialProps: { key: 'cad:1' } });
    await waitFor(() => expect(g.gates).toHaveLength(1));
    rerender({ key: 'cad:2' });
    await waitFor(() => expect(g.gates).toHaveLength(2));
    act(() => g.gates[0]!.release({ itemNo: 'P-OLD' }));                                      // 이전 CAD 의 응답
    act(() => g.gates[1]!.release({ itemNo: 'P-NEW' }));
    await waitFor(() => expect(result.current.get('a')).toMatchObject({ itemNo: 'P-NEW' }));
  });

  it('API 가 던져도 화면이 멈추지 않고 "연결 안 됨"으로 둔다', async () => {
    const api: PdmApi = { ...createEmptyApi(), matchCadParts: () => Promise.reject(new Error('boom')) };
    const { result } = renderHook(() => useSpecMatches(opts(api, ['a'], reqs(['a']))));
    await waitFor(() => expect(result.current.get('a')).toMatchObject({ status: 'none', reason: 'unreachable' }));
  });
});
