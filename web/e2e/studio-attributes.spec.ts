// 실제 브라우저: CAD 스튜디오의 속성 후보 패널. 실행: E2E_PORT=5184 pnpm e2e e2e/studio-attributes.spec.ts
import { type Page } from '@playwright/test';
import { expect, test, uploadAssembly } from './cad-fixtures';

/** 콘솔 오류 · 페이지 오류 · 400 이상 응답을 모은다 */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return errors;
}

test('속성 후보: 부품을 고르면 CAD 에서 뽑은 후보가 보이고, 확정하면 요약에 센다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await uploadAssembly(page);                                                                   // 예시 모델은 없다: CAD 를 올려서 본다

  const steps = page.getByRole('region', { name: '제조 순서' });
  await expect(page.getByRole('status', { name: '속성 후보 요약' })).toContainText('속성 후보');
  await page.getByRole('tab', { name: /^속성/ }).click();
  await expect(page.getByRole('list', { name: '부품별 속성 후보' })).toBeVisible();              // 고르기 전: 부품별 후보 수

  // 올린 OBJ 는 단위를 '단위'(미정)로 읽어 치수 후보는 없다: 이름에서 뽑은 후보(기판 나사 M3 → 나사 규격)로 본다
  await steps.locator('.part-row', { hasText: '기판 나사' }).click();
  const list = page.getByRole('list', { name: '기판 나사 M3 속성 후보' });
  await expect(list).toBeVisible();
  const thread = list.locator('.attr-row', { hasText: '나사 규격' }).first();
  await expect(thread.getByText('이름', { exact: true })).toBeVisible();                         // 출처
  await expect(thread.getByRole('meter', { name: '신뢰도' })).toBeVisible();

  await thread.getByRole('button', { name: /나사 규격 .* 확정$/ }).click();
  await expect(page.getByRole('status', { name: '속성 후보 요약' })).toContainText('확정 1개');
  await expect(thread.getByRole('button', { name: '나사 규격 확정 취소' })).toBeVisible();

  await page.getByRole('tab', { name: '온톨로지' }).click();                                      // 탭을 오가도 온톨로지 패널은 그대로
  await expect(page.getByRole('region', { name: '온톨로지' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('사양서 올리기 · BOM 올리기는 없다 (CAD 올리기만 있다)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /CAD 올리기/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /사양서 올리기/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /BOM 올리기/ })).toHaveCount(0);
  await expect(page.locator('input[aria-label="사양서 파일"]')).toHaveCount(0);
  await expect(page.locator('input[aria-label="BOM 파일"]')).toHaveCount(0);
});
