// 작업 표준 화면(구 MES 발행)의 실제 브라우저 확인. 실행: E2E_PORT=5183 pnpm e2e e2e/mes.spec.ts
// MES 발행 · 내보내기 · 이력은 사용자 지시로 삭제했다. 미리보기만 남아 있다.
import { expect, test, type Page } from '@playwright/test';

/** 콘솔 오류 · 페이지 오류 · 400 이상 응답을 모은다 */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return errors;
}

test('작업 표준: 미리보기만 있고 발행 · 내려받기 · 이력은 없다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/mes?product=HCR3A');
  await expect(page.getByRole('heading', { level: 1, name: '작업 표준' })).toBeVisible();

  const summary = page.getByRole('region', { name: '묶음 요약' });
  await expect(summary.getByRole('group', { name: '요약' })).toContainText('BOM 18줄');
  await expect(summary.getByRole('group', { name: '요약' })).toContainText('작업 단계 4');
  await expect(page.getByRole('table', { name: '제조 BOM' }).getByRole('row')).toHaveCount(19);

  // 작업 단계를 펼치면 규칙에서 뽑은 값과 주의사항이 보인다
  const steps = page.getByRole('region', { name: '작업 단계' });
  await steps.getByRole('button', { name: /J1 관절 모듈 조립/ }).click();
  await expect(steps.getByRole('list', { name: '단계 2 주의사항' })).toContainText('입력축 방향이 반대면');

  await expect(page.getByRole('button', { name: /MES로 발행|JSON 내려받기|CSV 내려받기/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '발행 이력' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('작업 표준: 모바일(390px)에서 가로로 넘치지 않는다 (펼친 단계 포함)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/mes?product=HCR3A');
  await expect(page.getByRole('region', { name: '묶음 요약' })).toBeVisible();
  await page.getByRole('region', { name: '작업 단계' }).getByRole('button', { name: /J1 관절 모듈 조립/ }).click();

  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
});
