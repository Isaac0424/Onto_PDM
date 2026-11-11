// 창을 닫기 전까지는 CAD 를 다시 불러오지 않는다: 다른 화면에 갔다 와도 뷰어와 열린 CAD 가 그대로다.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { SessionProvider } from './session';
import { seedCad } from './pages/studio/testSeed';

const PARTS = [{ id: 0, name: '하우징', path: '본체', layer: 0, ko: '', size: [120, 80, 20] }];
const LAYERS = [{ index: 0, step: 2, title: '하우징', partIds: [0] }];
const viewer = vi.hoisted(() => ({ mounts: 0, destroys: 0, files: [] as string[] }));

vi.mock('explode-studio', () => ({
  mountExplodeStudio: (container: HTMLElement) => {
    viewer.mounts += 1;
    const handlers: Record<string, ((d: unknown) => void)[]> = {};
    const emit = (type: string, d: unknown) => (handlers[type] ?? []).forEach(fn => fn(d));
    const root = Object.assign(document.createElement('div'), { innerHTML: '<div class="stage"></div>' });
    container.appendChild(root);
    let name = '';
    return {
      on: (type: string, fn: (d: unknown) => void) => { (handlers[type] ??= []).push(fn); return () => {}; },
      loadFile: async (f: File) => { viewer.files.push(f.name); name = f.name; emit('model', { name, parts: PARTS.length }); },
      replay: () => {}, setSpin: () => {},
      getState: () => ({ model: name, step: 1 }),
      getParts: () => PARTS, getLayers: () => LAYERS, root,
      go: () => {}, selectPart: () => {},
      destroy: () => { viewer.destroys += 1; },
    };
  },
}));

beforeEach(() => { viewer.mounts = 0; viewer.destroys = 0; viewer.files.length = 0; });

describe('CAD 스튜디오 유지', () => {
  it('조립 규칙 · 작업 표준에 갔다 와도 뷰어를 새로 만들지 않고 CAD 를 다시 불러오지 않는다', async () => {
    await seedCad('base.step', 'AAA');
    const user = userEvent.setup();
    render(<SessionProvider><MemoryRouter initialEntries={['/']}><App /></MemoryRouter></SessionProvider>);
    await waitFor(() => expect(viewer.files).toEqual(['base.step']));

    const nav = screen.getAllByRole('link', { name: '조립 규칙' })[0]!;
    await user.click(nav);
    expect(await screen.findByRole('heading', { level: 1, name: '조립 규칙' })).toBeInTheDocument();
    expect(screen.getByTestId('studio-keepalive')).toHaveAttribute('hidden');          // 숨겨 둘 뿐 지우지 않는다

    await user.click(screen.getAllByRole('link', { name: '작업 표준' })[0]!);
    expect(await screen.findByRole('heading', { level: 1, name: '작업 표준' })).toBeInTheDocument();

    await user.click(screen.getAllByRole('link', { name: 'CAD 스튜디오' })[0]!);
    await waitFor(() => expect(screen.getByTestId('studio-keepalive')).not.toHaveAttribute('hidden'));
    expect(within(screen.getByTestId('studio-keepalive')).getByRole('region', { name: '등록한 CAD' })).toBeInTheDocument();

    expect(viewer.mounts).toBe(1);
    expect(viewer.destroys).toBe(0);
    expect(viewer.files).toEqual(['base.step']);                                         // 파일을 다시 읽지 않았다
  });

  it('스튜디오를 열지 않은 채 다른 화면으로 시작하면 스튜디오(three.js)를 만들지 않는다', async () => {
    render(<SessionProvider><MemoryRouter initialEntries={['/rules']}><App /></MemoryRouter></SessionProvider>);
    expect(await screen.findByRole('heading', { level: 1, name: '조립 규칙' })).toBeInTheDocument();
    expect(screen.queryByTestId('studio-keepalive')).not.toBeInTheDocument();
    expect(viewer.mounts).toBe(0);
  });

  it('이미 열려 있는 CAD 카드를 다시 눌러도 다시 불러오지 않는다', async () => {
    await seedCad('base.step', 'AAA');
    const user = userEvent.setup();
    render(<SessionProvider><MemoryRouter initialEntries={['/']}><App /></MemoryRouter></SessionProvider>);
    await waitFor(() => expect(viewer.files).toEqual(['base.step']));
    const card = await screen.findByRole('button', { name: 'base.step 열기' });
    await user.click(card);
    await user.click(card);
    expect(viewer.files).toEqual(['base.step']);
  });
});
