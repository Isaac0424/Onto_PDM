// 실제 브라우저 · 실제 3D 뷰어 · http 모드(PDM 백엔드 → OPMS): 확정한 볼트 규격으로 보유 품번(OPMS 부품)을 찾고, 연결 상태를 정직하게 보인다.
// 백엔드 호출(/api/v1/pdm)은 가짜로 가로챈다(src/api/testBackend.ts): 실제 백엔드 · OPMS DB 에 의존하지 않는다. 서버 DB · 보관소도 cad-fixtures.ts 가 가로챈다.
// 이 파일은 playwright.config.ts 의 두 번째 개발 서버(E2E_PORT + 1, VITE_API_MODE=http)를 쓴다. 실행: E2E_PORT=5196 pnpm e2e e2e/opms-connection.spec.ts
import { type Page } from '@playwright/test';
import { fakeBackend, socketPart, type FakeBackend } from '../src/api/testBackend';
import { expect, partRows, test, uploadBolts } from './cad-fixtures';

const HTTP_PORT = Number(process.env.E2E_PORT ?? 5174) + 1;
test.use({ baseURL: `http://localhost:${HTTP_PORT}` });

/** OPMS 에 있다고 치는 보유 볼트: PRT-S1(육각구멍붙이 M6×25)과 같은 규격이 재질만 다른 둘 */
const OPMS_PARTS = [socketPart(101, 25, 'SCM435', 'M6'), socketPart(102, 25, 'SUS304', 'M6')];

async function routeBackend(page: Page, fake: FakeBackend) {
  await page.route('**/api/v1/pdm/**', async route => {
    const req = route.request();
    try {
      const res = await fake.fetch(new URL(req.url()).pathname, { method: req.method(), ...(req.postData() ? { body: req.postData()! } : {}) });
      await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
    } catch { await route.abort('connectionrefused'); }               // 백엔드가 꺼진 것을 흉내 낸다
  });
}

const statusLine = (page: Page) => page.locator('.opms-line');
const stepRow = (page: Page, name: string) => partRows(page).filter({ hasText: name }).first();

async function selectPart(page: Page, name: string) {
  const tab = page.getByRole('tab', { name: /^속성/ });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await stepRow(page, name).click();
}

/** PRT-S1: 형상으로 본 종류와 나사 규격 · 길이를 확정한다 */
async function confirmSocketSpec(page: Page) {
  await selectPart(page, 'PRT-S1');
  const block = page.getByRole('region', { name: '형상으로 본 볼트 종류' });
  await expect(block).toBeVisible({ timeout: 20_000 });
  await block.getByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }).click();
  await page.getByRole('button', { name: /^나사 규격 M6 확정$/ }).click();
  await page.getByRole('button', { name: /^길이 25 mm 확정$/ }).click();
}

test('OPMS 연결됨: 확정 전에도 CAD 형상 추정 규격으로 "후보 · 추정"이 올라오고, 규격을 확정하면 추정이 사라지고 하나를 고르면 보유 품번이 된다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  const fake = fakeBackend({ parts: OPMS_PARTS });
  await routeBackend(page, fake);
  await page.goto('/');

  await expect(statusLine(page)).toContainText('OPMS 연결됨');
  await expect(statusLine(page)).toContainText('온톨로지 0.15.0');
  await expect(statusLine(page)).toContainText('부품 2개');
  await uploadBolts(page);

  // 확정하지 않았는데도 형상이 추정한 규격(M6 · 25 mm)으로 OPMS 부품이 후보로 올라온다. 후보 · 추정일 뿐 보유 품번이 아니다
  const steps = page.getByRole('region', { name: '제조 순서' });
  await expect(stepRow(page, 'PRT-S1')).toContainText('후보 2개 · 추정', { timeout: 30_000 });
  await expect(stepRow(page, 'PRT-H1')).toContainText('미보유 · 추정 규격', { timeout: 30_000 });      // OPMS 에 육각볼트 M6×25 는 없다: 못 찾았다
  await expect(steps.getByText('보유 0')).toBeVisible();                                                 // 자동 확정은 없다
  // 추정할 수 없는 부품(구멍을 생략한 단순화 모델 · 판 · 너트)은 규격을 확정해야 찾는다
  for (const name of ['PRT-X1', 'PRT-PLATE', 'PRT-NUT']) await expect(stepRow(page, name)).toContainText('규격 확정 필요');
  await expect(steps.getByText(/규격 확정 대기 \d/)).toBeVisible();
  const asked = fake.calls.filter(c => c.path === '/opms/match');
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.length).toBeLessThanOrEqual(5);                                                           // 볼트 5종(서로 다른 규격)만큼, 부품 8개만큼 묻지 않는다

  await confirmSocketSpec(page);
  await expect(stepRow(page, 'PRT-S1')).toContainText('후보 2개');
  await expect(stepRow(page, 'PRT-S1')).not.toContainText('추정');                                       // 사람이 확정하면 추정 표시가 사라진다
  await page.getByRole('tab', { name: '온톨로지' }).click();
  const list = page.getByRole('list', { name: '보유 품번 후보' });
  await expect(list.locator('.cand')).toHaveCount(2);
  await expect(list).toContainText('육각구멍붙이볼트 M6 · 25 mm · SUS304');
  await expect(page.getByRole('list', { name: 'P-00000000102 일치 근거' })).toContainText('나사 규격 M6 일치');
  await expect(list.locator('.cand-score').first()).toContainText('확인한 2개 속성이 모두 일치 · 미확인 1개(재질)');   // 100% 가 아니라 확인한 것과 미확인을 말한다
  await expect(list).not.toContainText('100%');
  const bodies = fake.calls.filter(c => c.path === '/opms/match').map(c => c.body);
  expect(bodies).toContainEqual({ class_code: 'SocketHeadBolt', head_type: 'Socket', values: { threadSize: 'M6', length: 25 } });
  expect(bodies.filter(b => JSON.stringify(b).includes('SocketHeadBolt'))).toHaveLength(1);                // 확정해도 같은 규격이라 다시 묻지 않는다

  await list.getByRole('button', { name: 'P-00000000102 이 품번으로 확정' }).click();
  await expect(stepRow(page, 'PRT-S1')).toContainText('P-00000000102');
  await expect(stepRow(page, 'PRT-S1')).not.toContainText('후보');
  await page.getByRole('tab', { name: '온톨로지' }).click();
  await expect(page.getByRole('img', { name: /PRT-S1 온톨로지 그래프/ })).toContainText('SUS304');   // OPMS 부품의 속성이 그래프에 보인다
  expect(errors).toEqual([]);

  // 판은 볼트가 아니라 규격을 확정할 것이 없다: 그대로 "규격 확정 필요"
  await expect(stepRow(page, 'PRT-PLATE')).toContainText('규격 확정 필요');
});

test('추정 규격으로 찾은 부품을 고르면 온톨로지 탭에 추정 안내 한 줄이 있고 후보는 "확인한 N개 · 미확인 M개"로 보인다', async ({ page }) => {
  await routeBackend(page, fakeBackend({ parts: OPMS_PARTS }));
  await page.goto('/');
  await uploadBolts(page);
  await expect(stepRow(page, 'PRT-S1')).toContainText('후보 2개 · 추정', { timeout: 30_000 });
  await stepRow(page, 'PRT-S1').click();
  await page.getByRole('tab', { name: '온톨로지' }).click();
  await expect(page.getByText(/CAD 형상에서 M6 · 25 mm 로 추정해 찾았어요\. 규격을 확정하면 더 정확해져요/)).toBeVisible();
  const first = page.getByRole('list', { name: '보유 품번 후보' }).locator('.cand-score').first();
  await expect(first).toContainText('확인한 2개 속성이 모두 일치 · 미확인 1개(재질)');
  await expect(first).toHaveAttribute('title', /가중 점수 100%/);
});

test('백엔드가 꺼져 있으면 "PDM 백엔드가 꺼져 있어요" + "연결 안 됨"(미보유 아님). 켜고 다시 시도하면 연결되어 후보를 다시 찾는다', async ({ page }) => {
  const fake = fakeBackend({ parts: OPMS_PARTS, backend: 'down' });
  await routeBackend(page, fake);
  await page.goto('/');

  await expect(statusLine(page)).toContainText('PDM 백엔드가 꺼져 있어요');
  await expect(statusLine(page).getByRole('button', { name: '다시 시도' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);                                                // 빨간 오류 배너가 아니다
  await uploadBolts(page);
  await confirmSocketSpec(page);
  await expect(stepRow(page, 'PRT-S1')).toContainText('연결 안 됨');
  await expect(stepRow(page, 'PRT-S1')).not.toContainText('미보유');

  fake.state.backend = 'up';
  await statusLine(page).getByRole('button', { name: '다시 시도' }).click();
  await expect(statusLine(page)).toContainText('OPMS 연결됨');
  await expect(stepRow(page, 'PRT-S1')).toContainText('후보 2개');
});

test('백엔드는 켜져 있고 OPMS(Neo4j)만 꺼져 있으면 그 이유를 구분해 말한다', async ({ page }) => {
  await routeBackend(page, fakeBackend({ parts: OPMS_PARTS, opms: 'OPMS_UNAVAILABLE' }));
  await page.goto('/');
  await expect(statusLine(page)).toContainText('OPMS에 연결하지 못했어요');
  await expect(statusLine(page)).not.toContainText('PDM 백엔드가 꺼져 있어요');
});

test('모바일(390px)에서도 연결 상태 줄 · 후보 목록이 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await routeBackend(page, fakeBackend({ parts: OPMS_PARTS }));
  await page.goto('/');
  await expect(statusLine(page)).toContainText('OPMS 연결됨');
  await uploadBolts(page);
  await confirmSocketSpec(page);
  await page.getByRole('tab', { name: '온톨로지' }).click();
  await expect(page.getByRole('list', { name: '보유 품번 후보' }).locator('.cand')).toHaveCount(2);
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
});
