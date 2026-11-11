import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../api/mock/mockApi';
import type { AssemblyPartInput } from '../../api/types';
import { SessionProvider } from '../../session';
import { conflictKeys, candidateId, type Decision } from './AttributePanel';
import { StudioPage } from './StudioPage';

// 속성 추출 엔진(A 작업)은 따로 시험한다. 여기서는 화면이 후보를 어떻게 보이고 · 확정하고 · 규칙에 넘기는지를 본다.
const extract = vi.hoisted(() => ({ specCalls: [] as { text: string; names: string[] }[] }));

vi.mock('../../extract', () => ({
  extractCadAttributes: (parts: { name: string; size: number[] | null }[]) => parts.map(p => ({
    partName: p.name,
    attributes:
      p.name === '상부 커버' ? [
        { key: 'thickness', label: '두께', value: 3, unit: 'mm', source: 'cad', evidence: '가장 얇은 치수 = 3 mm', confidence: 0.95 },
        { key: 'volume', label: '체적', value: 30240, unit: 'mm³', source: 'cad', evidence: '메시 체적(열린 모델이라 추정)', confidence: 0.4, estimated: true },
      ]
      : p.name === '기판 나사 M3' ? [{ key: 'threadSize', label: '나사 규격', value: 'M3', source: 'name', evidence: '이름의 "M3"', confidence: 0.9 }]
      : [],
  })),
  extractSpecAttributes: (text: string, names: string[]) => {
    extract.specCalls.push({ text, names });
    return /3\.2/.test(text)
      ? [{ partName: '상부 커버', attributes: [{ key: 'thickness', label: '두께', value: 3.2, unit: 'mm', source: 'spec', evidence: '상부 커버 두께는 3.2 mm 로 한다', confidence: 0.8 }] }]
      : [];
  },
  parseBomSheet: () => ({ rows: [], columns: {}, warnings: [] }),
}));

// 파일 보관소 서버는 쓰지 않는다
vi.mock('../../api/vault', () => ({
  uploadToVault: async (file: File, kind: string) => ({ sha256: 'ab'.repeat(32), size: file.size, name: file.name, format: 'txt', kind, duplicate: false }),
}));

const PARTS = [
  { id: 0, name: '하우징', path: '본체', layer: 0, ko: '', size: [120, 80, 20], unit: 'mm' },
  { id: 1, name: '기판 나사 M3', path: '체결', layer: 1, ko: '', size: [3, 3, 8], unit: 'mm' },
  { id: 2, name: '상부 커버', path: '외장', layer: 2, ko: '', size: [126, 80, 3], unit: 'mm' },
];
const LAYERS = [
  { index: 0, step: 2, title: '하우징', partIds: [0] },
  { index: 1, step: 3, title: '기판 나사 M3', partIds: [1] },
  { index: 2, step: 4, title: '상부 커버', partIds: [2] },
];

vi.mock('explode-studio', () => ({
  mountExplodeStudio: (container: HTMLElement) => {
    const handlers: Record<string, ((d: unknown) => void)[]> = {};
    const emit = (type: string, d: unknown) => (handlers[type] ?? []).forEach(fn => fn(d));
    const root = Object.assign(document.createElement('div'), { innerHTML: '<div class="stage"></div>' });
    container.appendChild(root);
    let model = '제어 박스 · 예시 모델';
    return {
      on: (type: string, fn: (d: unknown) => void) => { (handlers[type] ??= []).push(fn); return () => { handlers[type] = (handlers[type] ?? []).filter(f => f !== fn); }; },
      loadExample: () => emit('model', { name: '제어 박스 · 예시 모델', parts: PARTS.length }),
      loadFile: async (f: File) => { model = f.name; emit('model', { name: model, parts: PARTS.length }); },
      loadSpec: async () => {},
      getState: () => ({ model, step: 1 }),
      getParts: () => PARTS,
      getLayers: () => LAYERS,
      root,
      go: (n: number) => emit('step', { step: n, layer: n - 2 }),
      selectPart: (name: string) => { const p = PARTS.find(x => x.name === name)!; emit('select', { id: p.id, name: p.name, layer: p.layer }); },
      destroy: () => {},
    };
  },
}));

let guideInputs: AssemblyPartInput[][] = [];

function renderPage() {
  window.localStorage.setItem('onto-pdm-session', JSON.stringify({ userId: 2, adminMode: false }));
  const api = createMockApi(() => JSON.parse(window.localStorage.getItem('onto-pdm-session')!));
  const real = api.getAssemblyGuides.bind(api);
  api.getAssemblyGuides = async parts => { guideInputs.push(parts); return real(parts); };       // 규칙 조회에 무엇을 넘기는지 본다
  return render(
    <SessionProvider api={api}>
      <MemoryRouter><StudioPage /></MemoryRouter>
    </SessionProvider>,
  );
}

async function openAttributes(user: ReturnType<typeof userEvent.setup>) {
  const steps = await screen.findByRole('region', { name: '제조 순서' });
  await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());
  await user.click(screen.getByRole('tab', { name: /^속성/ }));
  return steps;
}

beforeEach(() => { guideInputs = []; extract.specCalls.length = 0; });

describe('속성 후보 패널', () => {
  it('부품을 고르면 CAD · 이름에서 뽑은 후보를 출처 · 신뢰도 · 추정 표시와 함께 보인다', async () => {
    const user = userEvent.setup();
    renderPage();
    const steps = await openAttributes(user);
    await user.click(within(steps).getByRole('button', { name: /^상부 커버/ }));

    const list = await screen.findByRole('list', { name: '상부 커버 속성 후보' });
    const thickness = within(list).getByText('두께').closest('li')!;
    expect(within(thickness).getByText('3 mm')).toBeInTheDocument();
    expect(within(thickness).getByText('CAD')).toBeInTheDocument();
    expect(within(thickness).getByRole('meter', { name: '신뢰도' })).toHaveAttribute('aria-valuenow', '95');
    const volume = within(list).getByText('체적').closest('li')!;
    expect(within(volume).getByText('추정')).toBeInTheDocument();                                  // 형상에서 추정한 값은 숨기지 않는다
    expect(within(volume).getByRole('meter', { name: '신뢰도' })).toHaveAttribute('aria-valuenow', '40');

    await user.click(within(steps).getByRole('button', { name: /^기판 나사 M3/ }));
    const screw = await screen.findByRole('list', { name: '기판 나사 M3 속성 후보' });
    expect(within(screw).getByText('이름')).toBeInTheDocument();                                    // 이름의 규격 표기에서 온 후보
    expect(within(screw).getByText('M3')).toBeInTheDocument();
  });

  it('부품을 고르지 않으면 부품별 후보 수를 보이고, 누르면 그 부품으로 간다', async () => {
    const user = userEvent.setup();
    renderPage();
    await openAttributes(user);
    const over = await screen.findByRole('list', { name: '부품별 속성 후보' });
    expect(within(over).getByRole('button', { name: /상부 커버.*후보 2/ })).toBeInTheDocument();
    expect(within(over).getByRole('button', { name: /하우징.*후보 0/ })).toBeInTheDocument();
    await user.click(within(over).getByRole('button', { name: /기판 나사 M3/ }));
    expect(await screen.findByRole('list', { name: '기판 나사 M3 속성 후보' })).toBeInTheDocument();
  });

  it('요약 칩은 후보와 확정 수를 센다', async () => {
    const user = userEvent.setup();
    renderPage();
    const steps = await openAttributes(user);
    expect(screen.getByRole('status', { name: '속성 후보 요약' })).toHaveTextContent('속성 후보 3개 · 확정 0개');

    await user.click(within(steps).getByRole('button', { name: /^상부 커버/ }));
    await user.click(await screen.findByRole('button', { name: '두께 3 mm 확정' }));
    expect(screen.getByRole('status', { name: '속성 후보 요약' })).toHaveTextContent('속성 후보 3개 · 확정 1개');
    await user.click(screen.getByRole('button', { name: '체적 30240 mm³ 제외' }));
    expect(screen.getByRole('status', { name: '속성 후보 요약' })).toHaveTextContent('속성 후보 2개 · 확정 1개');
  });

  it('확정한 속성과 분류가 조립 규칙 조회에 들어간다 (확정 전에는 속성이 없다)', async () => {
    const user = userEvent.setup();
    renderPage();
    const steps = await openAttributes(user);
    const last = () => guideInputs[guideInputs.length - 1]!.find(p => p.name === '상부 커버')!;
    await waitFor(() => expect(last().className).toBe('커버'));                                     // 분류는 매칭 결과에서
    expect(last().attributes).toBeUndefined();

    await user.click(within(steps).getByRole('button', { name: /^상부 커버/ }));
    await user.click(await screen.findByRole('button', { name: '두께 3 mm 확정' }));
    await waitFor(() => expect(last().attributes).toEqual({ thickness: 3 }));
    expect(last().size).toEqual([126, 80, 3]);                                                    // 크기는 그대로 같이 간다

    await user.click(screen.getByRole('button', { name: '두께 확정 취소' }));
    await waitFor(() => expect(last().attributes).toBeUndefined());
  });

  it('제외하면 후보에서 사라지고, 되돌릴 수 있다', async () => {
    const user = userEvent.setup();
    renderPage();
    const steps = await openAttributes(user);
    await user.click(within(steps).getByRole('button', { name: /^상부 커버/ }));
    await user.click(await screen.findByRole('button', { name: '체적 30240 mm³ 제외' }));
    expect(screen.queryByText('체적')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '제외한 후보 1개 되돌리기' }));
    expect(await screen.findByText('체적')).toBeInTheDocument();
  });

  it('사양서(txt)를 올리면 후보가 더해지고, 출처가 다른 값은 충돌로 표시되며 하나만 확정된다', async () => {
    const user = userEvent.setup();
    renderPage();
    const steps = await openAttributes(user);
    const file = new File(['상부 커버 두께는 3.2 mm 로 한다.'], 'spec.txt', { type: 'text/plain' });
    await user.upload(screen.getByLabelText('사양서 파일'), file);

    expect(await screen.findByText(/spec\.txt: 속성 후보 1개를 찾았어요/)).toBeInTheDocument();
    expect(extract.specCalls[0]).toMatchObject({ text: '상부 커버 두께는 3.2 mm 로 한다.', names: ['하우징', '기판 나사 M3', '상부 커버'] });
    expect(screen.getByRole('status', { name: '속성 후보 요약' })).toHaveTextContent('속성 후보 4개');

    await user.click(within(steps).getByRole('button', { name: /^상부 커버/ }));
    const list = await screen.findByRole('list', { name: '상부 커버 속성 후보' });
    expect(within(list).getAllByText('충돌')).toHaveLength(2);                                      // CAD 3 mm 와 사양서 3.2 mm
    expect(within(list).getByText('사양서')).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: '두께 3 mm 확정' }));
    await user.click(within(list).getByRole('button', { name: '두께 3.2 mm 확정' }));
    expect(within(list).getByRole('button', { name: '두께 3 mm 확정' })).toBeInTheDocument();       // 앞의 확정은 풀린다
    expect(within(list).getByRole('button', { name: '두께 확정 취소' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '속성 후보 요약' })).toHaveTextContent('확정 1개');
  });

  it('PDF 는 값 추출을 아직 지원하지 않는다고 알려 준다', async () => {
    const user = userEvent.setup();
    renderPage();
    await openAttributes(user);
    await user.upload(screen.getByLabelText('사양서 파일'), new File(['%PDF'], 'spec.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText(/PDF에서 속성 값을 뽑는 것은 아직 지원하지 않아요/)).toBeInTheDocument();
    expect(extract.specCalls).toHaveLength(0);
  });

  it('다른 모델을 열면 결정과 사양서 후보를 비운다', async () => {
    const user = userEvent.setup();
    renderPage();
    const steps = await openAttributes(user);
    await user.click(within(steps).getByRole('button', { name: /^상부 커버/ }));
    await user.click(await screen.findByRole('button', { name: '두께 3 mm 확정' }));
    expect(screen.getByRole('status', { name: '속성 후보 요약' })).toHaveTextContent('확정 1개');

    await user.upload(screen.getByLabelText('CAD 파일'), new File(['x'], 'other.step'));
    await waitFor(() => expect(screen.getByRole('status', { name: '속성 후보 요약' })).toHaveTextContent('확정 0개'));
  });
});

describe('conflictKeys', () => {
  const a = (value: string | number, source: 'cad' | 'spec' = 'cad') => ({ key: 'thickness', label: '두께', value, unit: 'mm', source, evidence: '', confidence: 1 });

  it('같은 키에 값이 다르면 충돌이고, 같은 값이거나 제외한 후보만 다르면 아니다', () => {
    const list = [a(3), a(3.2, 'spec')];
    expect([...conflictKeys(list, new Map())]).toEqual(['thickness']);
    expect(conflictKeys([a(3), a(3, 'spec')], new Map()).size).toBe(0);
    const rejected = new Map<string, Decision>([[candidateId(list[1]!), 'rejected']]);
    expect(conflictKeys(list, rejected).size).toBe(0);
  });
});
