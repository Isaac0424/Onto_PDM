import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyApi } from '../../api/emptyApi';
import type { PdmApi } from '../../api/types';
import { SessionProvider } from '../../session';
import { StudioPage } from './StudioPage';
import { studioTestApi } from './testApi';
import { seedCad } from './testSeed';
import { createFakeCadDb, type FakeCadDb } from './testServer';

// jsdom 에는 WebGL 이 없어 뷰어는 같은 API 모양의 가짜로 바꾼다. 스튜디오는 예시(목업) 모델 없이 시작하므로, 시험은 CAD 를 미리 등록하고 열어 둔 상태에서 시작한다(seedCad).
const PARTS = [
  { id: 0, name: '하우징', path: '본체', layer: 0, ko: '', size: [120, 80, 20] },
  { id: 1, name: '제어 기판', path: '전장', layer: 1, ko: '', size: [96, 60, 1.6] },
  { id: 2, name: '기판 나사 M3', path: '체결', layer: 2, ko: '', size: [3, 3, 8] },
  { id: 3, name: '기판 나사 M3', path: '체결', layer: 2, ko: '', size: [3, 3, 8] },
  { id: 4, name: '전원 버튼', path: '외장', layer: 3, ko: '', size: [10, 10, 4] },
  { id: 5, name: '상부 커버', path: '외장', layer: 4, ko: '', size: [126, 80, 3] },
];
const LAYERS = [
  { index: 0, step: 2, title: '하우징', partIds: [0] },
  { index: 1, step: 3, title: '제어 기판', partIds: [1] },
  { index: 2, step: 4, title: '기판 나사 M3', partIds: [2, 3] },
  { index: 3, step: 5, title: '전원 버튼', partIds: [4] },
  { index: 4, step: 6, title: '상부 커버', partIds: [5] },
];

const studio = vi.hoisted(() => ({ goCalls: [] as number[], calls: [] as string[], last: undefined as undefined | { destroyed: boolean } }));

vi.mock('explode-studio', () => ({
  mountExplodeStudio: (container: HTMLElement) => {
    const handlers: Record<string, ((d: unknown) => void)[]> = {};
    const emit = (type: string, d: unknown) => (handlers[type] ?? []).forEach(fn => fn(d));
    const state = { destroyed: false };
    let model = '';
    const root = Object.assign(document.createElement('div'), { innerHTML: '<div class="stage"></div>' });   // 실제 뷰어처럼 컨테이너 안에 붙인다
    container.appendChild(root);
    studio.last = state;
    return {
      on: (type: string, fn: (d: unknown) => void) => { (handlers[type] ??= []).push(fn); return () => { handlers[type] = (handlers[type] ?? []).filter(f => f !== fn); }; },
      loadFile: async (f: File) => { model = f.name; emit('model', { name: model, parts: PARTS.length }); },
      replay: () => { studio.calls.push('replay'); },
      setSpin: (on: boolean) => { studio.calls.push(`spin:${on}`); },
      getState: () => ({ model, step: 1 }),
      getParts: () => PARTS,
      getLayers: () => LAYERS,
      root,
      go: (n: number) => { studio.goCalls.push(n); emit('step', { step: n, layer: n - 2 }); },
      selectPart: (key: string | number) => { const p = PARTS.find(x => typeof key === 'number' ? x.id === key : x.name === key)!; emit('select', { id: p.id, name: p.name, layer: p.layer }); },
      destroy: () => { state.destroyed = true; },
    };
  },
}));

/** 기본은 시험용 답이 들어 있는 API(studioTestApi). 아무것도 연결되지 않은 모습은 createEmptyApi() 를 넘겨 본다 */
async function renderPage(api: PdmApi = studioTestApi()) {
  await seedCad();                                                    // 보관함에 CAD 하나 + 마지막에 열어 둔 CAD 로 기록
  const view = render(
    <SessionProvider api={api}>
      <MemoryRouter><StudioPage /></MemoryRouter>
    </SessionProvider>,
  );
  return { api, ...view };
}

beforeEach(() => { studio.goCalls.length = 0; studio.calls.length = 0; });

describe('CAD 스튜디오 (메인 화면)', () => {
  it('제조 순서를 단계별로 나누고 부품마다 보유 품번 매칭을 보인다', async () => {
    await renderPage();
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());

    expect(within(steps).getByText('CAD 구조에서 나눈 5단계 · 부품 5종')).toBeInTheDocument();
    expect(within(steps).getByText('P-T0000000160', { selector: '.chip-ok' })).toBeInTheDocument();   // 전원 버튼: 이름이 정확히 같아 확정
    expect(within(steps).getByText('후보 P-T0000000001')).toBeInTheDocument();                       // 기판 나사 M3: CAD 이름 별칭 → 후보
    expect(within(steps).getByText('×2')).toBeInTheDocument();                                       // 같은 이름의 두 개는 한 줄로
    expect(within(steps).getByText('분류 커버')).toBeInTheDocument();                                 // 미보유: 추정 분류
    expect(within(steps).getByText('미보유', { selector: '.chip-none' })).toBeInTheDocument();         // 미보유: 분류도 없음(제어 기판)
    expect(within(steps).getByRole('group', { name: '보유 품번 매칭 현황' })).toHaveTextContent('보유 1후보 2미보유 2');
  });

  it('단계를 누르면 뷰어가 그 단계로 간다', async () => {
    const user = userEvent.setup();
    await renderPage();
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await user.click(within(steps).getByRole('button', { name: /^3\s*기판 나사 M3/ }));
    expect(studio.goCalls).toEqual([4]);
    expect(within(steps).getByRole('button', { name: /^3\s*기판 나사 M3/ })).toHaveAttribute('aria-current', 'step');
  });

  it('고르지 않으면 모델 전체의 분류 그래프, 보유 부품을 고르면 그 부품의 온톨로지가 보인다', async () => {
    const user = userEvent.setup();
    await renderPage();
    const onto = await screen.findByRole('region', { name: '온톨로지' });
    expect(await within(onto).findByRole('img', { name: 'base.step 온톨로지 그래프' })).toBeInTheDocument();

    const steps = screen.getByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());
    await user.click(within(steps).getByRole('button', { name: /^전원 버튼\s*P-T0000000160/ }));

    expect(await within(onto).findByRole('img', { name: '전원 버튼 온톨로지 그래프' })).toBeInTheDocument();
    expect(await within(onto).findByText('전기 · 전자 › 스위치 · 버튼')).toBeInTheDocument();      // 분류 사슬
    expect(within(onto).getAllByText('정격 12V 50mA').length).toBeGreaterThan(0);                    // 속성이 그래프 노드로
    expect(within(onto).queryByRole('link', { name: '품목 상세' })).not.toBeInTheDocument();           // 품목 화면은 삭제됨
  });

  it('미보유 부품에도 OPMS 등록 요청 버튼은 없다 (등록 요청은 삭제됨, 사용자 지시)', async () => {
    const user = userEvent.setup();
    await renderPage();
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());

    await user.click(within(steps).getByRole('button', { name: /^제어 기판/ }));
    const onto = screen.getByRole('region', { name: '온톨로지' });
    expect(within(onto).getByText('분류 없음 · OPMS 분류 제안 필요')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /OPMS (에 )?등록 요청/ })).not.toBeInTheDocument();
    expect(within(steps).getByRole('group', { name: '보유 품번 매칭 현황' })).toHaveTextContent('미보유 2');
  });

  it('후보 품번은 사람이 확정해야 보유로 바뀐다', async () => {
    const user = userEvent.setup();
    await renderPage();
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());

    await user.click(within(steps).getByRole('button', { name: /^기판 나사 M3\s*×2/ }));
    await user.click(await screen.findByRole('button', { name: '이 품번으로 확정' }));
    expect(await within(steps).findByText('P-T0000000001', { selector: '.chip-ok' })).toBeInTheDocument();
  });

  describe('서버 DB', () => {
    // CAD 는 서버 DB(/api/cads)에 저장된다. 사양서 · BOM 올리기는 없다(삭제됨, 사용자 지시)
    let db: FakeCadDb;
    beforeEach(() => {
      db = createFakeCadDb();
      vi.stubGlobal('fetch', db.fetch);
    });
    afterEach(() => { vi.unstubAllGlobals(); });
    /** 마지막에 열어 둔 CAD 가 열릴 때까지 기다린다 (열리면 화면이 안내를 비우므로, 그 뒤에 올려야 안내가 남는다) */
    const opened = () => screen.findByText('base.step', { selector: '.holo-model' });

    it('CAD 는 서버 DB 로 올라가고, 사양서 · BOM 으로는 아무것도 보내지 않는다', async () => {
      const user = userEvent.setup();
      await renderPage();
      await opened();
      await user.upload(screen.getByLabelText('CAD 파일'), new File(['solid'], '브래킷.step'));

      await waitFor(() => expect(db.urls).toContain(`POST /api/cads?name=${encodeURIComponent('브래킷.step')}`));
      expect(db.urls.some(u => u.startsWith('POST /api/files'))).toBe(false);                 // 파일 보관소(/api/files)로는 올리지 않는다
      expect(db.rows.size).toBeGreaterThanOrEqual(1);
    });

    it('서버가 꺼져 있어도 화면에서는 열리고, 저장 실패를 알려준다', async () => {
      db.down = true;
      const user = userEvent.setup();
      await renderPage();
      await opened();
      await user.upload(screen.getByLabelText('CAD 파일'), new File(['solid'], 'a.step'));
      expect(await screen.findByRole('alert')).toHaveTextContent('서버에 연결하지 못했습니다');
      expect(screen.getByRole('region', { name: '제조 순서' })).toBeInTheDocument();
    });
  });

  it('부품을 고르면 3D 위에 그 부품의 조립 규칙 카드와 자막이 겹쳐 뜬다', async () => {
    const user = userEvent.setup();
    await renderPage();
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());
    expect(await screen.findByRole('status', { name: /단계나 부품을 고르면/ })).toBeInTheDocument();     // 고르기 전: 안내 자막

    await user.click(within(steps).getByRole('button', { name: /^제어 기판/ }));
    const card = await screen.findByRole('complementary', { name: '조립 안내' });
    expect(within(card).getByText('STEP 2 / 5')).toBeInTheDocument();
    expect(within(card).getByText('장착')).toBeInTheDocument();
    expect(within(card).getByText('왼쪽 (−X)')).toBeInTheDocument();                                    // 입력 포트 위치
    expect(within(card).getByRole('list', { name: '주의사항' })).toHaveTextContent('정전기 방지 손목 스트랩');
    expect(within(card).getByText('SP-ELC-01 · 제어 기판 장착')).toBeInTheDocument();
    expect(await screen.findByRole('status', { name: '입력 포트가 왼쪽, 출력 포트가 오른쪽으로 오도록 놓습니다.' })).toBeInTheDocument();

    await user.click(within(steps).getByRole('button', { name: /^상부 커버/ }));                         // 두께 3 mm → 필요한 나사 길이
    expect(await within(await screen.findByRole('complementary', { name: '조립 안내' })).findByText('≥ 7.5 mm (두께 + 1.5 × 지름)')).toBeInTheDocument();
  });

  it('규칙이 없는 부품은 없다고 말하고, 카드는 접을 수 있다', async () => {
    const user = userEvent.setup();
    await renderPage();                                        // 시험용 API 에는 하우징에 걸리는 규칙이 없다
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());

    await user.click(within(steps).getByRole('button', { name: /^하우징후보/ }));
    const card = await screen.findByRole('complementary', { name: '조립 안내' });
    expect(within(card).getByText('연결된 규칙 없음')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: '안내 접기' }));
    expect(within(card).queryByText('연결된 규칙 없음')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '안내 펼치기' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('CAD 를 올리면 자동 회전을 켜고 처음부터 재생한다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByRole('region', { name: '제조 순서' });
    expect(studio.calls).toEqual([]);                                  // 열어 둔 CAD 를 다시 열 때는 재생하지 않는다 (올릴 때만 시작한다)
    await user.upload(screen.getByLabelText('CAD 파일'), new File(['solid'], 'a.step'));
    await waitFor(() => expect(studio.calls).toEqual(['spin:true', 'replay']));
  });

  it('화면을 떠나면 뷰어를 정리한다', async () => {
    const { unmount } = await renderPage();
    await screen.findByRole('region', { name: '제조 순서' });
    unmount();
    expect(studio.last?.destroyed).toBe(true);
  });
});

describe('CAD 스튜디오: 보유 품번 · 규칙 · 온톨로지를 읽어 올 곳(OPMS)이 없을 때', () => {
  // 기본 API 는 비어 있다(가짜 데이터 없음). 화면은 "없음"이 아니라 "OPMS 에 연결되면 표시돼요"라고 말하고, CAD 에서 계산하는 것은 그대로 보인다.
  it('제조 순서는 CAD 구조 그대로 보이고, 매칭 칩 대신 연결 안내가 나온다 (보유 · 후보 · 미보유 숫자를 지어내지 않는다)', async () => {
    await renderPage(createEmptyApi());
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    expect(within(steps).getByText('CAD 구조에서 나눈 5단계 · 부품 5종')).toBeInTheDocument();
    expect(within(steps).getByRole('note')).toHaveTextContent('보유 품번 매칭은 OPMS에 연결되면 표시돼요.');
    expect(within(steps).queryByRole('group', { name: '보유 품번 매칭 현황' })).not.toBeInTheDocument();
    expect(within(steps).queryByText('미보유')).not.toBeInTheDocument();
    expect(within(steps).queryByText(/매칭 중…/)).not.toBeInTheDocument();
    expect(within(steps).getByRole('button', { name: /^하우징/ })).toBeInTheDocument();
  });

  it('온톨로지 패널은 그래프 대신 연결 안내를 보인다 (오류가 아니다)', async () => {
    const user = userEvent.setup();
    await renderPage(createEmptyApi());
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await user.click(within(steps).getByRole('button', { name: /^전원 버튼/ }));
    const onto = screen.getByRole('region', { name: '온톨로지' });
    const note = within(onto).getByRole('status', { name: 'OPMS 연결 안내' });
    expect(note).toHaveTextContent('온톨로지를 읽을 곳이 없어요');
    expect(note).toHaveTextContent('속성 탭');
    expect(within(onto).queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('부품을 고르면 3D 위 카드는 "연결된 규칙 없음"이 아니라 OPMS 에 연결되면 표시된다고 말한다', async () => {
    const user = userEvent.setup();
    await renderPage(createEmptyApi());
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    expect(await screen.findByRole('status', { name: /조립 규칙은 OPMS에 연결되면/ })).toBeInTheDocument();    // 고르기 전 자막
    await user.click(within(steps).getByRole('button', { name: /^제어 기판/ }));
    const card = await screen.findByRole('complementary', { name: '조립 안내' });
    expect(within(card).getByText('OPMS에 연결되면 표시돼요')).toBeInTheDocument();
    expect(within(card).queryByText('연결된 규칙 없음')).not.toBeInTheDocument();
    expect(await screen.findByRole('status', { name: '제어 기판: 조립 규칙은 OPMS에 연결되면 이 위에 표시돼요.' })).toBeInTheDocument();
  });

  it('CAD 에서 계산하는 속성 후보는 연결과 상관없이 나온다', async () => {
    const user = userEvent.setup();
    await renderPage(createEmptyApi());
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await user.click(screen.getByRole('tab', { name: /^속성/ }));
    await user.click(within(steps).getByRole('button', { name: /^상부 커버/ }));
    const list = await screen.findByRole('list', { name: '상부 커버 속성 후보' });
    expect(within(list).getByText('두께')).toBeInTheDocument();                                      // 크기 3 mm 에서 계산한 값
  });

  it('머리에 CAD 올리기만 있고 사양서 올리기 · BOM 올리기는 없다', async () => {
    await renderPage(createEmptyApi());
    await screen.findByRole('region', { name: '제조 순서' });
    expect(screen.getByRole('button', { name: /CAD 올리기/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /사양서 올리기/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /BOM 올리기/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('사양서 파일')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('BOM 파일')).not.toBeInTheDocument();
    expect(screen.getByLabelText('CAD 파일')).toBeInTheDocument();
  });
});
