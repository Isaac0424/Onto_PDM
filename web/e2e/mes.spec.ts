// 작업 표준 화면의 실제 브라우저 확인. 실행: E2E_PORT=5183 pnpm e2e e2e/mes.spec.ts
// 작업표준서는 PDM 백엔드(규칙집 rules/)가 읽어 주고, 제품 · BOM 은 OPMS 에서 읽어 올 곳이 없다(가짜 데이터 없음): 읽어 올 곳이 없으면 화면은 비어 있다고 정직하게 말한다. 규칙집 연동 시험은 rulebook.spec.ts.
// MES 발행 · 내보내기 · 이력은 사용자 지시로 삭제했다.
import { type Page } from '@playwright/test';
import { expect, test } from './cad-fixtures';

/** 콘솔 오류 · 페이지 오류 · 400 이상 응답을 모은다 */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return errors;
}

test('작업 표준: OPMS 에 연결되기 전에는 연결 안내가 나오고, 제품 · BOM · 발행 버튼은 없다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/mes');
  await expect(page.getByRole('heading', { level: 1, name: '작업 표준' })).toBeVisible();

  const note = page.getByRole('status', { name: 'OPMS 연결 안내' });
  await expect(note).toContainText('작업 표준을 만들 데이터가 없어요');
  await expect(note).toContainText('PDM 백엔드에 연결되면 작업표준서');
  await expect(page.getByRole('combobox', { name: '제품' })).toHaveCount(0);
  await expect(page.getByRole('table', { name: '제조 BOM' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /MES로 발행|JSON 내려받기|CSV 내려받기/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '발행 이력' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);                                         // 오류가 아니다
  expect(errors).toEqual([]);
});

test('작업 표준: 모바일(390px)에서 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/mes');
  await expect(page.getByRole('status', { name: 'OPMS 연결 안내' })).toBeVisible();
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
});
