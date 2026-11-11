import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AssemblyPartInput } from '../../api/types';
import { SessionProvider } from '../../session';
import { StudioPage } from './StudioPage';
import { studioTestApi } from './testApi';
import { seedCad } from './testSeed';

// 가짜 없이: 실제 속성 추출(extract)이 만든 후보가 화면을 지나 규칙 조회까지 이어지는지 본다. 뷰어(WebGL)만 가짜다.
const PARTS = [
  { id: 0, name: '기판 나사 M3', path: '체결', layer: 0, ko: '', size: [3, 3, 8], unit: 'mm' },
  { id: 1, name: '상부 커버', path: '외장', layer: 1, ko: '', size: [126, 80, 3], unit: 'mm' },
];
const LAYERS = [
  { index: 0, step: 2, title: '기판 나사 M3', partIds: [0] },
  { index: 1, step: 3, title: '상부 커버', partIds: [1] },
];

vi.mock('explode-studio', () => ({
  mountExplodeStudio: (container: HTMLElement) => {
    const handlers: Record<string, ((d: unknown) => void)[]> = {};
    const emit = (type: string, d: unknown) => (handlers[type] ?? []).forEach(fn => fn(d));
    const root = Object.assign(document.createElement('div'), { innerHTML: '<div class="stage"></div>' });
    container.appendChild(root);
    let model = '';
    return {
      on: (type: string, fn: (d: unknown) => void) => { (handlers[type] ??= []).push(fn); return () => {}; },
      loadFile: async (f: File) => { model = f.name; emit('model', { name: model, parts: PARTS.length }); },
      getState: () => ({ model, step: 1 }),
      getParts: () => PARTS, getLayers: () => LAYERS, root,
      go: () => {},
      selectPart: (name: string) => { const p = PARTS.find(x => x.name === name)!; emit('select', { id: p.id, name: p.name, layer: p.layer }); },
      destroy: () => {},
    };
  },
}));

describe('속성 후보 (실제 추출)', () => {
  it('CAD 두께 후보를 확정하면 조립 규칙 조회에 그 값이 실린다', async () => {
    const user = userEvent.setup();
    await seedCad();                                       // 예시 모델은 없다: 등록해 둔 CAD 가 열린 상태로 시작
    const base = studioTestApi();
    const inputs: AssemblyPartInput[][] = [];
    const api = { ...base, getAssemblyGuides: async (parts: AssemblyPartInput[]) => { inputs.push(parts); return base.getAssemblyGuides(parts); } };
    render(<SessionProvider api={api}><MemoryRouter><StudioPage /></MemoryRouter></SessionProvider>);

    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: /^속성/ }));
    await user.click(within(steps).getByRole('button', { name: /^상부 커버/ }));

    const list = await screen.findByRole('list', { name: '상부 커버 속성 후보' });
    const thickness = within(list).getByText('두께', { selector: '.attr-label' }).closest('li')!;
    expect(within(thickness).getByText('3 mm')).toBeInTheDocument();                              // CAD 의 가장 얇은 치수
    await user.click(within(thickness).getByRole('button', { name: /두께 3 mm 확정/ }));
    await waitFor(() => expect(inputs[inputs.length - 1]!.find(p => p.name === '상부 커버')?.attributes).toMatchObject({ thickness: 3 }));
  });
});
