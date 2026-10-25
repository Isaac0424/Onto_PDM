// 실제 브라우저 확인. 테스트마다 새 브라우저 컨텍스트라 목 데이터가 처음 상태로 시작한다.
import { expect, test, type Page } from '@playwright/test';

/** 콘솔 오류 · 페이지 오류 · 400 이상 응답을 모은다 */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return errors;
}

const SCREENS: [string, string][] = [
  ['/items', '품목'],
  ['/items/P0000100?tab=overview', 'HCR3A 본체'],
  ['/items/P0000100?tab=bom', 'HCR3A 본체'],
  ['/items/P0000110?tab=used', '베이스 조립품'],
  ['/items/P0000121?tab=docs', 'J1 감속기'],
  ['/items/P0000100?tab=history', 'HCR3A 본체'],
  ['/products', '제품'],
  ['/requests', '내 등록 요청'],
  ['/requests/new', '새 등록 요청'],
  ['/admin/requests', '등록 요청 검토'],
  ['/admin/proposals', '분류 제안 검토'],
  ['/admin/publish', '그래프 발행 상태'],
];

test('모든 화면이 오류 없이 열린다', async ({ page }) => {
  const errors = collectErrors(page);
  for (const [path, heading] of SCREENS) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading }), path).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('3D 탭에서 분해도 뷰어가 그려진다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/items/P0000120?tab=viewer');
  await expect(page.locator('.viewer-host canvas').first()).toBeAttached({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('BOM 트리: 접기 · 자식 품목으로 이동', async ({ page }) => {
  await page.goto('/items/P0000100?tab=bom');
  const bom = page.getByRole('table', { name: 'BOM' });
  await expect(bom.getByRole('link', { name: 'P0000001' })).toHaveCount(2);
  await page.getByRole('button', { name: '모두 접기' }).click();
  await expect(bom.getByRole('link', { name: 'P0000001' })).toHaveCount(0);
  await page.getByRole('button', { name: '모두 펼치기' }).click();
  await bom.getByRole('link', { name: 'P0000121' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'J1 감속기' })).toBeVisible();
});

test('관리자 모드: 등록 요청 승인으로 품번이 발급되고 작업중 품목이 생긴다', async ({ page }) => {
  await page.goto('/admin/requests');
  await page.getByRole('button', { name: '승인 · 품번 발급' }).click();
  await page.getByRole('tab', { name: /처리됨/ }).click();
  // 카드에는 중복 후보 링크도 있으므로 "발급 품번" 항목의 링크만 고른다
  const issued = page.locator('section.card', { hasText: '케이블 클램프' }).locator('dt:text-is("발급 품번") + dd a');
  await expect(issued).toHaveText(/^P\d{7}$/);
  await issued.click();
  await expect(page.getByRole('heading', { level: 1, name: '케이블 클램프' })).toBeVisible();
  await expect(page.getByText('승인 전 리비전입니다')).toBeVisible();
});

test('관리자 모드: 분류 제안을 승인하면 기다리던 에이전트 임시저장에 분류가 들어간다', async ({ page }) => {
  await page.goto('/admin/proposals');
  await page.locator('section.card', { hasText: '셀프태핑 나사' }).getByRole('button', { name: '새 분류로 승인' }).click();
  await page.goto('/admin/requests');
  await page.getByRole('tab', { name: /임시저장/ }).click();
  await expect(page.locator('section.card', { hasText: '셀프태핑 나사 M3x6' })).toContainText('체결류 › 셀프태핑 나사');
});

test('엔지니어: 관리자 메뉴가 없고 관리자 화면은 막힌다', async ({ page }) => {
  await page.goto('/items');
  await page.getByLabel('사용자 (데모)').selectOption('2');
  await expect(page.getByRole('link', { name: '등록 요청 검토' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /관리자 모드/ })).toBeDisabled();
  await page.goto('/admin/requests');
  await expect(page.getByText(/관리자 모드에서만 볼 수 있습니다/)).toBeVisible();
});

test('임시저장한 요청은 새로고침해도 남는다', async ({ page }) => {
  await page.goto('/requests/new');
  await page.getByLabel(/이름 \(원래 이름\)/).fill('Spacer 3mm');
  await page.getByRole('button', { name: '임시저장' }).click();
  await expect(page.getByText(/임시저장했습니다/)).toBeVisible();
  await expect(page).toHaveURL(/\/requests\/\d+$/);
  await page.reload();
  await expect(page.getByLabel(/이름 \(원래 이름\)/)).toHaveValue('Spacer 3mm');
});

test('모바일(390px)에서 화면이 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  for (const path of ['/items', '/items/P0000100?tab=bom', '/items/P0000121?tab=docs', '/requests/new', '/admin/requests', '/admin/proposals']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
    }));
    expect(scroll, path).toBeLessThanOrEqual(client);
  }
});
