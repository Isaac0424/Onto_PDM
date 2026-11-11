// 실제 브라우저 · 실제 3D 뷰어 · http 모드: 볼트를 고르면 속성 탭에 "OPMS 필수 속성" 체크리스트가 나온다.
// 백엔드 호출(/api/v1/pdm)은 가짜로 가로챈다(src/api/testBackend.ts, 실제 SocketHeadBolt 필수 속성 모양): 실제 백엔드 · OPMS DB 에 의존하지 않는다.
// 서버 DB · 보관소는 cad-fixtures.ts 가 가로챈다. http 모드 개발 서버(E2E_PORT + 1)를 쓴다. 실행: E2E_PORT=5203 pnpm e2e e2e/opms-required.spec.ts
import { type Page } from '@playwright/test';
import { fakeBackend, socketPart, type FakeBackend } from '../src/api/testBackend';
import { expect, partRows, test, uploadBolts } from './cad-fixtures';

const HTTP_PORT = Number(process.env.E2E_PORT ?? 5174) + 1;
test.use({ baseURL: `http://localhost:${HTTP_PORT}` });

async function routeBackend(page: Page, fake: FakeBackend) {
  await page.route('**/api/v1/pdm/**', async route => {
    const req = route.request();
    try {
      const res = await fake.fetch(new URL(req.url()).pathname, { method: req.method(), ...(req.postData() ? { body: req.postData()! } : {}) });
      await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
    } catch { await route.abort('connectionrefused'); }
  });
}

const stepRow = (page: Page, name: string) => partRows(page).filter({ hasText: name }).first();
const checklist = (page: Page) => page.getByRole('region', { name: 'OPMS 필수 속성' });
const reqRow = (page: Page, label: string) => checklist(page).locator('.req-row').filter({ has: page.locator('.req-label', { hasText: new RegExp(`^${label}$`) }) });

async function selectPart(page: Page, name: string) {
  const tab = page.getByRole('tab', { name: /^속성/ });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await stepRow(page, name).click();
}

test('볼트를 고르면 OPMS 필수 속성 8개가 상태별로 나오고, 규격을 확정하면 확인이 늘어난다 (빨강 없음)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  const fake = fakeBackend({ parts: [socketPart(101, 25, 'SCM435', 'M6')] });
  await routeBackend(page, fake);
  await page.goto('/');
  await uploadBolts(page);

  await selectPart(page, 'PRT-S1');                                      // 육각구멍붙이 M6×25
  await expect(checklist(page).getByRole('heading', { level: 3 })).toContainText('OPMS 필수 속성 · 확인 2/8', { timeout: 30_000 });
  await expect(checklist(page)).toContainText('육각구멍붙이볼트 기준');
  await expect(checklist(page).getByRole('status', { name: '필수 속성 완성도' })).toContainText('확인 2/8 · 추정 3개 · 미확인 3개(재질, 표면처리, 강도 등급)');
  await expect(reqRow(page, '나사 규격')).toContainText('M6');
  await expect(reqRow(page, '나사 규격')).toContainText('CAD 추정');
  await expect(reqRow(page, '피치')).toContainText('1 mm');                // M6 보통 나사 피치 (OPMS 가 채운다)
  await expect(reqRow(page, '피치')).toContainText('OPMS가 채워요');
  await expect(reqRow(page, '나사 방향')).toContainText('오른나사');
  await expect(reqRow(page, '재질')).toContainText('미확인');
  await expect(reqRow(page, '재질')).toContainText('사양서·BOM에서 와요');
  await expect(page.getByRole('alert')).toHaveCount(0);                    // 오류 배너 없음

  const kind = page.getByRole('region', { name: '형상으로 본 볼트 종류' });
  await kind.getByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }).click();
  await page.getByRole('button', { name: /^나사 규격 M6 확정$/ }).click();
  await page.getByRole('button', { name: /^길이 25 mm 확정$/ }).click();
  await expect(checklist(page).getByRole('heading', { level: 3 })).toContainText('확인 4/8');
  await expect(reqRow(page, '나사 규격')).toContainText('확정');
  await expect(reqRow(page, '피치')).not.toContainText('추정이라 다시 확인');
  expect(fake.calls.filter(c => c.path === '/opms/classes/SocketHeadBolt')).toHaveLength(1);       // 분류별로 한 번만 읽는다
  expect(errors).toEqual([]);

  // 볼트가 아닌 부품에는 체크리스트가 없다
  await selectPart(page, 'PRT-PLATE');
  await expect(page.getByRole('region', { name: '속성 후보' })).toBeVisible();
  await expect(checklist(page)).toHaveCount(0);
});

test('OPMS 에 아직 없는 분류(버튼헤드)는 상위 분류(볼트) 기준이라고 밝히고 OPMS 에 묻지 않는다', async ({ page }) => {
  const fake = fakeBackend({ parts: [socketPart(101, 25, 'SCM435', 'M6')] });
  await routeBackend(page, fake);
  await page.goto('/');
  await uploadBolts(page);
  await selectPart(page, 'PRT-B1');                                      // 버튼 머리(OPMS 미등록 제안)
  await expect(checklist(page)).toContainText('볼트 기준', { timeout: 30_000 });
  await expect(checklist(page)).toContainText('OPMS에 아직 없어 상위 분류로 확인해요');
  expect(fake.calls.filter(c => c.path === '/opms/classes/ButtonHeadBolt')).toHaveLength(0);
});

test('백엔드가 꺼져 있으면 "OPMS에 연결되면 필수 속성을 확인해요" (오류 배너 아님)', async ({ page }) => {
  await routeBackend(page, fakeBackend({ parts: [socketPart(101, 25, 'SCM435', 'M6')], backend: 'down' }));
  await page.goto('/');
  await uploadBolts(page);
  await selectPart(page, 'PRT-S1');
  await expect(page.getByRole('status', { name: 'OPMS 필수 속성' })).toContainText('OPMS에 연결되면 필수 속성을 확인해요.', { timeout: 30_000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(checklist(page)).toHaveCount(0);
});

test('모바일(390px)에서도 체크리스트가 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await routeBackend(page, fakeBackend({ parts: [socketPart(101, 25, 'SCM435', 'M6')] }));
  await page.goto('/');
  await uploadBolts(page);
  await selectPart(page, 'PRT-S1');
  await expect(checklist(page).getByRole('heading', { level: 3 })).toContainText('확인 2/8', { timeout: 30_000 });
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
});
