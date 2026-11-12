// E2E 공용 헬퍼: 예시(목업) 모델이 없으므로, 시험은 CAD 파일을 직접 올려서 같은 흐름을 확인한다.
// OBJ 는 `o 이름` 객체마다 부품 하나로 읽히고(뷰어가 객체 이름을 부품 이름으로 쓴다), 위아래로 쌓으면 단계로 나뉜다.
import { test as base, expect, type Page } from '@playwright/test';
import { fakeServer, type FakeServer } from './fake-server';
import { boltMesh, nutMesh, plateMesh, randomRotation, transform, type Mesh } from '../src/extract/fastener.fixtures';

export { expect };
export type { FakeServer };

type Box = [name: string, x: number, y: number, z: number, w: number, d: number, h: number];

/** 직육면체 객체들을 OBJ 본문으로 만든다 (객체마다 꼭짓점 8개 + 면 6개) */
function objOf(parts: Box[]): Buffer {
  let base = 0;
  let out = '';
  for (const [name, x, y, z, w, d, h] of parts) {
    const v = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]]
      .map(([a, b, c]) => `v ${a! + x} ${b! + y} ${c! + z}`).join('\n');
    const f = [[1, 2, 3, 4], [5, 8, 7, 6], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 8, 4], [4, 8, 5, 1]]
      .map(q => `f ${q.map(i => i + base).join(' ')}`).join('\n');
    out += `o ${name}\n${v}\n${f}\n`;
    base += 8;
  }
  return Buffer.from(out);
}

export type AssemblyKind = 'electronics' | 'frame';

/** 부품 이름 (제조 순서 패널의 행 이름) */
export const ASSEMBLY_PARTS: Record<AssemblyKind, string[]> = {
  electronics: ['하우징', '제어 기판', '기판 나사 M3', '전원 버튼', '상부 커버'],
  frame: ['프레임 본체', '브래킷', '볼트 M8'],
};

/**
 * CAD 조립품 OBJ.
 * - electronics: 하우징 120×80×20, 제어 기판 96×60×2, 기판 나사 M3 3×3×8, 전원 버튼 10×10×4, 상부 커버 126×80×3.
 *   이름에서 뽑는 속성 후보(기판 나사 M3 → 나사 규격 M3)와 크기에서 계산하는 후보(두께 등)를 시험하기 좋은 이름이다. 보유 품번 · 조립 규칙 데이터는 없다(OPMS 연결 전).
 * - frame: 다른 CAD 로 바꿔 열었는지 구분하려는 두 번째 조립품 (프레임 본체 · 브래킷 · 볼트 M8).
 */
export function assemblyObj(kind: AssemblyKind = 'electronics'): Buffer {
  if (kind === 'frame') {
    return objOf([['프레임 본체', 0, 0, 0, 100, 60, 10], ['브래킷', 10, 10, 12, 40, 20, 3], ['볼트 M8', 20, 20, 16, 8, 8, 12]]);
  }
  return objOf([
    ['하우징', 0, 0, 0, 120, 80, 20],
    ['제어 기판', 10, 10, 22, 96, 60, 2],
    ['기판 나사 M3', 20, 20, 25, 3, 3, 8],
    ['전원 버튼', 100, 30, 22, 10, 10, 4],
    ['상부 커버', 0, 0, 32, 126, 80, 3],
  ]);
}

/** 볼트 형상 분류 시험용 부품 이름 (이름만 보면 볼트인지 알 수 없다: 형상으로만 구분된다) */
export const BOLT_PARTS = ['PRT-S1', 'PRT-H1', 'PRT-F1', 'PRT-B1', 'PRT-C1', 'PRT-X1', 'PRT-PLATE', 'PRT-NUT'] as const;

/** 메시 여러 개를 `o 이름` 객체로 이은 OBJ (꼭짓점 번호는 파일 전체에서 이어진다) */
function meshesObj(items: { name: string; mesh: Mesh }[]): Buffer {
  const lines: string[] = [];
  let off = 0;
  for (const { name, mesh } of items) {
    lines.push(`o ${name}`);
    for (let i = 0; i < mesh.positions.length; i += 3) lines.push(`v ${mesh.positions[i]!.toFixed(5)} ${mesh.positions[i + 1]!.toFixed(5)} ${mesh.positions[i + 2]!.toFixed(5)}`);
    for (let i = 0; i < mesh.indices.length; i += 3) lines.push(`f ${mesh.indices[i]! + 1 + off} ${mesh.indices[i + 1]! + 1 + off} ${mesh.indices[i + 2]! + 1 + off}`);
    off += mesh.positions.length / 3;
  }
  return Buffer.from(`${lines.join('\n')}\n`);
}

/**
 * 볼트 5종 + 판 + 너트 OBJ (임의 방향으로 놓여 있다). 모두 M6, 이름은 형상과 무관한 PRT-*.
 *  PRT-S1 육각구멍붙이 M6×25 · PRT-H1 육각 M6×25 · PRT-F1 육각플랜지 M6×20 · PRT-B1 버튼 M6×16 · PRT-C1 접시 M6×20(전체 길이)
 *  PRT-X1 육각구멍붙이 M6×20 이지만 구멍을 생략한 단순화 모델 · PRT-PLATE 판 · PRT-NUT 너트
 */
export function boltAssemblyObj(): Buffer {
  const at = (i: number, mesh: Mesh) => transform(mesh, { rotation: randomRotation(40 + i), translate: [i * 30, (i % 2) * 20, 0] });
  return meshesObj([
    { name: 'PRT-S1', mesh: at(0, boltMesh('socket', 'M6', 25)) },
    { name: 'PRT-H1', mesh: at(1, boltMesh('hex', 'M6', 25)) },
    { name: 'PRT-F1', mesh: at(2, boltMesh('flange', 'M6', 20)) },
    { name: 'PRT-B1', mesh: at(3, boltMesh('button', 'M6', 16)) },
    { name: 'PRT-C1', mesh: at(4, boltMesh('countersunk', 'M6', 20)) },
    { name: 'PRT-X1', mesh: at(5, boltMesh('socket', 'M6', 20, { drive: 'none' })) },
    { name: 'PRT-PLATE', mesh: transform(plateMesh(60, 30, 4), { translate: [20, 70, 0] }) },
    { name: 'PRT-NUT', mesh: transform(nutMesh(10, 5, 6), { translate: [100, 40, 0] }) },
  ]);
}

/** 볼트 형상 CAD 를 올리고, 3D 가 그려지고 제조 순서에 부품 행이 나올 때까지 기다린다 */
export async function uploadBolts(page: Page, name = 'bolts.obj'): Promise<string> {
  await page.getByLabel('CAD 파일').setInputFiles({ name, mimeType: 'text/plain', buffer: boltAssemblyObj() });
  await expect(page.locator('.holo-host canvas').first()).toBeAttached({ timeout: 20_000 });
  await expect(partRows(page)).toHaveCount(BOLT_PARTS.length, { timeout: 30_000 });
  return name;
}

/** 10 mm 정육면체 STL (삼각형 12개, 부품 1개) */
export function cubeStl(name: string, size = 10): Buffer {
  const s = size;
  const tri = (a: number[], b: number[], c: number[]) =>
    `facet normal 0 0 0\n outer loop\n  vertex ${a.join(' ')}\n  vertex ${b.join(' ')}\n  vertex ${c.join(' ')}\n endloop\nendfacet\n`;
  const t = [
    [[0, 0, 0], [s, s, 0], [s, 0, 0]], [[0, 0, 0], [0, s, 0], [s, s, 0]],
    [[0, 0, s], [s, 0, s], [s, s, s]], [[0, 0, s], [s, s, s], [0, s, s]],
    [[0, 0, 0], [s, 0, 0], [s, 0, s]], [[0, 0, 0], [s, 0, s], [0, 0, s]],
    [[0, s, 0], [s, s, s], [s, s, 0]], [[0, s, 0], [0, s, s], [s, s, s]],
    [[0, 0, 0], [0, 0, s], [0, s, s]], [[0, 0, 0], [0, s, s], [0, s, 0]],
    [[s, 0, 0], [s, s, s], [s, 0, s]], [[s, 0, 0], [s, s, 0], [s, s, s]],
  ] as number[][][];
  return Buffer.from(`solid ${name}\n${t.map(([a, b, c]) => tri(a!, b!, c!)).join('')}endsolid ${name}\n`);
}

/**
 * 모든 시험이 쓰는 test: 서버 DB(/api/cads)와 파일 보관소(/api/files)를 가짜 서버로 자동으로 가로챈다(auto fixture).
 * 이 컴퓨터에 실제 서버(8788)가 떠 있어도 시험 CAD 가 실제 DB · 보관소에 쌓이지 않게 한다. 시험 본문에서 `server` 로 받아 호출 기록을 보거나 server.down 으로 서버를 끈다.
 * 새 창(context.newPage)에도 같은 가짜 서버가 걸린다 (브라우저 컨텍스트 단위).
 */
export const test = base.extend<{ server: FakeServer }>({
  server: [async ({ context }, use) => {
    // 등록한 CAD 목록은 기본이 접힘이다. 시험은 카드를 바로 누르므로 펼친 채 시작한다 (이미 정해 둔 값은 덮지 않는다)
    await context.addInitScript(() => { try { if (window.localStorage.getItem('onto-pdm.cad.lib-open') === null) window.localStorage.setItem('onto-pdm.cad.lib-open', '1'); } catch { /* 무시 */ } });
    await use(await fakeServer(context));
  }, { auto: true }],
});

/** 제조 순서 패널의 부품 행 */
export const partRows = (page: Page) => page.getByRole('region', { name: '제조 순서' }).locator('.part-row');

/** CAD 를 올리고, 3D 가 그려지고 제조 순서에 부품 행이 나올 때까지 기다린다 */
export async function uploadAssembly(page: Page, opts: { name?: string; kind?: AssemblyKind } = {}): Promise<string> {
  const kind = opts.kind ?? 'electronics';
  const name = opts.name ?? (kind === 'frame' ? 'frame.obj' : 'electronics-box.obj');
  await page.getByLabel('CAD 파일').setInputFiles({ name, mimeType: 'text/plain', buffer: assemblyObj(kind) });
  await expect(page.locator('.holo-host canvas').first()).toBeAttached({ timeout: 20_000 });
  await expect(partRows(page)).toHaveCount(ASSEMBLY_PARTS[kind].length, { timeout: 20_000 });
  return name;
}

/** 지금 제조 순서에 나온 부품 이름들 (행 순서와 무관하게 비교하려고 정렬해서 돌려준다) */
export async function shownParts(page: Page): Promise<string[]> {
  const names = await partRows(page).locator('.part-name').evaluateAll(els => els.map(e => (e.firstChild?.textContent ?? e.textContent ?? '').trim()));
  return names.sort();
}

/**
 * 3D 화면에서 부품이 있는 지점을 찾아 왼쪽 클릭으로 고른다 (모델이 화면 어디에 놓이는지는 뷰어가 정하므로 격자로 훑는다).
 * 부품이 골라지면 그 지점을 돌려준다. 고른 상태로 남는다.
 */
export async function clickOnPart(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator('.holo-host canvas').first().boundingBox())!;
  const card = page.locator('.holo-host .stage').getByRole('complementary', { name: '조립 안내' });
  for (const fy of [0.55, 0.65, 0.45, 0.75, 0.35, 0.85, 0.25]) {
    for (const fx of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const p = { x: box.x + box.width * fx, y: box.y + box.height * fy };
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(120);
      if ((await card.count()) > 0) return p;
    }
  }
  throw new Error('3D 화면에서 부품을 찾지 못했어요');
}
