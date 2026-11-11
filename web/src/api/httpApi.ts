// PDM 백엔드(backend/, FastAPI)의 HTTP 구현. 백엔드가 OPMS 의 Neo4j 를 **읽기만** 해서 분류 · 부품 · 매칭을 준다.
// 온톨로지는 OPMS 소유다: 이 구현은 아무것도 쓰지 않는다. 제품 · BOM · 조립 규칙 · MES 는 OPMS 에 없는 데이터라 지금처럼 비어 있다(emptyApi).
// 개발 서버는 /api/v1/pdm 을 백엔드(PDM_API_PORT, 기본 8100)로 넘긴다 (vite.config.ts).
import { createChangesHttp } from './changesApi';
import { createEmptyApi } from './emptyApi';
import {
  ApiError, RulebookError, type CadPartCandidate, type CadPartHint, type CadPartMatch, type OpmsPartInfo, type OpmsState, type OpmsStatus, type PdmApi,
  type RuleSelectRequest, type RuleSelectResponse, type RulebookFinding, type RulebookSource, type RulebookStatus, type TaxonomyClass,
} from './types';

const BASE = '/api/v1/pdm';
const BACKEND_DOWN = 'PDM 백엔드에 연결하지 못했습니다. `onto-pdm serve`로 백엔드를 켜 주세요.';

interface WireClass {
  code: string; label_ko: string; label_en?: string | null; parent?: string | null; leaf: boolean;
  path: string[]; path_labels: string[]; family_root?: string | null; head_type?: string | null;
}
interface WireMatchProp { prop_key: string; label: string; hit: boolean | null; doc_display?: string | null; part_display?: string | null }
interface WireCandidate {
  part_no: string; class_code: string; class_label: string; class_path_labels: string[]; label: string;
  verdict: 'confirmed' | 'suspected'; score: number; capped: boolean; class_capped: boolean; matched: WireMatchProp[];
}
interface WireMatchResult { verdict: 'confirmed' | 'suspected' | 'none'; reason: string; candidates: WireCandidate[] }
interface WirePart {
  part_no: string; class_code: string; class_label: string; class_path_labels: string[]; label: string;
  values: Record<string, string | number>; value_labels: Record<string, string>;
}
interface WireClassDetail {
  code?: string; label_ko?: string;
  properties: {
    key: string; label_ko: string; datatype: string; unit?: string | null; required?: boolean; min?: number | null; max?: number | null; fixed?: string | null;
    omitted_default?: string | null; omitted_default_label?: string | null;
    lookup_default?: { key: string; series?: string | null; series_label?: string | null; values?: Record<string, number[]> } | null;
  }[];
}
interface WireStatus { state: Exclude<OpmsState, 'backend_down'>; message?: string | null; ontology_version?: string | null; classes?: number | null; parts?: number | null }

/** 백엔드가 응답하지 않는다(꺼짐 · 프록시 오류 · 서버의 응답이 아님) */
class BackendDown extends Error {}
/** 백엔드는 떠 있는데 OPMS 를 읽지 못한다 (503 + 코드) */
class OpmsDown extends Error {
  constructor(readonly state: Exclude<OpmsState, 'ok' | 'backend_down'>, message: string) { super(message); }
}

/** 백엔드는 떠 있는데 규칙집(rules/)을 읽지 못한다 (503 RULEBOOK_INVALID · RULEBOOK_UNAVAILABLE) */
class RulebookDown extends Error {
  constructor(readonly kind: 'invalid' | 'unavailable', message: string, readonly errors: RulebookFinding[]) { super(message); }
}

const OPMS_CODE_STATE: Record<string, Exclude<OpmsState, 'ok' | 'backend_down'>> = {
  OPMS_UNAVAILABLE: 'opms_down', OPMS_NOT_CONFIGURED: 'not_configured', OPMS_AUTH_FAILED: 'auth_failed', OPMS_NO_ONTOLOGY: 'no_ontology',
};

// ---- 규칙집(snake_case 선 형식 → camelCase) ----
// 값이 비어 있는 항목은 키가 빠지지 않고 null 로 온다: 화면 모양(optional)에 맞게 null 인 키는 뺀다. 단 값 자리(value)의 null 은 '값이 비어 있다'는 뜻이라 남긴다.
// values · where · attributes 는 키가 데이터(표의 열 이름 · 속성 이름)라 바꾸지 않는다.
const FREE_KEYS = new Set(['values', 'where', 'attributes']);
const camelOf = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
function camelKeys<T>(v: unknown, free = false): T {
  if (Array.isArray(v)) return v.map(x => camelKeys(x, free)) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === null && k !== 'value' && !free) continue;
      out[free ? k : camelOf(k)] = camelKeys(x, free || FREE_KEYS.has(k));
    }
    return out as T;
  }
  return v as T;
}
/** 필터 객체 → 쿼리 문자열. 백엔드 이름과 다른 키만 바꾼다 */
const FILTER_KEY: Record<string, string> = { classCode: 'class_code' };
const rulebookQuery = (o: object | undefined) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o ?? {})) if (typeof v === 'string' && v) p.set(FILTER_KEY[k] ?? k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface HttpApiOptions {
  fetchImpl?: typeof fetch;
  /** 요청 제한시간(ms) */
  timeoutMs?: number;
}

export function createHttpApi(opts: HttpApiOptions = {}): PdmApi {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeout = opts.timeoutMs ?? 8000;

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let res: Response;
    try { res = await doFetch(`${BASE}${path}`, { ...init, signal: ctl.signal }); }
    catch { throw new BackendDown(BACKEND_DOWN); }
    finally { clearTimeout(timer); }
    const body = await res.json().catch(() => null) as ({ error?: { code?: string; message?: string; details?: { errors?: { where: string; message: string }[] } | null } } & Record<string, unknown>) | null;
    if (res.ok) {
      if (body === null) throw new BackendDown(BACKEND_DOWN);                        // 200 인데 JSON 이 아니다(프록시의 안내 페이지 등)
      return body as T;
    }
    const err = body?.error;
    if (!err || typeof err.code !== 'string') throw new BackendDown(BACKEND_DOWN);   // 백엔드의 오류 본문이 아니다: 백엔드가 꺼진 것으로 본다
    if (err.code.startsWith('RULEBOOK_')) {                                          // 규칙집(rules/)을 읽지 못한다: OPMS 문제가 아니다
      throw new RulebookDown(err.code === 'RULEBOOK_INVALID' ? 'invalid' : 'unavailable', err.message ?? '규칙집을 읽지 못했습니다.',
        (err.details?.errors ?? []).map(e => ({ level: 'error' as const, where: e.where, message: e.message })));
    }
    if (res.status === 503) throw new OpmsDown(OPMS_CODE_STATE[err.code] ?? 'opms_down', err.message ?? 'OPMS 를 읽지 못했습니다.');
    throw new ApiError(err.message ?? '요청을 처리하지 못했습니다', res.status === 404 ? 404 : 400);
  }

  // 분류는 자주 바뀌지 않아 한 번 읽어 둔다(실패하면 다음에 다시). 매칭 결과에 분류 이름을 붙이는 데 쓴다
  let classCache: Promise<WireClass[]> | undefined;
  const classes = () => {
    classCache ??= call<WireClass[]>('/opms/classes').catch(e => { classCache = undefined; throw e; });
    return classCache;
  };

  // 분류별 속성 이름 · 단위 (부품 상세에 한글 이름을 붙이는 데 쓴다)
  const detailCache = new Map<string, Promise<WireClassDetail>>();
  const classDetail = (code: string) => {
    let d = detailCache.get(code);
    if (!d) { d = call<WireClassDetail>(`/opms/classes/${encodeURIComponent(code)}`).catch(e => { detailCache.delete(code); throw e; }); detailCache.set(code, d); }
    return d;
  };

  const toCandidate = (c: WireCandidate): CadPartCandidate => ({
    itemNo: c.part_no, itemName: c.label, score: c.score, classLabel: c.class_label, classPath: c.class_path_labels,
    matched: c.matched.map(m => ({ label: m.label, hit: m.hit, ...(m.doc_display ? { doc: m.doc_display } : {}), ...(m.part_display ? { part: m.part_display } : {}) })),
    capped: c.capped, classCapped: c.class_capped,
  });

  const noneWithClass = async (name: string, hint: CadPartHint, reason: CadPartMatch['reason']): Promise<CadPartMatch> => {
    const cls = hint.fastenerClass ? await classes().then(rows => rows.find(c => c.code === hint.fastenerClass), () => undefined) : undefined;
    return {
      name, status: 'none', ...(reason ? { reason } : {}),
      ...(cls ? { classIri: `cls:${cls.code}`, classLabel: cls.label_ko, classPath: cls.path_labels } : {}),
    };
  };

  // 같은 규격(클래스 · 머리 모양 · 나사 규격 · 길이)으로 이미 물어본 결과는 다시 묻지 않는다: 12A 처럼 같은 볼트가 수십 개인 CAD 에서
  // 부품마다 요청하지 않고 서로 다른 규격 수만큼만 묻는다. 진행 중인 요청도 함께 쓴다. OPMS 를 못 읽은 결과는 기억하지 않는다(다시 시도할 수 있게).
  const matchCache = new Map<string, Promise<WireMatchResult | 'unreachable'>>();
  const specKey = (h: CadPartHint) => JSON.stringify([h.fastenerClass ?? null, h.headType ?? null, h.threadSize ?? null, h.length ?? null]);

  function wireMatch(hint: CadPartHint): Promise<WireMatchResult | 'unreachable'> {
    const key = specKey(hint);
    const known = matchCache.get(key);
    if (known) return known;
    const values: Record<string, string | number> = {
      ...(hint.threadSize !== undefined ? { threadSize: hint.threadSize } : {}),
      ...(hint.length !== undefined ? { length: hint.length } : {}),
    };
    const p = call<WireMatchResult>('/opms/match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(hint.fastenerClass ? { class_code: hint.fastenerClass } : {}), ...(hint.headType ? { head_type: hint.headType } : {}), values }),
    }).then(
      (r): WireMatchResult | 'unreachable' => r,
      (e): 'unreachable' => {
        matchCache.delete(key);
        if (e instanceof BackendDown || e instanceof OpmsDown) return 'unreachable';
        throw e;
      },
    );
    matchCache.set(key, p);
    p.catch(() => matchCache.delete(key));
    return p;
  }

  async function matchOne(name: string, hint: CadPartHint | undefined): Promise<CadPartMatch> {
    // 보유 품번은 이름이 아니라 규격으로 찾는다(OPMS 부품에는 이름이 없다). 규격이 없으면 확정을 기다린다
    if (!hint || (hint.threadSize === undefined && hint.length === undefined)) return { name, status: 'none', reason: 'needs_values' };
    const res = await wireMatch(hint);
    if (res === 'unreachable') return { name, status: 'none', reason: 'unreachable' };
    if (res.candidates.length === 0) return noneWithClass(name, hint, 'no_candidate');
    const [best, ...rest] = res.candidates.map(toCandidate);
    return {
      name, status: res.verdict === 'confirmed' ? 'matched' : 'suggested', itemNo: best!.itemNo, itemName: best!.itemName, method: 'attributes', score: best!.score,
      classIri: `cls:${res.candidates[0]!.class_code}`, ...(best!.classLabel ? { classLabel: best!.classLabel } : {}), ...(best!.classPath ? { classPath: best!.classPath } : {}),
      candidates: [best!, ...rest],
    };
  }

  async function status(): Promise<OpmsStatus> {
    try {
      const s = await call<WireStatus>('/opms/status');
      return {
        state: s.state, ...(s.message ? { message: s.message } : {}),
        ...(s.ontology_version ? { ontologyVersion: s.ontology_version } : {}),
        ...(s.classes != null ? { classes: s.classes } : {}), ...(s.parts != null ? { parts: s.parts } : {}),
      };
    } catch (e) {
      if (e instanceof OpmsDown) return { state: e.state, message: e.message };
      return { state: 'backend_down', message: BACKEND_DOWN };
    }
  }

  // ---- 조립 규칙 · 작업표준서(규칙집): 백엔드가 rules/ 를 읽기 전용으로 내보낸다 ----
  async function rb<T>(path: string, init?: RequestInit): Promise<T> {
    try { return camelKeys<T>(await call<unknown>(`/rulebook${path}`, init)); }
    catch (e) {
      if (e instanceof BackendDown) throw new RulebookError(e.message, 'backend_down');
      if (e instanceof RulebookDown) throw new RulebookError(e.message, e.kind, e.errors);
      if (e instanceof OpmsDown) throw new RulebookError(e.message, 'unavailable');
      throw e;
    }
  }

  // 같은 (분류 · 속성 · 역할 · 모델)은 한 번만 묻는다. 읽지 못한 결과는 기억하지 않는다(다시 시도할 수 있게)
  const selectCache = new Map<string, Promise<RuleSelectResponse>>();
  const selectKey = (r: RuleSelectRequest) => JSON.stringify([
    r.classCode, r.classPath ?? [], Object.entries(r.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b)), r.role ?? null, r.model ?? null, !!r.includeInapplicable,
  ]);

  const rulebook: RulebookSource = {
    async status(): Promise<RulebookStatus> {
      try {
        const s = await call<{
          state: 'ok' | 'invalid' | 'unavailable'; message?: string | null; loaded_at?: string | null;
          counts?: Record<string, number> | null; by_grade?: Record<string, number> | null;
          validation?: { errors?: RulebookFinding[]; warnings?: RulebookFinding[] } | null;
        }>('/rulebook/status');
        return {
          state: s.state, ...(s.message ? { message: s.message } : {}), ...(s.loaded_at ? { loadedAt: s.loaded_at } : {}),
          ...(s.counts ? { counts: camelKeys(s.counts) } : {}), ...(s.by_grade ? { byGrade: s.by_grade } : {}),
          ...(s.validation?.errors?.length ? { errors: s.validation.errors } : {}), ...(s.validation?.warnings?.length ? { warnings: s.validation.warnings } : {}),
        };
      } catch { return { state: 'backend_down', message: BACKEND_DOWN }; }
    },
    listRules: filter => rb(`/rules${rulebookQuery(filter)}`),
    getRule: id => rb(`/rules/${encodeURIComponent(id)}`),
    listOperations: () => rb('/operations'),
    listTools: () => rb('/tools'),
    listWorkStandards: filter => rb(`/work-standards${rulebookQuery(filter)}`),
    getWorkStandard: id => rb(`/work-standards/${encodeURIComponent(id)}`),
    listGaps: () => rb('/gaps'),
    selectRules(req) {
      const key = selectKey(req);
      const known = selectCache.get(key);
      if (known) return known;
      const p = rb<RuleSelectResponse>('/select', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          class_code: req.classCode, ...(req.classPath?.length ? { class_path: req.classPath } : {}), attributes: req.attributes ?? {},
          ...(req.role ? { role: req.role } : {}), ...(req.model ? { model: req.model } : {}), ...(req.includeInapplicable ? { include_inapplicable: true } : {}),
        }),
      });
      selectCache.set(key, p);
      p.catch(() => selectCache.delete(key));
      return p;
    },
  };

  const empty = createEmptyApi();
  return {
    ...empty,
    ...createChangesHttp(doFetch, timeout),                                          // 설계 변경: /changes (백엔드에 라우트가 없으면 빈 상태)
    rulebook,
    // 제품 · 규칙 · MES 는 OPMS 에 없는 데이터라 connected 는 false 로 둔다. OPMS 를 읽는지는 opms 로 본다
    connected: false,
    opms: {
      status,
      async getPart(partNo) {
        try {
          const p = await call<WirePart>(`/opms/parts/${encodeURIComponent(partNo)}`);
          const detail = await classDetail(p.class_code).catch(() => undefined);           // 속성 이름을 못 읽어도 부품은 보인다(키 이름으로)
          const spec = new Map((detail?.properties ?? []).map(x => [x.key, x]));
          const info: OpmsPartInfo = {
            partNo: p.part_no, classCode: p.class_code, classLabel: p.class_label, classPathLabels: p.class_path_labels,
            label: p.label, values: p.values, valueLabels: p.value_labels,
            properties: Object.entries(p.values).map(([key, v]) => {
              const x = spec.get(key);
              return { key, label: x?.label_ko ?? key, text: p.value_labels[key] ?? (x?.unit ? `${v} ${x.unit}` : String(v)) };
            }),
          };
          return info;
        } catch (e) {
          if (e instanceof BackendDown || e instanceof OpmsDown) throw new ApiError(e.message, 503);
          throw e;
        }
      },
      async getClassSpec(code) {
        try {
          const d = await classDetail(code);                                               // 분류별로 한 번만 읽는다(실패하면 다음에 다시)
          return {
            code, label: d.label_ko ?? code,
            properties: d.properties.map(p => ({
              key: p.key, label: p.label_ko, datatype: p.datatype, required: !!p.required,
              ...(p.unit ? { unit: p.unit } : {}), ...(p.min != null ? { min: p.min } : {}), ...(p.max != null ? { max: p.max } : {}),
              ...(p.fixed ? { fixed: p.fixed } : {}),
              ...(p.omitted_default ? { omittedDefault: { code: p.omitted_default, label: p.omitted_default_label ?? p.omitted_default } } : {}),
              ...(p.lookup_default ? { lookupDefault: { key: p.lookup_default.key, ...(p.lookup_default.series_label ? { seriesLabel: p.lookup_default.series_label } : {}), values: p.lookup_default.values ?? {} } } : {}),
            })),
          };
        } catch (e) {
          if (e instanceof BackendDown || e instanceof OpmsDown) throw new ApiError(e.message, 503);
          throw e;
        }
      },
    },
    async listClasses(): Promise<TaxonomyClass[]> {
      try {
        return (await classes()).map(c => ({
          iri: `cls:${c.code}`, code: c.code, labelKo: c.label_ko, ...(c.label_en ? { labelEn: c.label_en } : {}),
          ...(c.parent ? { parentIri: `cls:${c.parent}` } : {}), kind: 'part' as const,
        }));
      } catch (e) {
        if (e instanceof BackendDown || e instanceof OpmsDown) return [];             // 읽지 못하면 비어 있다(연결 상태는 opms.status 가 말한다)
        throw e;
      }
    },
    matchCadParts: (names, hints) => Promise.all(names.map(n => matchOne(n, hints?.[n]))),
    clearMatchCache: () => { matchCache.clear(); selectCache.clear(); },
  };
}
