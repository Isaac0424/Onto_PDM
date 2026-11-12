// 고른 부품이 든 행만 진해진다: 같은 이름의 부품이 다른 단계에도 있어도 함께 진해지지 않는다.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { LayerInfo, PartInfo } from 'explode-studio';
import { AssemblySteps } from './AssemblySteps';

const part = (id: number, name: string, layer: number): PartInfo => ({ id, name, path: '', layer, ko: '', size: null, unit: 'mm' });
// 단계 1: PANEL · BOLT(1개), 단계 2: BOLT(2개). 같은 이름 BOLT 가 두 단계에 있다
const PARTS = [part(0, 'PANEL', 0), part(1, 'BOLT', 0), part(2, 'BOLT', 1), part(3, 'BOLT', 1)];
const LAYERS: LayerInfo[] = [
  { index: 0, step: 2, title: '유틸리티', partIds: [0, 1] },
  { index: 1, step: 3, title: '체결', partIds: [2, 3] },
];

const view = (extra: { selectedName?: string; selectedId?: number }, onSelect = vi.fn()) => {
  render(<AssemblySteps layers={LAYERS} parts={PARTS} matches={new Map()} step={2} onStep={vi.fn()} onSelect={onSelect} {...extra} />);
  return onSelect;
};
const rowIn = (stepTitle: string, name: string) => {
  const li = screen.getByText(stepTitle).closest('li.step') as HTMLElement;
  return within(li).getByText(name, { selector: '.part-name' }).closest('button')!;
};

describe('제조 순서의 부품 행 강조', () => {
  it('볼트를 고르면 그 볼트 행만 진해지고 같은 단계의 패널과 다른 단계의 같은 이름 볼트는 그대로다', () => {
    view({ selectedName: 'BOLT', selectedId: 1 });
    expect(rowIn('유틸리티', 'BOLT')).toHaveClass('part-on');
    expect(rowIn('유틸리티', 'PANEL')).not.toHaveClass('part-on');
    expect(rowIn('체결', 'BOLT')).not.toHaveClass('part-on');
  });

  it('다른 단계의 볼트(번호 3)를 고르면 그 단계의 행만 진해진다', () => {
    view({ selectedName: 'BOLT', selectedId: 3 });
    expect(rowIn('체결', 'BOLT')).toHaveClass('part-on');
    expect(rowIn('유틸리티', 'BOLT')).not.toHaveClass('part-on');
  });

  it('행을 누르면 이름과 그 행의 부품 번호를 함께 알린다 (같은 이름의 다른 단계 부품이 골라지지 않게)', async () => {
    const onSelect = view({});
    await userEvent.setup().click(rowIn('체결', 'BOLT'));
    expect(onSelect).toHaveBeenCalledWith('BOLT', 2);
  });
});
