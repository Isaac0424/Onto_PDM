import { useEffect, useState } from 'react';
import type { OpmsClassSpec, PdmApi } from '../../api/types';

/** OPMS 분류의 필수 속성 규칙을 읽는 상태. idle: 읽을 분류가 없다 · loading · ready · error(OPMS 를 못 읽거나 그런 분류가 없다) */
export type ClassSpecState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; spec: OpmsClassSpec }
  | { status: 'error'; message: string };

/**
 * 분류가 요구하는 속성을 OPMS 에서 읽는다(읽기 전용). OPMS 를 읽을 수 있을 때(link === 'ok')만 부르고,
 * 연결이 (다시) 돌아오면(epoch) 다시 읽는다. 분류별 결과는 API 구현이 기억한다.
 */
export function useClassSpec(api: PdmApi, code: string | undefined, link: 'none' | 'loading' | 'ok' | 'off', epoch: number): ClassSpecState {
  const [state, setState] = useState<{ key: string; value: ClassSpecState }>({ key: '', value: { status: 'idle' } });
  const key = code && link === 'ok' ? `${code}|${epoch}` : '';

  useEffect(() => {
    if (!key || !code || !api.opms) return;
    let alive = true;
    api.opms.getClassSpec(code).then(
      spec => { if (alive) setState({ key, value: { status: 'ready', spec } }); },
      e => { if (alive) setState({ key, value: { status: 'error', message: String((e as Error).message ?? e) } }); },
    );
    return () => { alive = false; };
  }, [api, code, key]);

  if (!key) return { status: 'idle' };
  return state.key === key ? state.value : { status: 'loading' };
}
