// 실제 브라우저 · 실제 3D 뷰어: CAD 형상으로 본 볼트 종류. 부품 메시를 뷰어에서 읽어 소켓 · 버튼 · 접시 · 육각 · 플랜지를 구분하고,
// 판 · 너트에는 볼트 블록이 없고, 확정한 값과 등록 요청 초안(OPMS 연결 전이라 매칭 · 규칙은 없다)까지 본다. 실행: E2E_PORT=5192 pnpm e2e e2e/fastener-shape.spec.ts
// 서버 DB(/api/cads) · 파일 보관소는 cad-fixtures.ts 의 가짜 서버가 가로챈다.
import { type Page } from '@playwright/test';
import { expect, partRows, test, uploadBolts } from './cad-fixtures';

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return errors;
}

/** 속성 탭에서 부품을 고른다 */
async function selectPart(page: Page, name: string) {
  const tab = page.getByRole('tab', { name: /^속성/ });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await partRows(page).filter({ hasText: name }).first().click();
}

const block = (page: Page) => page.getByRole('region', { name: '형상으로 본 볼트 종류' });
const candidates = (page: Page) => block(page).getByRole('list', { name: '볼트 종류 후보' }).locator(':scope > li');

test('형상으로 볼트 종류를 구분한다: 소켓 · 육각 · 플랜지 · 버튼 · 접시, 미등록 제안 칩은 버튼 · 접시에만', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await uploadBolts(page);

  const expected: [part: string, label: string, proposed: boolean][] = [
    ['PRT-S1', '육각구멍붙이볼트', false],
    ['PRT-H1', '육각볼트', false],
    ['PRT-F1', '육각플랜지볼트', false],
    ['PRT-B1', '버튼헤드볼트', true],
    ['PRT-C1', '접시머리볼트', true],
  ];
  for (const [part, label, proposed] of expected) {
    await selectPart(page, part);
    await expect(block(page)).toBeVisible({ timeout: 20_000 });
    await expect(candidates(page).first()).toContainText(label);
    if (proposed) await expect(candidates(page).first().getByText('제안(미등록)')).toBeVisible();
    else await expect(candidates(page).first().getByText('제안(미등록)')).toHaveCount(0);
    // 속성 후보: 머리 모양 · 나사 규격(M6)
    const list = page.getByRole('list', { name: `${part} 속성 후보` });
    await expect(list.locator('.attr-row', { hasText: '머리 모양' })).toBeVisible();
    await expect(list.locator('.attr-row', { hasText: '나사 규격' })).toContainText('M6');
  }

  // 판 · 너트: 볼트 블록이 없다 (분석이 끝난 뒤에도)
  for (const part of ['PRT-PLATE', 'PRT-NUT']) {
    await selectPart(page, part);
    await expect(page.getByRole('list', { name: `${part} 속성 후보` })).toBeVisible();
    await expect(page.getByRole('status', { name: '형상 분석' })).toHaveCount(0, { timeout: 15_000 });
    await expect(block(page)).toHaveCount(0);
  }
  expect(errors.filter(e => !/Failed to load resource/.test(e))).toEqual([]);
});

test('구멍을 뺀 단순화 모델은 하나로 정하지 않고 후보가 여러 개라고 알린다', async ({ page }) => {
  await page.goto('/');
  await uploadBolts(page);
  await selectPart(page, 'PRT-X1');
  await expect(block(page).getByRole('note')).toContainText('후보가 여러 개예요 — 구동부 구멍이 보이지 않아요', { timeout: 20_000 });
  await expect(candidates(page).first().getByRole('meter')).toBeVisible();
});

test('확정한 볼트 종류 · 규격은 OPMS 에 연결되기 전에는 매칭 · 규칙에 쓰이지 않고, 미등록 클래스는 등록 요청 초안이 붙는다', async ({ page }) => {
  await page.goto('/');
  await uploadBolts(page);
  await selectPart(page, 'PRT-S1');
  await expect(block(page)).toBeVisible({ timeout: 20_000 });

  // 보유 품번을 읽어 올 곳(OPMS)이 없다: 매칭 칩 대신 안내가 나오고, 확정해도 가짜 후보 품번이 생기지 않는다
  const steps = page.getByRole('region', { name: '제조 순서' });
  await expect(steps.getByRole('note')).toContainText('보유 품번 매칭은 OPMS에 연결되면 표시돼요.');
  const row = partRows(page).filter({ hasText: 'PRT-S1' }).first();
  await candidates(page).first().getByRole('button', { name: '육각구멍붙이볼트 이 종류로 확정' }).click();
  await page.getByRole('button', { name: /^나사 규격 M6 확정$/ }).click();
  await page.getByRole('button', { name: /^길이 25 mm 확정$/ }).click();
  await expect(row).not.toContainText('P-');

  // 조립 안내: 규칙을 읽어 올 곳이 없다고 말한다 (규칙이 없는 것이 아니다)
  const hud = page.locator('.holo-host .stage').getByRole('complementary', { name: '조립 안내' });
  await expect(hud).toContainText('OPMS에 연결되면 표시돼요');

  // 버튼 헤드(미등록 제안): 확정하면 OPMS 분류 등록 요청 초안이 붙는다
  await selectPart(page, 'PRT-B1');
  await expect(block(page)).toBeVisible({ timeout: 20_000 });
  await candidates(page).first().getByRole('button', { name: '버튼헤드볼트 이 종류로 확정' }).click();
  await block(page).getByText('OPMS 분류 등록 요청 초안').click();
  await expect(block(page).getByLabel('OPMS 분류 등록 요청 본문')).toContainText('"code": "ButtonHeadBolt"');
  await expect(block(page).getByLabel('OPMS 분류 등록 요청 본문')).toContainText('"headType": "Button"');
});

test('확정한 볼트 종류는 새로고침해도 남는다', async ({ page }) => {
  await page.goto('/');
  await uploadBolts(page);
  await selectPart(page, 'PRT-C1');
  await expect(block(page)).toBeVisible({ timeout: 20_000 });
  await candidates(page).first().getByRole('button', { name: '접시머리볼트 이 종류로 확정' }).click();
  await expect(candidates(page).first().getByText('확정', { exact: true })).toBeVisible();

  await page.reload();
  await expect(partRows(page)).toHaveCount(8, { timeout: 30_000 });                       // 마지막 CAD 가 캐시에서 다시 열린다
  await selectPart(page, 'PRT-C1');
  await expect(candidates(page).first().getByRole('button', { name: '접시머리볼트 확정 취소' })).toBeVisible({ timeout: 20_000 });
});

test('모바일(390px)에서도 볼트 블록이 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await uploadBolts(page);
  await selectPart(page, 'PRT-B1');
  await expect(block(page)).toBeVisible({ timeout: 20_000 });
  await candidates(page).first().getByRole('button', { name: '버튼헤드볼트 이 종류로 확정' }).click();
  await block(page).getByText('OPMS 분류 등록 요청 초안').click();
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
  const box = await block(page).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(client + 1);
});
