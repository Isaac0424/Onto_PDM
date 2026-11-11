// 앱 셸: OPMS(ernest_hemingway_OPMS/web/src/components/Layout.tsx)의 글래스 사이드바 · 머리 · 드로어를 따른다.
// 사이드바 접기(Ctrl/⌘+B), 모바일 드로어. 폭과 상태는 styles.css 가 <html data-sidebar / data-drawer> 로 바꾼다.
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import logoUrl from '../assets/onto-pdm-mark.svg';
import { useSession } from '../session';

interface NavItem { to: string; icon: string; label: string; end?: boolean }

const VIEW_NAV: NavItem[] = [
  { to: '/', icon: 'view_in_ar', label: 'CAD 스튜디오', end: true },
  { to: '/items', icon: 'inventory_2', label: '품목' },
  { to: '/products', icon: 'category', label: '제품' },
];
const ASSEMBLY_NAV: NavItem[] = [{ to: '/rules', icon: 'rule', label: '조립 규칙' }];
const MAKE_NAV: NavItem[] = [{ to: '/mes', icon: 'factory', label: 'MES 발행' }];
const REGISTER_NAV: NavItem[] = [
  { to: '/requests', icon: 'edit_note', label: '내 등록 요청' },
  { to: '/bom-import', icon: 'table_chart', label: 'BOM 가져오기' },
];
const ADMIN_NAV: NavItem[] = [
  { to: '/admin/requests', icon: 'fact_check', label: '등록 요청 검토' },
  { to: '/admin/proposals', icon: 'account_tree', label: '분류 제안 검토' },
  { to: '/admin/publish', icon: 'sync_alt', label: '그래프 발행 상태' },
];

const ACTIVE = 'bg-primary-container text-on-primary-container font-body-md-bold';
const INACTIVE = 'text-on-surface-variant hover:bg-white/60 hover:text-on-surface';
const ITEM = 'sb-item flex items-center gap-space-sm min-w-0 px-space-md py-space-sm rounded-xl transition-colors';
const SIDEBAR_KEY = 'onto-pdm.sidebar';

const mobileQuery = () => window.matchMedia('(max-width: 767.98px)');
const readSaved = () => {
  try { return window.localStorage.getItem(SIDEBAR_KEY) === 'collapsed'; } catch { return false; }
};

export function Icon({ name, size = 18, className = '' }: { name: string; size?: number; className?: string }) {
  return <span className={`material-symbols-outlined shrink-0 ${className}`} style={{ fontSize: size }} aria-hidden="true">{name}</span>;
}

function NavSection({ title, items }: { title: string; items: NavItem[] }) {
  return (
    <>
      <div className="sb-label px-space-sm py-space-xs mt-space-md first:mt-0 font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider truncate">{title}</div>
      <nav aria-label={title} className="flex flex-col gap-space-xs mt-space-xs">
        {items.map(n => (
          <NavLink key={n.to} to={n.to} end={n.end} title={n.label} aria-label={n.label}
            className={({ isActive }) => `${ITEM} ${isActive ? ACTIVE : INACTIVE}`}>
            <Icon name={n.icon} />
            <span className="sb-label font-body-md text-body-md truncate">{n.label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { users, user, adminMode, canUseAdminMode, setUserId, setAdminMode, api, bump } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState(readSaved);
  const [drawer, setDrawer] = useState(false);
  const [mobile, setMobile] = useState(() => mobileQuery().matches);
  const sidebarRef = useRef<HTMLElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);

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

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
    root.dataset.drawer = drawer ? 'open' : 'closed';
    try { window.localStorage.setItem(SIDEBAR_KEY, root.dataset.sidebar); } catch { /* 저장 못 해도 동작에는 지장 없음 */ }
  }, [collapsed, drawer]);

  useEffect(() => {
    const mq = mobileQuery();
    const onChange = () => { setMobile(mq.matches); setDrawer(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  useEffect(() => { setDrawer(false); }, [location.pathname, location.search]);

  const toggle = useCallback(() => {
    if (mobileQuery().matches) setDrawer(d => !d);
    else setCollapsed(c => !c);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggle();
      } else if (e.key === 'Escape') setDrawer(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggle]);

  // 드로어를 열면 첫 메뉴로 포커스, 닫으면 원래 자리로
  useEffect(() => {
    if (drawer) {
      lastFocus.current = document.activeElement as HTMLElement | null;
      sidebarRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    } else if (lastFocus.current) {
      lastFocus.current.focus?.();
      lastFocus.current = null;
    }
  }, [drawer]);

  const pageLabel = [...VIEW_NAV, ...ASSEMBLY_NAV, ...MAKE_NAV, ...REGISTER_NAV, ...ADMIN_NAV].find(n => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)))?.label ?? '작업 영역';
  const roleLabel = user ? (user.role === 'admin' ? '관리자' : user.role === 'approver' ? '승인자' : '엔지니어') : '';

  return (
    <>
      <div className="sb-scrim" aria-hidden="true" onClick={() => setDrawer(false)} />
      <aside ref={sidebarRef} id="app-sidebar" aria-label="주 메뉴" {...(mobile && !drawer ? { inert: '' } : {})}
        className="shell-aside fixed left-0 top-0 h-full bg-glass border border-glass-edge shadow-glass backdrop-blur-xl backdrop-saturate-150 md:rounded-panel z-50 flex flex-col overflow-hidden">
        <div className="flex flex-col flex-1 min-h-0 min-w-0">
          <div className="sb-brand h-14 px-space-md flex items-center justify-between gap-space-sm shrink-0">
            <NavLink to="/" className="sb-brand-logo flex items-center gap-space-sm min-w-0 no-underline hover:no-underline">
              <img src={logoUrl} alt="" width={28} height={28} className="shrink-0" />
              <div className="flex flex-col min-w-0">
                <span className="font-headline-sm text-headline-sm text-on-surface leading-tight truncate">Onto PDM</span>
                <span className="font-label-sm text-label-sm text-on-surface-variant truncate">품목 · BOM · 문서</span>
              </div>
            </NavLink>
            <button type="button" onClick={toggle} aria-controls="app-sidebar" aria-expanded={!collapsed}
              aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'} title={`${collapsed ? '사이드바 펼치기' : '사이드바 접기'} (Ctrl/⌘+B)`}
              className="sb-desktop-only w-8 h-8 shrink-0 rounded-xl flex items-center justify-center text-on-surface-variant hover:bg-white/60 hover:text-on-surface transition-colors">
              <Icon name={collapsed ? 'left_panel_open' : 'left_panel_close'} size={20} />
            </button>
            <button type="button" onClick={() => setDrawer(false)} aria-label="메뉴 닫기"
              className="sb-mobile-only w-8 h-8 shrink-0 rounded-xl flex items-center justify-center text-on-surface-variant hover:bg-surface-container-high">
              <Icon name="close" size={20} />
            </button>
          </div>
          <div className="sb-scroll sb-pad p-space-md flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain">
            <NavSection title="조회" items={VIEW_NAV} />
            <NavSection title="조립" items={ASSEMBLY_NAV} />
            <NavSection title="제조" items={MAKE_NAV} />
            <NavSection title="등록" items={REGISTER_NAV} />
            {adminMode && <NavSection title="관리자 모드" items={ADMIN_NAV} />}
          </div>
        </div>
        <div className="sb-pad p-space-md border-t border-on-surface/[0.07] flex flex-col gap-space-sm shrink-0">
          {api.reset && (
            <button type="button" className="sb-meta btn btn-ghost btn-sm" onClick={resetDemo}>데모 초기화</button>
          )}
          <div className="sb-user flex items-center gap-space-sm min-w-0" title={user ? `${user.name} · ${roleLabel}` : ''}>
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0"><Icon name="person" className="text-on-primary" /></div>
            <div className="sb-label flex flex-col min-w-0">
              <span className="font-body-md-bold text-body-md-bold text-on-surface truncate">{user?.name ?? '—'}</span>
              <span className="font-label-sm text-label-sm text-on-surface-variant truncate">{roleLabel}</span>
            </div>
          </div>
        </div>
      </aside>

      <header className="shell-header fixed top-0 right-0 h-14 bg-glass border border-glass-edge shadow-glass backdrop-blur-xl backdrop-saturate-150 md:rounded-xl md:h-12 z-40 flex items-center justify-between gap-space-md px-space-md md:px-space-lg">
        <div className="flex items-center gap-space-sm min-w-0">
          <button type="button" onClick={toggle} aria-controls="app-sidebar" aria-expanded={drawer} aria-label="메뉴 열기"
            className="sb-mobile-only w-8 h-8 shrink-0 rounded-xl flex items-center justify-center text-on-surface-variant hover:bg-surface-container">
            <Icon name="menu" size={20} />
          </button>
          <div className="flex items-center gap-space-xs font-label-md text-label-md text-on-surface-variant min-w-0">
            <Icon name="hub" size={16} />
            <span className="hidden sm:inline truncate">Onto PDM</span>
            <Icon name="chevron_right" size={14} className="hidden sm:inline" />
            <span className="text-on-surface font-body-md-bold text-body-md-bold truncate">{pageLabel}</span>
          </div>
        </div>
        <form onSubmit={search} role="search" className="hidden md:flex items-center flex-1 max-w-xl mx-space-md">
          <div className="relative w-full flex items-center">
            <Icon name="search" className="absolute left-space-md text-outline" />
            <input type="search" aria-label="품목 검색" value={q} onChange={e => setQ(e.target.value)}
              placeholder="품번 · 이름 · 별칭(레거시 · ERP · CAD 이름) 검색"
              className="w-full h-8 pl-9 pr-space-md bg-white/85 rounded-xl border-0 text-body-sm font-body-sm text-on-surface placeholder:text-outline focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>
        </form>
        <div className="flex items-center gap-space-md shrink-0">
          <label className="switch" title={canUseAdminMode ? '' : '관리자 · 승인자 역할만 켤 수 있습니다'}>
            <input type="checkbox" checked={adminMode} disabled={!canUseAdminMode} onChange={e => setAdminMode(e.target.checked)} />
            <span className="track" aria-hidden />
            관리자 모드
          </label>
          <select className="select !w-auto max-w-[10rem]" aria-label="사용자 (데모)"
            value={user?.id ?? ''} onChange={e => setUserId(Number(e.target.value))}>
            {users.map(u => (
              <option key={u.id} value={u.id}>{u.name} · {u.role === 'admin' ? '관리자' : u.role === 'approver' ? '승인자' : '엔지니어'}</option>
            ))}
          </select>
        </div>
      </header>

      <div className="shell-body">
        <main className="w-full pt-[4.5rem] md:pt-[4.75rem] pb-20 min-h-screen px-space-md md:px-[var(--shell-gap)]">{children}</main>
      </div>
    </>
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
