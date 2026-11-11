// CAD 형상과 부품 이름에서 속성 후보를 뽑는다 (순수 함수).
// 원칙: 원문(형상 · 이름)에 없는 값은 만들지 않는다. 계산한 값은 근거(evidence)와 신뢰도를 붙이고, 추정이면 estimated.
import type { CadPartInput, ExtractedAttribute, PartAttributes } from './types';

/** 길이 단위 → mm 환산 계수 */
const UNIT_TO_MM: Record<string, number> = { mm: 1, '㎜': 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, inches: 25.4 };

const round = (v: number, digits = 3): number => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

/** 단위 정보가 없는 파일(STL · OBJ · GLB 는 단위를 담지 않는다)이 뷰어에서 돌려주는 값들 */
const UNSPECIFIED_UNITS = new Set(['', '단위', 'unit', 'units', 'unitless', 'none']);

/** 단위가 적혀 있지 않은가 (그 경우 CAD 의 기본 단위인 mm 로 가정한다) */
export const isUnitUnspecified = (unit: string | undefined): boolean => unit !== undefined && UNSPECIFIED_UNITS.has(unit.trim().toLowerCase());   // 값을 아예 안 넘기면 '기본 mm' 계약이라 가정이 아니다

/**
 * 단위 문자열 → mm 환산 계수. 단위가 적혀 있지 않으면 mm 로 가정한다(isUnitUnspecified 로 구분해 추정 표시를 한다).
 * 모르는 단위(예: furlong)면 undefined: 그 단위로는 값을 만들지 않는다.
 */
export function mmFactor(unit: string | undefined): number | undefined {
  if (unit === undefined || isUnitUnspecified(unit)) return 1;
  return UNIT_TO_MM[unit.trim().toLowerCase()];
}

const DIM_LABEL = { length: '길이', width: '너비', height: '높이' } as const;

function geometryAttributes(p: CadPartInput): ExtractedAttribute[] {
  const out: ExtractedAttribute[] = [];
  const f = mmFactor(p.unit);
  if (f === undefined) return out;                                                  // 모르는 단위: 만들지 않는다
  const assumed = isUnitUnspecified(p.unit);                                       // 단위가 없으면 mm 로 가정한 값이다: 추정으로 표시하고 신뢰도를 낮춘다
  const unitName = assumed ? 'mm' : (p.unit ?? 'mm').trim();
  const converted = f !== 1;
  const note = assumed ? ' · 파일에 단위 정보가 없어 mm 로 가정' : '';
  const mark = assumed ? { estimated: true as const } : {};

  if (p.size) {
    const raw = p.size.filter(v => Number.isFinite(v) && v > 0);
    if (raw.length === 3) {
      const sorted = [...raw].sort((a, b) => b - a);
      const keys = ['length', 'width', 'height'] as const;
      keys.forEach((key, i) => {
        const orig = sorted[i]!;
        const mm = round(orig * f);
        out.push({
          key, label: DIM_LABEL[key], value: mm, unit: 'mm', source: 'cad', confidence: assumed ? 0.55 : 0.9, ...mark,
          evidence: `CAD 형상 크기 ${p.size!.map(v => round(v)).join(' × ')} ${unitName}에서 큰 순으로 ${i + 1}번째` + (converted ? ` (원값 ${round(orig)} ${unitName} → ${mm} mm)` : '') + note,
        });
      });
      const thin = sorted[2]!;
      const thinMm = round(thin * f);
      out.push({
        key: 'thickness', label: '두께', value: thinMm, unit: 'mm', source: 'cad', confidence: assumed ? 0.5 : 0.85, ...mark,
        evidence: `가장 얇은 치수 = ${thinMm} mm` + (converted ? ` (원값 ${round(thin)} ${unitName})` : '') + note,
      });
    }
  }

  if (p.volume !== undefined && Number.isFinite(p.volume) && p.volume > 0) {
    const mm3 = round(p.volume * f ** 3, 1);
    out.push({
      key: 'volume', label: '체적', value: mm3, unit: 'mm³', source: 'cad',
      confidence: p.volumeEstimated ? 0.4 : assumed ? 0.5 : 0.8,
      evidence: (p.volumeEstimated ? 'CAD 메시가 열려 있어 상자 체적에서 추정한 값' : '닫힌 CAD 메시에서 계산한 체적') + note,
      ...(p.volumeEstimated || assumed ? { estimated: true } : {}),
    });
  }
  return out;
}

interface Span { start: number; end: number }
const overlaps = (a: Span, spans: Span[]) => spans.some(s => a.start < s.end && s.start < a.end);

interface NameRule {
  re: RegExp;
  build(m: RegExpExecArray, name: string): ExtractedAttribute[];
}

const quote = (name: string, hit: string) => `이름 "${name}"의 "${hit.trim()}"`;

/** 부품 이름의 규격 표기 규칙. 위에서부터 차례로 보고, 앞 규칙이 쓴 글자는 뒤 규칙이 다시 쓰지 않는다 */
const NAME_RULES: NameRule[] = [
  { // M3 · M3x8 · M3×12
    re: /(?<![A-Za-z0-9])M(\d{1,2}(?:\.\d+)?)(?:\s*[x×X*]\s*(\d+(?:\.\d+)?)(?:\s?mm)?)?(?![0-9A-Za-z])/g,
    build(m, name) {
      const size = Number(m[1]);
      if (!(size >= 1 && size <= 64)) return [];
      const out: ExtractedAttribute[] = [{ key: 'threadSize', label: '나사 규격', value: `M${m[1]}`, source: 'name', confidence: 0.9, evidence: quote(name, m[0]) }];
      if (m[2]) out.push({ key: 'length', label: '길이', value: Number(m[2]), unit: 'mm', source: 'name', confidence: 0.85, evidence: quote(name, m[0]) });
      return out;
    },
  },
  { // Φ10 · φ10 · Ø10
    re: /[ΦφØø⌀]\s*(\d+(?:\.\d+)?)/g,
    build: (m, name) => [{ key: 'diameter', label: '지름', value: Number(m[1]), unit: 'mm', source: 'name', confidence: 0.9, evidence: quote(name, m[0]) }],
  },
  { // 400W · 2.2kW
    re: /(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)\s?(kW|W)(?![A-Za-z0-9])/g,
    build: (m, name) => [{ key: 'ratedPower', label: '정격 출력', value: Number(m[1]), unit: m[2] === 'W' ? 'W' : 'kW', source: 'name', confidence: 0.85, evidence: quote(name, m[0]) }],
  },
  { // 48V
    re: /(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)\s?V(?![A-Za-z0-9])/g,
    build: (m, name) => [{ key: 'ratedVoltage', label: '정격 전압', value: Number(m[1]), unit: 'V', source: 'name', confidence: 0.8, evidence: quote(name, m[0]) }],
  },
  { // 5kg · 120g — 이름 속 질량은 가반하중 같은 다른 뜻일 수 있어 신뢰도를 낮춘다
    re: /(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)\s?(kg|g)(?![A-Za-z])/g,
    build(m, name) {
      const grams = m[2] === 'g';
      const kg = round(Number(m[1]) / (grams ? 1000 : 1), 4);
      return [{
        key: 'mass', label: '표기 질량', value: kg, unit: 'kg', source: 'name', confidence: 0.5,
        evidence: `${quote(name, m[0])} (부품 질량이 아니라 정격 · 가반하중일 수 있음)` + (grams ? ` [환산: ${m[1]} g → ${kg} kg]` : ''),
      }];
    },
  },
  { // 3mm
    re: /(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)\s?mm(?![A-Za-z])/g,
    build: (m, name) => [{ key: 'nominalSize', label: '표기 치수', value: Number(m[1]), unit: 'mm', source: 'name', confidence: 0.6, evidence: quote(name, m[0]) }],
  },
  { // D10 — 코드와 헷갈릴 수 있어 추정으로 표시한다
    re: /(?<![A-Za-z0-9])D(\d+(?:\.\d+)?)(?![A-Za-z0-9])/g,
    build: (m, name) => [{ key: 'diameter', label: '지름', value: Number(m[1]), unit: 'mm', source: 'name', confidence: 0.5, estimated: true, evidence: `${quote(name, m[0])} (D 표기를 지름으로 읽음)` }],
  },
];

/** 부품 이름에 적힌 규격 표기에서 속성 후보를 뽑는다. 이름에 없으면 만들지 않는다 */
export function extractNameAttributes(name: string): ExtractedAttribute[] {
  const taken: Span[] = [];
  const found: { at: number; attrs: ExtractedAttribute[] }[] = [];
  for (const rule of NAME_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(name))) {
      const span = { start: m.index, end: m.index + m[0].length };
      if (overlaps(span, taken)) continue;
      const attrs = rule.build(m, name);
      if (attrs.length === 0) continue;
      taken.push(span);
      found.push({ at: m.index, attrs });
    }
  }
  return found.sort((a, b) => a.at - b.at).flatMap(f => f.attrs);
}

/** CAD 부품 목록에서 형상 · 이름 기반 속성 후보를 뽑는다 */
export function extractCad(parts: CadPartInput[]): PartAttributes[] {
  return parts.map(p => ({ partName: p.name, attributes: [...geometryAttributes(p), ...extractNameAttributes(p.name)] }));
}
