import { describe, expect, it } from 'vitest';
import { ApiError, type BomNode } from '../types';
import { createMockApi, type Session } from './mockApi';

function setup(initial: Session = { userId: 1, adminMode: true }) {
  const session = { ...initial };
  const api = createMockApi(() => session);
  return { api, session };
}
const flat = (nodes: BomNode[]): BomNode[] => nodes.flatMap(n => [n, ...flat(n.children)]);

describe('공개 범위', () => {
  it('엔지니어는 남의 작업중 리비전을 못 보고, 관리자 모드는 본다', async () => {
    const { api, session } = setup({ userId: 2, adminMode: false });
    const mine = await api.getItem('P0000150');                    // 이설계가 만든 작업중 품목
    expect(mine.revisions.map(r => r.status)).toEqual(['wip']);

    session.userId = 1; session.adminMode = false;                    // 관리자 역할이지만 모드 꺼짐
    await expect(api.getItem('P0000150')).rejects.toMatchObject({ status: 404 });
    session.adminMode = true;
    expect((await api.getItem('P0000150')).itemNo).toBe('P0000150');
  });

  it('관리자 모드가 아니면 다른 사람의 검토중 리비전이 목록 상태에 나오지 않는다', async () => {
    const { api } = setup({ userId: 1, adminMode: false });
    const cover = (await api.listItems({})).find(i => i.itemNo === 'P0000112')!;
    expect(cover.latestRevision?.rev).toBe('R00');
    expect(cover.latestRevision?.status).toBe('released');
  });

  it('별칭(레거시 품번)으로 검색된다', async () => {
    const { api } = setup();
    expect((await api.listItems({ q: 'BLT-0038' })).map(i => i.itemNo)).toEqual(['P0000001']);
  });
});

describe('BOM', () => {
  it('생산 보기는 승인본 BOM, 총수량은 단계마다 곱한다', async () => {
    const { api } = setup({ userId: 2, adminMode: false });
    const body = await api.getItem('P0000100');
    const bom = flat(await api.getBom(body.releasedRevision!.id, 'released'));
    const boltsUnderJ1 = bom.find(n => n.item.itemNo === 'P0000001' && n.depth === 2)!;
    expect(boltsUnderJ1.totalQuantity).toBe(12);
    expect(bom.some(n => n.item.itemNo === 'P0000150')).toBe(false);   // R02(작업중)에만 있는 브레이크
  });

  it('설계 보기는 보이는 최신 리비전을 따라간다', async () => {
    const { api } = setup({ userId: 1, adminMode: true });
    const base = await api.getItem('P0000110');
    const latest = flat(await api.getBom(base.releasedRevision!.id, 'latest'));
    expect(latest.find(n => n.item.itemNo === 'P0000112')!.revision?.rev).toBe('R01');   // 검토중
    const released = flat(await api.getBom(base.releasedRevision!.id, 'released'));
    expect(released.find(n => n.item.itemNo === 'P0000112')!.revision?.rev).toBe('R00');
  });

  it('공용 베이스 조립품의 사용처는 두 제품 (상위 리비전마다 한 줄)', async () => {
    const { api } = setup();
    const base = await api.getItem('P0000110');
    const used = await api.getWhereUsed(base.id);
    expect([...new Set(used.map(w => w.parent.itemNo))].sort()).toEqual(['P0000100', 'P0000200']);
    expect(used.filter(w => w.parent.itemNo === 'P0000100').map(w => w.parentRevision.rev).sort()).toEqual(['R01', 'R02']);
    expect(base.products.map(p => p.code).sort()).toEqual(['HCR3A', 'HCR5A']);
  });
});

describe('등록 요청', () => {
  it('임시저장은 빈 칸 허용, 제출은 이름 필요, 승인은 관리자 모드만', async () => {
    const { api, session } = setup({ userId: 2, adminMode: false });
    const draft = await api.savePartRequest(null, {});
    expect(draft.status).toBe('draft');
    await expect(api.submitPartRequest(draft.id)).rejects.toMatchObject({ status: 400 });

    await api.savePartRequest(draft.id, { name: 'Spacer 3mm', nameKo: '스페이서 3mm', classIri: 'cls:C0100' });
    const submitted = await api.submitPartRequest(draft.id);
    expect(submitted.status).toBe('submitted');
    await expect(api.approvePartRequest(draft.id)).rejects.toBeInstanceOf(ApiError);

    session.userId = 1; session.adminMode = true;
    const approved = await api.approvePartRequest(draft.id);
    expect(approved.issuedItemNo).toMatch(/^P\d{7}$/);
    const item = await api.getItem(approved.issuedItemNo!);
    expect(item.revisions.map(r => `${r.rev}:${r.status}`)).toEqual(['R00:wip']);
  });

  it('남의 임시저장은 관리자 모드에서만 보인다', async () => {
    const { api, session } = setup({ userId: 2, adminMode: false });
    await expect(api.listPartRequests('all')).rejects.toMatchObject({ status: 403 });
    session.userId = 1; session.adminMode = true;
    expect((await api.listPartRequests('all')).some(r => r.requestedBy === 2 && r.status === 'draft')).toBe(true);
  });

  it('분류가 없으면 승인할 수 없고, 분류 제안을 승인하면 기다리던 요청에 분류가 들어간다', async () => {
    const { api } = setup();
    await expect(api.approvePartRequest(1)).rejects.toMatchObject({ status: 409 });   // 1번은 임시저장
    const p = await api.approveClassProposal(1);
    expect(p.approvedIri).toBe('cls:C0102');
    expect((await api.getPartRequest(3)).payload.classIri).toBe('cls:C0102');
    expect((await api.listOutbox()).some(o => o.aggregate === 'class' && o.target.startsWith('cls:C0102'))).toBe(true);
  });

  it('기존 별칭과 겹치면 승인이 거부된다', async () => {
    const { api } = setup();
    const r = await api.savePartRequest(null, { name: 'Bolt again', classIri: 'cls:C0101', aliases: [{ scheme: 'legacy', value: 'BLT-0038' }] });
    const s = await api.submitPartRequest(r.id);
    expect(s.duplicateCheck?.[0]).toMatchObject({ itemNo: 'P0000001' });
    await expect(api.approvePartRequest(r.id)).rejects.toMatchObject({ status: 409 });
  });
});
