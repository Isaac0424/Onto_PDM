// 제품 연결 그래프의 필터 · 검색 · 사용처 경로 · MES 링크를 실제 브라우저(WebGL 이 켜진 상태)로 확인한다.
// 실행: E2E_PORT=5185 pnpm e2e e2e/product-graph-filters.spec.ts
import { expect, test, type Page } from '@playwright/test';

/** 콘솔 오류 · 페이지 오류 · 400 이상 응답을 모은다 */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return errors;
}

test('제품 연결 그래프: 상태 필터 · 검색 · 사용처 경로가 3D 와 묶음 패널에 반영된다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/products/HCR3A');
  const canvas = page.locator('.graph3d canvas').first();
  await expect(canvas).toBeAttached({ timeout: 20_000 });
  await expect(page.getByText('14개 중 14개 표시')).toBeVisible();

  // 최신 BOM 기준 + 승인 끄기: 작업중 · 검토중 품목과 그 조상만 남는다. 3D 도 새 그래프로 다시 그려진다
  await page.waitForTimeout(600);
  const before = await canvas.screenshot();
  await page.getByRole('group', { name: 'BOM 기준' }).getByRole('button', { name: '최신' }).click();
  await expect(page.getByText('15개 중 15개 표시')).toBeVisible();
  await page.getByRole('group', { name: '상태 필터' }).getByRole('button', { name: '승인' }).click();
  await expect(page.getByText('15개 중 4개 표시')).toBeVisible();
  await expect(canvas).toBeAttached();
  await page.waitForTimeout(600);
  expect((await canvas.screenshot()).equals(before)).toBe(false);                               // 그래프가 실제로 바뀌었다

  // 같은 정보를 목록으로: 걸러진 노드는 없고, 조상 조립품은 남는다
  await page.getByRole('group', { name: '보기' }).getByRole('button', { name: '목록' }).click();
  const list = page.getByRole('group', { name: '협동로봇 3 kg 연결 목록' });
  await expect(list.getByText('J1 브레이크')).toBeVisible();
  await expect(list.getByText('베이스 조립품').first()).toBeVisible();
  await expect(list.getByText('케이블 하네스')).toHaveCount(0);

  await page.getByRole('button', { name: '필터 지우기' }).click();
  await expect(page.getByText('15개 중 15개 표시')).toBeVisible();
  await expect(list.getByText('케이블 하네스')).toBeVisible();

  // 검색: 품번으로 한 곳이 맞으면 바로 선택되어 묶음 패널이 바뀐다. 사용처 경로가 제품까지 이어진다
  await page.getByRole('searchbox', { name: '품번 · 이름 검색' }).fill('P-00000000121');
  const panel = page.getByRole('complementary', { name: '묶음' });
  await expect(panel.getByRole('heading', { level: 2, name: 'J1 감속기' })).toBeVisible();
  await expect(panel.getByRole('list', { name: '사용처 경로' })).toContainText('J1 관절 모듈');
  await expect(panel.getByRole('list', { name: '사용처 경로' })).toContainText('협동로봇 3 kg');
  await panel.getByRole('list', { name: '사용처 경로' }).getByRole('button', { name: 'J1 관절 모듈' }).click();
  await expect(panel.getByRole('heading', { level: 2, name: 'J1 관절 모듈' })).toBeVisible();
  expect(errors).toEqual([]);

  // MES 발행 링크: 제품과 지금의 BOM 기준(최신)을 담아 /mes 로 간다
  await page.locator('.pg-head').getByRole('link', { name: 'MES 발행' }).click();   // 사이드바 메뉴에도 같은 이름이 있다
  await expect(page).toHaveURL(/\/mes\?product=HCR3A&rule=latest$/);
});

test('제품 연결 그래프: 공정 · 규칙 필터와 모바일 폭', async ({ page }) => {
  await page.goto('/products/HCR3A');
  await expect(page.locator('.graph3d canvas').first()).toBeAttached({ timeout: 20_000 });
  await page.getByRole('group', { name: '조립 규칙 필터' }).getByRole('button', { name: '규칙 있음' }).click();
  await expect(page.getByText('14개 중 11개 표시')).toBeVisible();                               // 규칙 7개 품목 + 조상 조립품 4개
  await page.getByRole('group', { name: '조립 규칙 필터' }).getByRole('button', { name: '규칙 없음' }).click();
  await expect(page.getByText(/^14개 중 \d+개 표시$/)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(500);
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
});
