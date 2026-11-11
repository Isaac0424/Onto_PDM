// 서버 DB 가 정본, 브라우저는 10분 캐시: 화면에서 보이는 것 (저장 상태 칩 · 캐시 남은 시간 · 자동 재전송 · 보던 상태 복원).
// 서버 DB 는 testServer.ts 의 가짜 fetch 로 흉내 낸다.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyApi } from '../../api/emptyApi';
import { SessionProvider } from '../../session';
import { createCadServer } from './cadServer';
import { CACHE_TTL_MS, readSession, writeSession } from './sessionCache';
import { StudioPage } from './StudioPage';
import { seedCad } from './testSeed';
import { createFakeCadDb, type FakeCadDb } from './testServer';

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
const viewer = vi.hoisted(() => ({ files: [] as string[], steps: [] as number[], picks: [] as string[] }));

vi.mock('explode-studio', () => ({
  mountExplodeStudio: (container: HTMLElement) => {
    const handlers: Record<string, ((d: unknown) => void)[]> = {};
    const emit = (type: string, d: unknown) => (handlers[type] ?? []).forEach(fn => fn(d));
    const root = Object.assign(document.createElement('div'), { innerHTML: '<div class="stage"></div>' });
    container.appendChild(root);
    let name = '';
    return {
      on: (type: string, fn: (d: unknown) => void) => { (handlers[type] ??= []).push(fn); return () => { handlers[type] = (handlers[type] ?? []).filter(f => f !== fn); }; },
      loadFile: async (f: File) => { viewer.files.push(f.name); name = f.name; emit('model', { name, parts: PARTS.length }); },
      replay: () => {}, setSpin: () => {},
      getState: () => ({ model: name, step: 1 }),
      getParts: () => PARTS, getLayers: () => LAYERS, root,
      go: (n: number) => { viewer.steps.push(n); },
      selectPart: (n: string) => { viewer.picks.push(n); const p = PARTS.find(x => x.name === n)!; emit('select', { id: p.id, name: p.name, layer: p.layer }); },
      destroy: () => {},
    };
  },
}));

const MIN = 60_000;
let db: FakeCadDb;

function renderPage() {
  const api = createEmptyApi();
  return render(<SessionProvider api={api}><MemoryRouter><StudioPage /></MemoryRouter></SessionProvider>);
}
/** 창을 닫았다 다시 연 것: 같은 브라우저 저장소(IndexedDB 대신 메모리, localStorage)를 두고 컴포넌트만 새로 만든다 */
function reopen(view: ReturnType<typeof renderPage>) {
  view.unmount();
  return renderPage();
}
const cadFile = (name: string, body = 'solid x') => new File([body], name);
/** 가짜 서버 DB 에 연결한 보관함으로 CAD 를 미리 올려 둔다. agoMin 분 전에 쓴 캐시로 */
const seedOnServer = (name: string, body: string, active: boolean, agoMin: number) =>
  seedCad(name, body, active, { server: createCadServer({ fetchImpl: db.fetch }), now: () => Date.now() - agoMin * MIN });
const activeId = () => JSON.parse(window.localStorage.getItem('onto-pdm.cad.active')!).id as string;

beforeEach(() => {
  viewer.files.length = 0; viewer.steps.length = 0; viewer.picks.length = 0;
  db = createFakeCadDb();
  vi.stubGlobal('fetch', db.fetch);
});
afterEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })); });

describe('저장 상태: 서버 DB 정본 + 브라우저 10분 캐시', () => {
  it('올리면 서버 DB 에 저장되고, 카드에 "서버 DB 저장됨"과 캐시 남은 시간이 보인다', async () => {
    const user = userEvent.setup();
    renderPage();
    const lib = await screen.findByRole('region', { name: '등록한 CAD' });
    await user.upload(screen.getByLabelText('CAD 파일'), cadFile('a.step', 'AAA'));
    const card = await within(lib).findByRole('button', { name: 'a.step 열기' });
    expect(await within(card).findByText('서버 DB 저장됨')).toBeInTheDocument();
    expect(within(card).getByText('캐시 10분 남음')).toBeInTheDocument();
    expect(db.rows.size).toBe(1);
    expect(await screen.findByText(/서버 DB에 저장했어요/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(lib).queryByText(/올린 CAD는 서버 DB에 저장돼요/)).not.toBeInTheDocument();       // 머리 설명 문구는 두지 않는다 (저장 상태는 카드 칩으로 보인다)
  });

  it('서버가 꺼진 동안 올린 CAD 는 "이 브라우저에만"으로 남고, 서버가 돌아오면 자동으로 DB 에 올라간다', async () => {
    db.down = true;
    const user = userEvent.setup();
    renderPage();
    const lib = await screen.findByRole('region', { name: '등록한 CAD' });
    await user.upload(screen.getByLabelText('CAD 파일'), cadFile('a.step', 'AAA'));
    const card = await within(lib).findByRole('button', { name: 'a.step 열기' });
    expect(await within(card).findByText('이 브라우저에만')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('서버에 연결하지 못했습니다');
    expect(within(lib).getByText(/서버에 연결되면 자동으로 올려요 · 대기 1개/)).toBeInTheDocument();
    expect(db.rows.size).toBe(0);

    db.down = false;
    window.dispatchEvent(new Event('online'));                                         // 서버가 돌아왔다 (15초 하트비트로도 같은 일이 일어난다)
    await waitFor(() => expect(db.rows.size).toBe(1));
    expect(await within(card).findByText('서버 DB 저장됨')).toBeInTheDocument();
    expect(within(lib).queryByText(/대기 \d+개/)).not.toBeInTheDocument();
    expect(await screen.findByText(/서버에 연결돼 CAD 1개를 서버 DB에 저장했어요/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();                       // 저장하지 못했다는 경고는 사라진다
  });

  it('화면을 열 때 서버에 못 보낸 CAD 가 있으면 그때 올린다', async () => {
    await seedCad('a.step', 'AAA', true);                                               // 서버가 꺼진 때 올려 둔 것
    renderPage();
    await waitFor(() => expect(db.rows.size).toBe(1));
    expect(await screen.findByText('서버 DB 저장됨')).toBeInTheDocument();
  });

  it('창을 닫고 10분 안에 다시 열면 캐시에서 바로 열리고, 서버에서 내용을 받지 않는다', async () => {
    await seedOnServer('a.step', 'AAA', true, 9);                                        // 9분 전에 쓴 캐시
    renderPage();
    await waitFor(() => expect(viewer.files).toEqual(['a.step']));
    expect(await screen.findByRole('button', { name: 'a.step 열기' })).toHaveAttribute('aria-current', 'true');
    expect(db.count('GET', '/content')).toBe(0);
  });

  it('10분이 지났으면 캐시가 비워져 있고, 마지막 CAD 는 서버 DB 에서 받아 열린다', async () => {
    await seedOnServer('a.step', 'AAA', true, 11);                                       // 11분 전에 쓴 캐시 = 만료
    renderPage();
    await waitFor(() => expect(viewer.files).toEqual(['a.step']));
    expect(db.count('GET', '/content')).toBe(1);
    const card = await screen.findByRole('button', { name: 'a.step 열기' });
    expect(await within(card).findByText('캐시 10분 남음')).toBeInTheDocument();           // 받아서 다시 캐시에 올랐다
  });

  it('목록에서 캐시가 만료된 CAD 는 "서버에서 불러와요"로 보이고, 누르면 서버에서 받아 열린다', async () => {
    const user = userEvent.setup();
    await seedOnServer('old.step', 'OLD', false, 11);                                    // 만료
    await seedOnServer('mid.step', 'MID', false, 4);                                     // 4분 전: 캐시 6분 남음
    await seedOnServer('fresh.step', 'FRESH', true, 3);                                  // 열려 있는 것
    renderPage();
    await waitFor(() => expect(viewer.files).toEqual(['fresh.step']));
    const old = await screen.findByRole('button', { name: 'old.step 열기' });
    expect(within(old).getByText('서버에서 불러와요')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: 'mid.step 열기' })).getByText('캐시 6분 남음')).toBeInTheDocument();
    expect(db.count('GET', '/content')).toBe(0);

    await user.click(old);
    await waitFor(() => expect(viewer.files).toEqual(['fresh.step', 'old.step']));
    expect(db.count('GET', '/content')).toBe(1);
    expect(await screen.findByText(/old\.step을\(를\) 서버 DB에서 받아 열었어요/)).toBeInTheDocument();
  });

  it('서버가 꺼져 있고 캐시도 만료됐으면, 열 수 없는 이유를 알리고 화면은 그대로다', async () => {
    const user = userEvent.setup();
    await seedOnServer('old.step', 'OLD', false, 11);
    await seedOnServer('fresh.step', 'FRESH', true, 1);
    db.down = true;
    renderPage();
    await waitFor(() => expect(viewer.files).toEqual(['fresh.step']));
    await user.click(await screen.findByRole('button', { name: 'old.step 열기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('서버에 연결하지 못했습니다');
    expect(viewer.files).toEqual(['fresh.step']);
    expect(screen.getByRole('button', { name: 'fresh.step 열기' })).toHaveAttribute('aria-current', 'true');
  });

  it('다른 브라우저에서 올린 CAD(서버에만 있음)도 목록에 나오고, 시작할 때 가장 최근 것으로 열린다', async () => {
    await createCadServer({ fetchImpl: db.fetch }).upload(cadFile('remote.step', 'REMOTE'));
    renderPage();
    const card = await screen.findByRole('button', { name: 'remote.step 열기' });
    await waitFor(() => expect(viewer.files).toEqual(['remote.step']));
    expect(db.count('GET', '/content')).toBe(1);
    expect(card).toHaveAttribute('aria-current', 'true');
  });

  it('제거하면 서버 DB 에서도 목록에서 빠진다. 확인창에 그 내용을 알린다', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await seedOnServer('a.step', 'AAA', true, 0);
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'a.step 목록에서 제거' }));
    expect(confirm.mock.calls[0]![0]).toContain('서버 DB의 사본도 목록에서 빠져요');
    expect(confirm.mock.calls[0]![0]).toContain('같은 파일을 다시 올리면 되살아나요');
    await waitFor(() => expect([...db.rows.values()].every(r => r.deleted)).toBe(true));
    expect(await screen.findByText('열어 둔 CAD가 없어요')).toBeInTheDocument();
  });
});

describe('보던 상태(고른 부품 · 단계)는 10분 동안 돌아온다', () => {
  it('부품을 고르면 세션에 적히고, 창을 닫았다 10분 안에 다시 열면 같은 부품이 골라져 있다', async () => {
    const user = userEvent.setup();
    const first = renderPage();
    await user.upload(await screen.findByLabelText('CAD 파일'), cadFile('base.step'));
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await user.click(await within(steps).findByRole('button', { name: /^제어 기판/ }));
    await waitFor(() => expect(readSession()?.partName).toBe('제어 기판'));
    expect(readSession()?.id).toBe(activeId());

    viewer.picks.length = 0; viewer.steps.length = 0;
    reopen(first);
    await waitFor(() => expect(viewer.picks).toEqual(['제어 기판']));                    // 고른 부품이 되살아났다
    expect(await screen.findByRole('complementary', { name: '조립 안내' })).toHaveTextContent('제어 기판');
  });

  it('단계를 보던 중이었으면 그 단계로 돌아간다', async () => {
    await seedCad();
    writeSession({ id: activeId(), step: 4 });
    renderPage();
    await waitFor(() => expect(viewer.steps).toContain(4));
    expect(viewer.picks).toEqual([]);
  });

  it('10분이 지난 세션은 무시한다 (CAD 는 그대로 열리지만 부품은 고르지 않는다)', async () => {
    await seedCad();
    writeSession({ id: activeId(), partName: '제어 기판', step: 3 }, Date.now() - CACHE_TTL_MS - 1000);
    renderPage();
    await waitFor(() => expect(viewer.files).toEqual(['base.step']));
    await screen.findByRole('region', { name: '제조 순서' });
    expect(viewer.picks).toEqual([]);
    expect(viewer.steps).toEqual([]);
  });

  it('다른 CAD 의 세션은 쓰지 않는다', async () => {
    await seedCad();
    writeSession({ id: 'some-other-cad', partName: '제어 기판' });
    renderPage();
    await waitFor(() => expect(viewer.files).toEqual(['base.step']));
    expect(viewer.picks).toEqual([]);
  });
});
