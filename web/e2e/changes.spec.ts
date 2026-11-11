// 설계 변경 화면의 실제 브라우저 확인. 실행: E2E_PORT=5290 pnpm e2e e2e/changes.spec.ts
// 두 모드를 본다: ① 읽어 올 곳이 없는 모드(empty, 기본 개발 서버): 가짜 변경 건 대신 연결 안내 ② http 모드(두 번째 개발 서버): 백엔드 호출을 가짜로 가로채
// SC-1(너트 교체 · 짝 불일치)과 SC-2(상판 두께 · 그립 부족)를 끝까지 따라간다. 실제 백엔드 · OPMS DB 에 의존하지 않는다(변경 건은 시험 픽스처, source_system='fixture').
import { type Page } from '@playwright/test';
import { changeTestApi, sc1Change, sc1Graph, sc2Change } from '../src/pages/changes/testChange';
import { expect, test } from './cad-fixtures';

const HTTP_PORT = Number(process.env.E2E_PORT ?? 5174) + 1;

/** 콘솔 오류 · 페이지 오류를 모은다 (가로챈 API 의 404 는 제외하지 않는다: 이 시험의 요청은 모두 응답이 있어야 한다) */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

test.describe('읽어 올 곳이 없을 때', () => {
  test('설계 변경: 가짜 변경 건 대신 연결 안내가 나오고 사이드바에 메뉴가 있다', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/changes');
    await expect(page.getByRole('heading', { level: 1, name: '설계 변경' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '변경' }).getByRole('link', { name: '설계 변경' })).toBeVisible();
    const note = page.getByRole('status', { name: 'OPMS 연결 안내' });
    await expect(note).toContainText('설계 변경 데이터를 읽어 올 곳이 없어요');
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /새 변경 요청/ })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);                                             // 오류가 아니다
    await noHorizontalScroll(page);
    expect(errors).toEqual([]);
  });
});

test.describe('PDM 백엔드에 연결돼 있을 때 (http 모드, 호출은 가짜)', () => {
  test.use({ baseURL: `http://localhost:${HTTP_PORT}` });

  async function routeChanges(page: Page, fake = changeTestApi([sc1Change(), sc2Change()])) {
    await page.route('**/api/v1/pdm/changes**', async route => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace('/api/v1/pdm', '');
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/changes') return json(await fake.listChanges({}));
      const m = /^\/changes\/([^/]+)(\/impact(?:\/graph)?)?$/.exec(path);
      if (!m) return json({ error: { code: 'NOT_FOUND', message: '없음' } }, 404);
      const change = await fake.getChange(decodeURIComponent(m[1]!));
      if (!change) return json({ error: { code: 'CHANGE_NOT_FOUND', message: '없음' } }, 404);
      if (!m[2]) return json(change);
      if (m[2] === '/impact/graph') return json(sc1Graph);
      return json(change.latest_run);
    });
    return fake;
  }

  test('SC-1: 목록 → 상세에서 짝 불일치(막힘)가 보이고, 막힘이 남아 승인이 잠긴다', async ({ page }) => {
    const errors = collectErrors(page);
    await routeChanges(page);
    await page.goto('/changes');

    const table = page.getByRole('table', { name: '변경 요청 목록' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('link', { name: 'CR-2026-0002' })).toBeVisible();
    const row = table.getByRole('row').filter({ hasText: 'CR-2026-0001' });
    await expect(row.getByRole('group', { name: '영향 요약' })).toContainText(/막힘\s*1/);
    await noHorizontalScroll(page);

    await row.getByRole('link', { name: 'CR-2026-0001' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /너트 P-…22 → P-…23 교체/ })).toBeVisible();
    const findings = page.getByRole('table', { name: '영향 발견' });
    await expect(findings.getByText(/피치 1\.25 ↔ 1\.0/)).toBeVisible();
    await expect(page.getByRole('status', { name: '임시 판정' })).toContainText('PDM 참고 판정 · 기준 미지정');
    await expect(page.getByRole('img', { name: 'CR-2026-0001 영향 그래프' }).or(page.getByRole('group', { name: 'CR-2026-0001 영향 목록' }))).toBeVisible({ timeout: 20_000 });

    // 목록(3D 대안)으로 바꿔도 같은 정보가 키보드로 읽힌다
    await page.getByRole('button', { name: /목록/ }).first().click();
    const list = page.getByRole('group', { name: 'CR-2026-0001 영향 목록' });
    await expect(list.getByText('WO-FX-0002')).toBeVisible();
    await list.getByRole('button', { name: /육각너트 M8\(가는나사\)/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/^선택:/)).toContainText('막힘');

    await page.getByRole('tab', { name: /검토 · 승인/ }).click();
    await expect(page.getByRole('status', { name: '승인할 수 없는 이유' })).toContainText('막힘(blocked) 1건');
    await expect(page.getByRole('button', { name: '승인' })).toBeDisabled();
    expect(errors).toEqual([]);
  });

  test('SC-2: 그립 길이 부족(필요 32.5 mm · 볼트 30 mm · 2.5 mm 부족)과 CAD 추정 표시', async ({ page }) => {
    const errors = collectErrors(page);
    await routeChanges(page);
    await page.goto('/changes/CR-2026-0002');
    const findings = page.getByRole('table', { name: '영향 발견' });
    const grip = findings.getByRole('row').filter({ hasText: '그립 길이' });
    await expect(grip.getByText('필요 32.5 mm · 볼트 30 mm · 2.5 mm 부족').first()).toBeVisible();
    await expect(grip.getByText('추정')).toBeVisible();
    await expect(grip.getByText('막힘')).toBeVisible();
    await page.getByRole('tab', { name: /^대상/ }).click();
    await expect(page.getByRole('table', { name: '변경 대상' }).getByText('8 → 12')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('모바일 폭(390px)에서도 가로 스크롤이 생기지 않는다', async ({ page }) => {
    await routeChanges(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/changes');
    await expect(page.getByRole('table', { name: '변경 요청 목록' })).toBeVisible();
    await noHorizontalScroll(page);
    await page.goto('/changes/CR-2026-0001');
    await expect(page.getByRole('table', { name: '영향 발견' })).toBeVisible();
    await noHorizontalScroll(page);
    await page.getByRole('tab', { name: /^처분/ }).click();
    await expect(page.getByRole('table', { name: '처분' })).toBeVisible();
    await noHorizontalScroll(page);
  });
});
