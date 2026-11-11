// BOM 시트 가져오기: 줄마다 보유 품번과 맞춰 본다.
// 품번이 정확히 맞으면 확정(matched), 이름으로만 찾았거나 비슷하면 후보(suggested, 사람이 확인), 없으면 none(등록 요청 대상).
import type { BomSheetMatch, BomSheetRowInput, ItemSummary, PdmApi } from '../types';

export type BomSheetSource = Pick<PdmApi, 'listItems'>;

// mockApi.ts 의 normKey · similarity 와 같은 규칙이다 (mockApi 가 이 파일을 가져오므로 순환을 피하려고 여기에 둔다).
const normKey = (s: string) => s.toUpperCase().replace(/[\s_.\-]+/g, '');

function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = ` ${s.toLowerCase()} `;
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a), B = grams(b);
  let common = 0;
  A.forEach(g => { if (B.has(g)) common++; });
  return A.size + B.size ? (2 * common) / (A.size + B.size) : 0;
}

const SIMILAR = 0.6;
const namesOf = (it: ItemSummary) => [it.name, it.nameKo].filter((s): s is string => !!s);
const label = (it: ItemSummary) => it.nameKo ?? it.name;

function sameName(name: string, it: ItemSummary): boolean {
  return namesOf(it).some(n => normKey(n) === normKey(name) || similarity(name, n) >= SIMILAR);
}

export async function matchBomSheet(api: BomSheetSource, rows: BomSheetRowInput[]): Promise<BomSheetMatch[]> {
  const items = await api.listItems({});
  const byNo = new Map(items.map(it => [normKey(it.itemNo), it]));

  return rows.map((r): BomSheetMatch => {
    const itemNo = r.itemNo?.trim();
    const name = r.name?.trim();

    if (itemNo) {
      const hit = byNo.get(normKey(itemNo));
      if (hit) {
        const mismatch = name && !sameName(name, hit)
          ? ` (품번은 일치하지만 이름이 다릅니다: 시트 "${name}" / 품목 "${label(hit)}")` : '';
        return { line: r.line, status: 'matched', itemNo: hit.itemNo, itemName: label(hit), reason: `품번 일치${mismatch}` };
      }
    }

    const missed = itemNo ? ` (시트 품번 ${itemNo}은(는) 보유 목록에 없습니다)` : '';
    if (name) {
      const exact = items.find(it => namesOf(it).some(n => n === name)) ?? items.find(it => namesOf(it).some(n => normKey(n) === normKey(name)));
      if (exact) return { line: r.line, status: 'suggested', itemNo: exact.itemNo, itemName: label(exact), reason: `이름 일치: 품번을 확인하세요${missed}` };

      let best: { it: ItemSummary; score: number } | undefined;
      for (const it of items) {
        const score = Math.max(...namesOf(it).map(n => similarity(name, n)));
        if (score >= SIMILAR && (!best || score > best.score)) best = { it, score };
      }
      if (best) {
        return {
          line: r.line, status: 'suggested', itemNo: best.it.itemNo, itemName: label(best.it),
          reason: `이름이 비슷합니다 (유사도 ${best.score.toFixed(2)}): 품번을 확인하세요${missed}`,
        };
      }
    }
    return { line: r.line, status: 'none', reason: `보유 품번 없음 · 등록 요청 대상${missed}` };
  });
}
