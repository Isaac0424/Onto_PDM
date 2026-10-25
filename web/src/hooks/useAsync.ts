import { useEffect, useState, type DependencyList } from 'react';
import { useSession } from '../session';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

/** 비동기 읽기. 사용자 · 관리자 모드가 바뀌거나 데이터가 바뀌면(bump) 다시 읽는다. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const { revision } = useSession();
  const [state, setState] = useState<AsyncState<T>>({ data: undefined, error: undefined, loading: true });

  useEffect(() => {
    let alive = true;
    setState(s => ({ ...s, loading: true, error: undefined }));
    fn().then(
      data => alive && setState({ data, error: undefined, loading: false }),
      error => alive && setState({ data: undefined, error: error instanceof Error ? error : new Error(String(error)), loading: false }),
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, revision]);

  return state;
}
