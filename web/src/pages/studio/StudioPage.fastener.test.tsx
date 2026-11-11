import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyApi } from '../../api/emptyApi';
import type { AssemblyGuide, AssemblyPartInput, CadPartHint, CadPartMatch, PdmApi } from '../../api/types';
import { SessionProvider } from '../../session';
import { boltMesh, nutMesh, plateMesh, type Mesh } from '../../extract/fastener.fixtures';
import { StudioPage } from './StudioPage';
import { seedCad } from './testSeed';

// 형상으로 본 볼트 종류가 화면에 닿는 길: 뷰어가 부품 메시를 읽어 주면(getPartGeometry) 속성 패널에 클래스 후보 블록이 나오고,
// 사람이 확정한 값이 품번 매칭 · 조립 규칙으로 흐른다. 뷰어(WebGL)는 같은 API 모양의 가짜이고, 메시는 시험용 볼트 생성기가 만든다.
const MESHES: Record<string, Mesh> = {
  'PRT-S1': boltMesh('socket', 'M6', 25),                          // 육각구멍붙이 M6×25 → 보유 P-T0000000003 (ISO 4762)
  'PRT-H1': boltMesh('hex', 'M8', 25),                             // 육각 M8×25 → 보유 P-T0000000004 (ISO 4017)
  'PRT-B1': boltMesh('button', 'M4', 8),                           // 버튼 M4×8: 클래스가 OPMS 에 없다(제안) → 보유 P-T0000000005 (ISO 7380)는 규격으로
  'PRT-C1': boltMesh('countersunk', 'M4', 8),                      // 접시 M4×8: 보유 중인 M4×8 은 버튼이라 머리 모양이 달라 후보가 아니다
  'PRT-X1': boltMesh('socket', 'M6', 20, { drive: 'none' }),       // 구멍을 생략한 단순화 모델
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

const viewer = vi.hoisted(() => ({ geometryCalls: [] as string[], canRead: true }));

vi.mock('explode-studio', () => ({
  mountExplodeStudio: (container: HTMLElement) => {
    const handlers: Record<string, ((d: unknown) => void)[]> = {};
    const emit = (type: string, d: unknown) => (handlers[type] ?? []).forEach(fn => fn(d));
    const root = Object.assign(document.createElement('div'), { innerHTML: '<div class="stage"></div>' });
    container.appendChild(root);
    let model = '';
    const api: Record<string, unknown> = {
      on: (type: string, fn: (d: unknown) => void) => { (handlers[type] ??= []).push(fn); return () => { handlers[type] = (handlers[type] ?? []).filter(f => f !== fn); }; },
      loadFile: async (f: File) => { model = f.name; emit('model', { name: model, parts: PARTS.length }); },
      getState: () => ({ model, step: 1 }),
      getParts: () => PARTS,
      getLayers: () => LAYERS,
      root,
      go: (n: number) => emit('step', { step: n, layer: n - 2 }),
      selectPart: (name: string) => { const p = PARTS.find(x => x.name === name)!; emit('select', { id: p.id, name: p.name, layer: p.layer }); },
      destroy: () => {},
    };
    if (viewer.canRead) {
      api.getPartGeometry = (name: string) => {
        viewer.geometryCalls.push(name);
        const m = MESHES[name];
        return m ? { name, unit: 'mm', positions: Float32Array.from(m.positions), indices: Uint32Array.from(m.indices) } : null;
      };
    }
    return api;
  },
}));

let guideInputs: AssemblyPartInput[][] = [];

// 시험 안에서만 쓰는 보유 볼트 3종과 체결 규칙 하나 (제품에는 가짜 데이터가 없다: 기본 API 는 비어 있다).
// 보유 볼트의 머리 모양은 규격(ISO)이 정한다: 4762 소켓 · 4017 육각 · 7380 버튼.
const OWNED = [
  { itemNo: 'P-T0000000003', name: '육각구멍붙이볼트 M6x25', thread: 'M6', length: 25, head: 'Socket' },
  { itemNo: 'P-T0000000004', name: '외육각볼트 M8x25', thread: 'M8', length: 25, head: 'Hex' },
  { itemNo: 'P-T0000000005', name: '버튼머리나사 M4x8', thread: 'M4', length: 8, head: 'Button' },
];
const BOLT = { classIri: 'cls:C0101', classLabel: '볼트', classPath: ['체결류', '볼트'] };

/** 사람이 확정한 나사 규격 · 길이(· 머리 모양)로 보유 볼트를 찾는다. 머리 모양이 다른 볼트는 후보가 아니다. 규격으로도 못 찾아도 형상이 볼트라고 확정했으면 분류만 볼트로 둔다 */
function matchOne(name: string, hint?: CadPartHint): CadPartMatch {
  if (hint?.threadSize && hint.length !== undefined) {
    const hit = OWNED.find(b => b.thread === hint.threadSize && Math.abs(b.length - hint.length!) <= 0.5 && (!hint.headType || b.head === hint.headType));
    if (hit) return { name, status: 'suggested', itemNo: hit.itemNo, itemName: hit.name, method: 'attributes', score: hint.headType ? 0.95 : 0.9, ...BOLT };
  }
  if (hint && (hint.fastenerClass || hint.headType || hint.threadSize)) return { name, status: 'none', ...BOLT };
  return { name, status: 'none' };
}

/** 확정한 클래스가 규칙을 고른다: 이름이 볼트가 아니어도 소켓 헤드 M6 이면 육각 렌치 · 토크 */
const socketGuide = (p: AssemblyPartInput): AssemblyGuide | undefined => p.fastenerClass === 'SocketHeadBolt' && p.attributes?.threadSize === 'M6'
  ? {
      partName: p.name, ruleId: 'SP-FAS-02', ruleName: '소켓 헤드 볼트 체결', operation: 'fasten', operationLabel: '볼트 체결', title: '소켓 헤드 볼트 체결', caption: '육각 렌치로 조입니다.',
      params: [{ label: '체결 토크', value: '9.5 N·m ±10%' }], cautions: ['토크 값은 가상 값입니다. 실제 작업에 쓰지 않습니다.'], tools: ['육각 렌치 5 mm'], source: '시험용 규칙',
    }
  : undefined;

function testApi(): PdmApi {
  return {
    ...createEmptyApi(),
    connected: true,
    matchCadParts: async (names, hints = {}) => names.map(n => matchOne(n, hints[n])),
    getAssemblyGuides: async parts => { guideInputs.push(parts); return parts.flatMap(p => socketGuide(p) ?? []); },
  };
}

async function renderPage() {
  await seedCad();
  const api = testApi();
  return render(
    <SessionProvider api={api}>
      <MemoryRouter><StudioPage /></MemoryRouter>
    </SessionProvider>,
  );
}

const shapeBlock = () => screen.findByRole('region', { name: '형상으로 본 볼트 종류' });

/** 속성 탭을 열고 부품을 고른다 */
async function pick(user: ReturnType<typeof userEvent.setup>, name: string) {
  const steps = await screen.findByRole('region', { name: '제조 순서' });
  await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());
  if (screen.getByRole('tab', { name: /^속성/ }).getAttribute('aria-selected') !== 'true') await user.click(screen.getByRole('tab', { name: /^속성/ }));
  await user.click(within(steps).getByRole('button', { name: new RegExp(`^${name}`) }));
  return steps;
}

beforeEach(() => { guideInputs = []; viewer.geometryCalls.length = 0; viewer.canRead = true; });

describe('형상으로 본 볼트 종류 (속성 패널)', () => {
  it('부품을 고르면 메시를 읽어 볼트 종류 후보와 속성 후보(머리 모양 · 나사 규격 · 길이 · 육각구멍)가 나온다. 이름이 볼트가 아니어도', async () => {
    const user = userEvent.setup();
    await renderPage();
    await pick(user, 'PRT-S1');

    const block = await shapeBlock();
    const first = within(within(block).getByRole('list', { name: '볼트 종류 후보' })).getAllByRole('listitem')[0]!;
    expect(within(first).getByText('육각구멍붙이볼트')).toBeInTheDocument();
    expect(within(first).getByRole('meter', { name: '육각구멍붙이볼트 점수' })).toHaveAttribute('aria-valuenow', expect.stringMatching(/^[5-9]\d$|^100$/));
    expect(within(first).queryByText('제안(미등록)')).not.toBeInTheDocument();            // OPMS 에 있는 분류
    expect(viewer.geometryCalls).toContain('PRT-S1');

    const list = screen.getByRole('list', { name: 'PRT-S1 속성 후보' });
    const row = (label: string) => within(list).getByText(label).closest('li')!;
    expect(within(row('머리 모양')).getByText('Socket')).toBeInTheDocument();
    expect(within(row('나사 규격')).getByText('M6')).toBeInTheDocument();
    expect(within(row('길이')).getByText('25 mm')).toBeInTheDocument();
    expect(within(row('육각구멍 크기')).getByText('5 mm')).toBeInTheDocument();
    expect(within(row('나사 규격')).getByText('추정')).toBeInTheDocument();                 // 형상에서 추정한 값은 숨기지 않는다
    expect(within(list).queryByText('너비')).not.toBeInTheDocument();                       // 머리까지 잰 상자 크기 후보는 볼트에서 뺀다
  });

  it('OPMS 에 없는 분류(버튼 헤드)는 "제안(미등록)"으로 표시하고, 확정하면 등록 요청 초안(클래스 · 근거)이 붙는다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await pick(user, 'PRT-B1');

    const block = await shapeBlock();
    const first = within(within(block).getByRole('list', { name: '볼트 종류 후보' })).getAllByRole('listitem')[0]!;
    expect(within(first).getByText('버튼헤드볼트')).toBeInTheDocument();
    const chip = within(first).getByText('제안(미등록)');
    expect(chip).toHaveAttribute('title', 'OPMS 에 아직 없는 분류예요. 등록을 요청할 수 있어요');
    expect(within(block).queryByText('OPMS 분류 등록 요청 초안')).not.toBeInTheDocument();    // 확정 전에는 초안이 없다

    await user.click(within(first).getByRole('button', { name: '버튼헤드볼트 이 종류로 확정' }));
    expect(within(first).getByText('확정')).toBeInTheDocument();
    await user.click(within(block).getByText('OPMS 분류 등록 요청 초안'));
    const body = within(block).getByLabelText('OPMS 분류 등록 요청 본문').textContent!;
    expect(body).toContain('"code": "ButtonHeadBolt"');
    expect(body).toContain('"headType": "Button"');
    expect(body).toContain('"parent": "Bolt"');
    expect(body).toContain('OPMS 미등록 제안 클래스');                                       // 클래스를 고른 형상 근거가 실린다
    expect(body).toContain('"key": "threadSize"');
  });

  it('등록된 분류(소켓 헤드)는 요청 초안이 없다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await pick(user, 'PRT-S1');
    const block = await shapeBlock();
    await user.click(within(block).getByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }));
    expect(within(block).queryByText('OPMS 분류 등록 요청 초안')).not.toBeInTheDocument();
    await user.click(within(block).getByRole('button', { name: '육각구멍붙이볼트 확정 취소' }));
    expect(within(block).getByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' })).toBeInTheDocument();
  });

  it('구동부 구멍을 뺀 단순화 모델은 하나로 정하지 않고 후보가 여러 개라고 알린다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await pick(user, 'PRT-X1');
    const block = await shapeBlock();
    expect(within(block).getByRole('note')).toHaveTextContent('후보가 여러 개예요 — 구동부 구멍이 보이지 않아요');
    expect(within(block).getAllByRole('listitem').length).toBeGreaterThan(0);
    const note = within(block).getByRole('note');
    expect(note.closest('.fast-block')?.innerHTML).not.toMatch(/red|danger|#dc2626/i);       // 오류가 아니다: 빨강을 쓰지 않는다
  });

  it('판 · 너트는 볼트 블록이 없다 (분석이 끝난 뒤에도)', async () => {
    const user = userEvent.setup();
    await renderPage();
    for (const name of ['PRT-PLATE', 'PRT-NUT']) {
      await pick(user, name);
      await waitFor(() => expect(viewer.geometryCalls).toContain(name));
      await waitFor(() => expect(screen.queryByRole('status', { name: '형상 분석' })).not.toBeInTheDocument());
      expect(screen.queryByRole('region', { name: '형상으로 본 볼트 종류' })).not.toBeInTheDocument();
      expect(screen.getByRole('list', { name: `${name} 속성 후보` })).toBeInTheDocument();    // 기존 후보(크기 등)는 그대로
    }
  });

  it('뷰어가 메시를 못 읽으면(옛 뷰어) 아무것도 바뀌지 않는다', async () => {
    viewer.canRead = false;
    const user = userEvent.setup();
    await renderPage();
    await pick(user, 'PRT-S1');
    expect(screen.queryByRole('region', { name: '형상으로 본 볼트 종류' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '형상 분석' })).not.toBeInTheDocument();
    expect(viewer.geometryCalls).toEqual([]);
  });

  it('작은 부품은 고르기 전에 한가한 때 미리 분석해서, 속성 후보 수가 부품별 목록에 먼저 보인다', async () => {
    const user = userEvent.setup();
    await renderPage();
    const steps = await screen.findByRole('region', { name: '제조 순서' });
    await waitFor(() => expect(within(steps).queryByText('매칭 중…')).not.toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: /^속성/ }));
    await waitFor(() => expect(viewer.geometryCalls).toEqual(expect.arrayContaining(names)));    // 고르지 않았는데 모두 읽었다
    const overview = screen.getByRole('list', { name: '부품별 속성 후보' });
    const s1 = within(overview).getByRole('button', { name: /^PRT-S1/ });
    await waitFor(() => expect(within(s1).getByText(/후보 \d+/)).toBeInTheDocument());
    expect(Number(/후보 (\d+)/.exec(s1.textContent!)![1])).toBeGreaterThanOrEqual(4);          // 머리 모양 · 구동부 · 나사 규격 · 길이 · 육각구멍
  });
});

describe('확정한 형상 값이 품번 매칭 · 조립 규칙으로 흐른다', () => {
  const confirmAttrs = async (user: ReturnType<typeof userEvent.setup>, ...labels: RegExp[]) => {
    for (const re of labels) await user.click(await screen.findByRole('button', { name: re }));
  };
  const chipOf = (steps: HTMLElement, name: string) => within(steps).getByRole('button', { name: new RegExp(`^${name}`) });

  it('나사 규격 · 길이 · 머리 모양을 확정하면 규격이 같은 보유 품번이 후보로 올라온다', async () => {
    const user = userEvent.setup();
    await renderPage();
    let steps = await pick(user, 'PRT-S1');
    // 확정하기 전에도 CAD 형상이 추정한 규격(M6 · 25 mm)으로 후보가 올라온다. 이름이 아니라 규격에 걸린 후보 · 추정이고, 확정(보유 품번)은 아니다
    await waitFor(() => expect(chipOf(steps, 'PRT-S1')).toHaveTextContent('후보 P-T0000000003 · 추정'));
    await user.click(await within(await shapeBlock()).findByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }));
    await confirmAttrs(user, /^나사 규격 M6 확정$/, /^길이 25 mm 확정$/);
    await waitFor(() => expect(chipOf(steps, 'PRT-S1')).not.toHaveTextContent('추정'));              // 사람이 확정하면 '추정'이 사라진다
    expect(chipOf(steps, 'PRT-S1')).toHaveTextContent('후보 P-T0000000003');                        // 육각구멍붙이볼트 M6x25 (ISO 4762)

    steps = await pick(user, 'PRT-H1');
    await user.click(await within(await shapeBlock()).findByRole('button', { name: '육각볼트 이 종류로 확정' }));
    await confirmAttrs(user, /^나사 규격 M8 확정$/, /^길이 25 mm 확정$/);
    await waitFor(() => expect(chipOf(steps, 'PRT-H1')).toHaveTextContent('후보 P-T0000000004'));    // 외육각볼트 M8x25 (ISO 4017)

    // 후보 품번은 사람이 확정해야 보유가 된다 (규격 일치 근거가 온톨로지 패널에 보인다)
    await user.click(screen.getByRole('tab', { name: '온톨로지' }));
    expect(await screen.findByText(/규격 일치/)).toBeInTheDocument();
  });

  it('OPMS 에 없는 클래스(버튼 헤드)는 클래스 없이 치수와 머리 모양으로만 매칭하고, 머리 모양이 다른 보유 품번은 후보가 아니다', async () => {
    const user = userEvent.setup();
    await renderPage();
    let steps = await pick(user, 'PRT-B1');
    await user.click(await within(await shapeBlock()).findByRole('button', { name: '버튼헤드볼트 이 종류로 확정' }));
    await confirmAttrs(user, /^나사 규격 M4 확정$/, /^길이 8 mm 확정$/);
    await waitFor(() => expect(chipOf(steps, 'PRT-B1')).toHaveTextContent('후보 P-T0000000005'));    // 버튼머리나사 M4x8 (ISO 7380)

    steps = await pick(user, 'PRT-C1');
    await user.click(await within(await shapeBlock()).findByRole('button', { name: '접시머리볼트 이 종류로 확정' }));
    await confirmAttrs(user, /^나사 규격 M4 확정$/, /^길이 8 mm 확정$/);
    await waitFor(() => expect(chipOf(steps, 'PRT-C1')).toHaveTextContent('분류 볼트'));             // 같은 M4×8 이어도 머리 모양이 다르다: 후보 없음, 분류만 볼트
    expect(chipOf(steps, 'PRT-C1')).not.toHaveTextContent('P-T000');
  });

  it('확정한 클래스가 조립 규칙을 고른다: 이름이 볼트가 아니어도 육각 렌치 · 토크가 안내에 뜬다', async () => {
    const user = userEvent.setup();
    await renderPage();
    await pick(user, 'PRT-S1');
    const card = () => screen.findByRole('complementary', { name: '조립 안내' });
    expect(await card()).not.toHaveTextContent('체결 토크');                                      // 확정 전: 이 부품에 걸리는 규칙이 없다

    await user.click(await within(await shapeBlock()).findByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }));
    await confirmAttrs(user, /^나사 규격 M6 확정$/, /^육각구멍 크기 5 mm 확정$/);
    const hud = await card();
    await waitFor(() => expect(hud).toHaveTextContent('9.5 N·m ±10%'));                         // M6 소켓 헤드(가상 조건표)
    expect(hud).toHaveTextContent('육각 렌치 5 mm');
    expect(hud).toHaveTextContent('가상 값입니다');
    const last = guideInputs[guideInputs.length - 1]!.find(p => p.name === 'PRT-S1')!;
    expect(last).toMatchObject({ fastenerClass: 'SocketHeadBolt', attributes: { threadSize: 'M6', socketSize: 5, headType: 'Socket' } });
  });

  it('확정한 볼트 종류는 CAD 별로 기억돼 다시 열어도 남는다', async () => {
    const user = userEvent.setup();
    const first = await renderPage();
    await pick(user, 'PRT-B1');
    await user.click(await within(await shapeBlock()).findByRole('button', { name: '버튼헤드볼트 이 종류로 확정' }));
    await waitFor(() => {
      const raw = Object.entries(window.localStorage).find(([k]) => k.startsWith('onto-pdm.cad.state.cad:'))?.[1];
      expect(JSON.parse(raw ?? '{}').fastener).toEqual([['PRT-B1', 'ButtonHeadBolt']]);
    });
    first.unmount();

    await renderPage();
    await pick(user, 'PRT-B1');
    const block = await shapeBlock();
    expect(await within(block).findByRole('button', { name: '버튼헤드볼트 확정 취소' })).toBeInTheDocument();
    expect(within(block).getByText('OPMS 분류 등록 요청 초안')).toBeInTheDocument();
  });
});
