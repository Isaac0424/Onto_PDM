// 볼트 형상 분류 결과 → 속성 후보(ExtractedAttribute). 값은 사람이 확정하기 전의 후보이고 모두 추정이다.
// 키는 OPMS 속성 이름과 맞춘다: headType(요청서 요청 1) · driveType(요청 3, 후속) · threadSize · length · socketSize.
import { FASTENER_CONFIG as C } from './fastener.config';
import type { FastenerResult } from './fastener';
import type { ExtractedAttribute } from './types';

const round = (v: number, digits = 1) => { const k = 10 ** digits; return Math.round(v * k) / k; };

const DRIVE_LABEL = { HexSocket: '육각 구멍', Torx: '별 구멍(Torx 형)', Phillips: '십자 구멍', Slotted: '일자 홈', ExternalHex: '외육각(머리 바깥을 공구로 잡음)' } as const;

/**
 * 볼트 길이는 정수나 0.5 mm 단위로 규격화돼 있어, 잰 값이 그에 0.12 mm 안이면 맞춘다.
 * 모따기 · 머리 높이 때문에 실제 STEP 에서 15 mm 볼트가 14.95 로 잰다(1자리 반올림하면 14.9 가 되어 이름의 "15"와 충돌로 보인다).
 */
export function snapLength(len: number): number {
  const s = Math.round(len * 2) / 2;
  return Math.abs(len - s) <= 0.12 ? s : round(len, 1);
}

/** 잰 지름(mm)에 가장 가까운 표준 호칭 지름. 허용 오차를 넘으면 null */
export function nominalThreadSize(dMm: number): number | null {
  let best: number | null = null;
  for (const n of C.nominalSizes) {
    if (Math.abs(dMm - n) / n <= C.nominalTolerance && (best === null || Math.abs(dMm - n) < Math.abs(dMm - best))) best = n;
  }
  return best;
}

/**
 * 분류 결과에서 속성 후보를 만든다.
 *  - headType: 1위 후보의 머리 모양(없으면 만들지 않는다). 근거에 2위 이하 대안과 OPMS 미등록 여부를 적는다
 *  - driveType: 윗면 구멍의 모양(별 · 십자 · 일자는 판별이 약해 신뢰도를 낮춘다) 또는 외육각
 *  - threadSize: 몸통 지름을 표준 호칭으로 반올림한 M{d} (추정). 몸통을 나사산의 골지름으로 그린 모델은 머리 치수와 맞는 호칭으로, 머리만 있는 모델은 머리 치수로 짐작한다. 피치 · 전/반나사는 나사산이 모델에 없어 알 수 없다
 *  - length: 머리 아래 길이(접시머리는 머리를 포함한 전체 길이 — 규격의 길이 정의). 머리만 있는 모델은 만들지 않는다
 *  - socketSize: 육각 구멍의 대변
 * 파일에 단위가 없으면(STL · OBJ · GLB) mm 로 가정하고 모든 치수를 추정으로 표시한다.
 */
export function fastenerAttributes(r: FastenerResult): ExtractedAttribute[] {
  const out: ExtractedAttribute[] = [];
  const g = r.geometry;
  const top = r.candidates[0];
  const assumedNote = r.unit.assumed ? ' · 파일에 단위 정보가 없어 mm 로 가정' : '';
  const dimConf = (c: number) => (r.unit.assumed ? round(c * 0.8, 2) : c);

  if (top) {
    const alts = r.candidates.slice(1).map(c => `${c.label} ${c.score}${c.proposed ? '(제안)' : ''}`);
    out.push({
      key: 'headType', label: '머리 모양', value: top.headType, source: 'cad', confidence: r.confidence, estimated: true,
      evidence: [
        ...top.evidence,
        ...(r.ambiguous && !top.evidence.some(e => e.includes('확인하지 못함')) ? ['1·2위 점수가 가까워 단정하지 않음'] : []),
        ...(alts.length ? [`다른 후보: ${alts.join(', ')}`] : []),
      ].join(' · '),
    });
  }

  if (r.driveType) {
    const kind = g.recess.kind;
    const weak = kind === 'lobed' || kind === 'cross' || kind === 'slot';
    out.push({
      key: 'driveType', label: '구동부', value: r.driveType, source: 'cad', estimated: true,
      confidence: round(weak ? 0.45 : r.driveType === 'ExternalHex' ? 0.7 : 0.8, 2),
      evidence: `${DRIVE_LABEL[r.driveType]}${r.driveType === 'ExternalHex' ? ' — 머리 단면이 육각이고 윗면에 구멍이 없음' : ` — 머리 윗면의 오목부 단면 모양${g.recess.depth ? ` (깊이 ${g.recess.depth} mm)` : ''}`}`,
    });
  }

  if (r.unit.known) {
    const d = g.threadDiameter;
    const nom = g.nominalDiameter ?? nominalThreadSize(d);                         // 골지름으로 그린 몸통 · 머리만 있는 모델은 분류기가 정한 호칭
    const basis = g.diameterBasis;
    const conf = r.headOnly ? 0.5 : basis === 'minor' ? 0.7 : nom === null || nom === undefined ? 0.4 : 0.75;
    const how = r.headOnly
      ? `몸통이 모델에 없어 머리 치수(지름 ${g.headDiameter.toFixed(1)} mm, 높이 ${g.headHeight.toFixed(1)} mm)에서 M${nom}로 짐작`
      : nom === null || nom === undefined
        ? `CAD 몸통 지름 ${d.toFixed(1)} mm (표준 호칭과 맞지 않아 그대로 표기)`
        : basis === 'minor'
          ? `CAD 몸통 지름 ${d.toFixed(2)} mm = M${nom} 나사산의 골지름 → 호칭 M${nom} (머리 치수도 M${nom} 규격과 맞음)`
          : `CAD 몸통 지름 ${d.toFixed(1)} mm → 표준 호칭 M${nom}로 반올림`;
    out.push({
      key: 'threadSize', label: '나사 규격', value: `M${nom ?? round(d, 1)}`, source: 'cad', estimated: true,
      confidence: dimConf(conf),
      evidence: how + ' · 피치는 나사산이 모델에 없어 알 수 없음' + assumedNote,
    });
    if (!r.headOnly) {                                                              // 머리만 있는 모델은 길이를 알 수 없다
      const countersunk = top?.headType === 'Countersunk';
      const len = countersunk ? g.overallLength : g.underHeadLength;
      const value = snapLength(len);
      const measured = Math.abs(value - len) > 0.005 ? `${len.toFixed(2)} mm → 규격 길이 ${value} mm` : `${len.toFixed(1)} mm`;
      out.push({
        key: 'length', label: '길이', value, unit: 'mm', source: 'cad', estimated: true, confidence: dimConf(0.7),
        evidence: countersunk ? `머리 윗면에서 나사 끝까지 ${measured} (접시머리는 머리를 포함한 길이가 규격의 길이)` + assumedNote : `머리 아래에서 나사 끝까지 ${measured}` + assumedNote,
      });
    }
    if (g.recess.kind === 'hex' && g.recess.acrossFlats) {
      out.push({
        key: 'socketSize', label: '육각구멍 크기', value: round(g.recess.acrossFlats, 1), unit: 'mm', source: 'cad', estimated: true, confidence: dimConf(0.65),
        evidence: `머리 윗면 육각 구멍의 대변 ${g.recess.acrossFlats.toFixed(1)} mm (구멍 깊이의 ${Math.round(C.recess.measureDepthFraction * 100)}% 위치에서 측정)` + assumedNote,
      });
    }
  }
  return out;
}

