// 처음에 어떤 CAD 를 띄우는가: 예시(목업) 모델은 없다.
//   ① 마지막에 작업하던 CAD → ② 없으면 가장 최근에 올린 CAD → ③ 하나도 없으면 빈 안내.
// 실행: E2E_PORT=5187 pnpm e2e e2e/cad-restore.spec.ts  (서버 DB · 보관소는 cad-fixtures.ts 의 test 가 가짜 서버로 자동 처리)
import { type Page } from '@playwright/test';
import { ASSEMBLY_PARTS, expect, partRows, shownParts, test, uploadAssembly, type AssemblyKind } from './cad-fixtures';

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const library = (page: Page) => page.getByRole('region', { name: '등록한 CAD' });
const card = (page: Page, name: string) => library(page).getByRole('button', { name: `${name} 열기` });
const expectedParts = (kind: AssemblyKind) => [...ASSEMBLY_PARTS[kind]].sort();

/** 지금 열려 있는 CAD: 제조 순서의 부품 이름이 그 조립품의 것과 같고, 그 카드가 열린 것으로 표시된다 */
async function expectOpen(page: Page, name: string, kind: AssemblyKind) {
  await expect(card(page, name)).toHaveAttribute('aria-current', 'true', { timeout: 20_000 });
  await expect(partRows(page)).toHaveCount(ASSEMBLY_PARTS[kind].length, { timeout: 20_000 });
  expect(await shownParts(page)).toEqual(expectedParts(kind));
  await expect(page.locator('.holo-model')).toContainText(name.replace(/\.obj$/, ''), { timeout: 20_000 });
}

test('처음 열면 예시 모델 대신 빈 안내가 뜨고, CAD 올리기만 있다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  const empty = page.locator('.holo-empty');
  await expect(empty).toContainText('열어 둔 CAD가 없어요', { timeout: 30_000 });                  // 새로 켠 개발 서버가 3D 뷰어를 처음 묶는 데 오래 걸릴 수 있다
  await expect(empty.getByRole('button', { name: 'CAD 올리기' })).toBeVisible();
  await expect(page.getByRole('button', { name: '전자기기' })).toHaveCount(0);               // 예시 모델 선택은 없다
  await expect(page.getByRole('button', { name: '손목시계' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: '예시 모델' })).toHaveCount(0);
  await expect(partRows(page)).toHaveCount(0);                                                // 제조 순서는 비어 있다
  await expect(page.getByRole('region', { name: '제조 순서' })).toContainText('CAD 파일을 올리면 제조 순서가 나옵니다');
  await expect(page.locator('.holo-model')).toHaveText('CAD 없음');
  await expect(library(page).getByText(/아직 등록한 CAD가 없어요/)).toBeVisible();
  await expect(page.locator('.holo-host .stage').getByRole('complementary', { name: '조립 안내' })).toHaveCount(0);
  expect(errors).toEqual([]);

  // 빈 안내의 버튼으로도 올릴 수 있다 (숨은 파일 선택창을 연다)
  const chooser = page.waitForEvent('filechooser');
  await empty.getByRole('button', { name: 'CAD 올리기' }).click();
  await (await chooser).setFiles({ name: 'electronics-box.obj', mimeType: 'text/plain', buffer: Buffer.from('o a\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\nv 1 0 1\nv 1 1 1\nv 0 1 1\nf 1 2 3 4\nf 5 8 7 6\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 4 8 5 1\n') });
  await expect(card(page, 'electronics-box.obj')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.holo-empty')).toHaveCount(0);                                   // 올리면 안내가 사라진다
});

test('올린 CAD 는 화면을 옮겼다 돌아와도, 새로고침해도 같은 CAD 가 같은 부품으로 열려 있다', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const name = await uploadAssembly(page);
  await expectOpen(page, name, 'electronics');

  // 다른 화면(사이드바)으로 갔다가 돌아온다
  await page.getByRole('link', { name: '조립 규칙' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '조립 규칙' })).toBeVisible();
  await page.getByRole('link', { name: 'CAD 스튜디오' }).click();
  await expectOpen(page, name, 'electronics');
  await expect(page.locator('.holo-empty')).toHaveCount(0);

  // 새로고침
  await page.reload();
  await expectOpen(page, name, 'electronics');
  expect(errors.filter(e => !/Failed to load resource/.test(e))).toEqual([]);
});

test('마지막에 작업하던 CAD 가 먼저 열린다: 최근에 올린 것이 아니어도', async ({ page }) => {
  await page.goto('/');
  const first = await uploadAssembly(page, { kind: 'electronics', name: 'first-electronics.obj' });
  await expectOpen(page, first, 'electronics');

  // 두 번째를 올리면 그것이 열린다
  const second = await uploadAssembly(page, { kind: 'frame', name: 'second-frame.obj' });
  await expectOpen(page, second, 'frame');

  // 첫 번째 카드를 눌러 바꿔 열면, 새로고침해도 마지막에 작업하던 첫 번째가 열린다 (가장 최근에 올린 것은 두 번째)
  await card(page, first).click();
  await expectOpen(page, first, 'electronics');
  await page.reload();
  await expectOpen(page, first, 'electronics');
  await expect(card(page, second)).not.toHaveAttribute('aria-current', 'true');

  // 화면을 옮겼다 돌아와도 마찬가지다
  await page.getByRole('link', { name: '조립 규칙' }).click();
  await page.getByRole('link', { name: 'CAD 스튜디오' }).click();
  await expectOpen(page, first, 'electronics');
});

test('마지막에 작업하던 기록이 없으면 가장 최근에 올린 CAD 가 열린다', async ({ page }) => {
  await page.goto('/');
  const first = await uploadAssembly(page, { kind: 'electronics', name: 'first-electronics.obj' });
  await page.waitForTimeout(30);                                                              // 올린 시각이 다르게 (밀리초 단위)
  const second = await uploadAssembly(page, { kind: 'frame', name: 'second-frame.obj' });
  await card(page, first).click();                                                            // 마지막에 작업한 것은 첫 번째
  await expectOpen(page, first, 'electronics');

  await page.evaluate(() => window.localStorage.removeItem('onto-pdm.cad.active'));          // 작업 기록을 지운다
  await page.reload();
  await expectOpen(page, second, 'frame');                                                    // 가장 최근에 올린 것
  await expect(card(page, first)).not.toHaveAttribute('aria-current', 'true');
});

test('열려 있던 CAD 를 목록에서 제거하면 남은 CAD 가 열리고, 마지막 하나까지 지우면 빈 안내로 돌아간다', async ({ page }) => {
  await page.goto('/');
  const first = await uploadAssembly(page, { kind: 'electronics', name: 'first-electronics.obj' });
  await page.waitForTimeout(30);
  const second = await uploadAssembly(page, { kind: 'frame', name: 'second-frame.obj' });
  await expectOpen(page, second, 'frame');

  // 열려 있는 두 번째를 지우면 남은 첫 번째가 열린다
  page.once('dialog', d => void d.accept());
  await library(page).getByRole('button', { name: `${second} 목록에서 제거` }).click();
  await expect(card(page, second)).toHaveCount(0);
  await expectOpen(page, first, 'electronics');
  await expect(page.locator('.holo-empty')).toHaveCount(0);

  // 새로고침해도 지운 것은 돌아오지 않고, 남은 것이 열린다
  await page.reload();
  await expectOpen(page, first, 'electronics');
  await expect(card(page, second)).toHaveCount(0);

  // 마지막 하나까지 지우면 빈 안내 (예시 모델로 돌아가지 않는다)
  page.once('dialog', d => void d.accept());
  await library(page).getByRole('button', { name: `${first} 목록에서 제거` }).click();
  await expect(page.locator('.holo-empty')).toContainText('열어 둔 CAD가 없어요', { timeout: 20_000 });
  await expect(partRows(page)).toHaveCount(0);
  await expect(library(page).getByText(/아직 등록한 CAD가 없어요/)).toBeVisible();
  await expect(page.locator('.holo-model')).toHaveText('CAD 없음');
  await page.reload();
  await expect(page.locator('.holo-empty')).toContainText('열어 둔 CAD가 없어요');
});

test('열려 있지 않은 CAD 를 지워도 보던 CAD 는 그대로다', async ({ page }) => {
  await page.goto('/');
  const first = await uploadAssembly(page, { kind: 'electronics', name: 'first-electronics.obj' });
  const second = await uploadAssembly(page, { kind: 'frame', name: 'second-frame.obj' });
  await expectOpen(page, second, 'frame');

  page.once('dialog', d => void d.accept());
  await library(page).getByRole('button', { name: `${first} 목록에서 제거` }).click();
  await expect(card(page, first)).toHaveCount(0);
  await expectOpen(page, second, 'frame');                                                    // 열려 있던 것이 바뀌지 않는다
});
