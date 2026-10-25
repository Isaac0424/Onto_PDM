import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createApi, type Session } from './api/client';
import type { PdmApi, User } from './api/types';

interface SessionValue {
  api: PdmApi & { reset?: () => void };
  users: User[];
  user: User | undefined;
  /** 관리자 역할(admin · approver)이고 관리자 모드를 켰을 때 */
  adminMode: boolean;
  canUseAdminMode: boolean;
  setUserId(id: number): void;
  setAdminMode(on: boolean): void;
  /** 데이터가 바뀌었을 때 화면들이 다시 읽도록 */
  revision: number;
  bump(): void;
}

const SessionContext = createContext<SessionValue | null>(null);
const KEY = 'onto-pdm-session';

function loadSession(): Session {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Session;
  } catch { /* 저장소를 못 쓰면 기본값 */ }
  return { userId: 1, adminMode: true };
}

export function SessionProvider({ children, api: injected }: { children: ReactNode; api?: PdmApi }) {
  const [session, setSession] = useState<Session>(loadSession);
  const ref = useRef(session);
  ref.current = session;
  const api = useMemo(() => injected ?? createApi(() => ref.current), [injected]);
  const [users, setUsers] = useState<User[]>([]);
  const [revision, setRevision] = useState(0);

  useEffect(() => { api.listUsers().then(setUsers); }, [api]);
  useEffect(() => {
    try { window.localStorage.setItem(KEY, JSON.stringify(session)); } catch { /* 무시 */ }
  }, [session]);

  const user = users.find(u => u.id === session.userId);
  const canUseAdminMode = !!user && (user.role === 'admin' || user.role === 'approver');
  const bump = useCallback(() => setRevision(n => n + 1), []);

  const value: SessionValue = {
    api, users, user, canUseAdminMode,
    adminMode: canUseAdminMode && session.adminMode,
    setUserId: id => { setSession(s => ({ ...s, userId: id })); bump(); },
    setAdminMode: on => { setSession(s => ({ ...s, adminMode: on })); bump(); },
    revision, bump,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('SessionProvider 안에서만 쓸 수 있습니다');
  return v;
}
