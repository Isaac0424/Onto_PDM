import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/AppShell';
import type { GraphNode, NodeTone } from './graphData';

/** 제품 연결 그래프의 필터 상태. 모두 기본값이면 걸러지는 것이 없다 */
export interface GraphFilterState {
  /** 보일 상태 (승인 · 작업중/검토중 · 폐기) */
  tones: ReadonlySet<NodeTone>;
  /** 조립 규칙이 연결된 품목만 / 안 된 품목만 / 전체 */
  rules: 'all' | 'with' | 'without';
  /** 보일 공정 종류(규칙의 operation). 비어 있으면 전체 */
  operations: ReadonlySet<string>;
}

export const ALL_TONES: readonly NodeTone[] = ['ok', 'maybe', 'none'];
export const DEFAULT_FILTERS: GraphFilterState = { tones: new Set(ALL_TONES), rules: 'all', operations: new Set() };

export const filtersActive = (f: GraphFilterState) => f.tones.size !== ALL_TONES.length || f.rules !== 'all' || f.operations.size > 0;

export interface OperationOption { key: string; label: string; count: number }

const TONE_LABEL: Record<NodeTone, string> = {
  ok: '승인', maybe: '작업중 · 검토중', none: '폐기',
  impact_none: '영향 없음', impact_review: '확인 필요', impact_affected: '처분 필요', impact_blocked: '막힘',
};
const TONE_CLASS: Record<NodeTone, string> = {
  ok: 'chip-ok', maybe: 'chip-maybe', none: 'chip-none',
  impact_none: 'chip-none', impact_review: 'chip-maybe', impact_affected: 'chip-maybe', impact_blocked: 'chip-none',
};
const RULE_LABEL = { all: '전체', with: '규칙 있음', without: '규칙 없음' } as const;

/** 검색 비교용: 대소문자 · 공백 · - · _ · . 를 무시한다 (품번 P-00000000121 = p00000000121) */
const norm = (s: string) => s.toLowerCase().replace(/[\s_.\-]+/g, '');

/** 검색 결과: 보이는 노드(제품 제외) 중 품번이나 이름에 검색어가 들어 있는 것 */
export function searchNodes(nodes: GraphNode[], query: string, limit = 8): GraphNode[] {
  const q = norm(query);
  if (!q) return [];
  return nodes.filter(n => n.kind !== 'product' && (norm(n.label).includes(q) || norm(n.id).includes(q))).slice(0, limit);
}

/**
 * 그래프 필터 막대: 상태 · 조립 규칙 유무 · 공정 종류 칩과 품번/이름 검색.
 * 검색은 보이는 노드 안에서 찾는다. 한 곳만 맞으면 바로 그 노드를 고르고(3D 가 그쪽으로 초점), 여러 곳이면 목록을 띄워 Enter 로 첫째를 고른다.
 */
export function GraphFilters({ filters, onChange, operations, total, shown, candidates, onPick, onClear }: {
  filters: GraphFilterState;
  onChange(next: GraphFilterState): void;
  operations: OperationOption[];
  /** 걸러지기 전 품목 수 (제품 제외) */
  total: number;
  /** 지금 보이는 품목 수 (조상으로 남은 조립품 포함, 제품 제외) */
  shown: number;
  /** 검색 대상: 지금 그래프에 보이는 노드 */
  candidates: GraphNode[];
  onPick(id: string): void;
  onClear(): void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(true);
  const picked = useRef<string | null>(null);
  const results = useMemo(() => searchNodes(candidates, query), [candidates, query]);
  const active = filtersActive(filters);

  // 한 곳만 맞으면 바로 고른다. 같은 노드를 반복해서 고르지 않는다
  useEffect(() => {
    if (results.length === 1 && picked.current !== results[0]!.id) {
      picked.current = results[0]!.id;
      onPick(results[0]!.id);
    }
    if (results.length !== 1) picked.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  const toggleTone = (t: NodeTone) => {
    const next = new Set(filters.tones);
    if (next.has(t)) next.delete(t); else next.add(t);
    onChange({ ...filters, tones: next });
  };
  const toggleOperation = (key: string) => {
    const next = new Set(filters.operations);
    if (next.has(key)) next.delete(key); else next.add(key);
    onChange({ ...filters, operations: next });
  };
  const choose = (n: GraphNode) => {
    picked.current = n.id;
    onPick(n.id);
    setQuery(n.label);
    setOpen(false);
  };

  return (
    <div className="pg-filters" role="group" aria-label="그래프 필터">
      <div className="pg-filter-row">
        <div className="pg-fgroup" role="group" aria-label="상태 필터">
          {ALL_TONES.map(t => (
            <button key={t} type="button" className={`pg-fchip ${TONE_CLASS[t]}`} aria-pressed={filters.tones.has(t)} onClick={() => toggleTone(t)}>{TONE_LABEL[t]}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="조립 규칙 필터">
          {(['all', 'with', 'without'] as const).map(r => (
            <button key={r} type="button" aria-pressed={filters.rules === r} onClick={() => onChange({ ...filters, rules: r })}>{RULE_LABEL[r]}</button>
          ))}
        </div>
        {operations.length > 0 && (
          <div className="pg-fgroup" role="group" aria-label="공정 필터">
            {operations.map(o => (
              <button key={o.key} type="button" className="pg-fchip chip-sent" aria-pressed={filters.operations.has(o.key)} onClick={() => toggleOperation(o.key)}>
                {o.label} <span className="faint">{o.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="pg-filter-row">
        <div className="pg-search">
          <Icon name="search" size={16} className="pg-search-icon" />
          <input
            type="search" className="input" aria-label="품번 · 이름 검색" placeholder="품번 · 이름으로 찾아 이동" value={query}
            onChange={e => { setQuery(e.target.value); setOpen(true); }}
            onKeyDown={e => {
              if (e.key === 'Enter' && results[0]) { e.preventDefault(); choose(results[0]); }
              if (e.key === 'Escape') { setQuery(''); setOpen(false); }
            }} />
          {open && results.length > 1 && (
            <ul className="pg-search-results" aria-label="검색 결과">
              {results.map(n => (
                <li key={n.id}>
                  <button type="button" onClick={() => choose(n)}>
                    <span>{n.label}</span><span className="mono faint">{n.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query.trim() && results.length === 0 && <p className="pg-search-none" role="status">보이는 품목 중에 없습니다</p>}
        </div>
        <span className="pg-filter-count" aria-live="polite" title="필터에 맞는 품목의 조상 조립품도 함께 보입니다">{total}개 중 {shown}개 표시</span>
        {active && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { onClear(); }}>
            <Icon name="filter_alt_off" size={14} />필터 지우기
          </button>
        )}
      </div>
    </div>
  );
}
