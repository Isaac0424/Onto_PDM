// 실제 브라우저 · http 모드(PDM 백엔드): 조립 규칙 목록 · 작업표준 · 스튜디오 조립 안내가 규칙집(rules/)을 읽는다.
// 백엔드 호출(/api/v1/pdm)은 같은 응답 모양의 가짜로 가로챈다(src/api/testBackend.ts: 실제 rules/ 에서 옮긴 규칙 5 · 작업표준서 3 · 공백 4): 실제 백엔드 · OPMS DB 에 의존하지 않는다.
// 서버 DB · 보관소는 cad-fixtures.ts 가 가로챈다. 이 파일은 playwright.config.ts 의 두 번째 개발 서버(E2E_PORT + 1, VITE_API_MODE=http)를 쓴다.
// 실행: E2E_PORT=5205 pnpm e2e e2e/rulebook.spec.ts
import { type Page } from '@playwright/test';
import { fakeBackend, type FakeBackend } from '../src/api/testBackend';
import { expect, partRows, test, uploadBolts } from './cad-fixtures';

const HTTP_PORT = Number(process.env.E2E_PORT ?? 5174) + 1;
test.use({ baseURL: `http://localhost:${HTTP_PORT}` });

async function routeBackend(page: Page, fake: FakeBackend) {
  await page.route('**/api/v1/pdm/**', async route => {
    const req = route.request();
    try {
      const res = await fake.fetch(new URL(req.url()).pathname, { method: req.method(), ...(req.postData() ? { body: req.postData()! } : {}) });
      await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
    } catch { await route.abort('connectionrefused'); }               // 백엔드가 꺼진 것을 흉내 낸다
  });
}

const noOverflow = async (page: Page) => {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
};

test('조립 규칙: 규칙집 상태줄 · 규칙 목록 · 값마다 출처 배지(쪽 번호 · CAD 추정 · 작성 필요)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  await routeBackend(page, fakeBackend());
  await page.goto('/rules');

  await expect(page.getByRole('status', { name: '규칙집 상태' })).toContainText('규칙집 적재됨 · 규칙 5 · 작업표준 3 · 공백 4 · 모두 초안(검토 전)');
  const list = page.getByRole('region', { name: '규칙 목록' });
  await expect(list.getByRole('link')).toHaveCount(5);
  await expect(list.getByText('초안 · 검토 전')).toHaveCount(5);

  // 사용설명서 근거: 쪽 번호가 붙은 확정값
  await list.getByRole('link', { name: /AR-FAS-001/ }).click();
  const detail = page.getByRole('region', { name: '규칙 상세' });
  await expect(detail.getByRole('heading', { level: 2, name: '로봇 암 베이스 고정 볼트 체결' })).toBeVisible();
  const table = detail.getByRole('table', { name: '조건표' });
  await expect(table.getByRole('row').nth(3)).toContainText('HCR-12A');
  await expect(table.getByRole('row').nth(3)).toContainText('140 N·m');
  await expect(detail.getByRole('list', { name: '주의사항' })).toContainText('사용설명서(KR) 3.3절 p.49');

  // 근거가 없는 값: 확정값처럼 보이지 않는다
  await list.getByRole('link', { name: /AR-FAS-006/ }).click();
  await expect(detail.getByRole('heading', { level: 2, name: /로봇 암 본체 소켓 헤드 볼트/ })).toBeVisible();
  await expect(detail.getByRole('region', { name: '적용 대상' }).getByText('CAD 추정')).toBeVisible();
  const torque = detail.getByRole('table', { name: '규칙 값' }).getByRole('row').filter({ hasText: '체결 토크' });
  await expect(torque).toContainText('작성 필요 G-001');
  await expect(torque).toContainText('근거 없음 · 작성 필요 G-001');
  await expect(detail.getByRole('region', { name: '작성이 필요한 곳' })).toContainText('G-001');

  // 필터
  await list.getByRole('combobox', { name: '출처 필터' }).selectOption('unknown');
  await expect(list.getByRole('link')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('조립 규칙: 백엔드가 꺼져 있으면 이유를 말하고 (빨강 아님), 켜고 다시 시도하면 규칙이 보인다', async ({ page }) => {
  const fake = fakeBackend({ backend: 'down' });
  await routeBackend(page, fake);
  await page.goto('/rules');
  const note = page.getByRole('status', { name: '규칙집 연결 안내' });
  await expect(note).toContainText('PDM 백엔드가 꺼져 있어요');
  await expect(page.getByRole('alert')).toHaveCount(0);
  fake.state.backend = 'up';
  await note.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByRole('region', { name: '규칙 목록' }).getByRole('link')).toHaveCount(5);
});

test('조립 규칙: rules/ 에 검증 오류가 있으면 규칙 대신 오류 목록을 펼쳐 보인다', async ({ page }) => {
  await routeBackend(page, fakeBackend({ rulebook: 'invalid' }));
  await page.goto('/rules');
  const note = page.getByRole('status', { name: '규칙집 연결 안내' });
  await expect(note).toContainText('오류가 있어 보여 드릴 수 없어요');
  await note.getByText('오류 2건 보기').click();
  await expect(note.getByRole('list', { name: '규칙집 오류 목록' })).toContainText('없는 규칙 AR-X-999 을 참조합니다');
  await expect(page.getByRole('region', { name: '규칙 목록' })).toHaveCount(0);
});

test('작업 표준: 작업표준서 목록 → 작업 순서 · 경고 문구(쪽 번호) · 품질 확인 · 표준 시간 없음 · 작성 필요 목록', async ({ page }) => {
  await routeBackend(page, fakeBackend());
  await page.goto('/mes');
  await expect(page.getByRole('heading', { level: 1, name: '작업 표준' })).toBeVisible();
  const list = page.getByRole('region', { name: '작업표준서 목록' });
  await expect(list.getByRole('button', { name: /WS-/ })).toHaveCount(3);

  const detail = page.getByRole('region', { name: '작업표준서 상세' });
  await expect(detail.getByRole('heading', { level: 2, name: '로봇 암 베이스 고정' })).toBeVisible();
  await expect(detail.getByRole('region', { name: '표준 시간' })).toContainText('표준 시간 없음 — 근거 없음 (G-006)');
  await expect(detail.getByRole('region', { name: '작업 순서' }).getByRole('listitem')).toHaveCount(3);
  await expect(detail.getByRole('list', { name: '작업 주의사항' })).toContainText('사용설명서(KR) 3.3절 p.50');
  await expect(detail.getByRole('region', { name: '품질 확인' })).toContainText('판정 기준: 완전 밀착');
  await expect(detail.getByRole('button', { name: '인쇄' })).toBeVisible();

  await list.getByRole('button', { name: /WS-HCR12A-ASM-01/ }).click();
  await expect(detail.getByText(/작업 절차\(순서 · 토크 · 공구\)가 없어요/)).toBeVisible();
  await expect(detail.getByRole('table', { name: '2번 암 조립품 체결 부품' })).toContainText('BOLT-M4X15');

  await list.getByRole('button', { name: /작성 필요 목록/ }).click();
  await expect(page.getByRole('region', { name: '작성 필요 목록' })).toContainText('소켓 헤드 볼트(M3 · M4) 체결 토크');
});

test('모바일(390px)에서도 조립 규칙 · 작업 표준 화면이 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await routeBackend(page, fakeBackend());
  await page.goto('/rules/AR-FAS-001');
  await expect(page.getByRole('region', { name: '규칙 상세' }).getByRole('table', { name: '조건표' })).toBeVisible();
  await noOverflow(page);
  await page.goto('/mes?standard=WS-HCR-INS-02');
  await expect(page.getByRole('region', { name: '작업표준서 상세' }).getByRole('region', { name: '작업 순서' })).toBeVisible();
  await noOverflow(page);
});

test('스튜디오 조립 안내: 볼트를 고르면 CAD 추정 기준으로 적용되는 규칙이 뜨고, 역할을 고르면 그 역할의 규칙(모델별 값)이 정해진다', async ({ page }) => {
  const fake = fakeBackend();
  await routeBackend(page, fake);
  await page.goto('/');
  await uploadBolts(page, 'Body HCR12A R00 3D.obj');                       // 파일 이름에서 로봇 모델(HCR-12A)을 읽는다
  await partRows(page).filter({ hasText: 'PRT-S1' }).first().click();

  const hud = page.getByRole('complementary', { name: '조립 안내' });
  await expect(hud.getByText('CAD 추정 기준')).toBeVisible({ timeout: 30_000 });
  await expect(hud.getByText('HCR-12A')).toBeVisible();
  const applied = hud.getByRole('region', { name: '적용되는 규칙', exact: true });
  await expect(applied).toContainText('AR-SAF-001');
  await expect(applied).toContainText('사용설명서(KR) 3.3절 p.50');
  await expect(hud.getByRole('region', { name: '확정하면 적용되는 규칙' })).toContainText('알아야 확정돼요: 이 볼트의 역할');
  await expect(page.getByRole('status', { name: /^\(CAD 추정\) 로봇에 조립되어 있는 볼트는 절대 임의로 분해하지 마세요/ })).toBeVisible();

  // PRT-S1 은 M6 이라 'M3 · M4 소켓 헤드 볼트' 규칙(AR-FAS-006)은 해당 없음 — 역할 선택지에 나오지 않는다
  await expect(hud.getByRole('button', { name: '로봇 암 본체 조립에 쓰인 M3 · M4 소켓 헤드 볼트' })).toHaveCount(0);
  await hud.getByRole('button', { name: '로봇 암 베이스를 설치면에 고정하는 볼트 4개' }).click();
  const base = hud.getByRole('region', { name: '적용되는 규칙', exact: true });
  await expect(base).toContainText('AR-FAS-001');
  await expect(base).toContainText('나사 규격M12');                               // 모델(HCR-12A)로 표의 행이 하나로 정해진다 — 사용설명서 3.3
  await expect(base).toContainText('체결 토크140 N·m');
  const selects = fake.calls.filter(c => c.path === '/rulebook/select');
  expect(selects.length).toBeLessThanOrEqual(3);
  expect(selects.at(-1)!.body).toMatchObject({ class_code: 'SocketHeadBolt', role: 'robot_base_mount', model: 'HCR-12A', attributes: { threadSize: 'M6', length: 25 } });
});

test('스튜디오 조립 안내: 판(종류를 알 수 없음)은 규칙을 고르지 않고 이유를 말한다', async ({ page }) => {
  const fake = fakeBackend();
  await routeBackend(page, fake);
  await page.goto('/');
  await uploadBolts(page);
  await partRows(page).filter({ hasText: 'PRT-PLATE' }).first().click();
  await expect(page.getByRole('complementary', { name: '조립 안내' })).toContainText('종류를 알 수 없어 규칙을 고를 수 없어요');
  expect(fake.calls.filter(c => c.path === '/rulebook/select')).toHaveLength(0);
});
