import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AssemblyGuide, AssemblyPartInput } from '../../api/types';
import { createMockApi } from '../../api/mock/mockApi';
import { SessionProvider } from '../../session';
import { ProductListPage } from '../ProductListPage';
import { ProductGraphPage } from './ProductGraphPage';

// jsdom 에는 WebGL 이 없어 Graph3D 는 목록 보기로 물러난다. 그래서 이 시험은 목록 보기(키보드로 읽는 쪽)를 실제 컴포넌트로 확인한다.
function renderAt(path: string, session = { userId: 1, adminMode: true }, prepare?: (api: ReturnType<typeof createMockApi>) => void) {
  window.localStorage.setItem('onto-pdm-session', JSON.stringify(session));
  const api = createMockApi(() => JSON.parse(window.localStorage.getItem('onto-pdm-session')!));
  prepare?.(api);
  render(
    <SessionProvider api={api}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/products" element={<ProductListPage />} />
          <Route path="/products/:code" element={<ProductGraphPage />} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
  return api;
}

const LIST = '협동로봇 3 kg 연결 목록';
const listOf = async () => screen.findByRole('group', { name: LIST });
/** 목록에서 이름이 같은 줄이 여럿(위에서 이미 펼친 줄 표시)이면 첫 줄 */
const rowText = (root: HTMLElement, name: string) => within(root).getAllByText(name)[0]!;

describe('제품 연결 그래프 화면', () => {
  it('머리에 제품 · 최상위 조립품 · 요약을 보인다 (승인본 기준, HCR3A)', async () => {
    renderAt('/products/HCR3A');
    expect(await screen.findByRole('heading', { level: 1, name: '협동로봇 3 kg' })).toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 1 }).parentElement!;                // 머리의 최상위 조립품 링크 (묶음 패널에도 같은 링크가 있다)
    expect(within(heading).getByText('P-00000000100')).toBeInTheDocument();

    const chips = await screen.findByRole('group', { name: '요약' });
    expect(within(chips).getByText('부품 10종')).toBeInTheDocument();
    expect(within(chips).getByText('조립품 4개')).toBeInTheDocument();
    expect(within(chips).getByText('승인 14')).toBeInTheDocument();
    expect(within(chips).getByText('작업중 · 검토중 0')).toBeInTheDocument();
    expect(within(chips).getByText('폐기 0')).toBeInTheDocument();
    expect(within(chips).getByText(/조립 규칙 연결 7/)).toBeInTheDocument();          // 하우징 2 · 커버 · 감속기 2 · 모터 · M3 볼트
  });

  it('3D 를 못 쓰면 안내하고 목록으로 보여 준다. 목록은 제품 → 조립품 → 부품 순으로 중첩된다', async () => {
    renderAt('/products/HCR3A');
    expect(await screen.findByRole('status')).toHaveTextContent('이 환경에서는 3D를 쓸 수 없어 목록으로 보여 드립니다');
    expect(within(screen.getByRole('group', { name: '보기' })).getByRole('button', { name: /3D/ })).toBeDisabled();

    const list = await listOf();
    const li = (name: string) => rowText(list, name).closest('li')!;
    expect(within(li('협동로봇 3 kg')).getByText('HCR3A 본체')).toBeInTheDocument();          // 제품 아래 최상위 조립품
    expect(within(li('HCR3A 본체')).getByText('J1 관절 모듈')).toBeInTheDocument();
    expect(within(li('J1 관절 모듈')).getByText('J1 감속기')).toBeInTheDocument();             // 조립품 아래 부품
    expect(within(li('J1 관절 모듈')).queryByText('J2 감속기')).not.toBeInTheDocument();        // 다른 조립품의 부품은 아니다
    expect(within(li('협동로봇 3 kg')).getByText('케이블 하네스')).toBeInTheDocument();
  });

  it('노드를 고르면 묶음 패널에 품번 · 분류 · 문서 · 사용처 · 조립 규칙이 나온다', async () => {
    const user = userEvent.setup();
    renderAt('/products/HCR3A');
    const list = await listOf();
    await user.click(rowText(list, 'J1 감속기'));

    const panel = screen.getByRole('complementary', { name: '묶음' });
    expect(await within(panel).findByText('P-00000000121')).toBeInTheDocument();
    expect(within(panel).getByText('구매품')).toBeInTheDocument();
    expect(within(panel).getByText('동력 전달 › 감속기')).toBeInTheDocument();               // 분류 사슬
    expect(within(panel).getByText('J1 관절 모듈', { selector: 'dd' })).toBeInTheDocument();    // 사용처

    const spec = within(panel).getByRole('region', { name: '사양서 1건' });                   // 문서는 종류별로 묶는다
    expect(within(spec).getByText('D-SPEC-HCR')).toBeInTheDocument();
    const manual = within(panel).getByRole('region', { name: '설명서 1건' });
    expect(within(manual).getByText('제안')).toBeInTheDocument();                              // 확정 전 연결은 제안으로 표시

    expect(within(panel).getByRole('link', { name: 'SP-RED-01' })).toHaveAttribute('href', '/rules/SP-RED-01');
    expect(within(panel).queryByRole('link', { name: '품목 상세' })).not.toBeInTheDocument();     // 품목 화면은 삭제됨

    await user.click(within(panel).getByRole('button', { name: '선택 해제' }));
    expect(screen.getByRole('complementary', { name: '묶음' })).toHaveTextContent('제품 묶음');
  });

  it('여러 조립품에 쓰이는 품목은 노드 하나이고, 루트 1개당 총수량은 모두 더한다', async () => {
    const user = userEvent.setup();
    renderAt('/products/HCR3A');
    const list = await listOf();
    await user.click(rowText(list, '볼트 M3x8'));
    const panel = screen.getByRole('complementary', { name: '묶음' });
    expect(await within(panel).findByText('24')).toBeInTheDocument();                         // 12 + 12
    await user.click(rowText(list, '볼트 M4x10'));
    expect(await within(panel).findByText('14')).toBeInTheDocument();                         // 8 + 6
  });

  it('아무것도 고르지 않으면 제품 전체의 문서 · 조립 규칙 묶음을 보인다', async () => {
    renderAt('/products/HCR3A');
    const panel = await screen.findByRole('complementary', { name: '묶음' });
    expect(await within(panel).findByText('5건')).toBeInTheDocument();                         // 문서(같은 문서는 한 번만)
    expect(within(panel).getByText('5개')).toBeInTheDocument();                                // 조립 규칙
    expect(within(panel).getByRole('region', { name: '3D CAD 2건' })).toBeInTheDocument();
    expect(within(panel).getByRole('region', { name: '도면 1건' })).toBeInTheDocument();
    const hsg = within(panel).getByRole('link', { name: 'SP-HSG-01' });
    expect(hsg.closest('li')).toHaveTextContent('2개 품목');                                    // 베이스 하우징 · J1 하우징
  });

  it('단계를 1로 줄이면 하위 노드가 사라지고, 요약 숫자는 그대로다', async () => {
    const user = userEvent.setup();
    renderAt('/products/HCR3A');
    const list = await listOf();
    expect(within(list).getAllByText('J1 감속기').length).toBeGreaterThan(0);

    await user.selectOptions(screen.getByRole('combobox', { name: '단계' }), '1');
    await waitFor(() => expect(within(screen.getByRole('group', { name: LIST })).queryByText('J1 관절 모듈')).not.toBeInTheDocument());
    const after = screen.getByRole('group', { name: LIST });
    expect(within(after).getByText('HCR3A 본체')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: '요약' })).getByText('부품 10종')).toBeInTheDocument();
  });

  it('BOM 기준을 최신으로 바꾸면 작업중 리비전의 J1 브레이크가 붙는다 (관리자 모드)', async () => {
    const user = userEvent.setup();
    renderAt('/products/HCR3A');
    const list = await listOf();
    expect(within(list).queryByText('J1 브레이크')).not.toBeInTheDocument();

    await user.click(within(screen.getByRole('group', { name: 'BOM 기준' })).getByRole('button', { name: '최신' }));
    expect(await within(await listOf()).findByText('J1 브레이크')).toBeInTheDocument();
    const chips = screen.getByRole('group', { name: '요약' });
    expect(within(chips).getByText('부품 11종')).toBeInTheDocument();
    expect(within(chips).getByText('작업중 · 검토중 3')).toBeInTheDocument();                  // 최상위 조립품 R02 · 베이스 커버 R01 · J1 브레이크
  });

  it('관리자 모드가 꺼져 있으면 최신으로 바꿔도 남의 작업중 리비전은 보이지 않는다', async () => {
    const user = userEvent.setup();
    renderAt('/products/HCR3A', { userId: 1, adminMode: false });
    await listOf();
    await user.click(within(screen.getByRole('group', { name: 'BOM 기준' })).getByRole('button', { name: '최신' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '최신' })).toHaveAttribute('aria-pressed', 'true'));
    expect(within(await listOf()).queryByText('J1 브레이크')).not.toBeInTheDocument();
  });

  it('없는 제품 코드는 안내와 제품 목록 링크를 보인다', async () => {
    renderAt('/products/NOPE');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('제품 NOPE을(를) 찾을 수 없습니다');
    expect(within(alert).getByRole('link', { name: '제품 목록으로' })).toHaveAttribute('href', '/products');
  });

  it('제품 목록의 카드에서 연결 보기로 간다', async () => {
    renderAt('/products');
    const links = await screen.findAllByRole('link', { name: '연결 보기' });
    expect(links.map(l => l.getAttribute('href'))).toEqual(['/products/HCR3A', '/products/HCR5A']);
  });

  // ---------------- 필터 · 검색 · 사용처 경로 · 규칙 연결 · MES 링크 ----------------
  const filterGroup = (name: string) => screen.getByRole('group', { name });
  const shownText = () => screen.getByText(/개 중 \d+개 표시/).textContent;

  it('상태 필터: 승인을 끄면 작업중 · 검토중 품목과 그 조상 조립품만 남는다', async () => {
    const user = userEvent.setup();
    renderAt('/products/HCR3A');
    await listOf();
    expect(shownText()).toBe('14개 중 14개 표시');
    expect(screen.queryByRole('button', { name: '필터 지우기' })).not.toBeInTheDocument();

    await user.click(within(filterGroup('BOM 기준')).getByRole('button', { name: '최신' }));
    await within(await listOf()).findByText('J1 브레이크');
    expect(shownText()).toBe('15개 중 15개 표시');

    await user.click(within(filterGroup('상태 필터')).getByRole('button', { name: '승인' }));
    // 최상위 조립품 R02 · 베이스 커버 R01 · J1 브레이크가 작업중/검토중. 베이스 커버의 조상 베이스 조립품은 승인이지만 경로라서 남는다
    await waitFor(() => expect(shownText()).toBe('15개 중 4개 표시'));
    const list = await listOf();
    expect(within(list).getByText('J1 브레이크')).toBeInTheDocument();
    expect(within(list).getByText('베이스 조립품')).toBeInTheDocument();
    expect(within(list).queryByText('J1 관절 모듈')).not.toBeInTheDocument();
    expect(within(list).queryByText('케이블 하네스')).not.toBeInTheDocument();
    expect(within(filterGroup('상태 필터')).getByRole('button', { name: '승인' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: '필터 지우기' }));
    await waitFor(() => expect(shownText()).toBe('15개 중 15개 표시'));
    expect(within(await listOf()).getByText('케이블 하네스')).toBeInTheDocument();
  });

  it('조립 규칙 필터: 규칙 있음 / 없음 / 전체', async () => {
    const user = userEvent.setup();
    renderAt('/products/HCR3A');
    await listOf();
    const group = filterGroup('조립 규칙 필터');

    await user.click(within(group).getByRole('button', { name: '규칙 있음' }));
    await waitFor(() => expect(within(screen.getByRole('group', { name: LIST })).queryByText('볼트 M4x10')).not.toBeInTheDocument());
    let list = await listOf();
    expect(within(list).getAllByText('J1 감속기').length).toBeGreaterThan(0);               // 감속기 장착 규칙이 있다
    expect(within(list).queryByText('케이블 하네스')).not.toBeInTheDocument();                  // 규칙 없음

    await user.click(within(group).getByRole('button', { name: '규칙 없음' }));
    await waitFor(() => expect(within(screen.getByRole('group', { name: LIST })).queryByText('J1 감속기')).not.toBeInTheDocument());
    list = await listOf();
    expect(within(list).getAllByText('볼트 M4x10').length).toBeGreaterThan(0);
    expect(within(list).getByText('케이블 하네스')).toBeInTheDocument();

    await user.click(within(group).getByRole('button', { name: '전체' }));
    await waitFor(() => expect(shownText()).toBe('14개 중 14개 표시'));
  });

  it('공정 필터: 공정 칩을 켜면 그 공정의 규칙이 걸린 품목만 (규칙이 있는 공정만 칩으로 나온다)', async () => {
    const user = userEvent.setup();
    renderAt('/products/HCR3A');
    await listOf();
    const group = filterGroup('공정 필터');
    const labels = within(group).getAllByRole('button').map(b => b.textContent);
    expect(labels.some(t => t?.startsWith('장착'))).toBe(true);
    expect(labels.some(t => t?.startsWith('볼트 체결'))).toBe(true);
    expect(labels.some(t => t?.startsWith('용접'))).toBe(false);                               // 이 제품에는 용접 규칙이 걸린 품목이 없다

    await user.click(within(group).getByRole('button', { name: /^장착/ }));
    await waitFor(() => expect(within(screen.getByRole('group', { name: LIST })).queryByText('볼트 M3x8')).not.toBeInTheDocument());
    const list = await listOf();
    expect(within(list).getAllByText('J1 감속기').length).toBeGreaterThan(0);
    expect(within(list).getAllByText('J1 관절 모듈').length).toBeGreaterThan(0);               // 조상은 남는다
    expect(within(group).getByRole('button', { name: /^장착/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('검색: 한 곳만 맞으면 바로 고르고, 여러 곳이면 목록에서 Enter 로 첫째를 고른다', async () => {
    const user = userEvent.setup();
    renderAt('/products/HCR3A');
    await listOf();
    const box = screen.getByRole('searchbox', { name: '품번 · 이름 검색' });
    const panel = () => screen.getByRole('complementary', { name: '묶음' });

    await user.type(box, 'p00000000121');                                                      // 품번은 대소문자 · 하이픈을 무시한다
    expect(await within(panel()).findByRole('heading', { level: 2, name: 'J1 감속기' })).toBeInTheDocument();
    expect(within(await listOf()).getAllByRole('button', { current: true })[0]).toHaveTextContent('J1 감속기');   // 목록에서도 선택됨

    await user.clear(box);
    await user.type(box, '감속기');
    const results = await screen.findByRole('list', { name: '검색 결과' });
    expect(within(results).getAllByRole('button').map(b => b.textContent)).toEqual(['J1 감속기P-00000000121', 'J2 감속기P-00000000131']);
    await user.type(box, '{Enter}');
    expect(await within(panel()).findByRole('heading', { level: 2, name: 'J1 감속기' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '검색 결과' })).not.toBeInTheDocument();

    await user.clear(box);
    await user.type(box, 'zzzz');
    expect(await screen.findByText('보이는 품목 중에 없습니다')).toBeInTheDocument();
  });

  it('검색은 보이는 노드 안에서만 찾는다 (필터로 가려진 품목은 나오지 않는다)', async () => {
    const user = userEvent.setup();
    renderAt('/products/HCR3A');
    await listOf();
    await user.click(within(filterGroup('조립 규칙 필터')).getByRole('button', { name: '규칙 있음' }));
    await waitFor(() => expect(within(screen.getByRole('group', { name: LIST })).queryByText('케이블 하네스')).not.toBeInTheDocument());
    await user.type(screen.getByRole('searchbox', { name: '품번 · 이름 검색' }), '케이블');
    expect(await screen.findByText('보이는 품목 중에 없습니다')).toBeInTheDocument();
  });

  it('사용처 경로: 같은 품목이 두 조립품에 쓰이면 갈래마다 제품까지 보여 주고, 칩을 누르면 그 노드로 간다', async () => {
    const user = userEvent.setup();
    renderAt('/products/HCR3A');
    const list = await listOf();
    await user.click(rowText(list, '볼트 M3x8'));
    const panel = screen.getByRole('complementary', { name: '묶음' });

    const paths = await within(panel).findByRole('list', { name: '사용처 경로' });
    const chains = within(paths).getAllByRole('listitem').map(li => within(li).getAllByRole('button').map(b => b.textContent));
    expect(chains).toEqual([
      ['볼트 M3x8', 'J1 관절 모듈', 'HCR3A 본체', '협동로봇 3 kg'],
      ['볼트 M3x8', 'J2 관절 모듈', 'HCR3A 본체', '협동로봇 3 kg'],
    ]);
    expect(within(paths).getAllByRole('button', { current: true })).toHaveLength(2);           // 맨 앞 칩은 지금 보는 품목

    await user.click(within(paths).getAllByRole('button', { name: /J2 관절 모듈/ })[0]!);
    expect(await within(panel).findByRole('heading', { level: 2, name: 'J2 관절 모듈' })).toBeInTheDocument();

    await user.click(within(within(panel).getByRole('list', { name: '사용처 경로' })).getAllByRole('button', { name: /협동로봇 3 kg/ })[0]!);
    expect(await within(panel).findByRole('heading', { level: 2, name: '제품 묶음' })).toBeInTheDocument();   // 제품 칩은 제품 묶음으로
  });

  it('작업 표준 링크는 제품과 지금의 BOM 기준을 담고, BOM 가져오기 링크는 없다', async () => {
    const user = userEvent.setup();
    renderAt('/products/HCR3A');
    await listOf();
    expect(screen.getByRole('link', { name: '작업 표준' })).toHaveAttribute('href', '/mes?product=HCR3A&rule=released');
    expect(screen.queryByRole('link', { name: 'BOM 가져오기' })).not.toBeInTheDocument();

    await user.click(within(filterGroup('BOM 기준')).getByRole('button', { name: '최신' }));
    await waitFor(() => expect(screen.getByRole('link', { name: '작업 표준' })).toHaveAttribute('href', '/mes?product=HCR3A&rule=latest'));
  });

  it('조립 규칙은 이름만이 아니라 분류 · 속성을 함께 넣어 품목마다 묻는다', async () => {
    const asked: AssemblyPartInput[] = [];
    renderAt('/products/HCR3A', undefined, api => {
      const real = api.getAssemblyGuides.bind(api);
      api.getAssemblyGuides = async parts => { asked.push(...parts); return real(parts); };
    });
    await listOf();
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));

    expect(asked).toContainEqual({ name: 'J1 감속기', className: '감속기', attributes: { 감속비: '100:1', '허용 순간 토크(N·m)': 147 } });
    expect(asked).toContainEqual({ name: '볼트 M3x8', className: '볼트', attributes: { '호칭 지름': 'M3', '길이(mm)': 8, 규격: 'ISO 4762' } });
    expect(asked.some(a => /P-0000/.test(a.name))).toBe(false);                                // 이름에 품번을 섞지 않는다
    expect(new Set(asked.map(a => JSON.stringify(a))).size).toBe(asked.length);                // 같은 질문은 한 번만
  });

  it('분류로 걸리는 규칙도 그래프에 연결된다 (규칙 엔진이 이름이 아니라 분류를 보는 경우)', async () => {
    const fake = (name: string): AssemblyGuide => ({
      partName: name, ruleId: 'SP-FAKE-01', ruleName: '분류 규칙', operation: 'fasten', operationLabel: '볼트 체결', title: name, caption: '', params: [], cautions: [], tools: [], source: '',
    });
    renderAt('/products/HCR3A', undefined, api => {                                              // 분류가 '볼트'인 품목에만 규칙을 돌려주는 가짜 엔진
      api.getAssemblyGuides = async parts => parts.filter(p => p.className === '볼트').map(p => fake(p.name));
    });
    const chips = await screen.findByRole('group', { name: '요약' });
    await waitFor(() => expect(within(chips).getByText(/조립 규칙 연결 2/)).toBeInTheDocument());   // 볼트 M3x8 · 볼트 M4x10
    const list = await listOf();
    expect(within(list).getAllByText('규칙 1').length).toBeGreaterThan(0);                       // 목록의 규칙 표식
  });
});
