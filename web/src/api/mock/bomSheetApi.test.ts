import { describe, expect, it } from 'vitest';
import { parseBomSheet } from '../../extract';
import { createMockApi } from './mockApi';

function setup(initial = { userId: 1, adminMode: true }) {
  const session = { ...initial };
  return { api: createMockApi(() => session), session };
}

describe('matchBomSheet (목 API)', () => {
  it('품번이 일치하면 확정, 이름만 맞으면 후보, 아무것도 없으면 등록 요청 대상이다', async () => {
    const { api } = setup();
    const [matched, byName, none] = await api.matchBomSheet([
      { line: 1, itemNo: 'P-00000000001', name: '볼트 M3x8', quantity: 4 },
      { line: 2, name: '전원 버튼', quantity: 1 },
      { line: 3, itemNo: 'P-99999999999', name: '고정용 클립 XQ-7', quantity: 2 },
    ]);
    expect(matched).toMatchObject({ line: 1, status: 'matched', itemNo: 'P-00000000001', itemName: '볼트 M3x8', reason: '품번 일치' });
    expect(byName).toMatchObject({ line: 2, status: 'suggested', itemNo: 'P-00000000160', reason: '이름 일치: 품번을 확인하세요' });
    expect(none).toMatchObject({ line: 3, status: 'none' });
    expect(none.itemNo).toBeUndefined();
    expect(none.reason).toBe('보유 품번 없음 · 등록 요청 대상 (시트 품번 P-99999999999은(는) 보유 목록에 없습니다)');
  });

  it('품번은 대소문자 · 하이픈 · 공백을 무시하고 맞춘다', async () => {
    const { api } = setup();
    const [m] = await api.matchBomSheet([{ line: 1, itemNo: 'p 00000000160', quantity: 1 }]);
    expect(m).toMatchObject({ status: 'matched', itemNo: 'P-00000000160' });
  });

  it('품번은 일치하지만 이름이 다르면 사유에 알린다 (확정은 유지)', async () => {
    const { api } = setup();
    const [m] = await api.matchBomSheet([{ line: 1, itemNo: 'P-00000000160', name: '완전히 다른 부품명', quantity: 1 }]);
    expect(m!.status).toBe('matched');
    expect(m!.reason).toBe('품번 일치 (품번은 일치하지만 이름이 다릅니다: 시트 "완전히 다른 부품명" / 품목 "전원 버튼")');
    const [same] = await api.matchBomSheet([{ line: 1, itemNo: 'P-00000000160', name: 'Power button', quantity: 1 }]);     // 영문 이름이 같으면 알리지 않는다
    expect(same!.reason).toBe('품번 일치');
  });

  it('품번을 못 찾았지만 이름이 비슷하면 유사도를 알리며 후보로 둔다', async () => {
    const { api } = setup();
    const [m] = await api.matchBomSheet([{ line: 1, itemNo: 'P-0000000999', name: '배터리 팩', quantity: 1 }]);
    expect(m).toMatchObject({ status: 'suggested', itemNo: 'P-00000000161' });
    expect(m!.reason).toMatch(/^이름이 비슷합니다 \(유사도 0\.\d\d\): 품번을 확인하세요/);
    expect(m!.reason).toContain('시트 품번 P-0000000999은(는) 보유 목록에 없습니다');
  });

  it('공개 범위를 따른다: 남의 작업중 품목은 관리자 모드가 아니면 후보도 아니다', async () => {
    const { api, session } = setup();
    const [admin] = await api.matchBomSheet([{ line: 1, itemNo: 'P-00000000150', quantity: 1 }]);   // 이설계의 작업중 품목
    expect(admin!.status).toBe('matched');
    session.adminMode = false;
    const [hidden] = await api.matchBomSheet([{ line: 1, itemNo: 'P-00000000150', quantity: 1 }]);
    expect(hidden!.status).toBe('none');
  });

  it('시트 읽기 결과를 그대로 넣어 줄 번호가 이어진다', async () => {
    const { api } = setup();
    const sheet = parseBomSheet('품번,품명,수량\nP-00000000001,볼트 M3x8,12\nP-00000000121,J1 감속기,1\n,알 수 없는 부품,3');
    const result = await api.matchBomSheet(sheet.rows);
    expect(result.map(r => [r.line, r.status])).toEqual([[1, 'matched'], [2, 'matched'], [3, 'none']]);
  });
});
