import type { ReactNode } from 'react';
import type { AsyncState } from '../hooks/useAsync';
import type { Tone } from '../labels';

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
