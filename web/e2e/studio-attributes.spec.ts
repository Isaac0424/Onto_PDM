// 실제 브라우저: CAD 스튜디오의 속성 후보 패널. 실행: E2E_PORT=5184 pnpm e2e e2e/studio-attributes.spec.ts
import { expect, test, type Page } from '@playwright/test';

/** 콘솔 오류 · 페이지 오류 · 400 이상 응답을 모은다 */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return errors;
}

/** 파일 보관소 서버(8788)는 이 시험에서 쓰지 않는다 */
async function stubVault(page: Page) {
  await page.route('**/api/files**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ sha256: 'ef'.repeat(32), size: 10, name: 'spec.txt', format: 'txt', kind: 'spec', duplicate: false }),
  }));
}

test('속성 후보: 부품을 고르면 CAD 에서 뽑은 후보가 보이고, 확정하면 요약에 센다', async ({ page }) => {
  const errors = collectErrors(page);
  await stubVault(page);
  await page.goto('/');
  await expect(page.locator('.holo-host canvas').first()).toBeAttached({ timeout: 20_000 });

  const steps = page.getByRole('region', { name: '제조 순서' });
  await expect(page.getByRole('status', { name: '속성 후보 요약' })).toContainText('속성 후보');
  await page.getByRole('tab', { name: /^속성/ }).click();
  await expect(page.getByRole('list', { name: '부품별 속성 후보' })).toBeVisible();              // 고르기 전: 부품별 후보 수

  await steps.locator('.part-row', { hasText: '상부 커버' }).click();
  const list = page.getByRole('list', { name: '상부 커버 속성 후보' });
  await expect(list).toBeVisible();
  const thickness = list.locator('.attr-row', { hasText: '두께' }).first();
  await expect(thickness.getByText('CAD', { exact: true })).toBeVisible();                       // 출처
  await expect(thickness.getByRole('meter', { name: '신뢰도' })).toBeVisible();

  await thickness.getByRole('button', { name: /두께 .* 확정$/ }).click();
  await expect(page.getByRole('status', { name: '속성 후보 요약' })).toContainText('확정 1개');
  await expect(thickness.getByRole('button', { name: '두께 확정 취소' })).toBeVisible();

  await page.getByRole('tab', { name: '온톨로지' }).click();                                      // 탭을 오가도 온톨로지 패널은 그대로
  await expect(page.getByRole('region', { name: '온톨로지' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('속성 후보: 사양서(txt)를 올리면 후보가 더해지고 값이 다르면 충돌로 보인다', async ({ page }) => {
  const errors = collectErrors(page);
  await stubVault(page);
  await page.goto('/');
  await expect(page.locator('.holo-host canvas').first()).toBeAttached({ timeout: 20_000 });
  await expect(page.getByRole('region', { name: '제조 순서' }).locator('.part-row').first()).toBeVisible();

  await page.setInputFiles('input[aria-label="사양서 파일"]', {
    name: 'spec.txt', mimeType: 'text/plain', buffer: Buffer.from('상부 커버 두께는 3.2 mm 로 한다.\n', 'utf-8'),
  });
  await expect(page.getByText(/spec\.txt: 속성 후보 \d+개를 찾았어요/)).toBeVisible();

  await page.getByRole('tab', { name: /^속성/ }).click();
  await page.getByRole('region', { name: '제조 순서' }).locator('.part-row', { hasText: '상부 커버' }).click();
  const list = page.getByRole('list', { name: '상부 커버 속성 후보' });
  await expect(list.getByText('사양서', { exact: true })).toBeVisible();
  await expect(list.getByText('충돌').first()).toBeVisible();                                    // CAD 3 mm ↔ 사양서 3.2 mm
  expect(errors).toEqual([]);
});

test('속성 후보: PDF 는 값 추출을 아직 지원하지 않는다고 알려 준다', async ({ page }) => {
  await stubVault(page);
  await page.goto('/');
  await expect(page.locator('.holo-host canvas').first()).toBeAttached({ timeout: 20_000 });
  await page.setInputFiles('input[aria-label="사양서 파일"]', { name: 'spec.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n') });
  await expect(page.getByText(/PDF에서 속성 값을 뽑는 것은 아직 지원하지 않아요/)).toBeVisible();
});
