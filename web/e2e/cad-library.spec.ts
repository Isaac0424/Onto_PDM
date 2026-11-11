// 등록한 CAD 목록: 올린 CAD 가 화면을 옮기거나 새로고침해도 남는다 (실제 브라우저의 IndexedDB 와 실제 3D 뷰어).
// 서버 DB(/api/cads)와 보관소(/api/files)는 가짜 서버로 가로챈다(cad-fixtures.ts 의 test): 이 컴퓨터에 서버가 떠 있어도 시험 파일이 실제 DB 에 쌓이지 않게 한다.
import { type Page } from '@playwright/test';
import { cubeStl, expect, test } from './cad-fixtures';

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test('등록한 CAD 는 화면을 옮기고 새로고침해도 목록에 남고, 보던 모델이 그대로 열린다', async ({ page, server }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('.holo-host canvas').first()).toBeAttached({ timeout: 20_000 });
  const lib = page.getByRole('region', { name: '등록한 CAD' });
  await expect(lib.getByText(/아직 등록한 CAD가 없어요/)).toBeVisible();

  // 1) 등록: 목록에 올라가고 열린다
  await page.getByLabel('CAD 파일').setInputFiles({ name: 'cube-a.stl', mimeType: 'model/stl', buffer: cubeStl('a') });
  const card = lib.getByRole('button', { name: 'cube-a.stl 열기' });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.holo-model')).toContainText('cube-a', { timeout: 20_000 });
  await expect(lib.getByText(/부품 \d+개/)).toBeVisible({ timeout: 20_000 });          // 분석이 끝나면 부품 수가 목록에 남는다
  await expect(card).toContainText('서버 DB 저장됨');                                     // 서버 DB 에 저장됐다
  expect(server.count('POST', '/api/cads')).toBe(1);
  expect(server.rows.size).toBe(1);
  expect(server.count('POST', '/api/files')).toBe(0);                                   // CAD 는 보관소로 따로 올리지 않는다 (서버가 DB 에 저장하며 복사한다)

  // 2) 다른 화면으로 옮겼다가 돌아와도: 목록이 남고, 보던 CAD 가 다시 열려 있다 (빈 화면이 되지 않는다)
  await page.getByRole('link', { name: '조립 규칙' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '조립 규칙' })).toBeVisible();
  await page.getByRole('link', { name: 'CAD 스튜디오' }).click();
  const back = page.getByRole('region', { name: '등록한 CAD' }).getByRole('button', { name: 'cube-a.stl 열기' });
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.holo-model')).toContainText('cube-a', { timeout: 20_000 });

  // 3) 새로고침해도 남는다
  await page.reload();
  const afterReload = page.getByRole('region', { name: '등록한 CAD' }).getByRole('button', { name: 'cube-a.stl 열기' });
  await expect(afterReload).toBeVisible();
  await expect(afterReload).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.holo-model')).toContainText('cube-a', { timeout: 20_000 });
  expect(errors.filter(e => !/Failed to load resource/.test(e))).toEqual([]);
});

test('여러 CAD 를 등록해 오가고, 목록에서 제거할 수 있다', async ({ page, server }) => {
  await page.goto('/');
  await expect(page.locator('.holo-host canvas').first()).toBeAttached({ timeout: 20_000 });
  const lib = page.getByRole('region', { name: '등록한 CAD' });

  await page.getByLabel('CAD 파일').setInputFiles({ name: 'cube-a.stl', mimeType: 'model/stl', buffer: cubeStl('a', 10) });
  await expect(lib.getByRole('button', { name: 'cube-a.stl 열기' })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('CAD 파일').setInputFiles({ name: 'cube-b.stl', mimeType: 'model/stl', buffer: cubeStl('b', 20) });
  await expect(lib.getByRole('button', { name: 'cube-b.stl 열기' })).toHaveAttribute('aria-current', 'true', { timeout: 20_000 });

  // 목록의 다른 CAD 를 누르면 그 CAD 가 열린다 (예시 모델은 없다)
  await lib.getByRole('button', { name: 'cube-a.stl 열기' }).click();
  await expect(lib.getByRole('button', { name: 'cube-b.stl 열기' })).not.toHaveAttribute('aria-current', 'true');
  await expect(lib.getByRole('button', { name: 'cube-a.stl 열기' })).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.holo-model')).toContainText('cube-a', { timeout: 20_000 });

  // 제거: 취소하면 그대로, 확인하면 사라지고 새로고침해도 돌아오지 않는다
  page.once('dialog', d => void d.dismiss());
  await lib.getByRole('button', { name: 'cube-b.stl 목록에서 제거' }).click();
  await expect(lib.getByRole('button', { name: 'cube-b.stl 열기' })).toBeVisible();
  page.once('dialog', d => void d.accept());
  await lib.getByRole('button', { name: 'cube-b.stl 목록에서 제거' }).click();
  await expect(lib.getByRole('button', { name: 'cube-b.stl 열기' })).toHaveCount(0);
  await page.reload();
  const again = page.getByRole('region', { name: '등록한 CAD' });
  await expect(again.getByRole('button', { name: 'cube-a.stl 열기' })).toBeVisible();
  await expect(again.getByRole('button', { name: 'cube-b.stl 열기' })).toHaveCount(0);
  expect([...server.rows.values()].filter(r => !r.deleted).map(r => r.name)).toEqual(['cube-a.stl']);   // 서버 DB 에서도 목록에서 빠졌다
});

test('보관소 서버에만 있는 CAD 를 목록으로 가져온다', async ({ page }) => {
  await page.route('**/api/files**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/content')) return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: cubeStl('remote') });
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ sha256: 'e'.repeat(64), name: 'remote.stl', size: 600, format: 'stl', kind: 'cad', uploadedAt: '2026-11-11T09:00:00Z' }]),
    });
  });
  await page.goto('/');
  const lib = page.getByRole('region', { name: '등록한 CAD' });
  await lib.getByRole('button', { name: '보관소에서 가져오기' }).click();
  await lib.getByRole('region', { name: '보관소의 CAD' }).getByRole('button', { name: 'remote.stl 가져오기' }).click();
  await expect(lib.getByRole('button', { name: 'remote.stl 열기' })).toHaveAttribute('aria-current', 'true', { timeout: 20_000 });
  await page.reload();                                                                    // 가져온 CAD 도 이 브라우저에 남는다
  await expect(page.getByRole('region', { name: '등록한 CAD' }).getByRole('button', { name: 'remote.stl 열기' })).toBeVisible();
});

test('모바일(390px)에서도 목록이 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  await page.getByLabel('CAD 파일').setInputFiles({ name: 'a-very-long-cad-file-name-for-mobile-layout.stl', mimeType: 'model/stl', buffer: cubeStl('m') });
  await expect(page.getByRole('region', { name: '등록한 CAD' }).getByRole('button', { name: /열기$/ })).toBeVisible({ timeout: 20_000 });
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
});
