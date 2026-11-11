import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { createApi } from './api/client';
import type { PdmApi } from './api/types';

interface SessionValue {
  api: PdmApi;
  /** 데이터가 바뀌었을 때 화면들이 다시 읽도록 */
  revision: number;
  bump(): void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children, api: injected }: { children: ReactNode; api?: PdmApi }) {
  const api = useMemo(() => injected ?? createApi(), [injected]);
  const [revision, setRevision] = useState(0);
  const bump = useCallback(() => setRevision(n => n + 1), []);
  const value: SessionValue = { api, revision, bump };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('SessionProvider 안에서만 쓸 수 있습니다');
  return v;
}
