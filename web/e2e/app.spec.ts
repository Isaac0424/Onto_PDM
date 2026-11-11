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
  ['/', 'CAD 스튜디오'],
  ['/products/HCR3A', '협동로봇 3 kg'],
  ['/rules', '조립 규칙'],
  ['/rules/SP-WLD-01', '조립 규칙'],
  ['/products', '제품'],
  ['/mes?product=HCR3A', '작업 표준'],
];

test('모든 화면이 오류 없이 열린다', async ({ page }) => {
  const errors = collectErrors(page);
  for (const [path, heading] of SCREENS) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading }), path).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('메인 화면: 3D 홀로그램 + 제조 순서 + 온톨로지, 부품을 고르면 그 부품의 온톨로지가 보인다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('.holo-host canvas').first()).toBeAttached({ timeout: 20_000 });

  const steps = page.getByRole('region', { name: '제조 순서' });
  await expect(steps.getByText(/CAD 구조에서 나눈 \d+단계/)).toBeVisible();
  await expect(steps.locator('.chip-ok', { hasText: 'P-00000000160' })).toBeVisible();       // 전원 버튼: 보유 품번으로 확정
  await expect(page.getByRole('img', { name: /예시 모델 온톨로지 그래프/ })).toBeVisible();     // 고르기 전: 모델 전체

  await steps.locator('.part-row', { hasText: '전원 버튼' }).click();
  await expect(page.getByRole('img', { name: '전원 버튼 온톨로지 그래프' })).toBeVisible();
  await expect(page.getByText('전기 · 전자 › 스위치 · 버튼')).toBeVisible();

  // 등록 요청은 삭제됨(사용자 지시): 미보유 부품에도 요청 버튼이 없다
  await steps.locator('.part-row', { hasText: '제어 기판' }).click();
  await expect(page.getByRole('button', { name: /OPMS (에 )?등록 요청/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('메인 화면: 부품을 고르면 3D 위에 조립 규칙 카드와 자막이 겹쳐 뜬다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('.holo-host canvas').first()).toBeAttached({ timeout: 20_000 });
  await page.getByRole('region', { name: '제조 순서' }).locator('.part-row', { hasText: '제어 기판' }).click();

  const card = page.locator('.holo-host .stage').getByRole('complementary', { name: '조립 안내' });   // 카드는 3D 무대 안에 있다
  await expect(card).toBeVisible();
  await expect(card.getByText('왼쪽 (−X)')).toBeVisible();
  await expect(card.getByText('SP-ELC-01 · 제어 기판 장착')).toBeVisible();
  await expect(page.locator('.holo-host .stage').getByRole('status', { name: /입력 포트가 왼쪽/ })).toBeVisible();   // 아래 자막
  expect(errors).toEqual([]);
});

test('메인 화면의 3D: 배경을 한 번 누르면 포커스가 꺼지고, 배경을 더블클릭하면 전체로 시점이 맞춰진다', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const canvas = page.locator('.holo-host canvas').first();
  await expect(canvas).toBeAttached({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  const box = (await canvas.boundingBox())!;
  const onPart = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.68 };      // 하우징 위
  const empty = { x: box.x + 40, y: box.y + box.height * 0.4 };                      // 모델 밖 배경
  const card = page.locator('.holo-host .stage').getByRole('complementary', { name: '조립 안내' });

  await page.mouse.click(onPart.x, onPart.y);                                        // 부품 선택: 그 층에 포커스
  await expect(card).toBeVisible();

  await page.mouse.click(empty.x, empty.y);                                          // 배경 한 번: 포커스 꺼짐
  await expect(card).toHaveCount(0);

  await page.waitForTimeout(600);
  const focusedOff = await canvas.screenshot();
  await page.mouse.dblclick(empty.x, empty.y);                                       // 배경 더블클릭: 전체 기준 시점 정렬
  await page.waitForTimeout(1500);
  expect((await canvas.screenshot()).equals(focusedOff)).toBe(false);
  await expect(card).toHaveCount(0);
});

test('메인 화면의 3D: 오른쪽 클릭은 아무것도 고르지 않고, 오른쪽 드래그는 시점을 옮긴다', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });                                      // 스캔 빛줄기 애니메이션이 화면 비교를 흔들지 않게
  await page.goto('/');
  const canvas = page.locator('.holo-host canvas').first();
  await expect(canvas).toBeAttached({ timeout: 20_000 });
  await expect(page.locator('.xs-root')).toHaveAttribute('data-skin', 'glass');            // CAD 무대만 검정이 아니다
  await expect(page.locator('.axl:not([hidden])')).toHaveCount(0);                          // 빨강 · 초록 · 파랑 기준 축 표시 없음

  await page.waitForTimeout(800);
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height * 0.7;                          // 모델이 있는 아래쪽 (부품 위)
  const before = await canvas.screenshot();

  await page.mouse.click(cx, cy, { button: 'right' });                                       // 제자리 오른쪽 클릭: 부품을 고르지 않는다
  await page.waitForTimeout(400);
  expect((await canvas.screenshot()).equals(before)).toBe(true);
  await expect(page.locator('.holo-side .part-on')).toHaveCount(0);

  await page.mouse.move(cx, cy);                                                             // 오른쪽 드래그: 시점이 옮겨진다
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 90, cy + 50, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(400);
  expect((await canvas.screenshot()).equals(before)).toBe(false);

  const prevented = await canvas.evaluate(c => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    c.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(true);                                                              // 브라우저 메뉴는 열지 않는다
});

test('제품 연결 그래프: 제품 → 조립품 → 부품이 3D로 이어지고, 노드를 고르면 문서와 조립 규칙이 묶여 나온다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/products/HCR3A');
  const canvas = page.locator('.graph3d canvas').first();
  await expect(canvas).toBeAttached({ timeout: 20_000 });
  await expect(page.getByRole('group', { name: '요약' })).toContainText('조립 규칙 연결');

  // 오른쪽 버튼으로 끌어도 아무것도 바뀌지 않고 브라우저 메뉴도 열리지 않는다 (CAD 화면과 같다)
  await page.waitForTimeout(800);
  const box = (await canvas.boundingBox())!;
  const before = await canvas.screenshot();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 6 });
  await page.waitForTimeout(250);
  const during = await canvas.screenshot();
  await page.mouse.up({ button: 'right' });
  expect(during.equals(before)).toBe(true);
  expect(await canvas.evaluate(c => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }); c.dispatchEvent(e); return e.defaultPrevented; })).toBe(true);

  // 같은 정보를 목록으로도 본다 (3D를 못 쓸 때의 대체 보기). 노드를 고르면 묶음 패널이 바뀐다
  await page.getByRole('group', { name: '보기' }).getByRole('button', { name: '목록' }).click();
  await page.getByRole('button', { name: /P-00000000121/ }).first().click();
  const panel = page.getByRole('complementary', { name: '묶음' });
  await expect(panel).toContainText('J1 감속기');
  await expect(panel.getByRole('link', { name: 'SP-RED-01' })).toBeVisible();                // 이 부품에 적용되는 조립 규칙
  await panel.getByRole('link', { name: 'SP-RED-01' }).click();
  await expect(page.getByRole('heading', { level: 2, name: '감속기 장착' })).toBeVisible();   // 규칙 화면으로 이어진다
  expect(errors).toEqual([]);
});

test('조립 규칙: 목록 · 공정 필터 · 상세(조건표) · 온톨로지 3D', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/rules');
  await expect(page.getByText('규칙 11개 · 승인 9 · 검토 전 2')).toBeVisible();

  await page.getByRole('group', { name: '공정 필터' }).getByRole('button', { name: /^용접/ }).click();
  const list = page.getByRole('region', { name: '규칙 목록' });
  await expect(list.getByRole('link')).toHaveCount(1);
  await list.getByRole('link', { name: /SP-WLD-01/ }).click();

  const detail = page.getByRole('region', { name: '규칙 상세' });
  await expect(detail.getByText('검토 전').first()).toBeVisible();                            // 가상 값 · 검토 전임을 숨기지 않는다
  await expect(detail.getByRole('table', { name: '조건표' }).getByRole('row')).toHaveCount(5);   // 머리 1 + 두께 구간 4

  await detail.getByRole('tab', { name: '온톨로지(3D)' }).click();
  await expect(detail.locator('.graph3d canvas').first()).toBeAttached({ timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('삭제된 관리 화면(품목 · 등록 요청 · BOM 가져오기 · 관리자)은 열리지 않는다', async ({ page }) => {
  for (const path of ['/items', '/requests', '/bom-import', '/admin/requests']) {
    await page.goto(path);
    await expect(page.getByText(/없는 화면입니다/), path).toBeVisible();
  }
});

test('모바일(390px)에서 화면이 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  for (const path of ['/', '/products/HCR3A', '/rules', '/mes?product=HCR3A']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
    }));
    expect(scroll, path).toBeLessThanOrEqual(client);
  }
});
