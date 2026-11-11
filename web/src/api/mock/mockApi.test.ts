import { describe, expect, it } from 'vitest';
import type { BomNode } from '../types';
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
    const mine = await api.getItem('P-00000000150');                    // 이설계가 만든 작업중 품목
    expect(mine.revisions.map(r => r.status)).toEqual(['wip']);

    session.userId = 1; session.adminMode = false;                    // 관리자 역할이지만 모드 꺼짐
    await expect(api.getItem('P-00000000150')).rejects.toMatchObject({ status: 404 });
    session.adminMode = true;
    expect((await api.getItem('P-00000000150')).itemNo).toBe('P-00000000150');
  });

  it('관리자 모드가 아니면 다른 사람의 검토중 리비전이 목록 상태에 나오지 않는다', async () => {
    const { api } = setup({ userId: 1, adminMode: false });
    const cover = (await api.listItems({})).find(i => i.itemNo === 'P-00000000112')!;
    expect(cover.latestRevision?.rev).toBe('R00');
    expect(cover.latestRevision?.status).toBe('released');
  });

  it('별칭(레거시 품번)으로 검색된다', async () => {
    const { api } = setup();
    expect((await api.listItems({ q: 'BLT-0038' })).map(i => i.itemNo)).toEqual(['P-00000000001']);
  });
});

describe('BOM', () => {
  it('생산 보기는 승인본 BOM, 총수량은 단계마다 곱한다', async () => {
    const { api } = setup({ userId: 2, adminMode: false });
    const body = await api.getItem('P-00000000100');
    const bom = flat(await api.getBom(body.releasedRevision!.id, 'released'));
    const boltsUnderJ1 = bom.find(n => n.item.itemNo === 'P-00000000001' && n.depth === 2)!;
    expect(boltsUnderJ1.totalQuantity).toBe(12);
    expect(bom.some(n => n.item.itemNo === 'P-00000000150')).toBe(false);   // R02(작업중)에만 있는 브레이크
  });

  it('설계 보기는 보이는 최신 리비전을 따라간다', async () => {
    const { api } = setup({ userId: 1, adminMode: true });
    const base = await api.getItem('P-00000000110');
    const latest = flat(await api.getBom(base.releasedRevision!.id, 'latest'));
    expect(latest.find(n => n.item.itemNo === 'P-00000000112')!.revision?.rev).toBe('R01');   // 검토중
    const released = flat(await api.getBom(base.releasedRevision!.id, 'released'));
    expect(released.find(n => n.item.itemNo === 'P-00000000112')!.revision?.rev).toBe('R00');
  });

  it('공용 베이스 조립품의 사용처는 두 제품 (상위 리비전마다 한 줄)', async () => {
    const { api } = setup();
    const base = await api.getItem('P-00000000110');
    const used = await api.getWhereUsed(base.id);
    expect([...new Set(used.map(w => w.parent.itemNo))].sort()).toEqual(['P-00000000100', 'P-00000000200']);
    expect(used.filter(w => w.parent.itemNo === 'P-00000000100').map(w => w.parentRevision.rev).sort()).toEqual(['R01', 'R02']);
    expect(base.products.map(p => p.code).sort()).toEqual(['HCR3A', 'HCR5A']);
  });
});

describe('CAD 부품 → 보유 품번 매칭 (설계 6장)', () => {
  it('이름이 정확히 같으면 확정하고, CAD 이름 별칭과 비슷한 이름은 후보로만 둔다', async () => {
    const { api } = setup();
    const [exact, cadAlias, fuzzy] = await api.matchCadParts(['전원 버튼', '기판 나사 M3', '하우징']);
    expect(exact).toMatchObject({ status: 'matched', itemNo: 'P-00000000160', method: 'exact', score: 1 });
    expect(cadAlias).toMatchObject({ status: 'suggested', itemNo: 'P-00000000001', method: 'cad_name', score: 0.97 });
    expect(fuzzy).toMatchObject({ status: 'suggested', method: 'fuzzy' });
  });

  it('대소문자 · 공백 · 하이픈을 무시한 일치는 정규화 후보다', async () => {
    const { api } = setup();
    const [m] = await api.matchCadParts(['p 00000000121']);
    expect(m).toMatchObject({ status: 'suggested', itemNo: 'P-00000000121', method: 'normalized', score: 0.95 });
  });

  it('보유 품번이 없으면 CAD 이름 그대로 두고, 이름으로 추정한 분류를 붙인다', async () => {
    const { api } = setup();
    const [cover, board] = await api.matchCadParts(['상부 커버', '제어 기판']);
    expect(cover?.status).toBe('none');
    expect(cover?.classPath).toEqual(['하우징 · 커버', '커버']);
    expect(board).toEqual({ name: '제어 기판', status: 'none' });                // 분류도 없다 → OPMS 분류 제안 대상
  });

  it('보유한 품목에는 그 품목의 분류 사슬이 따라온다', async () => {
    const { api } = setup();
    const [m] = await api.matchCadParts(['배터리']);
    expect(m?.classPath).toEqual(['전기 · 전자', '배터리']);
  });

  it('남의 작업중 품목은 매칭 후보가 아니다 (공개 범위)', async () => {
    const { api } = setup({ userId: 1, adminMode: false });
    const [m] = await api.matchCadParts(['J1 브레이크']);                        // 이설계의 작업중 품목
    expect(m?.status).not.toBe('matched');
  });
});

describe('조립 규칙 (가상 회사 온토전자, 목업)', () => {
  it('나사는 체결 토크 · 순서, 커버는 두께로 필요한 나사 길이를 계산한다', async () => {
    const { api } = setup();
    const [screw, cover] = await api.getAssemblyGuides([
      { name: '기판 나사 M3', size: [3, 3, 8] },
      { name: '상부 커버', size: [126, 80, 3] },
    ]);
    expect(screw).toMatchObject({ ruleId: 'SP-FAS-01', operation: 'fasten', operationLabel: '볼트 체결' });
    expect(screw?.params).toContainEqual({ label: '체결 토크', value: '0.6 N·m ±10%' });
    expect(cover).toMatchObject({ ruleId: 'SP-CVR-01', operation: 'cover' });
    expect(cover?.params).toContainEqual({ label: '필요 나사 길이', value: '≥ 7.5 mm (두께 + 1.5 × 지름)' });
    expect(cover?.params).toContainEqual({ label: '사용 나사', value: 'M3 × 12', ok: true });       // 12 ≥ 3 + 4.5
  });

  it('용접 조건은 모재 두께에 따라 바뀐다: 얇으면 I형, 두꺼우면 V형 · 굵은 필러', async () => {
    const { api } = setup();
    const [thin, thick] = await api.getAssemblyGuides([{ name: '러그', size: [3, 2.6, 7] }, { name: '러그', size: [20, 8, 30] }]);
    expect(thin?.params).toEqual(expect.arrayContaining([{ label: '개선 형상', value: 'I형 (개선 없음)' }, { label: '필러(용접봉) 지름', value: 'Φ1.6' }]));
    expect(thick?.params).toEqual(expect.arrayContaining([{ label: '개선 형상', value: 'V형 60° · 다층 용접' }, { label: '필러(용접봉) 지름', value: 'Φ3.2' }]));
    expect(thin?.cautions[0]).toContain('가상 값');                                                    // 가상 조건표임을 숨기지 않는다
  });

  it('기판은 입력 · 출력 포트 방향을 알려 주고, 압입은 별도 공정이며, 규칙 없는 부품은 빠진다', async () => {
    const { api } = setup();
    const guides = await api.getAssemblyGuides([{ name: '제어 기판' }, { name: '사파이어 크리스털' }, { name: '볼펜 심' }]);
    expect(guides.map(g => g.partName)).toEqual(['제어 기판', '사파이어 크리스털']);
    expect(guides[0]?.params).toEqual(expect.arrayContaining([{ label: '입력 포트 위치', value: '왼쪽 (−X)' }, { label: '출력 포트 위치', value: '오른쪽 (+X)' }]));
    expect(guides[1]).toMatchObject({ ruleId: 'SP-PRS-01', operation: 'press_fit' });
  });
});

describe('조립 규칙 목록 · 상세 (목업)', () => {
  it('규칙 11개: 승인 9 · 검토 전 2, 항목마다 핵심 값 2개와 적용 대상이 있다', async () => {
    const { api } = setup();
    const rules = await api.listAssemblyRules();
    expect(rules).toHaveLength(11);
    expect(rules.filter(r => r.status === 'approved')).toHaveLength(9);
    expect(rules.filter(r => r.status === 'draft').map(r => r.id).sort()).toEqual(['SP-PRS-01', 'SP-WLD-01']);       // 가상 값은 검토 전
    expect(new Set(rules.map(r => r.id)).size).toBe(11);
    rules.forEach(r => {
      expect(r.keyValues, r.id).toHaveLength(2);
      expect(r.appliesTo.length, r.id).toBeGreaterThan(0);
      expect(r.source, r.id).toContain(r.id);
    });
    expect(rules.find(r => r.id === 'SP-MOT-01')?.keyValues).toEqual([
      { label: '전원 포트 위치', value: '왼쪽 (−X)' }, { label: '엔코더 포트 위치', value: '오른쪽 (+X)' },
    ]);
  });

  it('용접 규칙 상세: 조건표 4행과 설명 · 조건 · 주의사항', async () => {
    const { api } = setup();
    const weld = await api.getAssemblyRule('SP-WLD-01');
    expect(weld).toMatchObject({ status: 'draft', operation: 'weld', operationLabel: '용접' });
    expect(weld.table?.columns).toEqual(['모재 두께', '개선 형상', '필러 지름', '루트 갭']);
    expect(weld.table?.rows).toHaveLength(4);
    expect(weld.table?.rows[0]).toEqual(['< 1.5 mm', 'I형 (개선 없음)', 'Φ1.0', '0 mm']);
    expect(weld.table?.rows[3]).toEqual(['≥ 6 mm', 'V형 60° · 다층 용접', 'Φ3.2', '2 ~ 3 mm']);
    expect(weld.conditions.length).toBeGreaterThan(0);
    expect(weld.cautions[0]).toContain('가상 값');
    expect(weld.usedBy).toEqual([]);                                                                 // 러그 품목은 보유 목록에 없다
  });

  it('규칙이 적용되는 보유 품목(usedBy)은 품목 이름으로 찾는다', async () => {
    const { api } = setup();
    const reducer = await api.getAssemblyRule('SP-RED-01');
    expect(reducer.usedBy.map(u => u.itemNo)).toEqual(expect.arrayContaining(['P-00000000121', 'P-00000000131']));   // J1 · J2 감속기
    const motor = await api.getAssemblyRule('SP-MOT-01');
    expect(motor.usedBy).toContainEqual({ itemNo: 'P-00000000122', name: '서보 모터 400W' });
    const screw = await api.getAssemblyRule('SP-FAS-01');
    expect(screw.usedBy).toContainEqual({ itemNo: 'P-00000000001', name: '볼트 M3x8' });
  });

  it('없는 규칙은 404', async () => {
    const { api } = setup();
    await expect(api.getAssemblyRule('SP-NOPE-99')).rejects.toMatchObject({ status: 404 });
  });
});

describe('조립 규칙: 분류 · 속성으로 걸기와 검증 (API)', () => {
  it('getAssemblyGuides 는 분류(className)와 속성(attributes)을 받아 규칙을 고른다', async () => {
    const { api } = setup();
    const [byClass, wrongClass, byName, thick] = await api.getAssemblyGuides([
      { name: '기판 고정 나사', className: '볼트', attributes: { threadSize: 'M3' } },      // 이름에 규격이 없어도 분류 + 속성으로 걸린다
      { name: '볼트 M3x8', className: '커버', attributes: { thickness: 3 } },                // 분류가 우선: 나사 규칙이 아니라 커버 규칙
      { name: '기판 나사 M3' },                                                               // 이름만으로도 걸린다 (하위 호환)
      { name: '러그', attributes: { thickness: 8 } },                                         // 두께 속성이 있으면 크기 없이도 계산
    ]);
    expect(byClass).toMatchObject({ partName: '기판 고정 나사', ruleId: 'SP-FAS-01' });
    expect(wrongClass).toMatchObject({ ruleId: 'SP-CVR-01' });
    expect(byName).toMatchObject({ ruleId: 'SP-FAS-01' });
    expect(thick?.params).toContainEqual({ label: '개선 형상', value: 'V형 60° · 다층 용접' });
  });

  it('M4 볼트처럼 속성 조건이 안 맞는 부품과 규칙 없는 부품은 빠진다', async () => {
    const { api } = setup();
    const guides = await api.getAssemblyGuides([
      { name: '볼트 M4x10', className: '볼트', attributes: { threadSize: 'M4' } },
      { name: '볼펜 심' },
    ]);
    expect(guides).toEqual([]);
  });

});
