// 세션 캐시: 열어 둔 CAD 는 창을 닫은 뒤에도 10분 동안 브라우저에 남아 바로 열린다.
//   - CAD 파일 자체의 캐시(IndexedDB 의 blob)는 cadLibrary 가 이 TTL 로 비운다.
//   - 여기서는 "보던 상태"(고른 부품 · 단계)를 localStorage 에 적어 두고, 10분이 지나면 없는 것으로 본다.
//   "마지막에 작업하던 CAD 가 무엇인가"(onto-pdm.cad.active)는 만료와 무관하다: 서버 DB 에서 다시 받으면 되기 때문이다.

/** 마지막으로 쓴 때부터 이 시간이 지나면 캐시를 비운다 */
export const CACHE_TTL_MS = 10 * 60 * 1000;
/** 열려 있는 동안 "아직 쓰는 중"이라고 알리는 간격 */
export const HEARTBEAT_MS = 15 * 1000;

const SESSION_KEY = 'onto-pdm.cad.session';

export interface CadSession {
  /** 열어 둔 CAD 의 id */
  id: string;
  /** 고른 부품 이름 */
  partName?: string;
  /** 뷰어의 단계 번호 (1 = 전체, 2 이상 = 제조 단계) */
  step?: number;
  /** 마지막으로 저장한 시각 (ms) */
  savedAt: number;
}

function lsGet(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } }
function lsSet(key: string, value: string) { try { window.localStorage.setItem(key, value); } catch { /* 저장 못 해도 동작에는 지장 없음 */ } }
function lsDel(key: string) { try { window.localStorage.removeItem(key); } catch { /* 무시 */ } }

export function writeSession(s: Omit<CadSession, 'savedAt'>, now = Date.now()): void {
  lsSet(SESSION_KEY, JSON.stringify({ ...s, savedAt: now }));
}

/** 10분 안에 저장한 세션만 돌려준다. 만료됐거나 깨진 값이면 null */
export function readSession(now = Date.now()): CadSession | null {
  try {
    const v = JSON.parse(lsGet(SESSION_KEY) ?? 'null') as CadSession | null;
    if (!v || typeof v.id !== 'string' || typeof v.savedAt !== 'number') return null;
    if (now - v.savedAt >= CACHE_TTL_MS || v.savedAt > now + 60_000) return null;
    return v;
  } catch { return null; }
}

/** 그 CAD 의 세션이면 지운다 (CAD 를 목록에서 제거할 때) */
export function clearSession(id?: string): void {
  if (id !== undefined) {
    try { if ((JSON.parse(lsGet(SESSION_KEY) ?? 'null') as CadSession | null)?.id !== id) return; } catch { /* 깨진 값은 지운다 */ }
  }
  lsDel(SESSION_KEY);
}

/** 캐시가 몇 분 남았는지 (올림, 최소 1) */
export const minutesLeft = (expiresAtIso: string, now: number): number =>
  Math.max(1, Math.ceil((Date.parse(expiresAtIso) - now) / 60_000));
