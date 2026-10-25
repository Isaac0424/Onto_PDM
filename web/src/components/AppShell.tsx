import { useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useSession } from '../session';

export function AppShell({ children }: { children: ReactNode }) {
  const { users, user, adminMode, canUseAdminMode, setUserId, setAdminMode, api, bump } = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState('');

  const search = (e: FormEvent) => {
    e.preventDefault();
    navigate(`/items?q=${encodeURIComponent(q.trim())}`);
  };
  const resetDemo = () => {
    if (!api.reset) return;
    if (window.confirm('목 데이터를 처음 상태로 되돌릴까요? 임시저장한 요청도 지워집니다.')) {
      api.reset();
      bump();
      navigate('/items');
    }
  };

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/items" className="brand" style={{ textDecoration: 'none' }}>
          <span className="brand-mark" aria-hidden>O</span>
          Onto PDM
        </NavLink>
        <form className="topbar-search" onSubmit={search} role="search">
          <input
            className="input" value={q} onChange={e => setQ(e.target.value)}
            placeholder="품번 · 이름 · 별칭(레거시 · ERP · CAD 이름) 검색" aria-label="품목 검색"
          />
        </form>
        <div className="topbar-right">
          <label className="switch" title={canUseAdminMode ? '' : '관리자 · 승인자 역할만 켤 수 있습니다'}>
            <input
              type="checkbox" checked={adminMode} disabled={!canUseAdminMode}
              onChange={e => setAdminMode(e.target.checked)}
            />
            <span className="track" aria-hidden />
            관리자 모드
          </label>
          <select
            className="select" style={{ width: 'auto' }} aria-label="사용자 (데모)"
            value={user?.id ?? ''} onChange={e => setUserId(Number(e.target.value))}
          >
            {users.map(u => (
              <option key={u.id} value={u.id}>{u.name} · {u.role === 'admin' ? '관리자' : u.role === 'approver' ? '승인자' : '엔지니어'}</option>
            ))}
          </select>
          {api.reset && <button type="button" className="btn btn-ghost btn-sm" onClick={resetDemo}>데모 초기화</button>}
        </div>
      </header>

      <nav className="sidebar" aria-label="주 메뉴">
        <div className="nav-group">
          <div className="nav-title">조회</div>
          <NavLink to="/items" className="nav-link">품목</NavLink>
          <NavLink to="/products" className="nav-link">제품</NavLink>
        </div>
        <div className="nav-group">
          <div className="nav-title">등록</div>
          <NavLink to="/requests" className="nav-link">내 등록 요청</NavLink>
        </div>
        {adminMode && (
          <div className="nav-group">
            <div className="nav-title">관리자 모드</div>
            <NavLink to="/admin/requests" className="nav-link">등록 요청 검토</NavLink>
            <NavLink to="/admin/proposals" className="nav-link">분류 제안 검토</NavLink>
            <NavLink to="/admin/publish" className="nav-link">그래프 발행 상태</NavLink>
          </div>
        )}
      </nav>

      <main className="main">{children}</main>
    </div>
  );
}

/** 관리자 모드 전용 화면 */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { adminMode } = useSession();
  if (!adminMode) {
    return <div className="banner banner-warning">관리자 모드에서만 볼 수 있습니다. 관리자 · 승인자 역할로 관리자 모드를 켜세요.</div>;
  }
  return <>{children}</>;
}
