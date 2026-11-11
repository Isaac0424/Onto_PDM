import { describe, expect, it } from 'vitest';
import type { PartInfo } from 'explode-studio';
import { prefetchNames } from './useFastenerShapes';

// 미리 분석하는 부품 이름: 같은 이름이 여럿이면 처음 나온 부품의 크기로 정한다(분석은 이름마다 한 번).
// 화면의 "형상 분석 중…" 표시도 같은 규칙을 써야 하므로, 이 규칙이 어긋나면 분석 중 표시가 끝나지 않는다(실제 12A 에서 본 문제).
const part = (id: number, name: string, size: [number, number, number] | null): PartInfo =>
  ({ id, name, path: '', layer: 0, ko: '', size, unit: 'mm' } as unknown as PartInfo);

describe('prefetchNames', () => {
  it('작은 부품은 미리 분석하고, 큰 부품과 크기를 모르는 부품은 고를 때만 분석한다', () => {
    const s = prefetchNames([part(0, 'BOLT', [4, 4, 15]), part(1, 'HOUSING', [300, 200, 100]), part(2, 'UNKNOWN', null)]);
    expect([...s]).toEqual(['BOLT']);
  });

  it('같은 이름이 여럿이면 처음 나온 부품의 크기로 정한다 (뒤의 부품이 작아도 큰 것이 먼저면 미리 분석하지 않는다)', () => {
    expect(prefetchNames([part(0, 'COVER', [400, 300, 20]), part(1, 'COVER', [10, 10, 5])]).has('COVER')).toBe(false);
    expect(prefetchNames([part(0, 'COVER', [10, 10, 5]), part(1, 'COVER', [400, 300, 20])]).has('COVER')).toBe(true);
  });
});
