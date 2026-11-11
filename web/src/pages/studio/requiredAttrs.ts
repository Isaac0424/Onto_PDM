// OPMS 필수 속성 체크리스트: CAD 에서 읽은 속성이 그 분류가 요구하는 필수 속성을 얼마나 채웠는지 센다 (순수 함수).
// OPMS 는 분류마다 필수 속성과 값 범위(constraints.yaml)를 두고 등록 때 검증한다. PDM 도 그 기준에 비춰 "무엇이 확인됐고 무엇이 비었는지"를 보여 준다.
// 판단은 OPMS 가 준 규칙(OpmsClassSpec)으로만 한다 — 이 파일은 속성 이름을 따로 알지 못한다(CAD 로 알 수 없는 속성 목록만 안내 문구에 쓴다).
import type { OpmsClassSpec, OpmsPropertyRule } from '../../api/types';
import type { ExtractedAttribute } from '../../extract';

/**
 * confirmed: 사람이 확정한 값 · estimated: CAD 에서 추정한 후보(아직 확정 전) ·
 * convention: OPMS 가 채우는 값(분류의 고정 값 · 원문에 없으면 관례로 채우는 값 · 값 표의 기본 열) — 비어 있다고 세지 않는다 · empty: 비어 있음(미확인)
 */
export type RequiredState = 'confirmed' | 'estimated' | 'convention' | 'empty';

export interface RequiredItem {
  key: string;
  label: string;
  state: RequiredState;
  /** 확정 · 추정 · 관례 값을 사람이 읽는 문장으로 (비어 있으면 없다) */
  valueText?: string;
  /** 상태 설명: 관례의 근거, 비어 있는 이유와 채울 곳 */
  note?: string;
  /** 추정이면 어디서 읽었는가 (CAD 형상 · 부품 이름의 규격 표기 …) · 신뢰도 · 근거 (속성 후보 목록에 같은 값이 있다) */
  source?: ExtractedAttribute['source'];
  confidence?: number;
  evidence?: string;
  /** OPMS 값 범위에 걸린다(빨강이 아니라 확인 필요) */
  warn?: string;
}

export interface RequiredView {
  classCode: string;
  classLabel: string;
  /** 형상 분류 클래스가 OPMS 에 없어 상위 클래스(예: 볼트) 기준으로 확인한다 */
  basis?: { proposedLabel: string };
  items: RequiredItem[];
  /** 필수 속성 수 */
  total: number;
  /** 확정 + OPMS 가 채우는 것 */
  known: number;
  /** 추정(확정 전 후보: CAD 형상 · 부품 이름 …) */
  estimated: number;
  /** 비어 있음(미확인) */
  empty: number;
  /** 값 범위 경고 수 */
  warnings: number;
}

/** CAD 형상으로는 알 수 없는 속성: 사양서 · BOM 에서 온다 (안내 문구용. 판단에는 쓰지 않는다) */
const NOT_FROM_CAD = new Set(['material', 'surfaceTreatment', 'strengthGrade']);

export const NOT_FROM_CAD_NOTE = 'CAD로 알 수 없어요 — 사양서·BOM에서 와요. 지금은 등록 요청 때 OPMS 검토 화면에서 채워요.';
export const NOT_READ_NOTE = 'CAD에서 읽지 못했어요. 등록 요청 때 OPMS 검토 화면에서 채워요.';

const SOURCE_NOTE: Record<ExtractedAttribute['source'], string> = { cad: 'CAD 형상', name: '부품 이름', spec: '사양서', bom: 'BOM' };

const textOf = (v: string | number, unit?: string) => `${v}${unit ? ` ${unit}` : ''}`;

/** 후보 중 쓸 값 하나: 신뢰도가 높은 것 먼저, 같으면 CAD 형상에서 읽은 것 먼저 */
function bestCandidate(list: readonly ExtractedAttribute[], key: string): ExtractedAttribute | undefined {
  const rank = (a: ExtractedAttribute) => (a.source === 'cad' ? 0 : 1);
  return list.filter(a => a.key === key).sort((a, b) => b.confidence - a.confidence || rank(a) - rank(b))[0];
}

function rangeWarning(rule: OpmsPropertyRule, value: string | number, estimated: boolean): string | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || rule.datatype === 'string' || rule.datatype === 'concept') return undefined;
  const unit = rule.unit ? ` ${rule.unit}` : '';
  const tail = estimated ? ' · 추정이라 다시 확인해요' : '';
  if (rule.min !== undefined && n < rule.min) return `OPMS 기준(≥${rule.min}${unit})보다 작아요${tail}`;
  if (rule.max !== undefined && n > rule.max) return `OPMS 기준(≤${rule.max}${unit})보다 커요${tail}`;
  return undefined;
}

export interface RequiredInput {
  spec: OpmsClassSpec;
  /** 사람이 확정한 속성 값 (속성 키 → 값). 확정한 볼트 종류가 정한 머리 모양도 들어 있다 */
  confirmed: Readonly<Record<string, string | number>>;
  /** 사람이 제외하지 않은 속성 후보(CAD 형상 추정) */
  candidates: readonly ExtractedAttribute[];
  /** 분류가 OPMS 에 없어 상위 클래스로 확인하는 경우, 원래 형상 분류의 이름 */
  proposedLabel?: string;
}

/** 필수 속성 하나의 상태를 정한다. 우선순위: 확정 → 분류의 고정 값 → CAD 추정 → OPMS 가 관례로 채움 → 비어 있음 */
function resolve(rule: OpmsPropertyRule, input: RequiredInput): RequiredItem {
  const { confirmed, candidates } = input;
  const base = { key: rule.key, label: rule.label };
  const unit = rule.unit;

  const fromHuman = confirmed[rule.key];
  if (fromHuman !== undefined) {
    const warn = rangeWarning(rule, fromHuman, false);
    return { ...base, state: 'confirmed', valueText: textOf(fromHuman, unit), ...(warn ? { warn } : {}) };
  }
  if (rule.fixed) return { ...base, state: 'convention', valueText: rule.fixed, note: '분류가 정해 둔 값이에요 (OPMS가 채워요)' };

  const cand = bestCandidate(candidates, rule.key);
  if (cand) {
    const warn = rangeWarning(rule, cand.value, true);
    return {
      ...base, state: 'estimated', valueText: textOf(cand.value, cand.unit ?? unit), source: cand.source, confidence: cand.confidence, evidence: cand.evidence,
      note: `${SOURCE_NOTE[cand.source]}에서 추정한 값이에요. 속성 탭에서 확정하면 확인으로 세요.`, ...(warn ? { warn } : {}),
    };
  }

  if (rule.omittedDefault) {
    return { ...base, state: 'convention', valueText: rule.omittedDefault.label, note: '원문에 없으면 OPMS가 관례로 채워요 (표기하지 않으면 이 값)' };
  }

  const lookup = rule.lookupDefault;
  if (lookup) {
    const keyConfirmed = confirmed[lookup.key];
    const keyCand = keyConfirmed === undefined ? bestCandidate(candidates, lookup.key) : undefined;
    const keyValue = keyConfirmed ?? keyCand?.value;
    const series = lookup.seriesLabel ?? '기본';
    const values = keyValue !== undefined ? lookup.values[String(keyValue)] : undefined;
    if (values && values.length > 0) {
      const assumed = keyConfirmed === undefined ? ' · 나사 규격이 추정이라 다시 확인해요' : '';
      return {
        ...base, state: 'convention', valueText: textOf(values.join(' / '), unit),
        note: `${series} 값이에요 — 원문에 없으면 OPMS가 나사 규격 ${keyValue} 기준으로 채워요${assumed}`,
      };
    }
    return { ...base, state: 'empty', note: keyValue !== undefined ? `나사 규격 ${keyValue}의 ${series} 값을 OPMS 표에서 찾지 못했어요. 등록 요청 때 채워요.` : `나사 규격이 정해지면 ${series} 값으로 OPMS가 채워요.` };
  }

  return { ...base, state: 'empty', note: NOT_FROM_CAD.has(rule.key) ? NOT_FROM_CAD_NOTE : NOT_READ_NOTE };
}

const STATE_RANK: Record<RequiredState, number> = { confirmed: 0, estimated: 1, convention: 2, empty: 3 };

/** 분류의 필수 속성마다 상태를 정하고 요약을 센다. 목록은 확정 → CAD 추정 → OPMS가 채움 → 미확인 순이라 비어 있는 것이 아래에 모인다(같은 상태 안에서는 OPMS 순서) */
export function checkRequired(input: RequiredInput): RequiredView {
  const items = input.spec.properties.filter(p => p.required).map(p => resolve(p, input)).sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
  const count = (s: RequiredState) => items.filter(i => i.state === s).length;
  return {
    classCode: input.spec.code, classLabel: input.spec.label,
    ...(input.proposedLabel ? { basis: { proposedLabel: input.proposedLabel } } : {}),
    items, total: items.length,
    known: count('confirmed') + count('convention'), estimated: count('estimated'), empty: count('empty'),
    warnings: items.filter(i => i.warn).length,
  };
}

/** 미확인 속성의 이름 목록 — 후보 줄의 "미확인 M개(길이, 재질)"와 같은 말투로 쓴다 */
export const emptyLabels = (v: RequiredView): string[] => v.items.filter(i => i.state === 'empty').map(i => i.label);

export function summaryText(v: RequiredView): string {
  const parts = [`확인 ${v.known}/${v.total}`];
  if (v.estimated > 0) parts.push(`추정 ${v.estimated}개`);
  if (v.empty > 0) parts.push(`미확인 ${v.empty}개(${emptyLabels(v).join(', ')})`);
  return parts.join(' · ');
}
