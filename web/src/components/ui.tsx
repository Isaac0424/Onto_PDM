import type { ReactNode } from 'react';
import type { AsyncState } from '../hooks/useAsync';
import type { Tone } from '../labels';
import { useSession } from '../session';
import { Icon } from './AppShell';

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`badge tone-${tone}`} title={title}>{children}</span>;
}

/** 로딩 · 오류 · 빈 상태를 한 곳에서 처리하고, 데이터가 있으면 children(data) */
export function Loaded<T>({ state, children, empty }: {
  state: AsyncState<T>;
  children: (data: T) => ReactNode;
  empty?: (data: T) => boolean;
}) {
  if (state.loading && state.data === undefined) return <div className="empty">불러오는 중…</div>;
  if (state.error) return <div className="banner banner-danger" role="alert">{state.error.message}</div>;
  if (state.data === undefined) return null;
  if (empty?.(state.data)) return <div className="empty">표시할 항목이 없습니다.</div>;
  return <>{children(state.data)}</>;
}

/**
 * 백엔드 · OPMS 에 연결되기 전에 데이터가 없는 화면의 안내. 목업 데이터를 대신 보이지 않고 정직하게 비어 있다고 말한다.
 * 오류가 아니라 상태이므로 role=status 이고 빨강을 쓰지 않는다.
 */
export function NotConnected({ title, hint, compact = false }: { title: string; hint?: string; compact?: boolean }) {
  const { api } = useSession();
  return (
    <section className={`not-connected ${compact ? 'not-connected-compact' : ''}`} role="status" aria-label="OPMS 연결 안내">
      <Icon name="cloud_off" size={compact ? 24 : 36} />
      <h3>{title}</h3>
      <p>{hint ?? 'OPMS에 연결되면 보유 품번 · 조립 규칙 · 제품 데이터가 여기에 표시돼요.'}</p>
      {/* PDM 백엔드가 OPMS 의 분류 · 부품은 읽고 있어도, 제품 · BOM · 조립 규칙은 OPMS 에 없는 데이터라 비어 있다 */}
      {api.opms && <p className="not-connected-note">PDM은 OPMS의 분류 · 부품만 읽어요. 이 데이터는 아직 OPMS에 없어서 비어 있어요.</p>}
    </section>
  );
}

export interface TabDef { id: string; label: string; count?: number }

export function Tabs({ tabs, value, onChange }: { tabs: TabDef[]; value: string; onChange(id: string): void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" className="tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function ErrorText({ error }: { error?: string }) {
  return error ? <div className="banner banner-danger" role="alert">{error}</div> : null;
}

/** 품번 + 이름 [한글] 두 줄 */
export function ItemName({ name, nameKo }: { name: string; nameKo?: string }) {
  return (
    <span className="name-cell">
      <span>{nameKo ?? name}</span>
      {nameKo && <small>{name}</small>}
    </span>
  );
}
