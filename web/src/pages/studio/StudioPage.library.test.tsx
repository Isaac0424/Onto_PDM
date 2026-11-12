import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../../session';
import { writeActive } from './cadLibrary';
import { StudioPage } from './StudioPage';
import { studioTestApi } from './testApi';
import { seedCad } from './testSeed';

// StudioPage.test.tsx 와 같은 가짜 뷰어. 어떤 파일을 열었는지 기록한다.
const PARTS = [
  { id: 0, name: '하우징', path: '본체', layer: 0, ko: '', size: [120, 80, 20] },
  { id: 1, name: '제어 기판', path: '전장', layer: 1, ko: '', size: [96, 60, 1.6] },
  { id: 2, name: '기판 나사 M3', path: '체결', layer: 2, ko: '', size: [3, 3, 8] },
];
const LAYERS = [
  { index: 0, step: 2, title: '하우징', partIds: [0] },
  { index: 1, step: 3, title: '제어 기판', partIds: [1] },
  { index: 2, step: 4, title: '기판 나사 M3', partIds: [2] },
];
const viewer = vi.hoisted(() => ({ files: [] as string[], mounts: 0, steps: [] as number[], picks: [] as string[] }));

vi.mock('explode-studio', () => ({
  mountExplodeStudio: (container: HTMLElement) => {
    const handlers: Record<string, ((d: unknown) => void)[]> = {};
    const emit = (type: string, d: unknown) => (handlers[type] ?? []).forEach(fn => fn(d));
    const root = Object.assign(document.createElement('div'), { innerHTML: '<div class="stage"></div>' });
    container.appendChild(root);
    viewer.mounts += 1;                                  // 뷰어가 새로 만들어진 횟수
    let name = '';
    return {
      on: (type: string, fn: (d: unknown) => void) => { (handlers[type] ??= []).push(fn); return () => { handlers[type] = (handlers[type] ?? []).filter(f => f !== fn); }; },
      loadFile: async (f: File) => { viewer.files.push(f.name); name = f.name; emit('model', { name, parts: PARTS.length }); },
      replay: () => {}, setSpin: () => {},
      getState: () => ({ model: name, step: 1 }),
      getParts: () => PARTS, getLayers: () => LAYERS, root,
      go: (n: number) => { viewer.steps.push(n); },
      selectPart: (key: string | number) => { const p = PARTS.find(x => typeof key === 'number' ? x.id === key : x.name === key)!; viewer.picks.push(p.name); emit('select', { id: p.id, name: p.name, layer: p.layer }); },
      destroy: () => {},
    };
  },
}));

const fetchMock = vi.fn();
function renderPage() {
  const api = studioTestApi();
  return render(<SessionProvider api={api}><MemoryRouter><StudioPage /></MemoryRouter></SessionProvider>);
}
/** 화면을 떠났다가 돌아온 것: 같은 브라우저 저장소(IndexedDB 대신 메모리, localStorage)를 두고 컴포넌트만 새로 만든다 */
async function leaveAndReturn(view: ReturnType<typeof renderPage>) {
  view.unmount();
  return renderPage();
}

const cadFile = (name: string, body = 'solid x') => new File([body], name);

beforeEach(() => {
  viewer.files.length = 0; viewer.mounts = 0; viewer.steps.length = 0; viewer.picks.length = 0;
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));            // 서버(DB · 보관소)는 꺼져 있다
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })); });

describe('등록한 CAD 목록 (화면을 옮겨도 유지)', () => {   // 서버가 꺼져 있어도 이 브라우저에는 남는다
  it('처음에는 목록이 비어 있고, CAD 를 올리면 목록에 올라 열린다', async () => {
    const user = userEvent.setup();
    renderPage();
    const lib = await screen.findByRole('region', { name: '등록한 CAD' });
    expect(within(lib).getByText(/아직 등록한 CAD가 없어요/)).toBeInTheDocument();

    await user.upload(screen.getByLabelText('CAD 파일'), cadFile('base.step'));
    const card = await within(lib).findByRole('button', { name: 'base.step 열기' });
    expect(card).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(viewer.files).toEqual(['base.step']));
    expect(await within(lib).findByText(/부품 3개 · 3단계/)).toBeInTheDocument();      // 분석이 끝나면 목록에 부품 · 단계 수가 남는다
  });

  it('화면을 떠났다 돌아와도 목록이 남고, 보던 CAD 가 그대로 다시 열린다', async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await user.upload(await screen.findByLabelText('CAD 파일'), cadFile('base.step'));
    await within(screen.getByRole('region', { name: '등록한 CAD' })).findByRole('button', { name: 'base.step 열기' });
    await waitFor(() => expect(viewer.files).toEqual(['base.step']));

    viewer.files.length = 0;
    await leaveAndReturn(first);
    const lib = await screen.findByRole('region', { name: '등록한 CAD' });
    const card = await within(lib).findByRole('button', { name: 'base.step 열기' });
    expect(card).toHaveAttribute('aria-current', 'true');                            // 보던 CAD 가 열려 있다
    await waitFor(() => expect(viewer.files).toEqual(['base.step']));                // 같은 파일을 다시 열었다
    expect(screen.queryByText('열어 둔 CAD가 없어요')).not.toBeInTheDocument();         // 빈 화면으로 돌아가지 않는다
  });

  it('여러 개를 등록하면 모두 남고, 눌러서 바꿔 열 수 있다', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(await screen.findByLabelText('CAD 파일'), cadFile('a.step', 'AAA'));
    await user.upload(screen.getByLabelText('CAD 파일'), cadFile('b.step', 'BBB'));
    const lib = screen.getByRole('region', { name: '등록한 CAD' });
    await within(lib).findByRole('button', { name: 'b.step 열기' });
    expect(within(lib).getByRole('button', { name: 'a.step 열기' })).toBeInTheDocument();

    viewer.files.length = 0;
    await user.click(within(lib).getByRole('button', { name: 'a.step 열기' }));
    await waitFor(() => expect(viewer.files).toEqual(['a.step']));
    expect(within(lib).getByRole('button', { name: 'a.step 열기' })).toHaveAttribute('aria-current', 'true');
    expect(within(lib).getByRole('button', { name: 'b.step 열기' })).not.toHaveAttribute('aria-current');
  });

  it('같은 파일을 다시 올리면 새로 만들지 않고 안내한다', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(await screen.findByLabelText('CAD 파일'), cadFile('a.step', 'SAME'));
    await screen.findByRole('button', { name: 'a.step 열기' });
    await user.upload(screen.getByLabelText('CAD 파일'), cadFile('a-copy.step', 'SAME'));
    expect(await screen.findByText(/이미 등록된 CAD예요/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '등록한 CAD' })).getAllByRole('button', { name: /열기$/ })).toHaveLength(1);
  });

  it('서버가 꺼져 있어도 등록되고, DB 에 저장하지 못한 사실은 경고와 카드 상태로 알린다', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(await screen.findByLabelText('CAD 파일'), cadFile('a.step'));
    expect(await screen.findByRole('button', { name: 'a.step 열기' })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('서버에 연결하지 못했습니다');
    expect(await screen.findByText('이 브라우저에만')).toBeInTheDocument();
    expect(screen.getAllByText(/서버에 연결되면 자동으로 올려요/).length).toBeGreaterThan(0);
    expect(screen.getByText(/서버가 꺼져 있어 이 브라우저에만 보관했어요/)).toBeInTheDocument();
  });

  it('하나뿐인 CAD 를 목록에서 제거하면 빈 화면이 되고, 화면을 옮겼다 돌아와도 되살아나지 않는다', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const first = renderPage();
    await user.upload(await screen.findByLabelText('CAD 파일'), cadFile('a.step'));
    const lib = screen.getByRole('region', { name: '등록한 CAD' });
    await within(lib).findByRole('button', { name: 'a.step 열기' });
    await waitFor(() => expect(viewer.mounts).toBe(1));

    await user.click(within(lib).getByRole('button', { name: 'a.step 목록에서 제거' }));
    await waitFor(() => expect(within(lib).queryByRole('button', { name: 'a.step 열기' })).not.toBeInTheDocument());
    expect(await screen.findByText('열어 둔 CAD가 없어요')).toBeInTheDocument();
    expect(viewer.mounts).toBe(2);                                                    // 열려 있던 모델을 비우려고 뷰어를 다시 만들었다

    await leaveAndReturn(first);
    expect(await screen.findByText('열어 둔 CAD가 없어요')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '등록한 CAD' })).queryByRole('button', { name: 'a.step 열기' })).not.toBeInTheDocument();
  });

  it('제거를 취소하면 그대로 둔다', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await user.upload(await screen.findByLabelText('CAD 파일'), cadFile('a.step'));
    const lib = screen.getByRole('region', { name: '등록한 CAD' });
    await within(lib).findByRole('button', { name: 'a.step 열기' });
    await user.click(within(lib).getByRole('button', { name: 'a.step 목록에서 제거' }));
    expect(within(lib).getByRole('button', { name: 'a.step 열기' })).toBeInTheDocument();
  });

  it('예시(목업) 모델 선택 버튼은 없다', async () => {
    renderPage();
    await screen.findByRole('region', { name: '등록한 CAD' });
    expect(screen.queryByRole('group', { name: '예시 모델' })).not.toBeInTheDocument();
    for (const name of ['전자기기', '손목시계']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('CAD 에서 사람이 확정한 것(후보 품번)도 화면을 옮겼다 돌아오면 남아 있다', async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await user.upload(await screen.findByLabelText('CAD 파일'), cadFile('base.step'));
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());
    await user.click(within(steps).getByRole('button', { name: /^기판 나사 M3/ }));
    await user.click(await screen.findByRole('button', { name: '이 품번으로 확정' }));
    expect(await within(steps).findByText('P-T0000000001', { selector: '.chip-ok' })).toBeInTheDocument();

    await leaveAndReturn(first);
    const again = await screen.findByRole('region', { name: '제조 순서' });
    expect(await within(again).findByText('P-T0000000001', { selector: '.chip-ok' })).toBeInTheDocument();   // 후보가 아니라 확정된 채로
    expect(within(again).queryByText('후보 P-T0000000001')).not.toBeInTheDocument();
  });

  it('CAD 마다 확정한 것이 따로 기억된다 (다른 CAD 로 바꾸면 거기엔 없다)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.upload(await screen.findByLabelText('CAD 파일'), cadFile('a.step', 'AAA'));
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());
    await user.click(within(steps).getByRole('button', { name: /^기판 나사 M3/ }));
    await user.click(await screen.findByRole('button', { name: '이 품번으로 확정' }));
    await within(steps).findByText('P-T0000000001', { selector: '.chip-ok' });

    await user.upload(screen.getByLabelText('CAD 파일'), cadFile('b.step', 'BBB'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'b.step 열기' })).toHaveAttribute('aria-current', 'true'));
    await waitFor(() => expect(within(steps).getByText('후보 P-T0000000001')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'a.step 열기' }));                  // 돌아가면 a 의 확정이 되살아난다
    expect(await within(steps).findByText('P-T0000000001', { selector: '.chip-ok' })).toBeInTheDocument();
  });
});

describe('보관소에서 가져오기', () => {
  it('서버에만 있는 CAD 를 목록으로 가져온다', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/files') return new Response(JSON.stringify([{ sha256: 'd'.repeat(64), name: 'remote.step', size: 2048, format: 'step', kind: 'cad' }]), { status: 200 });
      if (url.endsWith('/content')) return new Response('REMOTE', { status: 200 });
      throw new TypeError('Failed to fetch');
    });
    renderPage();
    const lib = await screen.findByRole('region', { name: '등록한 CAD' });
    await user.click(within(lib).getByRole('button', { name: '보관소에서 가져오기' }));
    const vault = await within(lib).findByRole('region', { name: '보관소의 CAD' });
    await user.click(within(vault).getByRole('button', { name: 'remote.step 가져오기' }));

    expect(await within(lib).findByRole('button', { name: 'remote.step 열기' })).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(viewer.files).toEqual(['remote.step']));
  });

  it('서버가 꺼져 있으면 이유를 보이고, 평소에는 보관소를 부르지 않는다 (서버 DB 목록만 본다)', async () => {
    const user = userEvent.setup();
    renderPage();
    const lib = await screen.findByRole('region', { name: '등록한 CAD' });
    expect(fetchMock.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/files'))).toEqual([]);   // 화면을 열 때는 보관소를 부르지 않는다
    await waitFor(() => expect(fetchMock.mock.calls.some(c => c[0] === '/api/cads')).toBe(true));              // 서버 DB 목록은 본다
    await user.click(within(lib).getByRole('button', { name: '보관소에서 가져오기' }));
    expect(await within(lib).findByRole('alert')).toHaveTextContent('보관소 서버에 연결하지 못했어요');
  });
});

describe('시작할 때 무엇을 여는가 (예시 모델 없이)', () => {
  const later = () => new Promise(r => setTimeout(r, 5));                   // 올린 시각이 서로 다르게

  it('등록한 CAD 가 하나도 없으면 빈 안내만 보이고, 제조 순서와 조립 안내는 비어 있다', async () => {
    renderPage();
    expect(await screen.findByText('열어 둔 CAD가 없어요')).toBeInTheDocument();
    expect(viewer.files).toEqual([]);                                          // 아무것도 열지 않았다
    const steps = screen.getByRole('region', { name: '제조 순서' });
    expect(within(steps).getByText('CAD 파일을 올리면 제조 순서가 나옵니다.')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /단계나 부품을 고르면/ })).not.toBeInTheDocument();   // 조립 안내 자막도 없다
    expect(screen.getAllByRole('button', { name: 'CAD 올리기' })).toHaveLength(2);                    // 머리와 안내 안, 둘 다 올릴 수 있다
    expect(screen.getByText('CAD 없음')).toBeInTheDocument();
  });

  it('안내 안의 CAD 올리기 버튼은 파일 선택을 연다', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('열어 둔 CAD가 없어요');
    const input = screen.getByLabelText('CAD 파일') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    await user.click(within(screen.getByRole('status')).getByRole('button', { name: 'CAD 올리기' }));
    expect(click).toHaveBeenCalled();
  });

  it('마지막에 작업하던 CAD 가 있으면, 더 최근에 올린 것이 있어도 그것이 열린다', async () => {
    await seedCad('old.step', 'OLD', true);                                    // 마지막에 작업하던 것
    await later();
    await seedCad('new.step', 'NEW', false);                                   // 더 최근에 올렸지만 작업하던 것은 아니다
    renderPage();
    await waitFor(() => expect(viewer.files).toEqual(['old.step']));
    expect(await screen.findByRole('button', { name: 'old.step 열기' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'new.step 열기' })).not.toHaveAttribute('aria-current');
    expect(screen.queryByText('열어 둔 CAD가 없어요')).not.toBeInTheDocument();
  });

  it('작업하던 기록이 없으면 가장 최근에 올린 CAD 가 열린다', async () => {
    await seedCad('old.step', 'OLD', false);
    await later();
    await seedCad('new.step', 'NEW', false);
    renderPage();
    await waitFor(() => expect(viewer.files).toEqual(['new.step']));
    expect(await screen.findByRole('button', { name: 'new.step 열기' })).toHaveAttribute('aria-current', 'true');
    expect(window.localStorage.getItem('onto-pdm.cad.active')).toContain('"kind":"cad"');   // 이제 이것이 마지막에 작업하던 CAD 다
  });

  it('작업하던 CAD 를 열 수 없으면(보관함에 없으면) 가장 최근 것으로 넘어간다', async () => {
    await seedCad('only.step', 'ONLY', false);
    writeActive({ kind: 'cad', id: 'no-such-cad' });
    renderPage();
    await waitFor(() => expect(viewer.files).toEqual(['only.step']));
    expect(await screen.findByRole('button', { name: 'only.step 열기' })).toHaveAttribute('aria-current', 'true');
  });

  it('열려 있던 CAD 를 제거하면 남은 것 중 가장 최근 것이 열리고, 다 지우면 빈 안내가 보인다', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await seedCad('a.step', 'AAA', false);
    await later();
    await seedCad('b.step', 'BBB', true);
    renderPage();
    const lib = await screen.findByRole('region', { name: '등록한 CAD' });
    await waitFor(() => expect(viewer.files).toEqual(['b.step']));
    expect(viewer.mounts).toBe(1);

    await user.click(await within(lib).findByRole('button', { name: 'b.step 목록에서 제거' }));
    await waitFor(() => expect(within(lib).queryByRole('button', { name: 'b.step 열기' })).not.toBeInTheDocument());
    await waitFor(() => expect(viewer.files).toEqual(['b.step', 'a.step']));        // 남은 것으로 이어진다
    expect(viewer.mounts).toBe(2);                                                  // 뷰어를 새로 만들어 이전 모델을 비웠다
    expect(await within(lib).findByRole('button', { name: 'a.step 열기' })).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByText('열어 둔 CAD가 없어요')).not.toBeInTheDocument();

    await user.click(within(lib).getByRole('button', { name: 'a.step 목록에서 제거' }));
    expect(await screen.findByText('열어 둔 CAD가 없어요')).toBeInTheDocument();
    expect(viewer.mounts).toBe(3);
    expect(viewer.files).toEqual(['b.step', 'a.step']);                              // 더 열린 것은 없다
  });
});
