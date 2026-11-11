import { useEffect, useRef, useState } from 'react';
import type { CadPartHint, CadPartMatch, PdmApi } from '../../api/types';

/** 보유 품번을 OPMS 에 동시에 묻는 최대 수. 규격이 같은 부품은 API 가 한 번만 묻는다(httpApi 의 요청 중복 제거) */
export const MATCH_CONCURRENCY = 4;

/** 부품 하나가 보유 품번 매칭에 내놓는 것: 규격 값(확정했거나 CAD 형상 추정)과, 그 중 사람이 확정하지 않은 값의 표시 */
export interface SpecRequest {
  hint?: CadPartHint;
  estimated?: NonNullable<CadPartMatch['estimated']>;
}

const sigOf = (r: SpecRequest | undefined) => JSON.stringify([r?.hint ?? null, r?.estimated ?? null]);

/** 추정 값으로 찾은 결과는 늘 후보다: 어떤 API 가 확정(matched)을 돌려줘도 자동으로 보유 품번이 되지 않는다 */
function annotate(m: CadPartMatch, estimated: SpecRequest['estimated']): CadPartMatch {
  if (!estimated) return m;
  return { ...m, status: m.status === 'matched' ? 'suggested' : m.status, estimated };
}

export interface SpecMatchOptions {
  api: PdmApi;
  names: string[];
  requests: ReadonlyMap<string, SpecRequest>;
  /** OPMS 를 읽을 수 있게 된 횟수: 바뀌면 다시 묻는다 */
  epoch: number;
  /** OPMS 연결 상태를 아직 모르면 'loading'(묻지 않고 기다린다), 연결돼 있으면 'ok', 끊겼으면 'off'. OPMS 를 읽는 길이 없는 API 는 'none' */
  link: 'none' | 'loading' | 'ok' | 'off';
  /** 먼저 처리할 부품(고른 부품) */
  priorityName?: string | undefined;
  /** 바뀌면 처음부터 다시 한다(CAD 를 바꿈) */
  resetKey: string;
}

/**
 * 보유 품번 매칭. 규격(hint)이 없는 부품은 한 번에 묶어 묻고(서버를 부르지 않는다), 규격이 있는 부품은 하나씩 큐에 넣어
 * 최대 MATCH_CONCURRENCY 개씩 묻는다. 고른 부품이 먼저이고, 끝나는 대로 화면에 반영한다.
 * OPMS 연결이 안 되면 묻지 않고 '연결 안 됨'으로 둔다. 규격이 바뀐 부품만 다시 묻는다.
 */
export function useSpecMatches(o: SpecMatchOptions): Map<string, CadPartMatch> {
  const [matches, setMatches] = useState<Map<string, CadPartMatch>>(new Map());
  const applied = useRef(new Map<string, string>());       // 부품 이름 → 반영한 요청의 서명
  const generation = useRef(0);
  const queue = useRef<string[]>([]);
  const active = useRef(0);
  const pumpRef = useRef<() => void>(() => {});
  const live = useRef(o);
  live.current = o;

  const namesKey = o.names.join('|');
  const requestsKey = o.names.map(n => sigOf(o.requests.get(n))).join('\n');

  // CAD 를 바꾸거나 API 가 바뀌면 처음부터. OPMS 연결이 돌아오면(epoch) 반영한 것을 모두 다시 묻되 화면은 그대로 둔다
  useEffect(() => {
    generation.current += 1;
    queue.current = [];
    applied.current = new Map();
    o.api.clearMatchCache?.();
    setMatches(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.api, o.resetKey, namesKey]);
  useEffect(() => {
    generation.current += 1;
    queue.current = [];
    applied.current = new Map();
    o.api.clearMatchCache?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.epoch]);

  useEffect(() => {
    const { api, names, requests, link } = live.current;
    if (names.length === 0) return;
    const gen = generation.current;
    const put = (name: string, m: CadPartMatch, sig: string) => {
      if (gen !== generation.current || sigOf(live.current.requests.get(name)) !== sig) return;   // 그 사이 규격이 바뀌었으면 새 요청이 처리한다
      applied.current.set(name, sig);
      setMatches(prev => new Map(prev).set(name, m));
    };

    const loose: string[] = [];
    for (const name of names) {
      const req = requests.get(name);
      const sig = sigOf(req);
      if (applied.current.get(name) === sig) continue;
      if (!req?.hint) { loose.push(name); continue; }
      if (link === 'loading') continue;                         // 연결 상태를 알 때까지 기다린다
      if (link === 'off') { put(name, annotate({ name, status: 'none', reason: 'unreachable' }, req.estimated), sig); continue; }
      if (!queue.current.includes(name)) queue.current.push(name);
    }

    if (loose.length) {
      const sigs = new Map(loose.map(n => [n, sigOf(requests.get(n))]));
      void api.matchCadParts(loose).then(rows => {
        const byName = new Map(rows.map(r => [r.name, r]));
        loose.forEach(n => { const m = byName.get(n); if (m) put(n, m, sigs.get(n)!); });
      }, () => { /* 규격 없이 묻는 길은 서버를 부르지 않는다. 실패하면 '매칭 중'으로 남는다 */ });
    }

    const take = (): string | undefined => {
      const first = live.current.priorityName;
      const i = first ? queue.current.indexOf(first) : -1;
      return i >= 0 ? queue.current.splice(i, 1)[0] : queue.current.shift();
    };
    const pump = () => {
      while (active.current < MATCH_CONCURRENCY && queue.current.length > 0 && gen === generation.current) {
        const name = take()!;
        const req = live.current.requests.get(name);
        if (!req?.hint) continue;
        const sig = sigOf(req);
        active.current += 1;
        const hint = req.hint;
        void api.matchCadParts([name], { [name]: hint })
          .then(rows => rows[0] ?? { name, status: 'none' as const, reason: 'unreachable' as const }, () => ({ name, status: 'none' as const, reason: 'unreachable' as const }))
          .then(m => put(name, annotate({ ...m, name }, req.estimated), sig))
          .finally(() => { active.current -= 1; pumpRef.current(); });          // 세대가 바뀌었으면 최신 pump 가 이어서 처리한다
      }
    };
    pumpRef.current = pump;
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.api, namesKey, requestsKey, o.epoch, o.link, o.resetKey]);

  return matches;
}
