import { beforeEach, describe, expect, it } from 'vitest';
import { CACHE_TTL_MS, clearSession, minutesLeft, readSession, writeSession } from './sessionCache';

const T0 = 1_000_000_000_000;

describe('세션 캐시 (보던 상태를 10분 동안)', () => {
  beforeEach(() => window.localStorage.clear());

  it('캐시 시간은 10분이다', () => {
    expect(CACHE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it('10분 안에는 고른 부품 · 단계가 돌아오고, 10분이 지나면 없는 것으로 본다', () => {
    writeSession({ id: 'cad1', partName: '제어 기판', step: 3 }, T0);
    expect(readSession(T0 + 9 * 60_000 + 59_000)).toEqual({ id: 'cad1', partName: '제어 기판', step: 3, savedAt: T0 });
    expect(readSession(T0 + CACHE_TTL_MS)).toBeNull();
    expect(readSession(T0 + 11 * 60_000)).toBeNull();
  });

  it('다시 적으면(하트비트) 10분이 거기서부터 다시 시작한다', () => {
    writeSession({ id: 'cad1' }, T0);
    writeSession({ id: 'cad1', partName: '하우징' }, T0 + 8 * 60_000);
    expect(readSession(T0 + 15 * 60_000)?.partName).toBe('하우징');
  });

  it('깨진 값 · 없는 값은 null 이다', () => {
    expect(readSession(T0)).toBeNull();
    window.localStorage.setItem('onto-pdm.cad.session', '{깨짐');
    expect(readSession(T0)).toBeNull();
    window.localStorage.setItem('onto-pdm.cad.session', JSON.stringify({ id: 5 }));
    expect(readSession(T0)).toBeNull();
  });

  it('다른 CAD 의 세션은 지우지 않는다', () => {
    writeSession({ id: 'cad1' }, T0);
    clearSession('cad2');
    expect(readSession(T0)?.id).toBe('cad1');
    clearSession('cad1');
    expect(readSession(T0)).toBeNull();
  });

  it('캐시 남은 시간은 분 단위로 올림한다 (최소 1분)', () => {
    const exp = new Date(T0 + CACHE_TTL_MS).toISOString();
    expect(minutesLeft(exp, T0)).toBe(10);
    expect(minutesLeft(exp, T0 + 60_000)).toBe(9);
    expect(minutesLeft(exp, T0 + CACHE_TTL_MS - 1_000)).toBe(1);
    expect(minutesLeft(exp, T0 + CACHE_TTL_MS + 5_000)).toBe(1);
  });
});
