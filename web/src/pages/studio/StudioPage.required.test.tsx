import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../../api/httpApi';
import { fakeBackend, type FakeBackend } from '../../api/testBackend';
import { boltMesh, plateMesh, type Mesh } from '../../extract/fastener.fixtures';
import { SessionProvider } from '../../session';
import { StudioPage } from './StudioPage';
import { seedCad } from './testSeed';

// OPMS 필수 속성 체크리스트: 볼트로 분류된 부품의 속성 탭에, 그 분류가 요구하는 필수 속성을 확정 · CAD 추정 · OPMS가 채움 · 미확인으로 보인다.
// 백엔드(→ OPMS)는 같은 응답 모양의 가짜 fetch(testBackend, 실제 SocketHeadBolt 필수 속성 모양), 뷰어(WebGL)는 같은 API 모양의 가짜다.
const MESHES: Record<string, Mesh> = {
  'PRT-S1': boltMesh('socket', 'M4', 15),
  'BOLT-SHORT': boltMesh('socket', 'M4', 2.5),                      // 길이 2.5 mm: OPMS 기준(≥3)보다 작다
  'BOLT-NOHOLE': boltMesh('socket', 'M6', 20, { drive: 'none' }),   // 단순화 모델: 종류를 정하지 못한다
  'PRT-BTN': boltMesh('button', 'M4', 15),                          // OPMS 에 아직 없는 분류(제안)
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
const classCalls = (code: string) => backend.calls.filter(c => c.path === `/opms/classes/${code}`);

/** wrap: 가짜 백엔드의 fetch 를 감싸 일부 요청만 바꾼다(예: 분류 상세만 실패) */
async function renderPage(state: Parameters<typeof fakeBackend>[0] = {}, wrap?: (inner: typeof fetch) => typeof fetch) {
  await seedCad();
  backend = fakeBackend(state);
  return render(
    <SessionProvider api={createHttpApi({ fetchImpl: wrap ? wrap(backend.fetch) : backend.fetch })}>
      <MemoryRouter><StudioPage /></MemoryRouter>
    </SessionProvider>,
  );
}

/** 부품을 고르고 속성 탭을 연다 */
async function openPart(user: ReturnType<typeof userEvent.setup>, name: string) {
  const steps = await screen.findByRole('region', { name: '제조 순서' });
  await user.click(screen.getByRole('tab', { name: /^속성/ }));
  await user.click(within(steps).getByRole('button', { name: new RegExp(`^${name}`) }));
}
const checklist = () => screen.findByRole('region', { name: 'OPMS 필수 속성' });
/** 필수 속성 한 줄 (속성 이름으로) */
const rowOf = (block: HTMLElement, label: string) => within(block).getByText(label, { selector: '.req-label' }).closest('li')!;

beforeEach(() => window.localStorage.clear());

describe('OPMS 필수 속성 체크리스트 (속성 탭)', () => {
  it('볼트를 고르면 확정 전에도 추정한 분류(육각구멍붙이볼트)의 필수 8개가 상태별로 보인다: 확인 2/8 · 추정 3개 · 미확인 3개', async () => {
    const user = userEvent.setup();
    await renderPage();
    await openPart(user, 'PRT-S1');
    const block = await checklist();
    await waitFor(() => expect(within(block).getByRole('heading', { level: 3 })).toHaveTextContent('OPMS 필수 속성 · 확인 2/8'), { timeout: 20_000 });
    expect(within(block).getByText('육각구멍붙이볼트 기준')).toBeInTheDocument();
    expect(within(block).getByRole('status', { name: '필수 속성 완성도' })).toHaveTextContent('확인 2/8 · 추정 3개 · 미확인 3개(재질, 표면처리, 강도 등급)');
    expect(within(block).getByRole('meter', { name: '확인한 필수 속성' })).toHaveAttribute('aria-valuenow', '2');
    expect(within(block).getAllByRole('listitem').filter(li => li.className.startsWith('req-row'))).toHaveLength(8);

    // CAD 추정(확정 전): 나사 규격 · 길이 · 육각구멍 크기
    expect(rowOf(block, '나사 규격')).toHaveTextContent('M4');
    expect(rowOf(block, '나사 규격')).toHaveTextContent('CAD 추정');
    expect(rowOf(block, '길이')).toHaveTextContent('CAD 추정');
    expect(rowOf(block, '육각구멍 크기')).toHaveTextContent('CAD 추정');
    // OPMS 가 채움(비어 있다고 세지 않음): 피치(보통 나사) · 나사 방향
    expect(rowOf(block, '피치')).toHaveTextContent('0.7 mm');
    expect(rowOf(block, '피치')).toHaveTextContent('OPMS가 채워요');
    expect(rowOf(block, '피치')).toHaveTextContent('보통 나사 값이에요');
    expect(rowOf(block, '피치')).toHaveTextContent('나사 규격이 추정이라 다시 확인해요');
    expect(rowOf(block, '나사 방향')).toHaveTextContent('오른나사');
    expect(rowOf(block, '나사 방향')).toHaveTextContent('OPMS가 채워요');
    // 미확인: CAD 로 알 수 없는 것은 어디서 채우는지 알려 준다 (사양서 · BOM 올리기가 없으므로 등록 요청 때)
    for (const label of ['재질', '표면처리', '강도 등급']) {
      expect(rowOf(block, label)).toHaveTextContent('미확인');
      expect(rowOf(block, label)).toHaveTextContent('CAD로 알 수 없어요 — 사양서·BOM에서 와요. 지금은 등록 요청 때 OPMS 검토 화면에서 채워요.');
    }
    expect(block.querySelector('.banner-danger, [role="alert"]')).toBeNull();                     // 빨강(오류)이 아니다
  }, 40_000);

  it('규격을 확정하면 확정으로 세고(확인 4/8), 피치의 "추정" 안내가 사라진다. 확정이 추정보다 우선한다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await openPart(user, 'PRT-S1');
    const kind = await screen.findByRole('region', { name: '형상으로 본 볼트 종류' });
    await user.click(await within(kind).findByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }));
    await user.click(await screen.findByRole('button', { name: /^나사 규격 M4 확정$/ }));
    await user.click(await screen.findByRole('button', { name: /^길이 15 mm 확정$/ }));

    const block = await checklist();
    await waitFor(() => expect(within(block).getByRole('heading', { level: 3 })).toHaveTextContent('확인 4/8'));
    expect(rowOf(block, '나사 규격')).toHaveTextContent('확정');
    expect(rowOf(block, '나사 규격')).not.toHaveTextContent('CAD 추정');
    expect(rowOf(block, '길이')).toHaveTextContent('15 mm');
    expect(rowOf(block, '피치')).not.toHaveTextContent('추정이라 다시 확인');
    expect(within(block).getByRole('status', { name: '필수 속성 완성도' })).toHaveTextContent('확인 4/8 · 추정 1개 · 미확인 3개');
    expect(classCalls('SocketHeadBolt')).toHaveLength(1);                                            // 분류별로 한 번만 읽는다
  }, 40_000);

  it('값이 OPMS 범위(길이 ≥3 mm)에 걸리면 호박색 경고 칩: 추정이면 "추정이라 다시 확인", 확정해도 알린다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await openPart(user, 'BOLT-SHORT');
    const block = await checklist();
    await waitFor(() => expect(rowOf(block, '길이')).toHaveTextContent('OPMS 기준(≥3 mm)보다 작아요 · 추정이라 다시 확인해요'), { timeout: 20_000 });
    expect(within(rowOf(block, '길이')).getByRole('note')).toHaveClass('chip-maybe');                // 호박색이다 (빨강 아님)

    await user.click(await screen.findByRole('button', { name: /^길이 .+ 확정$/ }));
    await waitFor(() => expect(rowOf(block, '길이')).toHaveTextContent('확정'));
    expect(rowOf(block, '길이')).toHaveTextContent('OPMS 기준(≥3 mm)보다 작아요');
    expect(rowOf(block, '길이')).not.toHaveTextContent('추정이라');
  }, 40_000);

  it('볼트 종류를 정하지 못했으면(단순화 모델) 종류를 확정하라고 안내하고, 확정하면 그 분류로 체크리스트가 나온다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await openPart(user, 'BOLT-NOHOLE');
    expect(await screen.findByText('볼트 종류를 확정하면 OPMS 필수 속성을 확인해요.', {}, { timeout: 20_000 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'OPMS 필수 속성' })).not.toBeInTheDocument();
    expect(classCalls('SocketHeadBolt')).toHaveLength(0);

    const kind = await screen.findByRole('region', { name: '형상으로 본 볼트 종류' });
    await user.click(await within(kind).findByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }));
    const block = await checklist();
    expect(within(block).getByText('육각구멍붙이볼트 기준')).toBeInTheDocument();
  }, 40_000);

  it('OPMS 에 아직 없는 분류(버튼헤드볼트)는 상위 분류(볼트) 기준으로 확인하고, 등록 요청 초안에 비어 있는 필수 속성을 싣는다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await openPart(user, 'PRT-BTN');
    const block = await checklist();
    await waitFor(() => expect(within(block).getByText(/버튼헤드볼트은\(는\) OPMS에 아직 없어 상위 분류로 확인해요/)).toBeInTheDocument(), { timeout: 20_000 });
    expect(within(block).getByText(/^볼트 기준/)).toBeInTheDocument();
    expect(within(block).getByRole('heading', { level: 3 })).toHaveTextContent('/6');                  // 볼트의 필수 6개(소켓 전용 속성은 등록되면 더 생길 수 있다)
    expect(classCalls('Bolt').length).toBeGreaterThan(0);
    expect(classCalls('ButtonHeadBolt')).toHaveLength(0);                                                // OPMS 에 없는 분류는 묻지 않는다

    const kind = await screen.findByRole('region', { name: '형상으로 본 볼트 종류' });
    await user.click(await within(kind).findByRole('button', { name: '버튼헤드볼트 이 종류로 확정' }));
    const draft = await screen.findByLabelText('OPMS 분류 등록 요청 본문');
    await waitFor(() => expect(draft).toHaveTextContent('"missingRequired"'));
    expect(draft).toHaveTextContent('OPMS 필수 속성 중 비어 있는 것(상위 분류 볼트 기준): 재질, 표면처리');
    expect(draft).toHaveTextContent('등록 요청 때 OPMS 검토 화면에서 채워야 합니다');
  }, 40_000);

  it('볼트가 아닌 부품(판)에는 체크리스트가 없다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await openPart(user, 'PRT-PLATE');
    await screen.findByRole('region', { name: '속성 후보' });
    await waitFor(() => expect(screen.queryByText('형상 분석 중…')).not.toBeInTheDocument(), { timeout: 20_000 });
    expect(screen.queryByRole('region', { name: 'OPMS 필수 속성' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'OPMS 필수 속성' })).not.toBeInTheDocument();
  }, 40_000);

  it('OPMS 에 연결되지 않으면 "OPMS에 연결되면 필수 속성을 확인해요"이고 읽으려 하지 않는다(오류 배너 아님)', async () => {
    const user = userEvent.setup();
    await renderPage({ backend: 'down' });
    await openPart(user, 'PRT-S1');
    const note = await screen.findByRole('status', { name: 'OPMS 필수 속성' }, { timeout: 20_000 });
    expect(note).toHaveTextContent('OPMS에 연결되면 필수 속성을 확인해요.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(backend.calls.filter(c => c.path.startsWith('/opms/classes/'))).toEqual([]);
  }, 40_000);

  it('OPMS 에 그 분류가 없으면(읽기 실패) 이유와 함께 알린다', async () => {
    const user = userEvent.setup();
    // 분류 상세만 실패하게 한다: 상태 · 분류 목록은 정상
    await renderPage({}, inner => (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/opms/classes/SocketHeadBolt')) {
        return new Response(JSON.stringify({ error: { code: 'CLASS_NOT_FOUND', message: '분류를 찾을 수 없습니다', details: null } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return inner(input, init);
    }) as typeof fetch);
    await openPart(user, 'PRT-S1');
    const note = await screen.findByRole('status', { name: 'OPMS 필수 속성' }, { timeout: 20_000 });
    expect(note).toHaveTextContent('OPMS 필수 속성을 읽지 못했어요.');
    expect(note).toHaveTextContent('분류를 찾을 수 없습니다');
  }, 40_000);
});
