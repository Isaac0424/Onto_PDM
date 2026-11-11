import { describe, expect, it } from 'vitest';
import type { CadPartCandidate } from '../../api/types';
import { compareLine } from './OntologyPanel';

// 후보 한 줄의 주 표시: 퍼센트가 아니라 "확인한 K개 속성이 모두 일치 · 미확인 M개(…)". 미확인이 있으면 '100% 일치'라고 하지 않는다.
const cand = (matched: CadPartCandidate['matched'], over: Partial<CadPartCandidate> = {}): CadPartCandidate => ({ itemNo: 'P-1', itemName: '볼트', score: 1, matched, ...over });
const thread = { label: '나사 규격', hit: true as const, doc: 'M4', part: 'M4' };
const length = { label: '길이', hit: true as const, doc: '15 mm', part: '15 mm' };
const material = { label: '재질', hit: null, part: 'SUS304' };

describe('후보 비교 표시 (compareLine)', () => {
  it('확인한 속성이 모두 일치하고 미확인이 없으면 "확인한 K개 속성이 모두 일치"', () => {
    expect(compareLine(cand([thread, length])).text).toBe('확인한 2개 속성이 모두 일치');
  });

  it('길이가 누락이면 100% 라도 퍼센트로 말하지 않고 미확인으로 보인다 (완전 일치로 오인되지 않는다)', () => {
    const r = compareLine(cand([thread, { label: '길이', hit: null }, material]));
    expect(r.text).toBe('확인한 1개 속성이 모두 일치 · 미확인 2개(길이, 재질)');
    expect(r.text).not.toMatch(/100\s*%/);
    expect(r.title).toContain('가중 점수 100%');                    // 퍼센트는 툴팁에만
    expect(r.title).not.toMatch(/100% 일치/);
  });

  it('불일치가 있으면 "K개 중 H개 일치"', () => {
    const miss = { label: '길이', hit: false as const, doc: '8 mm', part: '15 mm' };
    expect(compareLine(cand([thread, miss, material], { score: 0.5 })).text).toBe('확인한 2개 중 1개 일치 · 미확인 1개(재질)');
  });

  it('다른 분류면 꼬리를 붙인다', () => {
    expect(compareLine(cand([thread], { classCapped: true })).text).toBe('확인한 1개 속성이 모두 일치 · 다른 분류');
  });

  it('비교한 속성 정보가 없는 응답(matched 없음)만 퍼센트로 말한다', () => {
    const r = compareLine({ itemNo: 'P-1', itemName: '볼트', score: 0.85 });
    expect(r.text).toBe('85% 일치');
  });

  it('양쪽에 값이 있는 속성이 하나도 없으면 "비교한 속성 없음"이고 미확인을 말한다 (100% 라고 하지 않는다)', () => {
    const r = compareLine(cand([{ label: '길이', hit: null }, material]));
    expect(r.text).toBe('비교한 속성 없음 · 미확인 2개(길이, 재질)');
    expect(r.text).not.toMatch(/100\s*%/);
  });
});
