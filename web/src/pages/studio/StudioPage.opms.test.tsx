import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../../api/httpApi';
import { fakeBackend, socketPart, type FakeBackend } from '../../api/testBackend';
import type { PdmApi } from '../../api/types';
import { boltMesh, plateMesh, type Mesh } from '../../extract/fastener.fixtures';
import { SessionProvider } from '../../session';
import { StudioPage } from './StudioPage';
import { seedCad } from './testSeed';

// 백엔드(→ OPMS)가 연결된 스튜디오: 보유 품번은 이름이 아니라 확정한 규격으로 OPMS 부품에서 찾고, 연결 상태를 정직하게 보인다.
// 백엔드는 같은 응답 모양의 가짜 fetch(testBackend)이고, 뷰어(WebGL)는 같은 API 모양의 가짜다.
const MESHES: Record<string, Mesh> = {
  'PRT-S1': boltMesh('socket', 'M4', 15),
  'PRT-PLATE': plateMesh(60, 30, 4),
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

async function renderPage(state: Parameters<typeof fakeBackend>[0] = {}) {
  await seedCad();
  backend = fakeBackend(state);
  return render(
    <SessionProvider api={createHttpApi({ fetchImpl: backend.fetch })}>
      <MemoryRouter><StudioPage /></MemoryRouter>
    </SessionProvider>,
  );
}

const stepsPanel = async () => {
  const steps = await screen.findByRole('region', { name: '제조 순서' });
  await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());
  return steps;
};
const statusLine = () => screen.findByText(/OPMS 연결됨|PDM 백엔드가 꺼져 있어요|OPMS에 연결하지 못했어요|OPMS 읽기 설정|계정을 받아주지|온톨로지가 아직 없어요/).then(el => el.closest('.opms-line')!);

/** 부품을 고르고, 형상으로 본 볼트 종류와 나사 규격 · 길이를 확정한다 */
async function confirmSpec(user: ReturnType<typeof userEvent.setup>) {
  const steps = await stepsPanel();
  await user.click(screen.getByRole('tab', { name: /^속성/ }));
  await user.click(within(steps).getByRole('button', { name: /^PRT-S1/ }));
  const block = await screen.findByRole('region', { name: '형상으로 본 볼트 종류' });
  await user.click(await within(block).findByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }));
  await user.click(await screen.findByRole('button', { name: /^나사 규격 M4 확정$/ }));
  await user.click(await screen.findByRole('button', { name: /^길이 15 mm 확정$/ }));
  return steps;
}

beforeEach(() => window.localStorage.clear());

describe('연결 상태', () => {
  it('OPMS 를 읽으면 "OPMS 연결됨 · 온톨로지 버전 · 부품 수"를 보인다 (PDM 은 읽기만 한다)', async () => {
    await renderPage();
    const line = await statusLine();
    expect(line).toHaveTextContent('OPMS 연결됨');
    expect(line).toHaveTextContent('온톨로지 0.15.0');
    expect(line).toHaveTextContent('부품 3개');
    expect(line).toHaveAttribute('title', expect.stringContaining('읽기만'));
  });

  it.each([
    [{ backend: 'down' as const }, 'PDM 백엔드가 꺼져 있어요'],
    [{ opms: 'OPMS_UNAVAILABLE' as const }, 'OPMS에 연결하지 못했어요'],
    [{ opms: 'OPMS_NOT_CONFIGURED' as const }, '백엔드에 OPMS 읽기 설정이 없어요'],
    [{ opms: 'OPMS_AUTH_FAILED' as const }, 'OPMS가 계정을 받아주지 않았어요'],
    [{ opms: 'OPMS_NO_ONTOLOGY' as const }, 'OPMS에 적용된 온톨로지가 아직 없어요'],
  ])('연결되지 않으면 이유를 구분해 말하고(오류 배너가 아니라 상태) 다시 시도할 수 있다: %j', async (state, text) => {
    await renderPage(state);
    const line = await statusLine();
    expect(line).toHaveTextContent(text);
    expect(within(line as HTMLElement).getByRole('button', { name: '다시 시도' })).toBeInTheDocument();
    expect(line.className).not.toMatch(/danger/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();                 // 빨강 경고가 아니다
  });
});

describe('조립 규칙 안내(HUD)', () => {
  it('규칙집을 읽는 길이 없고 OPMS 만 읽는 API 는 "연결되면"이 아니라 조립 규칙 데이터가 아직 없다고 말한다 (규칙집 기준 안내는 StudioPage.rules.test.tsx)', async () => {
    const user = userEvent.setup();
    await seedCad();
    backend = fakeBackend();
    const api: PdmApi = { ...createHttpApi({ fetchImpl: backend.fetch }), rulebook: undefined };
    render(<SessionProvider api={api}><MemoryRouter><StudioPage /></MemoryRouter></SessionProvider>);
    const steps = await stepsPanel();
    await user.click(within(steps).getByRole('button', { name: /^PRT-S1/ }));
    const hud = await screen.findByRole('complementary', { name: '조립 안내' });
    expect(hud).toHaveTextContent('조립 규칙 데이터가 아직 없어요');
    expect(screen.getByRole('status', { name: /조립 규칙 데이터는 아직 OPMS에 없어요/ })).toBeInTheDocument();
    expect(hud).not.toHaveTextContent('OPMS에 연결되면');
  });
});

describe('보유 품번 매칭 (OPMS)', () => {
  it('규격을 추정하지 못한 부품(판)은 "미보유"가 아니라 "규격 확정 필요"다 (OPMS 부품에는 이름이 없어 이름으로 찾지 않는다)', async () => {
    await renderPage();
    const steps = await stepsPanel();
    await waitFor(() => expect(within(steps).queryByText('형상 분석 중…')).not.toBeInTheDocument());
    const plate = within(steps).getByRole('button', { name: /^PRT-PLATE/ });
    expect(within(plate).getByText('규격 확정 필요')).toHaveAttribute('title', 'CAD로 규격을 추정하지 못했어요 — 속성 탭에서 확정하면 찾아요');
    expect(within(steps).getByText('규격 확정 대기 1')).toBeInTheDocument();
    expect(within(steps).getByText('미보유 0')).toBeInTheDocument();                // 못 찾은 것이 아니라 찾을 규격이 없는 것이다
  });

  it('볼트는 확정하기 전에도 CAD 형상이 추정한 규격(M4 · 15 mm)으로 OPMS 부품을 찾아 "후보 · 추정"으로 보인다 (자동 확정은 없다)', async () => {
    const user = userEvent.setup();
    await renderPage();
    const steps = await stepsPanel();
    const s1 = () => within(steps).getByRole('button', { name: /^PRT-S1/ });
    await waitFor(() => expect(s1()).toHaveTextContent('후보 2개 · 추정'));
    expect(s1()).not.toHaveTextContent('P-00000000048');                              // 후보일 뿐 보유 품번(확정)이 아니다
    const calls = backend.calls.filter(c => c.path === '/opms/match');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ class_code: 'SocketHeadBolt', head_type: 'Socket', values: { threadSize: 'M4', length: 15 } });
    expect(within(steps).getByText('후보 1')).toBeInTheDocument();

    // 온톨로지 탭: 후보 목록 위에 추정이라는 안내가 있고, 규격을 확정하면 '추정'이 사라진다
    await user.click(within(steps).getByRole('button', { name: /^PRT-S1/ }));
    await user.click(screen.getByRole('tab', { name: '온톨로지' }));
    expect(await screen.findByText(/CAD 형상에서 M4 · 15 mm 로 추정해 찾았어요\. 규격을 확정하면 더 정확해져요/)).toBeInTheDocument();
    expect(screen.getByText('후보 품번 · 추정')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /^속성/ }));
    const block = await screen.findByRole('region', { name: '형상으로 본 볼트 종류' });
    await user.click(await within(block).findByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }));
    await user.click(await screen.findByRole('button', { name: /^나사 규격 M4 확정$/ }));
    expect(s1()).toHaveTextContent('후보 2개 · 추정');                                   // 길이는 아직 추정이다
    await user.click(await screen.findByRole('button', { name: /^길이 15 mm 확정$/ }));
    await waitFor(() => expect(s1()).not.toHaveTextContent('추정'));
    expect(s1()).toHaveTextContent('후보 2개');
    expect(backend.calls.filter(c => c.path === '/opms/match')).toHaveLength(1);        // 같은 규격이라 다시 묻지 않는다
  });

  it('OPMS 에 같은 규격이 없으면 "미보유 · 추정 규격"이다 (못 찾은 것이지 확정한 미보유가 아니다)', async () => {
    await renderPage({ parts: [socketPart(61, 10, 'SCM435')] });                      // OPMS 에는 M4 × 10 뿐이라 M4 × 15 는 없다
    const steps = await stepsPanel();
    await waitFor(() => expect(within(steps).getByRole('button', { name: /^PRT-S1/ })).toHaveTextContent('미보유 · 추정 규격'));
  });

  it('나사 규격 · 길이를 확정하면 OPMS 부품이 후보로 올라오고, 후보가 둘이면 사람이 고른다 (확정하면 보유 품번)', async () => {
    const user = userEvent.setup();
    await renderPage();
    const steps = await confirmSpec(user);
    await waitFor(() => expect(within(steps).getByRole('button', { name: /^PRT-S1/ })).toHaveTextContent('후보 2개'));
    expect(backend.calls.filter(c => c.path === '/opms/match').at(-1)?.body).toEqual({ class_code: 'SocketHeadBolt', head_type: 'Socket', values: { threadSize: 'M4', length: 15 } });

    await user.click(screen.getByRole('tab', { name: '온톨로지' }));
    const list = await screen.findByRole('list', { name: '보유 품번 후보' });
    expect(within(list).getAllByRole('listitem').filter(li => li.className === 'cand')).toHaveLength(2);
    expect(within(list).getByText('육각구멍붙이볼트 M4 · 15 mm · SUS304')).toBeInTheDocument();      // OPMS 부품에는 이름이 없어 분류 · 규격으로 만든 이름
    const why = within(list).getByRole('list', { name: 'P-00000000048 일치 근거' });
    expect(within(why).getByText('나사 규격 M4 일치')).toBeInTheDocument();
    expect(within(why).getByText('길이 15 mm 일치')).toBeInTheDocument();
    expect(within(why).queryByText(/재질/)).not.toBeInTheDocument();                                  // 값이 없어 비교하지 않은 속성은 근거로 말하지 않는다
    expect(screen.getByText(/CAD에서 읽은 값은 근사라 후보까지만 돼요/)).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: 'P-00000000050 이 품번으로 확정' }));
    await waitFor(() => expect(within(steps).getByRole('button', { name: /^PRT-S1/ })).toHaveTextContent('P-00000000050'));
    expect(within(steps).getByRole('button', { name: /^PRT-S1/ })).not.toHaveTextContent('후보');
    await user.click(screen.getByRole('tab', { name: '온톨로지' }));
    expect(await screen.findByText('보유 품번')).toBeInTheDocument();
    // 확정한 OPMS 부품의 속성이 온톨로지 그래프에 한글 이름으로 보인다
    await waitFor(() => expect(screen.getByRole('img', { name: /PRT-S1 온톨로지 그래프/ })).toHaveTextContent('SCM435'));
    expect(backend.calls.some(c => c.path === '/opms/parts/P-00000000050')).toBe(true);
  });

  it('길이 후보를 제외하면 나사 규격만으로 후보가 올라온다 (사람이 제외한 추정 값은 쓰지 않고, 비교한 속성만 점수에 든다)', async () => {
    const user = userEvent.setup();
    await renderPage();
    const steps = await stepsPanel();
    await user.click(screen.getByRole('tab', { name: /^속성/ }));
    await user.click(within(steps).getByRole('button', { name: /^PRT-S1/ }));
    const block = await screen.findByRole('region', { name: '형상으로 본 볼트 종류' });
    await user.click(await within(block).findByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }));
    await user.click(await screen.findByRole('button', { name: /^나사 규격 M4 확정$/ }));
    await user.click(await screen.findByRole('button', { name: /^길이 15 mm 제외$/ }));                  // 길이 추정을 쓰지 않는다
    await waitFor(() => expect(within(steps).getByRole('button', { name: /^PRT-S1/ })).toHaveTextContent('후보 3개'));
    expect(within(steps).getByRole('button', { name: /^PRT-S1/ })).not.toHaveTextContent('추정');       // 규격을 사람이 확정했고 추정 값은 쓰지 않았다
    expect(backend.calls.filter(c => c.path === '/opms/match').at(-1)?.body).toEqual({ class_code: 'SocketHeadBolt', head_type: 'Socket', values: { threadSize: 'M4' } });

    // 점수는 비교한 속성만으로 계산돼 길이 없이도 100% 가 되므로, 퍼센트가 아니라 "확인한 K개가 모두 일치 · 미확인 M개(길이, 재질)"로 말한다
    await user.click(screen.getByRole('tab', { name: '온톨로지' }));
    const list = await screen.findByRole('list', { name: '보유 품번 후보' });
    const first = within(list).getAllByRole('listitem').find(li => li.className === 'cand')!;
    const score = first.querySelector('.cand-score')!;
    expect(score).toHaveTextContent('확인한 1개 속성이 모두 일치 · 미확인 2개(길이, 재질)');
    expect(first).not.toHaveTextContent('100%');                                                    // 미확인이 있으면 완전 일치로 오인되지 않는다
    expect(screen.getByText(/규격 일치\(나사 규격 · 길이 · 머리 모양\)/).parentElement).not.toHaveTextContent('100%');   // 상태 줄에도 퍼센트를 쓰지 않는다
    expect(score).toHaveAttribute('title', expect.stringContaining('가중 점수 100%'));               // 퍼센트는 툴팁에만 남는다
  });

  it('길이까지 확정하면 확인 못 한 것은 CAD 로 알 수 없는 속성(재질)만 남는다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await confirmSpec(user);
    await user.click(screen.getByRole('tab', { name: '온톨로지' }));
    const list = await screen.findByRole('list', { name: '보유 품번 후보' });
    const first = within(list).getAllByRole('listitem').find(li => li.className === 'cand')!;
    expect(first.querySelector('.cand-score')).toHaveTextContent('확인한 2개 속성이 모두 일치 · 미확인 1개(재질)');
    expect(first).not.toHaveTextContent('미확인 2개');                                                 // 길이는 확인했다
    expect(first).not.toHaveTextContent('100%');
  });
});

describe('연결이 끊겼다 돌아오면', () => {
  it('백엔드가 꺼져 있으면 "연결 안 됨"이고, 켜고 다시 시도하면 연결되어 매칭을 다시 한다', async () => {
    const user = userEvent.setup();
    await renderPage({ backend: 'down' });
    const steps = await confirmSpec(user);
    await waitFor(() => expect(within(steps).getByRole('button', { name: /^PRT-S1/ })).toHaveTextContent('연결 안 됨'));
    expect(within(steps).getByRole('button', { name: /^PRT-S1/ })).not.toHaveTextContent('미보유');     // 못 읽은 것을 "없다"고 말하지 않는다
    expect(within(steps).getByText('연결 안 됨 1')).toBeInTheDocument();

    backend.state.backend = 'up';
    await user.click(within((await statusLine()) as HTMLElement).getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('OPMS 연결됨')).toBeInTheDocument();
    await waitFor(() => expect(within(steps).getByRole('button', { name: /^PRT-S1/ })).toHaveTextContent('후보 2개'));
  });
});
