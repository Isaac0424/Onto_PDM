import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../../api/httpApi';
import { fakeBackend, type FakeBackend } from '../../api/testBackend';
import type { PdmApi } from '../../api/types';
import { boltMesh, plateMesh, type Mesh } from '../../extract/fastener.fixtures';
import { SessionProvider } from '../../session';
import { StudioPage } from './StudioPage';
import { seedCad } from './testSeed';

// 스튜디오 조립 안내(HUD) ← 규칙집(rules/): 고른 부품의 분류 · 속성 · 역할 · 로봇 모델로 적용되는 규칙을 찾는다. 사람이 확정한 것은 '확정 기준',
// CAD 형상이 추정한 것은 'CAD 추정 기준'(규칙 적용을 단정하지 않는다), 역할처럼 사람이 정해야 하는 조건은 고르게 한다.
// 백엔드(fetch)와 뷰어(WebGL)는 같은 응답 · API 모양의 가짜다.
const MESHES: Record<string, Mesh> = {
  'BOLT-M4X15': boltMesh('socket', 'M4', 15),
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
      selectPart: (key: string | number) => { const p = PARTS.find(x => typeof key === 'number' ? x.id === key : x.name === key)!; emit('select', { id: p.id, name: p.name, layer: p.layer }); },
      destroy: () => {},
    };
  },
}));

vi.setConfig({ testTimeout: 20_000 });                    // 형상 분석 + 화면 렌더가 겹쳐 컴퓨터가 바쁘면 5초를 넘길 수 있다

let backend: FakeBackend;
const selectCalls = () => backend.calls.filter(c => c.path === '/rulebook/select');
const lastSelect = () => selectCalls().at(-1)?.body;

async function renderPage(state: Parameters<typeof fakeBackend>[0] = {}, cad = 'Body HCR12A R00 3D.stp', api?: PdmApi) {
  await seedCad(cad);
  backend = fakeBackend(state);
  return render(
    <SessionProvider api={api ?? createHttpApi({ fetchImpl: backend.fetch })}>
      <MemoryRouter><StudioPage /></MemoryRouter>
    </SessionProvider>,
  );
}

const stepsPanel = () => screen.findByRole('region', { name: '제조 순서' });
async function pick(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(within(await stepsPanel()).getByRole('button', { name: new RegExp(`^${name}`) }));
}
const hud = () => screen.findByRole('complementary', { name: '조립 안내' });

beforeEach(() => window.localStorage.clear());

describe('조립 안내(HUD): 규칙집 기준', () => {
  it('확정하지 않은 볼트: CAD 추정 기준으로 적용되는 규칙(경고 문구 + 쪽 번호)과 역할을 알면 확정되는 규칙을 구분해 보인다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await pick(user, 'BOLT-M4X15');
    const card = within(await hud());
    await waitFor(() => expect(card.getByRole('region', { name: '적용되는 규칙' })).toBeInTheDocument());

    expect(card.getByText('CAD 추정 기준')).toBeInTheDocument();                                       // 확정이 아니다
    expect(card.getByText('SocketHeadBolt')).toBeInTheDocument();
    expect(card.getByText('HCR-12A')).toBeInTheDocument();                                              // 파일 이름에서 읽은 모델
    expect(card.getByText('초안 · 검토 전')).toBeInTheDocument();

    const applied = card.getByRole('region', { name: '적용되는 규칙' });
    expect(applied).toHaveTextContent('적용될 것으로 보는 규칙 1');
    expect(within(applied).getByRole('link', { name: 'AR-SAF-001' })).toHaveAttribute('href', '/rules/AR-SAF-001');
    const cautions = within(applied).getByRole('list', { name: 'AR-SAF-001 주의사항' });
    expect(cautions).toHaveTextContent('로봇에 조립되어 있는 볼트는 절대 임의로 분해하지 마세요.');
    expect(cautions).toHaveTextContent('사용설명서(KR) 3.3절 p.50');

    const pending = card.getByRole('region', { name: '확정하면 적용되는 규칙' });
    expect(pending).toHaveTextContent('AR-FAS-001');
    expect(pending).toHaveTextContent('AR-FAS-006');
    expect(pending).toHaveTextContent('알아야 확정돼요: 이 볼트의 역할');
    const roles = within(card.getByRole('group', { name: '역할 고르기' })).getAllByRole('button');
    expect(roles.map(b => b.textContent)).toEqual(expect.arrayContaining(['로봇 암 본체 조립에 쓰인 M3 · M4 소켓 헤드 볼트']));
    expect(roles).toHaveLength(3);

    // 자막: 적용되는 규칙의 경고 문구, 추정 기준이라고 밝힌다
    expect(screen.getByRole('status', { name: /^\(CAD 추정\) 로봇에 조립되어 있는 볼트는 절대 임의로 분해하지 마세요/ })).toBeInTheDocument();

    // 보낸 요청: 형상이 추정한 분류 · 규격 · 길이와 파일 이름에서 읽은 모델. 역할은 보내지 않는다(CAD 로 알 수 없다)
    expect(lastSelect()).toEqual({
      class_code: 'SocketHeadBolt', class_path: ['Fastener', 'Bolt', 'SocketHeadBolt'], attributes: { threadSize: 'M4', length: 15 }, model: 'HCR-12A',
    });
  });

  it('역할을 사람이 고르면 그 역할의 규칙이 정해지고, 값이 비어 있는 곳은 "작성 필요"로 보인다 (확정값처럼 보이지 않는다)', async () => {
    const user = userEvent.setup();
    await renderPage();
    await pick(user, 'BOLT-M4X15');
    const roleBtn = await within(await hud()).findByRole('button', { name: '로봇 암 본체 조립에 쓰인 M3 · M4 소켓 헤드 볼트' });
    await user.click(roleBtn);

    await waitFor(() => expect(lastSelect()).toMatchObject({ role: 'arm_assembly_bolt' }));
    const card = within(await hud());
    await waitFor(() => expect(card.getByRole('link', { name: 'AR-FAS-006' })).toBeInTheDocument());
    const applied = card.getByRole('region', { name: '적용되는 규칙' });
    expect(applied).toHaveTextContent('AR-FAS-006');
    expect(applied).toHaveTextContent('작성 필요 G-001');                                               // 체결 토크: 근거가 없어 비어 있다
    expect(applied).toHaveTextContent('작성 필요 G-005');                                               // 체결 순서
    expect(within(applied).getByText('체결 토크')).toBeInTheDocument();
    expect(within(applied).getAllByTitle('근거가 없어 값을 비워 뒀어요').length).toBeGreaterThanOrEqual(2);
    expect(card.getByRole('button', { name: '로봇 암 본체 조립에 쓰인 M3 · M4 소켓 헤드 볼트' })).toHaveAttribute('aria-pressed', 'true');
    expect(card.getByText('CAD 추정 기준')).toBeInTheDocument();                                       // 역할을 골라도 분류가 추정이면 추정 기준이다

    await user.click(card.getByRole('button', { name: '로봇 암 본체 조립에 쓰인 M3 · M4 소켓 헤드 볼트' }));      // 다시 누르면 해제: 규칙이 다시 '확정하면 적용'으로 돌아간다
    const again = within(await hud());
    await waitFor(() => expect(again.getByRole('region', { name: '확정하면 적용되는 규칙' })).toHaveTextContent('AR-FAS-006'));
    expect(again.getByRole('button', { name: '로봇 암 본체 조립에 쓰인 M3 · M4 소켓 헤드 볼트' })).toHaveAttribute('aria-pressed', 'false');
    expect(selectCalls()).toHaveLength(2);                                                              // 같은 요청(역할 없음)은 다시 보내지 않는다
  });

  it('베이스 고정 역할을 고르고 모델을 알면 모델별 표의 값(HCR-12A M12 140 N·m)이 하나로 정해진다 — 사용설명서 근거는 확정값으로 보인다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await pick(user, 'BOLT-M4X15');
    const base = await within(await hud()).findByRole('button', { name: '로봇 암 베이스를 설치면에 고정하는 볼트 4개' });
    await user.click(base);
    const card = within(await hud());
    await waitFor(() => expect(card.getByRole('link', { name: 'AR-FAS-001' })).toBeInTheDocument());
    const applied = card.getByRole('region', { name: '적용되는 규칙' });
    expect(applied).toHaveTextContent('나사 규격M12');
    expect(applied).toHaveTextContent('체결 토크140 N·m');
    expect(applied).toHaveTextContent('위치 결정 핀 지름5 mm');
    expect(within(applied).getByText('140 N·m')).toHaveClass('rb-value');                               // 확정값(사용설명서 근거)
  });

  it('볼트 종류를 사람이 확정하면 "확정 기준"이고 확정한 속성만 보낸다 (추정 규격은 보내지 않는다)', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole('tab', { name: /^속성/ }));
    await pick(user, 'BOLT-M4X15');
    const block = await screen.findByRole('region', { name: '형상으로 본 볼트 종류' });
    await user.click(await within(block).findByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }));

    const card = within(await hud());
    await waitFor(() => expect(card.getByText('확정 기준')).toBeInTheDocument());
    expect(card.queryByText('CAD 추정 기준')).not.toBeInTheDocument();
    await waitFor(() => expect(lastSelect()).toEqual({ class_code: 'SocketHeadBolt', class_path: ['Fastener', 'Bolt', 'SocketHeadBolt'], attributes: {}, model: 'HCR-12A' }));
    expect(card.getByRole('region', { name: '적용되는 규칙' })).toHaveTextContent('적용되는 규칙 1');

    await user.click((await screen.findAllByRole('button', { name: /^나사 규격 M4 확정$/ }))[0]!);       // 형상 · 부품 이름 두 출처에서 같은 값이 나온다
    await waitFor(() => expect(lastSelect()).toMatchObject({ attributes: { threadSize: 'M4' } }));
    expect(lastSelect()).not.toHaveProperty('attributes.length');                                       // 길이는 확정하지 않았다
  });

  it('종류를 알 수 없는 부품(판)은 규칙을 고르지 않고 이유를 말한다 (규칙집에 묻지도 않는다)', async () => {
    const user = userEvent.setup();
    await renderPage();
    await pick(user, 'PRT-PLATE');
    const card = within(await hud());
    expect(await card.findByText(/종류를 알 수 없어 규칙을 고를 수 없어요/)).toBeInTheDocument();
    expect(card.queryByText(/OPMS에 연결되면/)).not.toBeInTheDocument();
    expect(selectCalls()).toHaveLength(0);
  });

  it('로봇 모델을 파일 이름에서 읽을 수 없으면 모델을 보내지 않고 "모델 미확인"이라고 말한다', async () => {
    const user = userEvent.setup();
    await renderPage({}, 'base.step');
    await pick(user, 'BOLT-M4X15');
    const card = within(await hud());
    await waitFor(() => expect(card.getByText('모델 미확인')).toBeInTheDocument());
    await waitFor(() => expect(selectCalls().length).toBeGreaterThan(0));
    expect(lastSelect()).not.toHaveProperty('model');
  });

  it('같은 부품을 다시 골라도 같은 요청은 한 번만 보낸다 (분류 · 속성 · 역할 · 모델이 같으면)', async () => {
    const user = userEvent.setup();
    await renderPage();
    await pick(user, 'BOLT-M4X15');
    await within(await hud()).findByRole('region', { name: '적용되는 규칙' });
    await pick(user, 'PRT-PLATE');
    await pick(user, 'BOLT-M4X15');
    await within(await hud()).findByRole('region', { name: '적용되는 규칙' });
    expect(selectCalls()).toHaveLength(1);
  });

  it('규칙집을 읽을 수 없으면(rules/ 오류 · 파일 없음) 규칙을 보여 주지 않고 이유를 말한다 — 빨강 경고가 아니다', async () => {
    const user = userEvent.setup();
    await renderPage({ rulebook: 'invalid' });
    await pick(user, 'BOLT-M4X15');
    const card = within(await hud());
    expect(await card.findByText('규칙집(rules/)에 오류가 있어 규칙을 보여 드릴 수 없어요.')).toBeInTheDocument();
    expect(card.queryByRole('region', { name: '적용되는 규칙' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('PDM 백엔드가 꺼져 있으면 그 이유를 말하고, 돌아온 뒤 다른 부품을 고르면 다시 시도한다', async () => {
    const user = userEvent.setup();
    await renderPage({ backend: 'down' });
    await pick(user, 'BOLT-M4X15');
    expect(await within(await hud()).findByText('PDM 백엔드가 꺼져 있어 조립 규칙을 읽지 못했어요.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('규칙집을 읽는 길이 없는 API(OPMS 분류 · 부품만 읽는 구현)는 지금처럼 "조립 규칙 데이터가 아직 없어요"라고 말한다', async () => {
    const user = userEvent.setup();
    backend = fakeBackend();
    const api: PdmApi = { ...createHttpApi({ fetchImpl: backend.fetch }), rulebook: undefined };
    await seedCad();
    render(<SessionProvider api={api}><MemoryRouter><StudioPage /></MemoryRouter></SessionProvider>);
    await pick(user, 'PRT-PLATE');
    expect(await within(await hud()).findByText('조립 규칙 데이터가 아직 없어요')).toBeInTheDocument();
    expect(selectCalls()).toHaveLength(0);
  });
});

