// 실제 브라우저 확인. 가짜(목) 데이터는 없다: 보유 품번 · 조립 규칙 · 제품은 OPMS 에서 읽어 오는데 아직 연결돼 있지 않아, 그런 화면은 비어 있다고 말한다.
import { type Page } from '@playwright/test';
import { clickOnPart, expect, test, uploadAssembly } from './cad-fixtures';

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
  ['/rules', '조립 규칙'],
  ['/rules/SP-WLD-01', '조립 규칙'],
  ['/products', '제품'],
  ['/mes', '작업 표준'],
];

test('모든 화면이 오류 없이 열린다', async ({ page }) => {
  const errors = collectErrors(page);
  for (const [path, heading] of SCREENS) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading }), path).toBeVisible();
  }
  await page.goto('/products/HCR3A');                                                          // 제품 연결 그래프는 제목 대신 연결 안내가 나온다
  await expect(page.getByRole('status', { name: 'OPMS 연결 안내' })).toContainText('제품 연결 그래프를 그릴 데이터가 없어요');
  expect(errors).toEqual([]);
});

test('데이터가 필요한 화면(규칙 · 제품 · 제품 그래프 · 작업 표준)은 가짜 데이터 대신 OPMS 연결 안내를 보인다', async ({ page }) => {
  for (const [path, title] of [
    ['/rules', '조립 규칙이 없어요'], ['/products', '제품 데이터가 없어요'],
    ['/products/HCR3A', '제품 연결 그래프를 그릴 데이터가 없어요'], ['/mes', '작업 표준을 만들 데이터가 없어요'],
  ] as const) {
    await page.goto(path);
    const note = page.getByRole('status', { name: 'OPMS 연결 안내' });
    await expect(note, path).toContainText(title);
    await expect(note, path).toContainText('연결되면');
    await expect(page.getByRole('alert'), path).toHaveCount(0);                                // 오류가 아니라 안내다
    await expect(page.locator('body'), path).not.toContainText(/온토전자|협동로봇 3 kg|P-0000000010/);   // 데모 데이터의 흔적이 없다
  }
});

test('머리와 사이드바에 프로필 · 사용자 전환 · 관리자 모드 · 데모 초기화가 없다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'CAD 스튜디오' })).toBeVisible();
  await expect(page.locator('.sb-user')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByText('관리자 모드')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '데모 초기화' })).toHaveCount(0);
  await expect(page.locator('aside img')).toHaveCount(1);                                      // 사이드바의 사진은 로고 하나뿐
});

test('메인 화면: 3D 홀로그램 + 제조 순서가 CAD 에서 바로 나오고, 보유 품번 · 온톨로지는 OPMS 연결 안내가 나온다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await uploadAssembly(page);                                                                 // 예시 모델은 없다: CAD 를 올려서 본다

  const steps = page.getByRole('region', { name: '제조 순서' });
  await expect(steps.getByText(/CAD 구조에서 나눈 \d+단계/)).toBeVisible();
  await expect(steps.getByRole('note')).toContainText('보유 품번 매칭은 OPMS에 연결되면 표시돼요.');   // 보유 품번 칩을 지어내지 않는다
  await expect(steps.locator('.chip-ok, .chip-maybe, .chip-none')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '온톨로지' }).getByRole('status', { name: 'OPMS 연결 안내' })).toContainText('온톨로지를 읽을 곳이 없어요');

  await steps.locator('.part-row', { hasText: '전원 버튼' }).click();
  await expect(page.getByRole('region', { name: '온톨로지' }).getByRole('status', { name: 'OPMS 연결 안내' })).toBeVisible();
  await expect(page.getByRole('button', { name: /OPMS (에 )?등록 요청/ })).toHaveCount(0);        // 등록 요청은 삭제됨
  expect(errors).toEqual([]);
});

test('메인 화면: 부품을 고르면 3D 위에 조립 안내 카드와 자막이 겹쳐 뜨고, 규칙은 OPMS 에 연결되면 표시된다고 말한다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await uploadAssembly(page);
  await page.getByRole('region', { name: '제조 순서' }).locator('.part-row', { hasText: '제어 기판' }).click();

  const card = page.locator('.holo-host .stage').getByRole('complementary', { name: '조립 안내' });   // 카드는 3D 무대 안에 있다
  await expect(card).toBeVisible();
  await expect(card).toContainText('제어 기판');
  await expect(card.getByText('OPMS에 연결되면 표시돼요')).toBeVisible();
  await expect(page.locator('.holo-host .stage').getByRole('status', { name: /조립 규칙은 OPMS에 연결되면/ })).toBeVisible();   // 아래 자막
  expect(errors).toEqual([]);
});

test('메인 화면의 3D: 배경을 한 번 누르면 포커스가 꺼지고, 배경을 더블클릭하면 전체로 시점이 맞춰진다', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await uploadAssembly(page);
  const canvas = page.locator('.holo-host canvas').first();
  await page.waitForTimeout(1500);
  const box = (await canvas.boundingBox())!;
  const empty = { x: box.x + 40, y: box.y + box.height * 0.4 };                      // 모델 밖 배경
  const card = page.locator('.holo-host .stage').getByRole('complementary', { name: '조립 안내' });

  await clickOnPart(page);                                                           // 부품 선택: 그 층에 포커스
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
  await uploadAssembly(page);
  const canvas = page.locator('.holo-host canvas').first();
  await expect(page.locator('.xs-root')).toHaveAttribute('data-skin', 'glass');            // CAD 무대만 검정이 아니다
  await expect(page.locator('.axl:not([hidden])')).toHaveCount(0);                          // 빨강 · 초록 · 파랑 기준 축 표시 없음

  await page.waitForTimeout(800);
  const box = (await canvas.boundingBox())!;
  const card = page.locator('.holo-host .stage').getByRole('complementary', { name: '조립 안내' });
  const part = await clickOnPart(page);                                                      // 부품이 있는 지점을 찾고 (고른 상태)
  await page.mouse.click(box.x + 40, box.y + box.height * 0.4);                              // 배경을 눌러 선택을 푼다
  await expect(card).toHaveCount(0);
  let before = await canvas.screenshot();                                                    // 시점 전환이 끝나 화면이 멈출 때까지 기다린다
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    const next = await canvas.screenshot();
    if (next.equals(before)) break;
    before = next;
  }

  await page.mouse.click(part.x, part.y, { button: 'right' });                               // 부품 위에서 오른쪽 클릭: 부품을 고르지 않는다
  await page.waitForTimeout(400);
  expect((await canvas.screenshot()).equals(before)).toBe(true);
  await expect(page.locator('.holo-side .part-on')).toHaveCount(0);
  await expect(card).toHaveCount(0);

  await page.mouse.move(part.x, part.y);                                                     // 오른쪽 드래그: 시점이 옮겨진다
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(part.x + 90, part.y + 50, { steps: 6 });
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

test('삭제된 관리 화면(품목 · 등록 요청 · BOM 가져오기 · 관리자)은 열리지 않는다', async ({ page }) => {
  for (const path of ['/items', '/requests', '/bom-import', '/admin/requests']) {
    await page.goto(path);
    await expect(page.getByText(/없는 화면입니다/), path).toBeVisible();
  }
});

test('모바일(390px)에서 화면이 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  for (const path of ['/', '/products', '/products/HCR3A', '/rules', '/mes']) {
    await page.goto(path);
    await expect(page.getByRole('heading').first()).toBeVisible();
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
    }));
    expect(scroll, path).toBeLessThanOrEqual(client);
  }
});
