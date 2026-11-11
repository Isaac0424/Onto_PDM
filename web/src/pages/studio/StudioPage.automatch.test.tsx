import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../../api/httpApi';
import { fakeBackend, type FakeBackend } from '../../api/testBackend';
import { boltMesh, nutMesh, plateMesh, type Mesh } from '../../extract/fastener.fixtures';
import { SessionProvider } from '../../session';
import { StudioPage } from './StudioPage';
import { seedCad } from './testSeed';

// CAD 형상 분석이 만든 규격(추정)으로 보유 품번 찾기: 12A 처럼 같은 볼트가 많은 CAD 에서도 요청은 서로 다른 규격 수만큼이고,
// 결과는 '후보 · 추정'이며, 연결이 안 되면 묻지 않는다. 뷰어(WebGL)와 백엔드(fetch)는 같은 모양의 가짜다.
const SAME = Array.from({ length: 12 }, (_, i) => `BOLT-M4X15 #${String(i + 1).padStart(2, '0')}`);
const MESHES: Record<string, Mesh> = {
  ...Object.fromEntries(SAME.map(n => [n, boltMesh('socket', 'M4', 15)])),
  'BOLT-M4X10': boltMesh('socket', 'M4', 10),
  'BOLT-M6X25': boltMesh('socket', 'M6', 25),                        // OPMS 에 없는 규격
  'BOLT-NOHOLE': boltMesh('socket', 'M6', 20, { drive: 'none' }),     // 단순화 모델: 종류를 단정할 수 없다
  'PRT-PLATE': plateMesh(60, 30, 4),
  'PRT-NUT': nutMesh(10, 5, 6),
};
const names = Object.keys(MESHES);
const bbox = (m: Mesh): [number, number, number] => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, m.positions[i + k]!); hi[k] = Math.max(hi[k]!, m.positions[i + k]!); }
  return [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!].map(v => +v.toFixed(2)) as [number, number, number];
};
const PARTS = names.map((name, id) => ({ id, name, path: '체결', layer: id, ko: '', size: bbox(MESHES[name]!), unit: 'mm' }));
const LAYERS = names.map((name, i) => ({ index: i, step: i + 2, title: name, partIds: [i] }));

vi.mock('explode-studio', () => ({
  mountExplodeStudio: (container: HTMLElement) => {
    const handlers: Record<string, ((d: unknown) => void)[]> = {};
    const emit = (type: string, d: unknown) => (handlers[type] ?? []).forEach(fn => fn(d));
    const root = Object.assign(document.createElement('div'), { innerHTML: '<div class="stage"></div>' });
    container.appendChild(root);
    let model = '';
    return {
      on: (type: string, fn: (d: unknown) => void) => { (handlers[type] ??= []).push(fn); return () => { handlers[type] = (handlers[type] ?? []).filter(f => f !== fn); }; },
      loadFile: async (f: File) => { model = f.name; emit('model', { name: model, parts: PARTS.length }); },
      getState: () => ({ model, step: 1 }),
      getParts: () => PARTS,
      getLayers: () => LAYERS,
      getPartGeometry: (name: string) => {
        const m = MESHES[name];
        return m ? { name, unit: 'mm', positions: Float32Array.from(m.positions), indices: Uint32Array.from(m.indices) } : null;
      },
      root,
      go: (n: number) => emit('step', { step: n, layer: n - 2 }),
      selectPart: (name: string) => { const p = PARTS.find(x => x.name === name)!; emit('select', { id: p.id, name: p.name, layer: p.layer }); },
      destroy: () => {},
    };
  },
}));

let backend: FakeBackend;
const matchCalls = () => backend.calls.filter(c => c.path === '/opms/match');

async function renderPage(state: Parameters<typeof fakeBackend>[0] = {}) {
  await seedCad();
  backend = fakeBackend(state);
  return render(
    <SessionProvider api={createHttpApi({ fetchImpl: backend.fetch })}>
      <MemoryRouter><StudioPage /></MemoryRouter>
    </SessionProvider>,
  );
}
const stepsPanel = () => screen.findByRole('region', { name: '제조 순서' });
const row = (steps: HTMLElement, name: string) => within(steps).getByRole('button', { name: new RegExp(`^${name}`) });

beforeEach(() => window.localStorage.clear());

describe('CAD 형상 추정 규격으로 보유 품번 찾기', () => {
  it('같은 볼트가 12개여도 OPMS 에는 서로 다른 규격 수(M4×15 · M4×10 · M6×25)만큼만 묻고, 모두 "후보 · 추정"이 된다', async () => {
    await renderPage();
    const steps = await stepsPanel();
    await waitFor(() => {
      SAME.forEach(n => expect(row(steps, n)).toHaveTextContent('후보 2개 · 추정'));
      expect(row(steps, 'BOLT-M4X10')).toHaveTextContent('후보 P-00000000047 · 추정');
      expect(row(steps, 'BOLT-M6X25')).toHaveTextContent('미보유 · 추정 규격');                // OPMS 에 없는 규격: 못 찾았다
    }, { timeout: 20_000 });
    expect(matchCalls()).toHaveLength(3);                                                    // 부품 수(15)가 아니라 서로 다른 규격 수
    expect(matchCalls().map(c => JSON.stringify((c.body as { values: unknown }).values)).sort())
      .toEqual([{ threadSize: 'M4', length: 10 }, { threadSize: 'M4', length: 15 }, { threadSize: 'M6', length: 25 }].map(v => JSON.stringify(v)).sort());
  }, 30_000);

  it('추정할 수 없는 부품(단순화 모델 · 판 · 너트)은 "규격 확정 필요"로 남고 묻지 않는다', async () => {
    await renderPage();
    const steps = await stepsPanel();
    await waitFor(() => {
      expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument();
      expect(within(steps).queryByText('형상 분석 중…')).not.toBeInTheDocument();
    }, { timeout: 20_000 });
    for (const n of ['BOLT-NOHOLE', 'PRT-PLATE', 'PRT-NUT']) {
      expect(within(row(steps, n)).getByText('규격 확정 필요')).toHaveAttribute('title', 'CAD로 규격을 추정하지 못했어요 — 속성 탭에서 확정하면 찾아요');
    }
    expect(within(steps).getByText('규격 확정 대기 3')).toBeInTheDocument();
    expect(matchCalls().every(c => !JSON.stringify(c.body).includes('"length":20'))).toBe(true);     // 단순화 모델(M6×20)로는 묻지 않았다
  }, 30_000);

  it('추정 후보는 자동으로 보유 품번이 되지 않는다: 사람이 후보를 골라야 확정(품번 표시, 추정 사라짐)이다', async () => {
    const user = userEvent.setup();
    await renderPage();
    const steps = await stepsPanel();
    await waitFor(() => expect(row(steps, 'BOLT-M4X10')).toHaveTextContent('후보 P-00000000047 · 추정'), { timeout: 20_000 });
    expect(within(steps).getByText('보유 0')).toBeInTheDocument();                           // 아무것도 확정되지 않았다
    await user.click(row(steps, 'BOLT-M4X10'));
    await user.click(screen.getByRole('tab', { name: '온톨로지' }));
    await user.click(await screen.findByRole('button', { name: 'P-00000000047 이 품번으로 확정' }));
    await waitFor(() => expect(row(steps, 'BOLT-M4X10')).toHaveTextContent('P-00000000047'));
    expect(row(steps, 'BOLT-M4X10')).not.toHaveTextContent('추정');
    expect(row(steps, 'BOLT-M4X10')).not.toHaveTextContent('후보');
    expect(within(steps).getByText('보유 1')).toBeInTheDocument();
  }, 30_000);

  it('OPMS 연결이 안 되면 묻지 않는다: "연결 안 됨"이고, 연결이 돌아오면 그때 찾는다', async () => {
    const user = userEvent.setup();
    await renderPage({ backend: 'down' });
    const steps = await stepsPanel();
    await waitFor(() => expect(row(steps, 'BOLT-M4X10')).toHaveTextContent('연결 안 됨'), { timeout: 20_000 });
    expect(matchCalls()).toEqual([]);                                                        // 요청이 나가지 않았다
    backend.state.backend = 'up';
    await user.click(within((await screen.findByText(/PDM 백엔드가 꺼져 있어요/)).closest('.opms-line') as HTMLElement).getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(row(steps, 'BOLT-M4X10')).toHaveTextContent('후보 P-00000000047 · 추정'), { timeout: 20_000 });
    expect(matchCalls()).toHaveLength(3);
  }, 30_000);

  it('형상 분석 중인 부품은 "규격 확정 필요"가 아니라 "형상 분석 중…"이라고 말한다 (끝나면 추정 규격이 생길 수 있다)', async () => {
    await renderPage();
    const steps = await stepsPanel();
    // 분석은 한가한 때 하나씩 진행되므로, 처음에는 일부가 분석 중이다
    await waitFor(() => expect(within(steps).queryAllByText('형상 분석 중…').length).toBeGreaterThan(0));
    expect(within(steps).queryByText(/규격 확정 대기 [1-9]\d/)).not.toBeInTheDocument();
  });
});
