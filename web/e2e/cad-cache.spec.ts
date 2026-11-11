// 서버 DB 가 정본, 브라우저는 10분 캐시. 실제 브라우저의 IndexedDB · localStorage 와 가짜 시계(context.clock)로 "창을 닫고 9분 / 11분 뒤"를 확인한다.
// 서버 DB 는 가짜 서버(fake-server.ts)가 메모리로 흉내 낸다: 호출 기록으로 "서버를 불렀는가"를 확인한다.
// 실행: E2E_PORT=5188 pnpm e2e e2e/cad-cache.spec.ts
import { type Page } from '@playwright/test';
import { ASSEMBLY_PARTS, clickOnPart, expect, partRows, test, uploadAssembly } from './cad-fixtures';

const MIN = 60_000;
const library = (page: Page) => page.getByRole('region', { name: '등록한 CAD' });
const card = (page: Page, name: string) => library(page).getByRole('button', { name: `${name} 열기` });
const hud = (page: Page) => page.locator('.holo-host .stage').getByRole('complementary', { name: '조립 안내' });

/** 열려 있는 CAD: 그 카드가 열린 것으로 표시되고 제조 순서에 부품이 나온다 */
async function expectOpen(page: Page, name: string) {
  await expect(card(page, name)).toHaveAttribute('aria-current', 'true', { timeout: 20_000 });
  await expect(partRows(page)).toHaveCount(ASSEMBLY_PARTS.electronics.length, { timeout: 20_000 });
}

test('창을 닫고 9분 뒤에는 캐시에서 바로, 11분 뒤에는 서버 DB 에서 받아 열린다', async ({ page, context, server }) => {
  await context.clock.install({ time: new Date('2026-11-11T09:00:00Z') });
  await page.goto('/');
  const name = await uploadAssembly(page);
  await expect(card(page, name)).toContainText('서버 DB 저장됨');
  await expect(card(page, name)).toContainText('캐시 10분 남음');
  expect(server.count('POST', '/api/cads')).toBe(1);
  expect(server.rows.size).toBe(1);

  // 창을 닫고 9분 뒤에 다시 연다: 서버에서 내용을 받지 않고 캐시에서 열린다
  await page.close();
  await context.clock.fastForward(9 * MIN);
  const second = await context.newPage();
  await second.goto('/');
  await expectOpen(second, name);
  expect(server.count('GET', '/content')).toBe(0);
  await expect(card(second, name)).toContainText('캐시 10분 남음');                         // 연 시각부터 다시 10분

  // 다시 닫고 11분 뒤: 캐시가 비워져 서버 DB 에서 받아 열린다
  await second.close();
  await context.clock.fastForward(11 * MIN);
  const third = await context.newPage();
  await third.goto('/');
  await expectOpen(third, name);
  expect(server.count('GET', '/content')).toBe(1);
  await expect(card(third, name)).toContainText('서버 DB 저장됨');
  await expect(card(third, name)).toContainText('캐시 10분 남음');                          // 받아서 다시 캐시에 올랐다
});

test('캐시가 만료된 다른 CAD 는 목록에 "서버에서 불러와요"로 남고, 누르면 서버에서 받아 열린다', async ({ page, context, server }) => {
  await context.clock.install({ time: new Date('2026-11-11T09:00:00Z') });
  await page.goto('/');
  const first = await uploadAssembly(page, { kind: 'electronics', name: 'first-electronics.obj' });
  await context.clock.fastForward(5 * MIN);
  const second = await uploadAssembly(page, { kind: 'frame', name: 'second-frame.obj' });
  for (let i = 0; i < 3; i++) {                                                          // 12분 동안 열어 둔다: 4분마다 하트비트가 한 번씩 돌아 두 번째(열려 있는 것)는 캐시가 이어진다
    await context.clock.fastForward(4 * MIN);
    await page.waitForTimeout(300);
  }
  await page.reload();
  await expect(card(page, second)).toHaveAttribute('aria-current', 'true', { timeout: 20_000 });
  await expect(card(page, first)).toContainText('서버에서 불러와요');
  await expect(card(page, second)).toContainText('캐시');
  expect(server.count('GET', '/content')).toBe(0);

  await card(page, first).click();
  await expectOpen(page, first);
  expect(server.count('GET', '/content')).toBe(1);
  await expect(card(page, first)).toContainText('캐시 10분 남음');
});

test('서버가 꺼진 동안 올린 CAD 는 "이 브라우저에만"으로 남고, 서버가 돌아오면 15초 안에 자동으로 DB 에 올라간다', async ({ page, context, server }) => {
  await context.clock.install({ time: new Date('2026-11-11T09:00:00Z') });
  server.down = true;
  await page.goto('/');
  const name = await uploadAssembly(page);                                               // 서버가 꺼져 있어도 열린다
  await expect(card(page, name)).toContainText('이 브라우저에만');
  await expect(page.getByRole('alert')).toContainText('서버에 연결하지 못했습니다');
  await expect(library(page)).toContainText('서버에 연결되면 자동으로 올려요');
  expect(server.rows.size).toBe(0);

  server.down = false;
  await context.clock.runFor(16_000);                                                    // 열려 있는 동안 15초마다 하트비트가 못 보낸 것을 다시 보낸다
  await expect(card(page, name)).toContainText('서버 DB 저장됨');
  expect(server.rows.size).toBe(1);
  await expect(library(page)).not.toContainText('서버에 연결되면 자동으로 올려요');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('서버에 못 보낸 CAD 는 시간이 지나도 캐시에서 비워지지 않는다 (유일한 사본)', async ({ page, context, server }) => {
  await context.clock.install({ time: new Date('2026-11-11T09:00:00Z') });
  server.down = true;
  await page.goto('/');
  const name = await uploadAssembly(page);
  await page.close();

  await context.clock.fastForward(60 * MIN);                                              // 한 시간 뒤: 서버는 여전히 꺼져 있다
  const later = await context.newPage();
  await later.goto('/');
  await expectOpen(later, name);                                                          // 이 브라우저의 사본으로 열린다
  await expect(card(later, name)).toContainText('이 브라우저에만');

  server.down = false;
  await context.clock.runFor(16_000);
  await expect(card(later, name)).toContainText('서버 DB 저장됨');
  expect(server.rows.size).toBe(1);
});

test('보던 상태(고른 부품)는 창을 닫고 10분 안에는 돌아오고, 지나면 돌아오지 않는다', async ({ page, context }) => {
  await context.clock.install({ time: new Date('2026-11-11T09:00:00Z') });
  await page.goto('/');
  const name = await uploadAssembly(page);
  await clickOnPart(page);
  await expect(hud(page)).toBeVisible();
  const lines = (await hud(page).innerText()).split(/\n/).map(l => l.trim()).filter(Boolean);
  const step = lines[0]!;                                                                // 'STEP n / N'
  const rule = lines.at(-1)!;                                                            // 그 부품에 붙은 조립 규칙 이름 (예: 'SP-CVR-01 · 커버 조립')

  await page.close();
  await context.clock.fastForward(5 * MIN);
  const second = await context.newPage();
  await second.goto('/');
  await expectOpen(second, name);
  await expect(hud(second)).toBeVisible({ timeout: 20_000 });                              // 고른 부품의 조립 안내가 다시 떠 있다
  await expect(hud(second)).toContainText(step);                                           // 같은 단계 · 같은 부품의 안내 (규칙이 붙는 것까지 기다린다)
  await expect(hud(second)).toContainText(rule);

  await second.close();
  await context.clock.fastForward(11 * MIN);
  const third = await context.newPage();
  await third.goto('/');
  await expectOpen(third, name);                                                          // CAD 는 열리지만
  await third.waitForTimeout(800);
  await expect(hud(third)).toHaveCount(0);                                                // 보던 부품은 고르지 않는다
});
