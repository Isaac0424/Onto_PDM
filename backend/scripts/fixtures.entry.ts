// export_fixtures.mjs 가 번들해서 Node 로 실행한다. 웹의 목 API(web/src/api/mock)를 그대로 돌려 두 가지를 만든다.
//   src/onto_pdm/seed/seed.json   목 데이터(시드) 원본 — 백엔드 인메모리 저장소가 읽는다
//   tests/fixtures/parity.json    대표 입력에 대한 목 API 의 결과 — Python 구현이 같은 결과를 내는지 시험이 비교한다
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createMockApi } from '../../web/src/api/mock/mockApi';
import { createSeed } from '../../web/src/api/mock/seed';

const root = process.env.BACKEND_ROOT!;

const sessions = {
  admin: { userId: 1, adminMode: true },        // 김관리 · 관리자 모드 켬
  admin_off: { userId: 1, adminMode: false },   // 관리자 역할이지만 모드 끔
  engineer: { userId: 2, adminMode: false },    // 이설계
} as const;
type Who = keyof typeof sessions;

const NAMES = [
  '전원 버튼', '기판 나사 M3', '하우징', 'p 00000000121', '상부 커버', '제어 기판', '배터리', 'J1 브레이크', '스페이서', '러그',
  'J1 감속기', 'Bolt M3x8', 'M3x8', '볼트 M3x8', 'bolt m3x8', '서보 모터 400W', '케이블 하네스', '사파이어 크리스털', '볼펜 심', 'Base_HCR3A',
  'ERP-77121', 'P-00000000001', '좌측 커버 나사 M3', '우측 커버', '절대값 엔코더',
];
const PARTS = [
  { name: '기판 나사 M3', size: [3, 3, 8] }, { name: '상부 커버', size: [126, 80, 3] }, { name: '좌측 커버', size: [3, 80, 30] },
  { name: '제어 기판' }, { name: '스페이서' }, { name: '배터리' }, { name: '전원 버튼' }, { name: 'J1 감속기' }, { name: '서보 모터 400W' },
  { name: 'J1 하우징' }, { name: '러그', size: [3, 2.6, 7] }, { name: '러그', size: [20, 8, 30] }, { name: '러그', size: [20, 1.2, 30] },
  { name: '러그', size: [20, 5, 30] }, { name: '사파이어 크리스털' }, { name: '볼펜 심' }, { name: '상부 커버' }, { name: '하우징 보강재' },
  // 분류와 속성이 들어온 부품: 규칙은 이름보다 분류와 속성에 걸린다
  { name: '육각 렌치 볼트', className: '볼트', attributes: { threadSize: 'M3' } },
  { name: '육각 렌치 볼트', className: '체결류 › 볼트', attributes: { threadSize: 'm3' } },
  { name: '기판 나사 M3', className: '볼트', attributes: { threadSize: 'M4' } },
  { name: 'M3 볼트', className: '커버' },
  { name: '덮개', className: '커버', size: [100, 60, 2] },
  { name: '덮개', className: '커버', attributes: { thickness: 4 }, size: [100, 60, 2] },
  { name: '덮개', className: '커버', attributes: { thickness: '5.5' } },
  { name: '덮개', className: '커버', attributes: { thickness: 0 }, size: [100, 60, 2] },
  { name: '러그', attributes: { thickness: 8 } },
  { name: '러그', attributes: { thickness: 1 } },
  { name: '정체불명', className: '하우징' },
  { name: '제어 기판', className: '하우징' },
  { name: '감속기 하우징', className: '감속기' },
  { name: '모터 커버', className: '서보 모터' },
];
const RULE_IDS = ['SP-FAS-01', 'SP-CVR-01', 'SP-ELC-01', 'SP-SPC-01', 'SP-BAT-01', 'SP-SW-01', 'SP-RED-01', 'SP-MOT-01', 'SP-HSG-01', 'SP-WLD-01', 'SP-PRS-01', 'SP-NOPE'];

async function capture<T>(fn: () => Promise<T>): Promise<{ ok: T } | { error: { status: number; message: string } }> {
  try { return { ok: await fn() }; } catch (e) {
    const err = e as { status?: number; message?: string };
    return { error: { status: err.status ?? 500, message: err.message ?? String(e) } };
  }
}

const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v));    // undefined 를 없앤다 (JSON 과 같게)

async function main() {
  const cases: unknown[] = [];
  const seed0 = createSeed();
  const keyItems = ['P-00000000100', 'P-00000000200', 'P-00000000110', 'P-00000000120', 'P-00000000112', 'P-00000000150'];
  const bomRevisions = [...seed0.revisions.filter(r => keyItems.includes(seed0.items.find(i => i.id === r.itemId)!.itemNo)).map(r => r.id), 999];
  for (const who of Object.keys(sessions) as Who[]) {
    const session = { ...sessions[who] };
    const api = createMockApi(() => session);
    const rec = async (op: string, input: unknown, fn: () => Promise<unknown>) =>
      cases.push(strip({ op, who, input, result: await capture(fn) }));

    await rec('matchCadParts', NAMES, () => api.matchCadParts(NAMES));
    await rec('getAssemblyGuides', PARTS, () => api.getAssemblyGuides(PARTS as never));
    await rec('listAssemblyRules', null, () => api.listAssemblyRules());
    for (const id of RULE_IDS) await rec('getAssemblyRule', id, () => api.getAssemblyRule(id));

    const queries = [{}, { q: 'BLT-0038' }, { q: '볼트' }, { itemType: 'standard' }, { itemType: 'assembly' }, { status: 'wip' }, { status: 'released' }, { productId: 1 }, { productId: 2 }];
    for (const q of queries) await rec('listItems', q, () => api.listItems(q as never));
    for (const no of ['P-00000000100', 'P-00000000150', 'P-00000000112', 'P-00000000001', 'P-99999999999'])
      await rec('getItem', no, () => api.getItem(no));
    // 제품 루트 · 조립품 리비전의 BOM: 규칙 두 가지. (없는 리비전 번호 하나는 404 시험)
    if (who !== 'admin_off') {
      for (const rev of bomRevisions)
        for (const rule of ['released', 'latest'] as const) await rec('getBom', { rev, rule }, () => api.getBom(rev, rule));
    }
    for (const rev of [1, 5, 8, 14, 99]) await rec('getDocuments', rev, () => api.getDocuments(rev));
    for (const id of [1, 2, 5, 8, 9, 14, 19]) await rec('getWhereUsed', id, () => api.getWhereUsed(id));
  }

  const seed = createSeed();
  mkdirSync(path.join(root, 'src/onto_pdm/seed'), { recursive: true });
  mkdirSync(path.join(root, 'tests/fixtures'), { recursive: true });
  writeFileSync(path.join(root, 'src/onto_pdm/seed/seed.json'), JSON.stringify(strip(seed), null, 1) + '\n', 'utf-8');
  writeFileSync(path.join(root, 'tests/fixtures/parity.json'), JSON.stringify({ generatedFrom: 'web/src/api/mock', cases }) + '\n', 'utf-8');
  console.log(`seed + parity fixture: ${cases.length} cases`);
}

main();
