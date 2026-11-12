import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssemblyGuide, CadPartHint, CadPartMatch } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { extractCadAttributes, type ExtractedAttribute } from '../../extract';
import { FASTENER_CLASSES } from '../../extract/fastener.config';
import { estimateFastener } from '../../extract/fastener.estimate';
import { useSession } from '../../session';
import { AssemblyHud } from './AssemblyHud';
import { AssemblySteps } from './AssemblySteps';
import { AttributePanel, candidateId, type Decision } from './AttributePanel';
import { OntologyPanel } from './OntologyPanel';
import { OpmsStatusLine, useOpmsStatus } from './OpmsStatusLine';
import type { StudioApi } from 'explode-studio';
import { CadLibraryStrip } from './CadLibraryStrip';
import type { ShapeView } from './FastenerBlock';
import { classRequestDraft, classRequestText } from './registrationDraft';
import type { RequiredBlockView } from './RequiredBlock';
import { checkRequired } from './requiredAttrs';
import { modelFromNames } from './ruleModel';
import { useClassSpec } from './useClassSpec';
import { prefetchNames, useFastenerShapes } from './useFastenerShapes';
import { useRuleSelection, type RuleSelectionInput } from './useRuleSelection';
import { useSpecMatches, type SpecRequest } from './useSpecMatches';
import { createCadLibrary, readActive, readAnalysis, writeActive, writeAnalysis, type AddResult, type CadEntry } from './cadLibrary';
import { HEARTBEAT_MS, readSession, writeSession } from './sessionCache';
import { useStudio } from './useStudio';
import './studio.css';

/**
 * 메인 화면: CAD 3D 분해도(홀로그램) + 제조 순서 + 온톨로지.
 * CAD를 올리면 구조에서 제조(조립) 순서를 나누고, 단계마다 쓰이는 부품을 우리 회사가 보유한 품번과 매칭한다.
 * 보유하지 않은 부품은 CAD 이름 그대로(추정 분류가 있으면 함께) 보이고, OPMS로 등록 요청을 보낼 수 있다.
 */
export function StudioPage() {
  const { api } = useSession();
  // 등록한 CAD 목록: 올린 CAD 는 서버 DB 에 저장되고, 연 CAD 는 창을 닫아도 10분 동안 이 브라우저 캐시에 남아 바로 열린다
  const lib = useMemo(() => createCadLibrary(), []);
  const [entries, setEntries] = useState<CadEntry[]>([]);
  const [clock, setClock] = useState(() => Date.now());               // 캐시 남은 시간 표시용 (하트비트마다 갱신)
  /** 지금 열린 CAD: 'cad:<id>'. 열린 것이 없으면 'none'. CAD 마다 사람이 정한 것(확정 · 결정)을 이 열쇠로 기억한다 */
  const [activeKey, setActiveKey] = useState<string>('none');
  const [vaultError, setVaultError] = useState<string>();
  /** 목록을 다시 읽는다. 서버 DB 와 맞추는 것(withServer)은 화면을 열 때 · 서버가 돌아왔을 때만, 나머지는 이 브라우저에 있는 것만 읽는다 */
  const refreshEntries = useCallback(async (withServer = false) => {
    setEntries(await lib.list({ server: withServer }));
    setClock(Date.now());
  }, [lib]);

  const restore = useCallback(async (s: StudioApi) => {
    // 처음 열 CAD: 마지막에 작업하던 것. 그게 없거나 열 수 없으면 가장 최근에 올린 것. 하나도 없으면 빈 화면.
    // 캐시가 남아 있으면 바로 열리고, 만료됐으면 서버 DB 에서 받는다. 10분 안에 보던 상태(고른 부품 · 단계)도 되살린다
    const session = readSession();
    const tried = new Set<string>();
    let failure: string | undefined;
    const attempt = async (id: string) => {
      if (tried.has(id)) return false;
      tried.add(id);
      try {
        const file = await lib.open(id);
        setActiveKey(`cad:${id}`);
        writeActive({ kind: 'cad', id });
        await s.loadFile(file);
        if (session?.id === id) {
          if (session.step !== undefined && session.step >= 2) s.go(session.step);
          if (session.partName) s.selectPart(session.partName, true);
        }
        void refreshEntries();                                                         // 열면서 캐시 시각이 새로 시작됐다: 목록에 반영
        return true;
      } catch (e) { failure ??= String((e as Error).message ?? e); return false; }   // 열 수 없으면 다음 후보
    };
    const last = readActive();
    if (last && await attempt(last.id)) return true;
    const newest = await lib.latest();
    if (newest && await attempt(newest.id)) return true;
    if (failure && newest) setVaultError(failure);                                    // 목록에는 있는데 열지 못했다: 이유를 알린다
    return false;
  }, [lib, refreshEntries]);
  const studio = useStudio({ restore });
  const { parts, layers, model, selected } = studio;

  const [confirmed, setConfirmed] = useState<Map<string, CadPartMatch>>(new Map());
  const [guides, setGuides] = useState<Map<string, AssemblyGuide>>(new Map());
  const [notice, setNotice] = useState<string>();
  const cadInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'onto' | 'attr'>('onto');
  const [decisions, setDecisions] = useState<Map<string, Map<string, Decision>>>(new Map());
  /** 부품 이름 → 사람이 형상으로 확정한 볼트 클래스 코드 (CAD 마다 기억한다) */
  const [fastenerPick, setFastenerPick] = useState<Map<string, string>>(new Map());

  const names = useMemo(() => [...new Set(parts.map(p => p.name))], [parts]);

  // OPMS 읽기 연결: 연결이 (다시) 돌아오면 epoch 가 바뀌어 보유 품번 매칭을 다시 한다
  const opms = useOpmsStatus(api);
  const link = !api.opms ? 'none' : opms.status === 'loading' || opms.status === undefined ? 'loading' : opms.status.state === 'ok' ? 'ok' : 'off';

  // 부품 형상으로 본 볼트 종류: 고른 부품을 먼저, 작은 부품은 한가한 때 하나씩 분석한다
  const rawShapes = useFastenerShapes({ canRead: studio.canReadGeometry, read: studio.readGeometry }, parts, selected?.name, activeKey);
  // 형상 분류기가 "OPMS 에 아직 없는 제안"으로 둔 클래스라도 OPMS 가 그 사이 등록했으면(0.20.0: 버튼 · 접시 머리 볼트) 제안이 아니다.
  // OPMS 의 분류 목록을 읽어 와 맞춘다. 읽지 못하면 분류기 기본값을 그대로 쓴다
  const [registeredClasses, setRegisteredClasses] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let alive = true;
    api.listClasses().then(rows => { if (alive) setRegisteredClasses(new Set(rows.map(c => c.code))); }).catch(() => {});
    return () => { alive = false; };
  }, [api, link]);
  const shapes = useMemo(() => {
    if (registeredClasses.size === 0) return rawShapes;
    return new Map([...rawShapes].map(([name, e]): [string, typeof e] => {
      if (e.status !== 'done' || !e.result || !e.result.candidates.some(c => c.proposed && registeredClasses.has(c.classCode))) return [name, e];
      const candidates = e.result.candidates.map(c => (c.proposed && registeredClasses.has(c.classCode) ? { ...c, proposed: false } : c));
      return [name, { ...e, result: { ...e.result, candidates } }];
    }));
  }, [rawShapes, registeredClasses]);

  // 속성 후보: CAD 형상 · 부품 이름에서 뽑은 것. 확정해야 부품 속성이 된다
  const cadCands = useMemo(() => {
    const inputs = names.map(name => {
      const p = parts.find(x => x.name === name);
      const shape = shapes.get(name);
      return { name, size: p?.size ?? null, ...(p?.unit ? { unit: p.unit } : {}), ...(shape?.status === 'done' && shape.result ? { fastener: shape.result } : {}) };
    });
    return new Map(extractCadAttributes(inputs).map(r => [r.partName, r.attributes]));
  }, [parts, names, shapes]);

  const candidatesOf = useCallback((name: string): ExtractedAttribute[] => {
    const seen = new Set<string>();
    const out: ExtractedAttribute[] = [];
    for (const a of cadCands.get(name) ?? []) {
      const id = candidateId(a);
      if (!seen.has(id)) { seen.add(id); out.push(a); }
    }
    return out;
  }, [cadCands]);

  const confirmedAttrs = useMemo(() => {
    const out = new Map<string, Record<string, string | number>>();
    names.forEach(n => {
      const d = decisions.get(n);
      const rec: Record<string, string | number> = {};
      if (d) candidatesOf(n).forEach(a => { if (d.get(candidateId(a)) === 'confirmed') rec[a.key] = a.value; });
      const head = FASTENER_CLASSES.find(c => c.classCode === fastenerPick.get(n))?.headType;      // 확정한 볼트 종류는 머리 모양도 정한다
      if (head && rec.headType === undefined) rec.headType = head;
      if (Object.keys(rec).length) out.set(n, rec);
    });
    return out;
  }, [names, decisions, candidatesOf, fastenerPick]);

  // OPMS 필수 속성 체크리스트: 볼트로 분류된 고른 부품이 대상이다. 분류는 사람이 확정한 볼트 종류가 먼저이고, 없으면 형상 분석이 충분히 확실하게 추정한 것.
  // OPMS 에 없는 제안 분류(버튼 · 접시머리)는 OPMS 에서 규칙을 읽을 수 없어 상위 분류(볼트)로 확인한다.
  const requiredClass = useMemo(() => {
    const name = selected?.name;
    const e = name ? shapes.get(name) : undefined;
    if (!name || e?.status !== 'done' || !e.result) return undefined;
    const code = fastenerPick.get(name) ?? estimateFastener(e.result)?.classCode;
    const cls = FASTENER_CLASSES.find(c => c.classCode === code);
    if (!cls) return undefined;
    return cls.proposed ? { specCode: 'Bolt', proposedLabel: cls.label } : { specCode: cls.classCode };
  }, [selected?.name, shapes, fastenerPick]);
  const classSpec = useClassSpec(api, requiredClass?.specCode, link, opms.epoch);
  const requiredBlock = (name: string): RequiredBlockView | undefined => {
    const e = shapes.get(name);
    if (name !== selected?.name || e?.status !== 'done' || !e.result) return undefined;        // 볼트가 아니거나 분석 중이면 블록이 없다
    if (link === 'loading') return { status: 'loading' };
    if (link !== 'ok') return { status: 'offline' };
    if (!requiredClass) return { status: 'no-class' };
    if (classSpec.status === 'error') return { status: 'error', message: classSpec.message };
    if (classSpec.status !== 'ready') return { status: 'loading' };
    const alive = candidatesOf(name).filter(a => decisions.get(name)?.get(candidateId(a)) !== 'rejected');
    return {
      status: 'ready',
      view: checkRequired({
        spec: classSpec.spec, confirmed: confirmedAttrs.get(name) ?? {}, candidates: alive,
        ...(requiredClass.proposedLabel ? { proposedLabel: requiredClass.proposedLabel } : {}),
      }),
    };
  };
  const requiredOfSelected = selected ? requiredBlock(selected.name) : undefined;

  /** 고른 부품의 형상 분류: 분석 중이면 '분석 중', 볼트로 분류됐으면 후보 블록. 볼트가 아니거나 뷰어가 메시를 못 읽으면 없다 */
  const shapeView = (name: string): ShapeView | undefined => {
    const e = shapes.get(name);
    if (!e) return studio.canReadGeometry() ? { status: 'analyzing' } : undefined;
    if (e.status === 'analyzing') return { status: 'analyzing' };
    if (!e.result) return undefined;
    const pickedClass = fastenerPick.get(name);
    const cand = e.result.candidates.find(c => c.classCode === pickedClass);
    const confirmedKeys = new Set(Object.keys(confirmedAttrs.get(name) ?? {}));
    const missing = name === selected?.name && requiredOfSelected?.status === 'ready'
      ? requiredOfSelected.view.items.filter(i => i.state === 'empty').map(i => ({ key: i.key, label: i.label })) : [];
    const draft = cand ? classRequestDraft(name, cand, candidatesOf(name), confirmedKeys, missing) : undefined;
    return { status: 'done', result: e.result, ...(pickedClass ? { pickedClass } : {}), ...(draft ? { draft: classRequestText(draft) } : {}) };
  };
  const pickClass = useCallback((name: string, code: string | undefined) => {
    setFastenerPick(prev => {
      const next = new Map(prev);
      if (code) next.set(name, code); else next.delete(name);
      return next;
    });
  }, []);

  const overview = useMemo(() => names.map(n => {
    const d = decisions.get(n);
    const alive = candidatesOf(n).filter(a => d?.get(candidateId(a)) !== 'rejected');
    return { name: n, count: alive.length, confirmed: alive.filter(a => d?.get(candidateId(a)) === 'confirmed').length };
  }), [names, decisions, candidatesOf]);
  const attrTotal = overview.reduce((s, o) => s + o.count, 0);
  const attrConfirmed = overview.reduce((s, o) => s + o.confirmed, 0);

  const decide = useCallback((partName: string, id: string, decision: Decision | undefined) => {
    setDecisions(prev => {
      const next = new Map(prev);
      const mine = new Map(next.get(partName) ?? []);
      if (decision) mine.set(id, decision); else mine.delete(id);
      if (decision === 'confirmed') {                                        // 같은 키는 하나만 확정한다 (출처마다 값이 다를 수 있다)
        const key = id.split('|')[0];
        candidatesOf(partName).forEach(a => {
          const other = candidateId(a);
          if (other !== id && a.key === key && mine.get(other) === 'confirmed') mine.delete(other);
        });
      }
      next.set(partName, mine);
      return next;
    });
  }, [candidatesOf]);

  const restoreRejected = useCallback((partName: string) => {
    setDecisions(prev => {
      const mine = new Map(prev.get(partName) ?? []);
      [...mine].forEach(([k, v]) => { if (v === 'rejected') mine.delete(k); });
      return new Map(prev).set(partName, mine);
    });
  }, []);

  // 보유 품번을 찾는 규격: 사람이 확정한 나사 규격 · 길이 · 머리 모양이 먼저이고, 확정하지 않은 것은 CAD 형상 분석이 충분히 확실하게 추정한 값으로 채운다
  // (그 부품은 '후보 · 추정'으로만 보이고 품번 확정은 늘 사람이 한다). 클래스는 OPMS 에 등록된 것만 쓴다(미등록 제안 클래스는 치수와 머리 모양으로만).
  // 사람이 제외한 추정 후보(나사 규격 · 길이)는 쓰지 않는다.
  const requests = useMemo(() => {
    const out = new Map<string, SpecRequest>();
    const rejected = (n: string, key: string) => candidatesOf(n).some(a => a.key === key && decisions.get(n)?.get(candidateId(a)) === 'rejected');
    names.forEach(n => {
      const a = confirmedAttrs.get(n);
      const pick = FASTENER_CLASSES.find(c => c.classCode === fastenerPick.get(n));
      const shape = shapes.get(n);
      const est = shape?.status === 'done' ? estimateFastener(shape.result) : undefined;
      const confirmedLength = Number(a?.length);
      const threadSize = a?.threadSize !== undefined ? String(a.threadSize) : est && !rejected(n, 'threadSize') ? est.threadSize : undefined;
      const length = a?.length !== undefined && Number.isFinite(confirmedLength) ? confirmedLength : est?.length !== undefined && !rejected(n, 'length') ? est.length : undefined;
      const headType = a?.headType !== undefined ? String(a.headType) : est?.headType;
      const fastenerClass = pick ? (pick.proposed ? undefined : pick.classCode) : est && !est.proposed ? est.classCode : undefined;
      const hint: CadPartHint = {
        ...(threadSize !== undefined ? { threadSize } : {}),
        ...(length !== undefined ? { length } : {}),
        ...(headType !== undefined ? { headType } : {}),
        ...(fastenerClass ? { fastenerClass } : {}),
      };
      if (Object.keys(hint).length === 0) return;
      // 확정하지 않은 값(추정)만 표시한다. 사람이 둘 다 확정하면 '추정'이 사라진다
      const estThread = a?.threadSize === undefined && threadSize !== undefined;
      const estLength = a?.length === undefined && length !== undefined;
      out.set(n, {
        hint,
        ...(est && (estThread || estLength)
          ? { estimated: { ...(estThread ? { threadSize } : {}), ...(estLength ? { length } : {}), ...(est.unitAssumed ? { unitAssumed: true } : {}) } }
          : {}),
      });
    });
    return out;
  }, [names, confirmedAttrs, fastenerPick, shapes, decisions, candidatesOf]);

  // 보유 품번과 매칭한다: 부품 이름이 바뀌면(CAD 를 바꾸면) 처음부터, 규격이 바뀐 부품만 다시 묻는다. 고른 부품이 먼저, 최대 4개씩, 규격이 같으면 한 번만
  const namesKey = names.join('|');
  const matches = useSpecMatches({ api, names, requests, epoch: opms.epoch, link, priorityName: selected?.name, resetKey: activeKey });

  // 형상 분석이 아직 끝나지 않은 부품: 끝나면 추정 규격이 생길 수 있어 '규격 확정 필요'라고 말하지 않는다
  const analyzing = useMemo(() => {
    const out = new Set<string>();
    if (!studio.canReadGeometry()) return out;
    const prefetch = prefetchNames(parts);                                   // 미리 분석하는 부품과 같은 규칙(이름마다 처음 나온 부품)
    names.forEach(n => {
      const e = shapes.get(n);
      if (e?.status === 'analyzing' || (!e && prefetch.has(n))) out.add(n);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts, names, shapes]);

  // 부품마다 적용되는 사내 조립 규칙. 두께 같은 값은 CAD 크기에서, 분류는 매칭 결과에서, 속성은 사람이 확정한 값에서 가져온다
  // (CAD 형상 추정으로 찾은 후보의 분류는 확정 전이라 규칙을 고르는 데 쓰지 않는다)
  const guideClass = (n: string) => { const m = matches.get(n); return m && !m.estimated ? m.classLabel : undefined; };
  const guideKey = JSON.stringify(names.map(n => [n, guideClass(n) ?? '', confirmedAttrs.get(n) ?? {}, fastenerPick.get(n) ?? '']));
  useEffect(() => {
    let alive = true;
    if (names.length === 0) { setGuides(new Map()); return; }
    const inputs = names.map(name => {
      const size = parts.find(p => p.name === name)?.size;
      const className = guideClass(name);
      const attributes = confirmedAttrs.get(name);
      const fastenerClass = fastenerPick.get(name);                                // 형상으로 확정한 볼트 클래스: 이름이 볼트가 아니어도 체결 규칙을 고른다
      return { name, ...(size ? { size } : {}), ...(className ? { className } : {}), ...(attributes ? { attributes } : {}), ...(fastenerClass ? { fastenerClass } : {}) };
    });
    api.getAssemblyGuides(inputs).then(rows => { if (alive) setGuides(new Map(rows.map(g => [g.partName, g]))); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, namesKey, guideKey]);

  // 다른 모델을 열면 그 모델에서 사람이 정해 둔 것(확정한 매칭 · 속성 결정 · 볼트 종류)을 되살린다. 처음 여는 모델이면 비어 있다
  const [stateKey, setStateKey] = useState<string>();
  useEffect(() => {
    const saved = readAnalysis(activeKey);
    setConfirmed(new Map((saved?.confirmed ?? []) as [string, CadPartMatch][]));
    setDecisions(new Map((saved?.decisions ?? []).map(([k, v]) => [k, new Map(v as [string, Decision][])] as const)));
    setFastenerPick(new Map(saved?.fastener ?? []));
    setNotice(undefined);
    setStateKey(activeKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, activeKey]);
  useEffect(() => {
    if (!stateKey?.startsWith('cad:')) return;                              // 열린 CAD 가 없을 때는 저장할 것이 없다
    writeAnalysis(stateKey, {
      confirmed: [...confirmed],
      decisions: [...decisions].map(([k, v]) => [k, [...v]] as [string, [string, string][]]),
      fastener: [...fastenerPick],
    });
  }, [stateKey, confirmed, decisions, fastenerPick]);

  /** 서버에 못 보낸 CAD(올리기 · 지우기)를 다시 보낸다. 보냈으면 알리고 목록을 서버와 맞춘다 */
  const syncing = useRef(false);
  const syncPending = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      const r = await lib.syncPending();
      if (r.uploaded > 0) {
        setVaultError(undefined);
        setNotice(`서버에 연결돼 CAD ${r.uploaded}개를 서버 DB에 저장했어요.`);
      }
      if (r.uploaded + r.deleted > 0) await refreshEntries(true);
    } finally { syncing.current = false; }
  }, [lib, refreshEntries]);

  // 화면을 열면: 이 브라우저에 있는 것을 먼저 보이고, 못 보낸 것을 보낸 뒤 서버 목록과 맞춘다 (다른 브라우저에서 올린 CAD 도 나온다)
  useEffect(() => {
    let alive = true;
    void (async () => {
      await refreshEntries(false);
      await syncPending();
      if (alive) await refreshEntries(true);
    })();
    return () => { alive = false; };
  }, [refreshEntries, syncPending]);
  const activeId = activeKey.startsWith('cad:') ? activeKey.slice(4) : undefined;
  // 분석이 끝나면 부품 · 단계 수를 목록에 남긴다
  useEffect(() => {
    if (!activeId || studio.busy || parts.length === 0) return;
    void lib.setMeta(activeId, { parts: parts.length, layers: layers.length }).then(changed => { if (changed) void refreshEntries(); });
  }, [activeId, studio.busy, parts.length, layers.length, lib, refreshEntries]);

  // 세션 캐시: 열어 둔 CAD 와 보던 상태(고른 부품 · 단계)를 적어 두고, 열려 있는 동안 15초마다 "아직 쓰는 중"이라고 알려 캐시를 이어 간다.
  // 창을 닫으면(pagehide · 숨김) 바로 한 번 더 적는다. 닫은 뒤 10분 안에 다시 열면 캐시에서 바로 열리고 보던 상태도 돌아온다
  const live = useRef({ id: undefined as string | undefined, partName: undefined as string | undefined, step: 0, ready: false, waiting: false });
  live.current = {
    id: activeId, partName: selected?.name, step: studio.step,
    ready: !studio.busy && parts.length > 0, waiting: entries.some(e => e.storage === 'browser-only' && !e.syncNote),
  };
  const saveSession = useCallback((touch: boolean) => {
    const c = live.current;
    if (!c.id) return;
    if (c.ready) writeSession({ id: c.id, ...(c.partName ? { partName: c.partName } : {}), step: c.step });
    if (touch) void lib.touch(c.id);
  }, [lib]);
  useEffect(() => { saveSession(false); }, [saveSession, activeId, selected?.name, studio.step, studio.busy, parts.length]);
  useEffect(() => {
    const beat = () => {
      saveSession(true);
      if (live.current.waiting) void syncPending();
      void refreshEntries(false);                                       // 캐시 남은 시간 · 만료를 목록에 반영
    };
    const flush = () => saveSession(true);
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    const onOnline = () => void syncPending();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    window.addEventListener('pagehide', flush);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [saveSession, syncPending, refreshEntries]);

  const effective = useMemo(() => new Map([...matches, ...confirmed]), [matches, confirmed]);

  const confirm = useCallback((name: string, itemNo?: string) => {
    const found = matches.get(name);
    if (!found) return;
    const { estimated: _estimated, ...m } = found;                                      // 사람이 고르면 '추정'이 아니라 확정이다
    const c = itemNo ? m.candidates?.find(x => x.itemNo === itemNo) : undefined;     // 후보가 여럿이면 사람이 고른 것으로 확정한다
    const picked: Partial<CadPartMatch> = c
      ? { itemNo: c.itemNo, itemName: c.itemName, score: c.score, ...(c.classLabel ? { classLabel: c.classLabel } : {}), ...(c.classPath ? { classPath: c.classPath } : {}) }
      : {};
    setConfirmed(prev => new Map(prev).set(name, { ...m, ...picked, status: 'matched', method: m.method ?? 'exact' }));
  }, [matches]);

  // 안내가 가리킬 부품: 고른 부품, 없으면 지금 단계의 대표 부품
  const activeLayer = studio.step >= 2 ? layers[studio.step - 2] : undefined;
  const focusName = selected?.name ?? (activeLayer ? parts[activeLayer.partIds[0]!]?.name : undefined);
  const focusStep = focusName ? (parts.find(p => p.name === focusName)?.layer ?? -1) + 1 : 0;

  // 조립 규칙(규칙집 rules/): 고른 부품의 분류 · 속성 · 역할 · 로봇 모델로 적용되는 규칙을 찾는다. 사람이 확정한 분류와 확정한 속성만 확정 기준으로 보내고,
  // 확정하지 않은 부품은 CAD 형상이 충분히 확실하게 추정한 분류 · 규격을 '추정 기준'으로 보낸다(카드에 추정이라고 밝히고 규칙 적용을 단정하지 않는다).
  // 역할(베이스 고정 볼트 · 툴 고정 볼트 …)은 CAD 에서 알 수 없어 사람이 정한다(HUD 에서 고른다). 모델은 파일 · 부품 이름에서 하나로 읽을 때만 보낸다.
  const [roleByPart, setRoleByPart] = useState<Map<string, string>>(new Map());
  useEffect(() => { setRoleByPart(new Map()); }, [activeKey]);
  const robotModel = useMemo(() => modelFromNames([model, ...names]), [model, names]);
  const rulesInput = useMemo<RuleSelectionInput | undefined>(() => {
    if (!api.rulebook || !focusName) return undefined;
    const picked = FASTENER_CLASSES.find(c => c.classCode === fastenerPick.get(focusName));
    const shape = shapes.get(focusName);
    const est = shape?.status === 'done' ? estimateFastener(shape.result) : undefined;
    const cls = picked ?? (est ? FASTENER_CLASSES.find(c => c.classCode === est.classCode) : undefined);
    if (!cls) return undefined;                                                    // 분류를 모르는 부품은 규칙을 고르지 않는다
    const basis = picked ? 'confirmed' : 'estimated';
    const confirmedValues = confirmedAttrs.get(focusName) ?? {};
    const attributes: Record<string, string | number> = {};
    if (confirmedValues.threadSize !== undefined) attributes.threadSize = confirmedValues.threadSize;
    if (confirmedValues.length !== undefined) attributes.length = confirmedValues.length;
    if (basis === 'estimated' && est) {
      attributes.threadSize ??= est.threadSize;
      if (est.length !== undefined) attributes.length ??= est.length;
    }
    const role = roleByPart.get(focusName);
    return {
      classCode: cls.classCode, basis, attributes, ...(role ? { role } : {}), ...(robotModel ? { model: robotModel } : {}),
      ...(cls.proposed ? { parentCode: 'Bolt' } : {}),
    };
  }, [api.rulebook, focusName, fastenerPick, shapes, confirmedAttrs, roleByPart, robotModel]);
  const ruleSel = useRuleSelection(api, rulesInput);
  const pickRole = useCallback((role: string | undefined) => {
    if (!focusName) return;
    setRoleByPart(prev => { const next = new Map(prev); if (role) next.set(focusName, role); else next.delete(focusName); return next; });
  }, [focusName]);

  const activate = (key: string, a: Parameters<typeof writeActive>[0]) => { setActiveKey(key); writeActive(a); };

  /** CAD 를 서버 DB 에 저장한 결과를 사람이 읽는 문장으로 */
  const savedNotice = (name: string, r: AddResult) => {
    const id8 = r.entry.id.slice(0, 8);
    if (r.duplicate) return `${name}: 이미 등록된 CAD예요. 목록의 것을 열었어요.`;
    if (r.server === 'saved') return `${name}을(를) 서버 DB에 저장했어요 (${id8}).${r.vault === 'saved' ? ' 파일 보관소에도 복사했어요.' : ''}`;
    if (r.server === 'duplicate') return `${name}: 서버 DB에 같은 CAD가 이미 있어서 그것과 합쳤어요 (${id8}).`;
    if (r.server === 'rejected') return `${name}: 서버 DB가 받지 않아 이 브라우저에만 보관했어요.`;
    return `${name}: 서버가 꺼져 있어 이 브라우저에만 보관했어요. 서버에 연결되면 자동으로 올려요.`;
  };

  // CAD 를 올리면 목록에 등록하고(서버 DB 에 저장 + 이 브라우저 캐시에 올림) 바로 연다. 서버가 꺼져 있어도 열리고, 이 브라우저에만 남는다
  const registerCad = async (file: File) => {
    setVaultError(undefined);
    try {
      const r = await lib.add(file);
      activate(`cad:${r.entry.id}`, { kind: 'cad', id: r.entry.id });
      void studio.loadCad(file);                                           // 열기를 먼저 시작해야 목록의 부품 수가 이전 모델 값으로 적히지 않는다
      await refreshEntries();
      if (r.serverMessage) setVaultError(r.serverMessage);                  // 서버 DB 에 못 보낸 것은 경고로 알린다 (이 브라우저에는 등록됐다)
      setNotice(savedNotice(file.name, r));
    } catch (e) {
      setVaultError(String((e as Error).message ?? e));
      void studio.loadCad(file);
    }
  };

  const openEntry = async (e: CadEntry) => {
    setVaultError(undefined);
    if (activeKey === `cad:${e.id}` && !studio.busy && parts.length > 0) return;   // 이미 열려 있는 CAD 는 다시 불러오지 않는다
    if (!e.cached) setNotice(`${e.name}: 캐시에 없어서 서버 DB에서 받아 열어요…`);
    try {
      const file = await lib.open(e.id);
      activate(`cad:${e.id}`, { kind: 'cad', id: e.id });
      const opened = studio.loadCad(file);
      void refreshEntries();
      await opened;                                                          // 다른 CAD 로 바뀌면 화면이 안내를 비우므로, 열린 뒤에 알린다
      if (!e.cached) setNotice(`${e.name}을(를) 서버 DB에서 받아 열었어요. 이제 10분 동안 브라우저 캐시에 남아요.`);
    } catch (err) { setNotice(undefined); setVaultError(String((err as Error).message ?? err)); }
  };

  const removeEntry = async (e: CadEntry) => {
    if (!window.confirm(`"${e.name}"을(를) 등록 목록에서 제거할까요?\n서버 DB의 사본도 목록에서 빠져요. 내용은 DB에 남아 있어서 같은 파일을 다시 올리면 되살아나요.`)) return;
    const r = await lib.remove(e.id);
    if (!r.serverDeleted) setVaultError(`${e.name}: 서버 DB에서는 아직 지우지 못했어요. 서버가 켜지면 자동으로 지워요.`);
    await refreshEntries();
    if (activeKey === `cad:${e.id}`) { setActiveKey('none'); studio.remount(); }          // 열려 있던 CAD 를 지웠다: 남은 것 중 가장 최근 것을 열고, 없으면 빈 화면
  };

  const importFromVault = async (rec: Parameters<typeof lib.importFromVault>[0]) => {
    const r = await lib.importFromVault(rec);
    activate(`cad:${r.entry.id}`, { kind: 'cad', id: r.entry.id });
    void studio.loadCad(await lib.open(r.entry.id));
    await refreshEntries();
    setNotice(`${r.entry.name}을(를) 보관소에서 가져와 목록에 등록했어요.`);
  };

  return (
    <div className="holo-page">
      <div className="holo-backdrop" aria-hidden />

      <div className="holo-main">
        <header className="holo-head">
          <div>
            <p className="holo-eyebrow">CAD 관리</p>
            <h1>CAD 스튜디오</h1>
          </div>
          <div className="row holo-actions">
            <button type="button" className="btn" onClick={() => cadInput.current?.click()}><Icon name="upload_file" size={16} />CAD 올리기</button>
            <input ref={cadInput} type="file" hidden aria-label="CAD 파일" accept=".step,.stp,.iges,.igs,.stl,.obj,.glb,.gltf"
              onChange={e => { const f = e.target.files?.[0]; if (f) void registerCad(f); e.target.value = ''; }} />
          </div>
        </header>

        {studio.error && <div className="banner banner-danger" role="alert">{studio.error}</div>}
        {vaultError && <div className="banner banner-danger" role="alert">{vaultError}</div>}
        {notice && <div className="banner banner-info" role="status">{notice}</div>}

        <CadLibraryStrip entries={entries} now={clock} {...(activeId ? { activeId } : {})}
          onOpen={e => void openEntry(e)} onRemove={e => void removeEntry(e)} onUpload={() => cadInput.current?.click()}
          onLoadVault={() => lib.vaultCads()} onImportVault={importFromVault} />

        <div className="holo-frame">
          <div className="holo-strip">
            <span className={`led ${studio.busy ? 'led-busy' : ''}`} aria-hidden />
            <span className="holo-model">{model || (studio.busy ? 'CAD를 여는 중…' : 'CAD 없음')}</span>
            <span className="spacer" />
            {attrTotal > 0 && <span className="attr-chip" role="status" aria-label="속성 후보 요약">속성 후보 {attrTotal}개 · 확정 {attrConfirmed}개</span>}
            <span className="holo-meta">{studio.busy ? '분석 중…' : `부품 ${parts.length}개 · ${layers.length}단계`}</span>
          </div>
          <div ref={studio.host} className="holo-host" />
          {parts.length > 0 && (
            <AssemblyHud stage={studio.stage} total={layers.length} stepNo={focusStep}
              connected={api.connected} rulesMissing={!api.connected && !!api.opms && !api.rulebook}
              {...(ruleSel.view ? { rules: ruleSel.view, toolName: ruleSel.toolName, onPickRole: pickRole } : {})}
              {...(focusName ? { partName: focusName } : {})} {...(focusName && guides.get(focusName) ? { guide: guides.get(focusName)! } : {})} />
          )}
          {parts.length === 0 && !studio.busy && (
            <div className="holo-empty" role="status">
              <Icon name="view_in_ar" size={40} />
              <h3>열어 둔 CAD가 없어요</h3>
              <p>CAD를 올리면 이 화면에서 바로 3D로 보고, 제조 순서와 부품 매칭을 분석해요. 올린 CAD는 서버 DB에 저장돼 목록에 남고, 다음에 열면 마지막에 보던 CAD가 먼저 떠요.</p>
              <button type="button" className="btn btn-primary" onClick={() => cadInput.current?.click()}><Icon name="upload_file" size={16} />CAD 올리기</button>
            </div>
          )}
          <i className="corner corner-tl" aria-hidden /><i className="corner corner-tr" aria-hidden />
          <i className="corner corner-bl" aria-hidden /><i className="corner corner-br" aria-hidden />
        </div>
      </div>

      <aside className="holo-side">
        <OpmsStatusLine status={opms.status} onRetry={() => void opms.retry()} />
        <AssemblySteps
          layers={layers} parts={parts} matches={effective} analyzing={analyzing} connected={api.connected || !!api.opms} step={studio.step}
          {...(selected ? { selectedName: selected.name, selectedId: selected.id } : {})}
          onStep={studio.goStep} onSelect={(name, id) => studio.selectPart(id ?? name)}
        />
        <div className="seg inspector-tabs" role="tablist" aria-label="부품 정보">
          <button type="button" role="tab" aria-selected={tab === 'onto'} onClick={() => setTab('onto')}>온톨로지</button>
          <button type="button" role="tab" aria-selected={tab === 'attr'} onClick={() => setTab('attr')}>속성{attrTotal > 0 ? ` ${attrTotal}` : ''}</button>
        </div>
        {tab === 'onto' ? (
          <OntologyPanel
            model={model} parts={parts} matches={effective}
            {...(selected ? { selectedName: selected.name } : {})}
            onConfirm={confirm}
          />
        ) : (
          <AttributePanel
            {...(selected ? { partName: selected.name } : {})}
            candidates={selected ? candidatesOf(selected.name) : []}
            decisions={selected ? (decisions.get(selected.name) ?? new Map()) : new Map()}
            overview={overview}
            onDecide={(id, d) => selected && decide(selected.name, id, d)}
            onRestore={() => selected && restoreRejected(selected.name)}
            onSelectPart={studio.selectPart}
            {...(selected && shapeView(selected.name) ? { shape: shapeView(selected.name)! } : {})}
            onPickClass={code => selected && pickClass(selected.name, code)}
            {...(requiredOfSelected ? { required: requiredOfSelected } : {})}
          />
        )}
      </aside>
    </div>
  );
}
