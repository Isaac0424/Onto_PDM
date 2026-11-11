// 설계 변경 영향 분석의 HTTP 구현 (docs/change-impact-design.md 6장). 백엔드 /api/v1/pdm/changes… 를 부른다.
// 읽는 길은 백엔드가 꺼져 있거나 아직 이 라우트가 없거나(404) OPMS 를 못 읽는(503) 때 "연결 전" 빈 값을 돌려준다 — 화면이 가짜 변경 건 대신 안내를 보인다.
// 쓰는 길은 그 경우 ApiError(503)로 거절한다. 백엔드가 준 오류(코드 · 상세)는 ApiError.code · details 에 그대로 담아 화면이 이유를 보인다(409 DISPOSITION_REQUIRED 등).
import {
  ApiError, type ChangeDetail, type ChangePage, type ChangeQuery, type ChangeScopeView, type ChangeTargetView, type DispositionView,
  type ImpactGraphView, type ImpactRunView, type OntologyImpactView, type PdmApi, type ChangeReviewView,
} from './types';

const BASE = '/api/v1/pdm';
const BACKEND_DOWN = 'PDM 백엔드에 연결하지 못했습니다. `onto-pdm serve`로 백엔드를 켜 주세요.';
const EMPTY_PAGE: ChangePage = { items: [], total: 0, page: 1, size: 25 };

/** 백엔드가 응답하지 않거나 백엔드의 응답이 아니다(꺼짐 · 프록시 안내 페이지 · 이 라우트가 없는 구버전) */
class Unreachable extends Error {}

type Methods = Pick<PdmApi,
  | 'changesAvailable' | 'listChanges' | 'getChange' | 'createChange' | 'addChangeTarget' | 'removeChangeTarget' | 'setChangeScope'
  | 'getImpact' | 'recomputeImpact' | 'getImpactGraph' | 'setDisposition' | 'submitReview'
  | 'acceptChange' | 'submitChange' | 'approveChange' | 'rejectChange' | 'getOntologyImpact'>;

const statusOf = (s: number): 400 | 403 | 404 | 409 | 503 => (s === 403 || s === 404 || s === 409 || s === 503 ? s : 400);

export function createChangesHttp(doFetch: typeof fetch, timeoutMs: number): Methods {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try { res = await doFetch(`${BASE}${path}`, { ...init, signal: ctl.signal }); }
    catch { throw new Unreachable(BACKEND_DOWN); }
    finally { clearTimeout(timer); }
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => null) as ({ error?: { code?: string; message?: string; details?: Record<string, unknown> | null } } & Record<string, unknown>) | null;
    if (res.ok) {
      if (body === null) throw new Unreachable(BACKEND_DOWN);                           // 200 인데 JSON 이 아니다
      return body as T;
    }
    const err = body?.error;
    if (!err || typeof err.code !== 'string') throw new Unreachable(BACKEND_DOWN);       // 백엔드의 오류 본문이 아니다(라우트가 없는 404 등)
    throw new ApiError(err.message ?? '요청을 처리하지 못했습니다', statusOf(res.status), err.code, err.details ?? undefined);
  }

  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const withBody = (method: 'PUT' | 'POST', body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const enc = encodeURIComponent;

  /** 쓰는 길: 백엔드에 닿지 못하면 503 으로 거절한다 */
  async function write<T>(path: string, init: RequestInit): Promise<T> {
    try { return await call<T>(path, init); }
    catch (e) {
      if (e instanceof Unreachable) throw new ApiError(e.message, 503);
      throw e;
    }
  }

  /** 읽는 길: 읽어 올 곳이 없으면(닿지 못함 · 503) fallback, 없는 항목(404)도 fallback. 그 밖의 오류는 그대로 */
  async function read<T, F>(path: string, fallback: F, absorb404 = true): Promise<T | F> {
    try { return await call<T>(path); }
    catch (e) {
      if (e instanceof Unreachable) return fallback;
      if (e instanceof ApiError && (e.status === 503 || (absorb404 && e.status === 404))) return fallback;
      throw e;
    }
  }

  let available = false;                                                                  // 한 번 닿으면 기억한다(실패는 기억하지 않아 다시 시도한다)

  const query = (q: ChangeQuery | undefined) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== '') p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  return {
    async changesAvailable() {
      if (available) return true;
      const page = await read<ChangePage, null>('/changes?size=1', null);
      available = page !== null;
      return available;
    },
    listChanges: q => read<ChangePage, ChangePage>(`/changes${query(q)}`, EMPTY_PAGE) as Promise<ChangePage>,
    getChange: id => read<ChangeDetail, null>(`/changes/${enc(id)}`, null),
    createChange: body => write<ChangeDetail>('/changes', json(body)),
    addChangeTarget: (id, body) => write<ChangeTargetView>(`/changes/${enc(id)}/targets`, json(body)),
    removeChangeTarget: async (id, targetId) => { await write<void>(`/changes/${enc(id)}/targets/${targetId}`, { method: 'DELETE' }); },
    setChangeScope: (id, targetId, body) => write<ChangeScopeView[]>(`/changes/${enc(id)}/targets/${targetId}/scope`, withBody('PUT', body)),
    getImpact: (id, runId) => read<ImpactRunView, null>(`/changes/${enc(id)}/impact${runId !== undefined ? `?run_id=${runId}` : ''}`, null),
    recomputeImpact: id => write<ImpactRunView>(`/changes/${enc(id)}/impact`, json({})),
    getImpactGraph: id => read<ImpactGraphView, ImpactGraphView>(`/changes/${enc(id)}/impact/graph`, { nodes: [], edges: [] }) as Promise<ImpactGraphView>,
    setDisposition: (id, findingId, body) => write<DispositionView>(`/changes/${enc(id)}/dispositions/${findingId}`, withBody('PUT', body)),
    submitReview: (id, body) => write<ChangeReviewView>(`/changes/${enc(id)}/reviews`, json(body)),
    acceptChange: id => write<ChangeDetail>(`/changes/${enc(id)}/accept`, json({})),
    submitChange: id => write<ChangeDetail>(`/changes/${enc(id)}/submit`, json({})),
    approveChange: id => write<ChangeDetail>(`/changes/${enc(id)}/approve`, json({})),
    rejectChange: (id, body) => write<ChangeDetail>(`/changes/${enc(id)}/reject`, json(body)),
    getOntologyImpact: (from, to) => {
      const p = new URLSearchParams();
      if (from) p.set('from', from);
      if (to) p.set('to', to);
      const s = p.toString();
      return read<OntologyImpactView, null>(`/changes/ontology-impact${s ? `?${s}` : ''}`, null);
    },
  };
}
