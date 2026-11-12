// 등록한 CAD 목록 접고 펴기: 3D 화면이 바로 보이도록 기본은 접혀 있다.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CadLibraryStrip } from './CadLibraryStrip';
import type { CadEntry } from './cadLibrary';

const entry = (id: string, name: string): CadEntry => ({
  id, name, format: 'step', size: 2048, addedAt: '2026-11-12T01:00:00.000Z', storage: 'server', cached: true,
  cacheExpiresAt: '2026-11-12T01:10:00.000Z',
} as CadEntry);

const strip = (entries: CadEntry[], activeId?: string) => (
  <CadLibraryStrip entries={entries} {...(activeId ? { activeId } : {})} now={Date.parse('2026-11-12T01:01:00.000Z')}
    onOpen={vi.fn()} onRemove={vi.fn()} onUpload={vi.fn()} onLoadVault={async () => []} onImportVault={async () => {}} />
);

beforeEach(() => { window.localStorage.removeItem('onto-pdm.cad.lib-open'); });      // 사람이 정한 값이 없는 첫 방문

describe('등록한 CAD 목록 접기', () => {
  it('CAD 가 있으면 접힌 채 시작하고, 열린 CAD 이름만 머리줄에 보인다', () => {
    render(strip([entry('a', 'a.step'), entry('b', 'b.step')], 'b'));
    expect(screen.getByRole('button', { name: /등록한 CAD/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'a.step 열기' })).not.toBeInTheDocument();
    expect(screen.getByText('열린 CAD · b.step')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /CAD 등록/ })).toBeInTheDocument();         // 올리기는 접혀 있어도 누를 수 있다
  });

  it('누르면 펴지고, 고른 상태를 기억한다', async () => {
    const user = userEvent.setup();
    const { unmount } = render(strip([entry('a', 'a.step')], 'a'));
    await user.click(screen.getByRole('button', { name: /등록한 CAD/ }));
    expect(screen.getByRole('button', { name: 'a.step 열기' })).toBeInTheDocument();
    unmount();
    render(strip([entry('a', 'a.step')], 'a'));                                            // 다시 열어도 펴진 채
    expect(screen.getByRole('button', { name: 'a.step 열기' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /등록한 CAD/ }));
    expect(within(document.body).queryByRole('button', { name: 'a.step 열기' })).not.toBeInTheDocument();
  });

  it('등록한 CAD 가 하나도 없으면 펴서 안내한다', () => {
    render(strip([]));
    expect(screen.getByText(/아직 등록한 CAD가 없어요/)).toBeInTheDocument();
  });
});
