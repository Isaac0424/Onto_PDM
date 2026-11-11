import { useCallback, useEffect, useRef, useState } from 'react';
import type { PartGeometry, PartInfo } from 'explode-studio';
import { mmFactor } from '../../extract/cad';
import { classifyFastener, type FastenerResult } from '../../extract/fastener';

/** 부품 하나의 형상 분석 결과: 분석 중 · 끝남(볼트가 아니면 result 가 null) */
export type ShapeEntry = { status: 'analyzing' } | { status: 'done'; result: FastenerResult | null };

/** 미리(한가한 때) 분석하는 부품의 크기 상한 (mm). 이보다 큰 부품은 고를 때만 분석한다 — 볼트는 작다 */
export const PREFETCH_MAX_MM = 120;

/** 고르지 않아도 미리 분석하는 부품인가 (크기를 알고 PREFETCH_MAX_MM 이하) */
export function isPrefetchable(p: PartInfo): boolean {
  if (!p.size) return false;
  return Math.max(...p.size) * (mmFactor(p.unit) ?? 1) <= PREFETCH_MAX_MM;
}

/**
 * 미리 분석하는 부품 이름들. 같은 이름의 부품이 여럿이면(같은 볼트가 여러 번 쓰임) 처음 나온 부품의 크기로 정한다
 * (분석은 이름마다 한 번만 한다). 화면에서 "형상 분석 중"인지 가릴 때도 같은 규칙을 써야 끝나지 않는 분석 중 표시가 생기지 않는다.
 */
export function prefetchNames(parts: PartInfo[]): Set<string> {
  const seen = new Set<string>();
  const out = new Set<string>();
  parts.forEach(p => {
    if (seen.has(p.name)) return;
    seen.add(p.name);
    if (isPrefetchable(p)) out.add(p.name);
  });
  return out;
}

export interface FastenerShapeSource {
  /** 뷰어가 부품 메시를 읽어 줄 수 있는가 (시험의 가짜 뷰어나 옛 뷰어는 아니다) */
  canRead(): boolean;
  read(name: string): PartGeometry | null;
}

/**
 * 부품 형상으로 볼트 종류를 분류한다. 부품을 고르면 그 부품을 먼저, 그 밖의 작은 부품은 한가한 때 하나씩 분석한다.
 * 부품마다 한 번만 분석해 두고(CAD 가 바뀌면 비운다), 분석은 한 번에 부품 하나씩 작업을 나눠서 화면이 멈추지 않게 한다.
 * 뷰어에서 메시를 못 읽거나 분류에 실패하면 조용히 넘어가서 기존 속성 후보만 보인다.
 */
export function useFastenerShapes(src: FastenerShapeSource, parts: PartInfo[], selectedName: string | undefined, resetKey: string) {
  const [shapes, setShapes] = useState<Map<string, ShapeEntry>>(new Map());
  const srcRef = useRef(src);
  srcRef.current = src;
  const queue = useRef<string[]>([]);
  const known = useRef(new Set<string>());
  const timer = useRef<number>();
  const generation = useRef(0);

  const pump = useCallback(function run() {
    if (timer.current !== undefined) return;
    const name = queue.current.shift();
    if (name === undefined) return;
    const mine = generation.current;
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      if (mine !== generation.current) return;
      let result: FastenerResult | null = null;
      try {
        const g = srcRef.current.read(name);
        if (g) result = classifyFastener({ positions: g.positions, ...(g.indices ? { indices: g.indices } : {}), unit: g.unit });
      } catch { /* 형상을 읽지 못하면 이름 · 크기에서 뽑은 후보만 쓴다 */ }
      setShapes(prev => new Map(prev).set(name, { status: 'done', result }));
      run();
    }, 0);
  }, []);

  const request = useCallback((name: string, urgent: boolean) => {
    if (known.current.has(name)) {
      const i = queue.current.indexOf(name);
      if (urgent && i > 0) { queue.current.splice(i, 1); queue.current.unshift(name); }     // 이미 줄에 있으면 앞으로
      return;
    }
    known.current.add(name);
    if (urgent) queue.current.unshift(name); else queue.current.push(name);
    pump();
  }, [pump]);

  // CAD 가 바뀌면 분석한 것을 모두 비운다
  const partsKey = parts.map(p => p.name).join('|');
  useEffect(() => {
    generation.current += 1;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    queue.current = [];
    known.current = new Set();
    setShapes(new Map());
    return () => { generation.current += 1; window.clearTimeout(timer.current); timer.current = undefined; };
  }, [resetKey, partsKey]);

  // 고른 부품을 먼저
  useEffect(() => {
    if (selectedName && srcRef.current.canRead()) request(selectedName, true);
  }, [selectedName, resetKey, partsKey, request]);

  // 그 밖의 작은 부품은 한가한 때 하나씩
  useEffect(() => {
    if (parts.length === 0 || !srcRef.current.canRead()) return;
    prefetchNames(parts).forEach(name => request(name, false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partsKey, resetKey, request]);

  return shapes;
}
