// MES 발행 화면의 실제 브라우저 확인. 실행: E2E_PORT=5183 pnpm e2e e2e/mes.spec.ts
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/** 콘솔 오류 · 페이지 오류 · 400 이상 응답을 모은다 */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return errors;
}

test('MES 발행: 미리보기 → 발행 → 이력, 같은 리비전은 다시 발행되지 않는다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/mes?product=HCR3A');
  await expect(page.getByRole('heading', { level: 1, name: 'MES 발행' })).toBeVisible();

  const summary = page.getByRole('region', { name: '묶음 요약' });
  await expect(summary.getByRole('group', { name: '요약' })).toContainText('BOM 18줄');
  await expect(summary.getByRole('group', { name: '요약' })).toContainText('작업 단계 4');
  await expect(page.getByRole('table', { name: '제조 BOM' }).getByRole('row')).toHaveCount(19);

  // 작업 단계를 펼치면 규칙에서 뽑은 값과 주의사항이 보인다
  const steps = page.getByRole('region', { name: '작업 단계' });
  await steps.getByRole('button', { name: /J1 관절 모듈 조립/ }).click();
  await expect(steps.getByRole('list', { name: '단계 2 주의사항' })).toContainText('입력축 방향이 반대면');

  await page.getByRole('button', { name: 'MES로 발행' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'MES로 발행했습니다 (#1)' })).toBeVisible();
  const history = page.getByRole('table', { name: '발행 이력' });
  await expect(history.getByRole('row').nth(1)).toContainText('HCR3A');
  await expect(history.getByRole('row').nth(1)).toContainText('발행됨');

  await page.getByRole('button', { name: 'MES로 발행' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '이미 발행한 리비전입니다' })).toBeVisible();
  await expect(history.getByRole('row')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('MES 발행: JSON · CSV 로 내려받는다 (파일 이름 · 내용 · UTF-8 BOM)', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/mes?product=HCR3A');
  await expect(page.getByRole('region', { name: '묶음 요약' })).toBeVisible();

  const [json] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'JSON 내려받기' }).click()]);
  expect(json.suggestedFilename()).toBe('HCR3A_R01_mes.json');
  const pkg = JSON.parse(readFileSync((await json.path())!, 'utf-8'));
  expect(pkg).toMatchObject({ productCode: 'HCR3A', revision: 'R01', rule: 'released' });
  expect(pkg.bom).toHaveLength(18);
  expect(pkg.steps.map((s: { title: string }) => s.title)[0]).toBe('베이스 조립품 조립');

  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV 내려받기' }).click()]);
  expect(csv.suggestedFilename()).toBe('HCR3A_R01_mes.csv');
  const bytes = readFileSync((await csv.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);                           // 엑셀에서 한글이 깨지지 않게
  const lines = bytes.toString('utf-8').replace(/^﻿/, '').split('\r\n');
  expect(lines[0]).toBe('seq,level,item_no,name,quantity,total_quantity,step,rule_ids');
  expect(lines[1]).toBe('1,0,P-00000000100,HCR3A 본체,1,1,4,');
  expect(errors).toEqual([]);
});

test('MES 발행: 최신 기준은 승인 전 리비전을 경고하고 발행하지 않는다', async ({ page }) => {
  await page.goto('/mes?product=HCR3A');
  await expect(page.getByRole('region', { name: '묶음 요약' })).toBeVisible();
  await page.getByRole('group', { name: 'BOM 기준' }).getByRole('button', { name: '최신' }).click();

  await expect(page.getByRole('list', { name: '경고' })).toContainText('J1 브레이크 (R00 작업중)');
  await page.getByRole('button', { name: 'MES로 발행' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '승인된 리비전만 MES로 발행할 수 있습니다' })).toBeVisible();
  await expect(page.getByText('발행 이력이 없습니다.')).toBeVisible();
});

test('MES 발행: 모바일(390px)에서 가로로 넘치지 않는다 (펼친 단계 · 이력 포함)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/mes?product=HCR3A');
  await expect(page.getByRole('region', { name: '묶음 요약' })).toBeVisible();
  await page.getByRole('region', { name: '작업 단계' }).getByRole('button', { name: /J1 관절 모듈 조립/ }).click();
  await page.getByRole('button', { name: 'MES로 발행' }).click();
  await expect(page.getByRole('table', { name: '발행 이력' })).toBeVisible();

  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
});
