// 사양서 본문(텍스트)에서 부품에 관련된 속성 후보를 뽑는다 (순수 함수).
// 부품 이름이 나오는 구절과 그 앞뒤 한 문장 안에서만 찾는다. 같은 문장에 다른 부품이 나오면 그 이웃은 건너뛴다.
// 뽑은 값은 후보일 뿐이다: 원문 구절(evidence)과 신뢰도를 붙이고, 사람이 확정해야 부품 속성이 된다.
import { mmFactor } from './cad';
import type { ExtractedAttribute, PartAttributes } from './types';

/** 본문을 문장 · 줄 단위로 나눈다. 소수점(0.6)은 문장 끝으로 보지 않는다 */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n+|(?<=[.!?。])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
const STOP = new Set(['the', 'of', 'and', 'for', 'with', '부품', '모델', '제품']);
const SPEC_TOKEN = /^(?:m\d+(?:[x×]\d+(?:\.\d+)?)?|\d+(?:\.\d+)?(?:mm|kg|g|w|kw|v|a|ma)?)$/i;

interface Needle { whole: string; tokens: string[] }

/** 부품 이름에서 문장에 나와야 할 열쇠를 만든다: 이름 전체 또는 의미 있는 토큰 전부 */
function needleOf(name: string): Needle {
  const tokens = name.split(/[\s·,()[\]/_\-]+/).map(t => t.trim().toLowerCase()).filter(t => t.length >= 2 && !STOP.has(t) && !SPEC_TOKEN.test(t));
  return { whole: norm(name), tokens };
}

const mentions = (sentence: string, n: Needle) => {
  const s = norm(sentence);
  return (n.whole.length > 0 && s.includes(n.whole)) || (n.tokens.length > 0 && n.tokens.every(t => s.includes(t)));
};

interface Hit {
  key: string;
  label: string;
  value: string | number;
  unit?: string;
  /** 문장 안의 위치 (evidence 를 값 주변으로 자를 때) */
  at: number;
  base: number;
  /** 환산했으면 그 설명 */
  note?: string;
}

const LABEL: Record<string, string> = {
  torque: '체결 토크', torqueTolerance: '토크 허용 오차', material: '재료', thickness: '두께', length: '길이', diameter: '지름',
  threadSize: '나사 규격', ratedVoltage: '정격 전압', ratedCurrent: '정격 전류', ratedPower: '정격 출력',
};

const sig3 = (v: number) => Number(v.toPrecision(3));

/** 토크 단위 → N·m 환산 계수 (구분 기호와 공백을 뺀 표기 기준) */
const TORQUE_TO_NM: Record<string, number> = { Nm: 1, Ncm: 0.01, kgfcm: 0.0980665, kgfm: 9.80665 };

/** 재료 표기 → 대표 이름. 같은 재료의 다른 표기(STS304 · AISI 304 · 1.4301)는 한 이름으로 모은다 */
const MATERIALS: { re: RegExp; canon(m: RegExpExecArray): string }[] = [
  { re: /(?<![A-Za-z0-9])(?:SUS|STS)\s?-?\s?(\d{3}L?)(?![A-Za-z0-9])/gi, canon: m => `SUS${m[1]!.toUpperCase()}` },
  { re: /(?<![A-Za-z0-9])AISI\s?-?\s?(\d{3}L?)(?![A-Za-z0-9])/gi, canon: m => `SUS${m[1]!.toUpperCase()}` },
  { re: /(?<![\d.])1\.4301(?!\d)/g, canon: () => 'SUS304' },
  { re: /(?<![\d.])1\.4401(?!\d)/g, canon: () => 'SUS316' },
  { re: /(?<![A-Za-z0-9])SS\s?-?\s?(400|41|490)(?![A-Za-z0-9])/gi, canon: m => `SS${m[1]}` },
  { re: /(?<![A-Za-z0-9])(?:A|AA|AL)\s?-?\s?(6061|5052|7075)(?:-?T\d)?(?![A-Za-z0-9])/gi, canon: m => `A${m[1]}` },
  { re: /(?<![A-Za-z0-9])SCM\s?-?\s?(\d{3})(?![A-Za-z0-9])/gi, canon: m => `SCM${m[1]}` },
  { re: /(?<![A-Za-z0-9])(S45C|SPCC|SPHC|SK5)(?![A-Za-z0-9])/gi, canon: m => m[1]!.toUpperCase() },
];

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const LEN_UNIT = String.raw`\s*(mm|㎜|cm)?`;

function hitsOf(sentence: string): Hit[] {
  const hits: Hit[] = [];
  const taken: { start: number; end: number }[] = [];
  const free = (start: number, end: number) => !taken.some(t => start < t.end && t.start < end);
  const take = (start: number, end: number) => taken.push({ start, end });

  // 토크: 0.6 N·m, 0.6Nm, 6 kgf·cm
  const torque = new RegExp(String.raw`(?<![A-Za-z0-9.])${NUM}\s*(N\s*[·.\-•⋅*]?\s*m|N\s*[·.\-•⋅*]?\s*cm|kgf\s*[·.\-•⋅*]?\s*cm|kgf\s*[·.\-•⋅*]?\s*m)(?![A-Za-z])`, 'g');
  let m: RegExpExecArray | null;
  let torqueSeen = false;
  while ((m = torque.exec(sentence))) {
    const unit = m[2]!.replace(/[\s·.\-•⋅*]/g, '');
    const factor = TORQUE_TO_NM[unit];
    if (factor === undefined) continue;
    const orig = Number(m[1]);
    const value = sig3(orig * factor);
    hits.push({
      key: 'torque', label: LABEL.torque!, value, unit: 'N·m', at: m.index, base: 0.85,
      ...(factor !== 1 ? { note: `환산: ${m[1]} ${m[2]!.replace(/\s+/g, '')} → ${value} N·m` } : {}),
    });
    take(m.index, m.index + m[0].length);
    torqueSeen = true;
  }
  if (torqueSeen) {
    const tol = /±\s*(\d+(?:\.\d+)?)\s*%/.exec(sentence);
    if (tol) hits.push({ key: 'torqueTolerance', label: LABEL.torqueTolerance!, value: Number(tol[1]), unit: '%', at: tol.index, base: 0.8 });
  }

  // 재료
  for (const rule of MATERIALS) {
    rule.re.lastIndex = 0;
    while ((m = rule.re.exec(sentence))) {
      if (!free(m.index, m.index + m[0].length)) continue;
      hits.push({ key: 'material', label: LABEL.material!, value: rule.canon(m), at: m.index, base: 0.85 });
      take(m.index, m.index + m[0].length);
    }
  }

  // 키워드 치수: 두께 3mm, 길이 12 mm, 지름 Φ8
  const keywords: { key: string; re: RegExp }[] = [
    { key: 'thickness', re: new RegExp(String.raw`(?:두께|thickness)\s*(?:는|은|이|가|:|=)?\s*${NUM}${LEN_UNIT}`, 'gi') },
    { key: 'length', re: new RegExp(String.raw`(?:길이|length)\s*(?:는|은|이|가|:|=)?\s*${NUM}${LEN_UNIT}`, 'gi') },
    { key: 'diameter', re: new RegExp(String.raw`(?:지름|직경|diameter|dia\.?)\s*(?:는|은|이|가|:|=)?\s*[ΦφØø⌀]?\s*${NUM}${LEN_UNIT}`, 'gi') },
  ];
  for (const k of keywords) {
    while ((m = k.re.exec(sentence))) {
      if (!free(m.index, m.index + m[0].length)) continue;
      const unit = m[2]?.toLowerCase();
      const factor = mmFactor(unit);
      if (factor === undefined) continue;
      const mm = Number((Number(m[1]) * factor).toPrecision(6));
      hits.push({
        key: k.key, label: LABEL[k.key]!, value: mm, unit: 'mm', at: m.index, base: unit ? 0.8 : 0.6,
        ...(unit === 'cm' ? { note: `환산: ${m[1]} cm → ${mm} mm` } : unit ? {} : { note: '단위가 없어 mm 로 읽음' }),
      });
      take(m.index, m.index + m[0].length);
    }
  }
  const phi = /[ΦφØø⌀]\s*(\d+(?:\.\d+)?)/g;
  while ((m = phi.exec(sentence))) {
    if (!free(m.index, m.index + m[0].length)) continue;
    hits.push({ key: 'diameter', label: LABEL.diameter!, value: Number(m[1]), unit: 'mm', at: m.index, base: 0.7 });
    take(m.index, m.index + m[0].length);
  }

  // 나사 규격: M3, M3x8
  const thread = /(?<![A-Za-z0-9])M(\d{1,2}(?:\.\d+)?)(?:\s*[x×X*]\s*(\d+(?:\.\d+)?)(?:\s?mm)?)?(?![0-9A-Za-z])/g;
  while ((m = thread.exec(sentence))) {
    const size = Number(m[1]);
    if (!(size >= 3 && size <= 24) || !free(m.index, m.index + m[0].length)) continue;
    hits.push({ key: 'threadSize', label: LABEL.threadSize!, value: `M${m[1]}`, at: m.index, base: 0.8 });
    if (m[2]) hits.push({ key: 'length', label: LABEL.length!, value: Number(m[2]), unit: 'mm', at: m.index, base: 0.7 });
    take(m.index, m.index + m[0].length);
  }

  // 정격: 12V, 50mA, 400W
  const ratings: { key: string; re: RegExp; unit(m: RegExpExecArray): string }[] = [
    { key: 'ratedVoltage', re: /(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)\s?(V|VDC|VAC)(?![A-Za-z0-9])/g, unit: () => 'V' },
    { key: 'ratedCurrent', re: /(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)\s?(mA|A)(?![A-Za-z0-9])/g, unit: x => x[2]! },
    { key: 'ratedPower', re: /(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)\s?(kW|W)(?![A-Za-z0-9])/g, unit: x => x[2]! },
  ];
  for (const r of ratings) {
    while ((m = r.re.exec(sentence))) {
      if (!free(m.index, m.index + m[0].length)) continue;
      hits.push({ key: r.key, label: LABEL[r.key]!, value: Number(m[1]), unit: r.unit(m), at: m.index, base: 0.75 });
      take(m.index, m.index + m[0].length);
    }
  }
  return hits;
}

const EVIDENCE_MAX = 120;

/** 원문 구절을 그대로 보이되, 길면 값 주변 120자만 남긴다 */
export function snippet(sentence: string, at: number): string {
  if (sentence.length <= EVIDENCE_MAX) return sentence;
  const start = Math.max(0, Math.min(at - 50, sentence.length - EVIDENCE_MAX));
  const end = Math.min(sentence.length, start + EVIDENCE_MAX);
  return `${start > 0 ? '…' : ''}${sentence.slice(start, end)}${end < sentence.length ? '…' : ''}`;
}

interface Cand extends Hit { sentence: number; dist: number; text: string }

export function extractSpec(text: string, partNames: string[]): PartAttributes[] {
  const sentences = splitSentences(text);
  const needles = partNames.map(needleOf);
  const mentioned = sentences.map(s => needles.map(n => mentions(s, n)));        // 문장 × 부품

  return partNames.map((partName, pi) => {
    const own = new Set<number>();
    mentioned.forEach((row, si) => { if (row[pi]) own.add(si); });

    const cands: Cand[] = [];
    const seen = new Set<string>();
    for (const si of own) {
      for (const dist of [0, -1, 1]) {
        const sj = si + dist;
        if (sj < 0 || sj >= sentences.length) continue;
        if (dist !== 0 && !own.has(sj) && mentioned[sj]!.some((hit, pj) => hit && pj !== pi)) continue;   // 이웃 문장이 다른 부품 이야기면 쓰지 않는다
        const d = own.has(sj) ? 0 : 1;
        const tag = `${sj}:${d}`;
        if (seen.has(tag)) continue;
        seen.add(tag);
        for (const h of hitsOf(sentences[sj]!)) cands.push({ ...h, sentence: sj, dist: d, text: sentences[sj]! });
      }
    }

    // 같은 속성 · 같은 값은 가장 가까운 구절 하나만
    const best = new Map<string, Cand>();
    for (const c of cands) {
      const id = `${c.key}\u0001${String(c.value)}`;
      const cur = best.get(id);
      if (!cur || c.dist < cur.dist || (c.dist === cur.dist && c.base > cur.base) || (c.dist === cur.dist && c.base === cur.base && c.sentence < cur.sentence)) best.set(id, c);
    }
    // 같은 속성에 값이 둘 이상이면 충돌: 모두 후보로 두고 신뢰도를 낮춘다
    const perKey = new Map<string, number>();
    best.forEach(c => perKey.set(c.key, (perKey.get(c.key) ?? 0) + 1));

    const attributes: ExtractedAttribute[] = [...best.values()]
      .sort((a, b) => a.sentence - b.sentence || a.at - b.at)
      .map(c => {
        const conflict = (perKey.get(c.key) ?? 1) > 1;
        let confidence = c.dist === 0 ? c.base : Math.max(0.1, c.base - 0.3);
        if (conflict) confidence *= 0.6;
        const evidence = snippet(c.text, c.at) + (c.note ? ` [${c.note}]` : '') + (conflict ? ' [같은 속성에 다른 값이 있어 확인이 필요함]' : '');
        return {
          key: c.key, label: c.label, value: c.value, ...(c.unit ? { unit: c.unit } : {}), source: 'spec' as const,
          evidence, confidence: Math.round(confidence * 100) / 100,
        };
      });
    return { partName, attributes };
  });
}
