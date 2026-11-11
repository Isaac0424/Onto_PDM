import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { createEmptyApi } from '../../api/emptyApi';
import { ApiError, type PdmApi } from '../../api/types';
import { SessionProvider } from '../../session';
import { ChangeDetailPage } from './ChangeDetailPage';
import { ChangesPage } from './ChangesPage';
import { SC1_FINDINGS, changeTestApi, readyChange, runOf, sc1Change, sc2Change } from './testChange';

// jsdom 에는 WebGL 이 없어 Graph3D 는 목록 보기로 물러난다. 그래서 영향 그래프는 목록(키보드로 읽는 쪽)을 실제 컴포넌트로 확인한다.
// 변경 건은 시험 안에서만 만든다(testChange.ts, source_system='fixture'). 제품(앱)에는 가짜 데이터가 없다.
function renderAt(path: string, api: PdmApi) {
  render(
    <SessionProvider api={api}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/changes" element={<ChangesPage />} />
          <Route path="/changes/:id" element={<ChangeDetailPage />} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
}
const openTab = async (name: RegExp) => userEvent.click(await screen.findByRole('tab', { name }));

describe('설계 변경: 데이터를 읽어 올 곳이 없을 때', () => {
  it('목록은 가짜 변경 건 대신 연결 안내를 보인다(오류가 아니다)', async () => {
    renderAt('/changes', createEmptyApi());
    const note = await screen.findByRole('status', { name: 'OPMS 연결 안내' });
    expect(note).toHaveTextContent('설계 변경 데이터를 읽어 올 곳이 없어요');
    expect(note).toHaveTextContent('PDM 백엔드에 연결되면');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /새 변경 요청/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(note.innerHTML).not.toMatch(/red|danger|#dc2626/i);
  });

  it('상세도 "찾을 수 없음"이 아니라 연결 안내를 보인다', async () => {
    renderAt('/changes/CR-2026-0001', createEmptyApi());
    expect(await screen.findByRole('status', { name: 'OPMS 연결 안내' })).toHaveTextContent('설계 변경 데이터를 읽어 올 곳이 없어요');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('연결돼 있는데 목록이 비어 있으면 안내와 새 요청 버튼이 있다', async () => {
    renderAt('/changes', changeTestApi([]));
    expect(await screen.findByText(/아직 변경 요청이 없어요/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /새 변경 요청/ })).toBeInTheDocument();
  });

  it('없는 변경 건은 경고로 알린다', async () => {
    renderAt('/changes/CR-없음', changeTestApi());
    expect(await screen.findByRole('alert')).toHaveTextContent('찾을 수 없어요');
  });
});

describe('설계 변경 목록', () => {
  it('변경 건마다 상태 · 제품 · 영향 요약(막힘 · 처분 필요 · 확인 필요 · 영향 없음)을 보인다', async () => {
    renderAt('/changes', changeTestApi());
    const table = await screen.findByRole('table', { name: '변경 요청 목록' });
    const row1 = within(table).getByRole('link', { name: 'CR-2026-0001' }).closest('tr')!;
    const sum1 = within(row1).getByRole('group', { name: '영향 요약' });
    expect(sum1).toHaveTextContent(/막힘\s*1/);
    expect(sum1).toHaveTextContent(/처분 필요\s*3/);
    expect(sum1).toHaveTextContent(/영향 없음\s*2/);
    expect(within(row1).getByText('BRK-M8')).toBeInTheDocument();
    expect(within(row1).getByText('지시 검토중')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'CR-2026-0002' })).toBeInTheDocument();
  });

  it('낡은 분석과 일부만 분석한 것은 배지로 보인다', async () => {
    const stale = sc1Change({ latest_run: runOf('CO-2026-0001', SC1_FINDINGS, { stale: true, partial: true }) });
    renderAt('/changes', changeTestApi([stale]));
    const sum = await screen.findByRole('group', { name: '영향 요약' });
    expect(within(sum).getByText('낡음')).toBeInTheDocument();
    expect(within(sum).getByText('일부만 분석')).toBeInTheDocument();
  });

  it('상태로 거르고, 맞는 것이 없으면 그렇게 말한다', async () => {
    renderAt('/changes', changeTestApi());
    await screen.findByRole('table', { name: '변경 요청 목록' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '상태' }), '철회');
    expect(await screen.findByText('조건에 맞는 변경 요청이 없어요.')).toBeInTheDocument();
  });

  it('새 변경 요청을 만들면 상세로 간다', async () => {
    const api = changeTestApi();
    renderAt('/changes', api);
    await userEvent.click(await screen.findByRole('button', { name: /새 변경 요청/ }));
    const form = screen.getByRole('form', { name: '새 변경 요청' });
    expect(within(form).getByRole('button', { name: '요청 만들기' })).toBeDisabled();                  // 제목 · 이유가 있어야 한다
    await userEvent.type(within(form).getByLabelText('제목'), '새 요청');
    await userEvent.type(within(form).getByLabelText('변경 이유'), '이유');
    await userEvent.click(within(form).getByRole('button', { name: '요청 만들기' }));
    expect(await screen.findByRole('heading', { level: 1, name: /CR-2026-0099/ })).toBeInTheDocument();
    expect(api.calls).toContain('createChange 새 요청');
  });
});

describe('설계 변경 상세: SC-1 너트 교체(짝 불일치)', () => {
  it('막힘 이유를 수치로 보이고 임시 판정이라고 밝힌다', async () => {
    renderAt('/changes/CR-2026-0001', changeTestApi());
    expect(await screen.findByRole('heading', { level: 1, name: /너트 P-…22 → P-…23 교체/ })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: '영향 발견' });
    const pair = within(table).getByText(/피치 1\.25 ↔ 1\.0/).closest('tr')!;
    expect(within(pair).getByText('막힘')).toBeInTheDocument();
    expect(within(pair).getByText('맞지 않음')).toBeInTheDocument();
    expect(within(pair).getByText('임시 판정')).toBeInTheDocument();
    expect(within(pair).getByText('볼트 · 너트 · 와셔 짝')).toBeInTheDocument();
    // 그립 길이는 통과(새 너트 높이가 같다)
    const grip = within(table).getByText(/필요 28\.5 mm, 볼트 30 mm/).closest('tr')!;
    expect(within(grip).getByText('맞음')).toBeInTheDocument();

    const banner = screen.getByRole('status', { name: '임시 판정' });
    expect(banner).toHaveTextContent('PDM 참고 판정 · 기준 미지정');
    expect(banner).toHaveTextContent('온톨로지 0.19.0');
    expect(banner).toHaveTextContent('시연용 가정');
  });

  it('영향 그래프를 목록으로도 읽을 수 있다(키보드 · 3D 대안)', async () => {
    renderAt('/changes/CR-2026-0001', changeTestApi());
    const list = await screen.findByRole('group', { name: 'CR-2026-0001 영향 목록' });
    expect(within(list).getAllByRole('button').length).toBeGreaterThan(4);
    expect(within(list).getByText('WO-FX-0002')).toBeInTheDocument();
    expect(within(list).getAllByText('막힘').length).toBeGreaterThan(0);                                // 색에만 기대지 않는다: 글자로도 있다
    await userEvent.click(within(list).getByRole('button', { name: /육각너트 M8\(가는나사\)/ }));
    expect(await screen.findByText(/^선택:/)).toHaveTextContent('육각너트 M8(가는나사) P-…23 · 막힘');
    expect(within(list).getByRole('button', { name: /육각너트 M8\(가는나사\)/ })).toHaveAttribute('aria-current', 'true');
  });

  it('심각도로 거른다', async () => {
    renderAt('/changes/CR-2026-0001', changeTestApi());
    const table = await screen.findByRole('table', { name: '영향 발견' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + SC1_FINDINGS.length);
    await userEvent.click(screen.getByRole('button', { name: /^막힘 1$/ }));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText(/피치 1\.25 ↔ 1\.0/)).toBeInTheDocument();
  });

  it('막힘이 남아 있으면 승인 버튼이 잠기고 이유가 목록으로 보인다', async () => {
    renderAt('/changes/CR-2026-0001', changeTestApi());
    await openTab(/검토 · 승인/);
    const reasons = await screen.findByRole('status', { name: '승인할 수 없는 이유' });
    expect(reasons).toHaveTextContent('막힘(blocked) 1건');
    expect(reasons).toHaveTextContent('처분이 필요한 영향 3건');
    expect(reasons).toHaveTextContent('설계 · 구매 · 생산 검토가 필요해요');
    expect(screen.getByRole('button', { name: '승인' })).toBeDisabled();
  });
});

describe('설계 변경 상세: SC-2 상판 두께 8 → 12 mm(그립 길이 부족)', () => {
  it('필요 32.5 mm · 볼트 30 mm · 2.5 mm 부족을 보이고 CAD 추정이면 "추정"을 단다', async () => {
    renderAt('/changes/CR-2026-0002', changeTestApi());
    const table = await screen.findByRole('table', { name: '영향 발견' });
    const grip = within(table).getAllByText('필요 32.5 mm · 볼트 30 mm · 2.5 mm 부족')[0]!.closest('tr')!;
    expect(within(grip).getByText('막힘')).toBeInTheDocument();
    expect(within(grip).getByText('추정')).toBeInTheDocument();
    expect(within(grip).getByText('그립 길이')).toBeInTheDocument();
    // 대체 후보는 조건부 · 확인 필요 — 자동으로 정해지지 않는다
    const sub = within(table).getByText(/플랜지볼트가 육각볼트/).closest('tr')!;
    expect(within(sub).getByText('조건부')).toBeInTheDocument();
    expect(within(sub).getByText('확인 필요')).toBeInTheDocument();
    // 입력값 · 근거는 펼쳐 볼 수 있다
    await userEvent.click(within(grip).getByText('입력값 · 근거'));
    expect(within(grip).getByText('plate_thickness_source')).toBeInTheDocument();
    expect(within(grip).getByText('cad_estimate')).toBeInTheDocument();
  });

  it('대상 탭에 바뀌는 값(두께 8 → 12)과 개정 R00 → R01이 보인다', async () => {
    renderAt('/changes/CR-2026-0002', changeTestApi());
    await openTab(/^대상/);
    const table = await screen.findByRole('table', { name: '변경 대상' });
    expect(within(table).getByText('8 → 12')).toBeInTheDocument();
    expect(within(table).getByText('R00 → R01')).toBeInTheDocument();
    expect(within(table).getByText('수치 변경')).toBeInTheDocument();
  });
});

describe('설계 변경 상세: 낡음 · 일부만 분석', () => {
  it('외부 데이터가 바뀌어 낡으면 경고를 보이고 승인이 잠긴다', async () => {
    const stale = readyChange();
    stale.latest_run = runOf('CO-2026-0001', stale.latest_run!.findings, { stale: true, stale_reasons: ['재고 로트 LT-N-01 이 바뀌었어요.'] });
    renderAt('/changes/CR-2026-0001', changeTestApi([stale]));
    const banner = await screen.findByRole('status', { name: '낡은 분석' });
    expect(banner).toHaveTextContent('외부 데이터가 바뀌었어요 — 다시 분석하세요.');
    expect(banner).toHaveTextContent('LT-N-01');
    await openTab(/검토 · 승인/);
    expect(screen.getByRole('button', { name: '승인' })).toBeDisabled();
    expect(await screen.findByRole('status', { name: '승인할 수 없는 이유' })).toHaveTextContent('외부 데이터가 바뀌었어요');
  });

  it('OPMS 를 읽지 못한 분석은 "문제 없음"이 아니라고 말하고 승인을 막는다', async () => {
    const partial = readyChange();
    partial.latest_run = runOf('CO-2026-0001', partial.latest_run!.findings, { partial: true, warnings: ['OPMS에 연결되면 체결 적합성을 판정해요'] });
    renderAt('/changes/CR-2026-0001', changeTestApi([partial]));
    const banner = await screen.findByRole('status', { name: '일부만 분석' });
    expect(banner).toHaveTextContent('"문제 없음"이 아니에요');
    expect(banner).toHaveTextContent('OPMS에 연결되면 체결 적합성을 판정해요');
    await openTab(/검토 · 승인/);
    expect(screen.getByRole('button', { name: '승인' })).toBeDisabled();
  });

  it('영향 다시 분석 버튼이 재계산을 부른다', async () => {
    const api = changeTestApi();
    renderAt('/changes/CR-2026-0001', api);
    await userEvent.click(await screen.findByRole('button', { name: /영향 다시 분석/ }));
    await waitFor(() => expect(api.calls).toContain('recomputeImpact CR-2026-0001'));
  });
});

describe('설계 변경 상세: 처분 · 검토 · 승인', () => {
  it('영향마다 처분을 사유와 함께 정한다(제안은 미리 채우지 않는다)', async () => {
    const api = changeTestApi();
    renderAt('/changes/CR-2026-0001', api);
    await openTab(/^처분/);
    const table = await screen.findByRole('table', { name: '처분' });
    const wo = within(table).getByText('WO-FX-0002').closest('tr')!;
    expect(within(wo).getByText('제안: 진행 중 변경 검토')).toBeInTheDocument();
    const select = within(wo).getByRole('combobox', { name: /처분 선택/ });
    expect(select).toHaveValue('');                                                                      // 자동 확정 금지
    expect(within(wo).getByRole('button', { name: '저장' })).toBeDisabled();
    await userEvent.selectOptions(select, '기존 사양 그대로 허용');
    await userEvent.type(within(wo).getByRole('textbox', { name: /사유/ }), '이미 조립한 제품은 허용');
    await userEvent.click(within(wo).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(api.calls).toContain('setDisposition CR-2026-0001 14 use_as_is 이미 조립한 제품은 허용'));
    expect(await within(table).findByText(/현재:/)).toHaveTextContent('기존 사양 그대로 허용');
  });

  it('막힘 영향에는 위험 수용 · 조치 없음 선택지가 없고 "변경안을 고쳐야 한다"고 알린다', async () => {
    renderAt('/changes/CR-2026-0001', changeTestApi());
    await openTab(/^처분/);
    const table = await screen.findByRole('table', { name: '처분' });
    const pair = within(table).getByText('P-00000000001 ↔ P-00000000023').closest('tr')!;
    expect(within(pair).getByRole('note')).toHaveTextContent('변경안을 고쳐 다시 분석');
    const options = within(within(pair).getByRole('combobox', { name: /처분 선택/ })).getAllByRole('option').map(o => o.textContent);
    expect(options).toEqual(['처분 선택…', '변경안 수정', '대체 부품 선택', '설계와 검토']);
  });

  it('조건이 모두 갖춰지면 승인할 수 있고, 승인하면 새 개정이 발행됐다고 말한다', async () => {
    const api = changeTestApi([readyChange()]);
    renderAt('/changes/CR-2026-0001', api);
    await openTab(/검토 · 승인/);
    const approve = await screen.findByRole('button', { name: '승인' });
    await waitFor(() => expect(approve).toBeEnabled());
    expect(screen.queryByRole('status', { name: '승인할 수 없는 이유' })).not.toBeInTheDocument();
    await userEvent.click(approve);
    await waitFor(() => expect(api.calls).toContain('approveChange CR-2026-0001'));
    expect(await screen.findByText(/새 개정이 발행됐어요/)).toBeInTheDocument();
  });

  it('서버가 승인을 거절하면 그 이유를 그대로 보인다', async () => {
    const api = changeTestApi([readyChange()], {
      approveChange: async () => { throw new ApiError('처분이 없는 영향이 있습니다.', 409, 'DISPOSITION_REQUIRED', { finding_ids: [14] }); },
    });
    renderAt('/changes/CR-2026-0001', api);
    await openTab(/검토 · 승인/);
    await userEvent.click(await screen.findByRole('button', { name: '승인' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('처분이 없는 영향이 있습니다.');
    expect(alert).toHaveTextContent('처분이 필요한 영향 1건');
  });

  it('필요한 기능(설계 · 구매 · 생산)마다 검토 카드가 있고 의견을 낼 수 있다', async () => {
    const api = changeTestApi();
    renderAt('/changes/CR-2026-0001', api);
    await openTab(/검토 · 승인/);
    for (const fn of ['설계', '구매', '생산']) expect(await screen.findByRole('region', { name: `${fn} 검토` })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: '구매 검토' });
    await userEvent.click(within(card).getByRole('button', { name: '구매 의견 제출' }));
    await waitFor(() => expect(api.calls).toContain('submitReview CR-2026-0001 purchasing approve'));
  });

  it('반려는 사유가 있어야 하고 반려하면 서버에 사유를 보낸다', async () => {
    const api = changeTestApi();
    renderAt('/changes/CR-2026-0001', api);
    await openTab(/검토 · 승인/);
    const reject = await screen.findByRole('button', { name: '반려' });
    expect(reject).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: '반려 사유' }), '피치가 달라요');
    await userEvent.click(reject);
    await waitFor(() => expect(api.calls).toContain('rejectChange CR-2026-0001 피치가 달라요'));
  });
});

describe('설계 변경 상세: 적용 범위 · 대상 · 이력', () => {
  it('적용 범위를 저장한다(로트는 쉼표로 나눈다). 범위가 없으면 "미정"이라고 말한다', async () => {
    const noScope = sc1Change();
    noScope.targets = [{ ...noScope.targets[0]!, scopes: [] }];
    const api = changeTestApi([noScope]);
    renderAt('/changes/CR-2026-0001', api);
    await openTab(/적용 범위/);
    const card = await screen.findByRole('region', { name: 'P-00000000022 적용 범위' });
    expect(within(card).getByText('범위 미정')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: '범위 추가' }));
    await userEvent.type(within(card).getByLabelText('생산 로트 (쉼표로 구분)'), 'L1, L2');
    await userEvent.type(within(card).getByLabelText('일련번호 시작'), '120');
    await userEvent.click(within(card).getByRole('button', { name: '범위 저장' }));
    await waitFor(() => expect(api.calls.some(c => c.startsWith('setChangeScope CR-2026-0001 1') && c.includes('"lot_nos":["L1","L2"]') && c.includes('"serial_from":120'))).toBe(true));
  });

  it('서버가 범위를 거절하면 이유를 그 자리에 보인다', async () => {
    const api = changeTestApi([sc1Change()], { setChangeScope: async () => { throw new ApiError('같은 사업장의 범위가 겹칩니다.', 409, 'SCOPE_OVERLAP'); } });
    renderAt('/changes/CR-2026-0001', api);
    await openTab(/적용 범위/);
    await userEvent.click(await screen.findByRole('button', { name: '범위 저장' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('같은 사업장의 범위가 겹칩니다.');
  });

  it('검토가 시작된 뒤에는 대상을 바꿀 수 없다', async () => {
    renderAt('/changes/CR-2026-0001', changeTestApi());
    await openTab(/^대상/);
    expect(await screen.findByText('검토가 시작된 뒤에는 대상을 바꿀 수 없어요.')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: '변경 대상 추가' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /대상 빼기/ })).not.toBeInTheDocument();
  });

  it('대상 추가: 종류를 고르면 개정 · 교체 안내가 나온다', async () => {
    const api = changeTestApi([sc1Change({ order: { code: 'CO-2026-0001', status: 'draft' } })]);
    renderAt('/changes/CR-2026-0001', api);
    await openTab(/^대상/);
    const form = await screen.findByRole('form', { name: '변경 대상 추가' });
    expect(within(form).getByRole('note')).toHaveTextContent('규격');
    await userEvent.type(within(form).getByLabelText('품번'), 'P-00000000001');
    await userEvent.type(within(form).getByLabelText('바꿀 품번'), 'P-00000000015');
    await userEvent.click(within(form).getByRole('button', { name: '대상 추가' }));
    await waitFor(() => expect(api.calls.some(c => c.startsWith('addChangeTarget CR-2026-0001') && c.includes('"replacement_item_no":"P-00000000015"'))).toBe(true));
    await userEvent.selectOptions(within(form).getByRole('combobox'), '개정 (같은 품번)');
    expect(within(form).getByRole('note')).toHaveTextContent('도면 · 공차 · 검사 조건');
  });

  it('이력에 분석 근거(온톨로지 버전 · 입력 해시 · 임시 판정)와 처분 · 검토가 시간순으로 보인다', async () => {
    renderAt('/changes/CR-2026-0001', changeTestApi([readyChange()]));
    await openTab(/이력/);
    const list = await screen.findByRole('list', { name: '이력' });
    expect(within(list).getByText(/영향을 분석했어요/)).toBeInTheDocument();
    expect(within(list).getByText(/온톨로지 0\.19\.0 · 입력 abcdef01 · 임시 판정/)).toBeInTheDocument();
    expect(within(list).getAllByText(/처분을 “소진 후 전환”/).length).toBe(3);
    expect(within(list).getAllByText(/찬성을\(를\) 냈어요/).length).toBe(3);
  });
});

describe('접근성', () => {
  it('탭은 tablist 이고 고른 탭이 aria-selected 이다', async () => {
    renderAt('/changes/CR-2026-0001', changeTestApi());
    const tabs = await screen.findByRole('tablist');
    expect(within(tabs).getAllByRole('tab').map(t => t.textContent?.replace(/\d+$/, '').trim())).toEqual(['대상', '영향', '적용 범위', '처분', '검토 · 승인', '이력']);
    expect(within(tabs).getByRole('tab', { name: /^영향/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(within(tabs).getByRole('tab', { name: /이력/ }));
    expect(within(tabs).getByRole('tab', { name: /이력/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: '이력' })).toBeInTheDocument();
  });

  it('심각도는 색만이 아니라 글자로도 읽힌다(모든 배지에 텍스트)', async () => {
    renderAt('/changes/CR-2026-0001', changeTestApi());
    const table = await screen.findByRole('table', { name: '영향 발견' });
    const badges = within(table).getAllByText(/^(막힘|처분 필요|확인 필요|영향 없음)$/);
    expect(badges.length).toBe(SC1_FINDINGS.length);
    badges.forEach(b => expect(b.textContent).not.toBe(''));
  });

  it('요약은 이 화면에 빨강 오류 경고(alert)를 만들지 않는다(막힘은 상태이지 화면 오류가 아니다)', async () => {
    renderAt('/changes/CR-2026-0001', changeTestApi());
    await screen.findByRole('table', { name: '영향 발견' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('설계 변경 목록과 상세를 오가는 링크', () => {
  it('목록의 코드 링크는 상세 경로를 가리킨다', async () => {
    renderAt('/changes', changeTestApi());
    const link = await screen.findByRole('link', { name: 'CR-2026-0002' });
    expect(link).toHaveAttribute('href', '/changes/CR-2026-0002');
    await userEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: /상판 브래킷 두께 8 → 12 mm/ })).toBeInTheDocument();
    expect(sc2Change().code).toBe('CR-2026-0002');
  });
});
