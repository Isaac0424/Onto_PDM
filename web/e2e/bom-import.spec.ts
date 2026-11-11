// 실제 브라우저: BOM 가져오기. 실행: E2E_PORT=5184 pnpm e2e e2e/bom-import.spec.ts
import { expect, test, type Page } from '@playwright/test';

/** 콘솔 오류 · 페이지 오류 · 400 이상 응답을 모은다 */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return errors;
}

test('BOM 가져오기: 예시 시트 → 보유 · 후보 · 미보유 → 확정 → OPMS 등록 요청', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/bom-import');
  await expect(page.getByRole('heading', { level: 1, name: 'BOM 가져오기' })).toBeVisible();
  await page.getByRole('button', { name: '예시 불러오기' }).click();

  const result = page.getByRole('region', { name: '가져오기 결과' });
  await expect(result.getByRole('group', { name: '매칭 요약' })).toContainText('보유 2후보 1미보유 1');
  const table = result.getByRole('table', { name: 'BOM 시트 미리보기' });
  await expect(table.getByRole('link', { name: 'P-00000000001' })).toBeVisible();

  await result.getByRole('button', { name: '줄 3 이 품번으로 확정' }).click();                  // 이름만 맞은 전원 버튼
  await expect(result.getByRole('group', { name: '매칭 요약' })).toContainText('보유 3후보 0미보유 1');

  await result.getByRole('button', { name: /OPMS 등록 요청 1/ }).click();
  await expect(page.getByText(/1줄을 OPMS 등록 요청으로 보냈습니다/)).toBeVisible();
  await page.goto('/requests');
  await expect(page.getByText('방열판 20x20')).toBeVisible();                                     // 보낸 요청이 내 등록 요청에 있다
  expect(errors).toEqual([]);
});

test('BOM 가져오기: 파일을 올려도 서버로 보내지 않고 이 브라우저에서 읽는다', async ({ page }) => {
  const errors = collectErrors(page);
  const uploads: string[] = [];
  page.on('request', r => { if (r.method() !== 'GET') uploads.push(`${r.method()} ${r.url()}`); });
  await page.goto('/bom-import');
  await page.setInputFiles('input[aria-label="BOM 시트 파일"]', {
    name: '제어박스_BOM.csv', mimeType: 'text/csv',
    buffer: Buffer.from('품번,품명,수량,도면번호\nP-00000000121,J1 감속기,1,1\n,서보 모터 400W,1,2\n', 'utf-8'),
  });
  const result = page.getByRole('region', { name: '가져오기 결과' });
  await expect(result).toContainText('제어박스_BOM.csv');
  await expect(result.getByRole('table', { name: 'BOM 시트 미리보기' }).getByRole('link', { name: 'P-00000000121' })).toBeVisible();
  expect(uploads).toEqual([]);                                                                    // 읽기만 했고 어디로도 보내지 않았다
  expect(errors).toEqual([]);
});

test('BOM 가져오기: 머리줄이 없으면 안내하고, 모바일(390px)에서 가로로 넘치지 않는다', async ({ page }) => {
  await page.goto('/bom-import');
  await page.getByLabel('BOM 본문 붙여넣기').fill('그냥 글입니다');
  await page.getByRole('button', { name: '읽기' }).click();
  await expect(page.getByRole('alert')).toContainText('읽을 수 있는 줄이 없어요');                  // 머리줄도 수량도 없는 글

  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole('button', { name: '예시 불러오기' }).click();
  await expect(page.getByRole('region', { name: '가져오기 결과' })).toBeVisible();
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
});
