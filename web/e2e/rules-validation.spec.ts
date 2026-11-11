// 조립 규칙 화면의 규칙 검증 영역(PRD F-RUL-6)을 실제 브라우저로 확인한다.
// 실행: E2E_PORT=5182 pnpm e2e e2e/rules-validation.spec.ts  (playwright.config.ts 가 이 포트로 자기 서버를 띄운다)
import { expect, test, type Page } from '@playwright/test';

/** 콘솔 오류 · 페이지 오류 · 400 이상 응답을 모은다 */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return errors;
}

test('규칙 검증: 오류 0 · 경고 2(검토 전 규칙 둘)를 보이고, 링크가 그 규칙의 상세를 연다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/rules');

  const check = page.getByRole('region', { name: '규칙 검증' });
  await expect(check.getByText('오류 0')).toBeVisible();
  await expect(check.getByText('경고 2')).toBeVisible();
  const items = check.getByRole('list', { name: '검증 결과' });
  await expect(items.getByRole('listitem')).toHaveCount(2);
  await expect(items).toContainText('검토 전 규칙');

  // 문제가 있는 규칙(용접 · 압입)에만 목록 표식이 붙는다
  await expect(page.getByLabel('검증 문제 1건')).toHaveCount(2);

  await items.getByRole('link', { name: 'SP-WLD-01' }).click();
  await expect(page).toHaveURL(/\/rules\/SP-WLD-01$/);
  const detail = page.getByRole('region', { name: '규칙 상세' });
  await expect(detail.getByRole('heading', { level: 2, name: '박판 용접 (가상 조건표)' })).toBeVisible();
  await expect(detail.getByRole('region', { name: '이 규칙의 검증 결과' })).toContainText('검토 전 규칙');

  // 접어도 개수는 남고, 다시 펼치면 목록이 돌아온다
  await check.getByRole('button', { name: '접기' }).click();
  await expect(items).toHaveCount(0);
  await expect(check.getByText('경고 2')).toBeVisible();
  await check.getByRole('button', { name: '자세히' }).click();
  await expect(check.getByRole('list', { name: '검증 결과' })).toBeVisible();

  await check.getByRole('button', { name: /다시 검증/ }).click();
  await expect(check.getByText('경고 2')).toBeVisible();
  expect(errors).toEqual([]);
});

test('규칙 검증: 모바일(390px)에서 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/rules');
  await expect(page.getByRole('region', { name: '규칙 검증' }).getByText('경고 2')).toBeVisible();
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
});
