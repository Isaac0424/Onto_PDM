// 형상 분석이 만든 규격(추정)으로 보유 품번을 찾을 수 있는가: 부품 하나의 분류 결과 → 매칭에 쓸 추정 값.
// 사람이 확정하기 전의 값이라 결과는 '후보 · 추정'으로만 쓴다(품번 확정은 사람이 한다). 조건은 fastener.config.ts 의 autoMatch 와 아래 규칙이다:
//   1위 후보 점수가 문턱 이상 · 1·2위가 가깝거나 구동부를 못 읽은 모델(ambiguous)이 아님 · 표준 호칭의 나사 규격이 있음.
import { FASTENER_CONFIG as C } from './fastener.config';
import type { HeadType } from './fastener.config';
import type { FastenerResult } from './fastener';
import { fastenerAttributes, nominalThreadSize } from './fastener.attributes';

export interface FastenerEstimate {
  /** 1위 후보의 클래스 코드(OPMS 에 아직 없는 제안이면 proposed) */
  classCode: string;
  headType: HeadType;
  proposed: boolean;
  /** 나사 규격 (예: 'M4'). 표준 호칭만 */
  threadSize: string;
  /** 길이 mm. 머리만 있는 모델은 없다 */
  length?: number;
  /** 1위 후보의 점수 */
  score: number;
  /** 파일에 단위 정보가 없어 mm 로 가정한 값이다(STL · OBJ · GLB) */
  unitAssumed: boolean;
}

/** 분류 결과가 충분히 확실하면 추정 규격을 돌려주고, 아니면 undefined (그 부품은 사람이 규격을 확정해야 찾는다) */
export function estimateFastener(r: FastenerResult | null | undefined): FastenerEstimate | undefined {
  if (!r || r.ambiguous) return undefined;
  const top = r.candidates[0];
  if (!top || top.score < C.autoMatch.minScore) return undefined;
  if (!r.unit.known) return undefined;
  const g = r.geometry;
  if ((g.nominalDiameter ?? nominalThreadSize(g.threadDiameter)) == null) return undefined;           // 표준 호칭과 맞지 않는 지름은 규격으로 말하지 않는다
  const attrs = fastenerAttributes(r);
  const thread = attrs.find(a => a.key === 'threadSize');
  if (!thread || !/^M\d+(\.\d+)?$/.test(String(thread.value))) return undefined;
  const length = attrs.find(a => a.key === 'length');
  return {
    classCode: top.classCode, headType: top.headType, proposed: top.proposed, threadSize: String(thread.value),
    ...(length && typeof length.value === 'number' ? { length: length.value } : {}),
    score: top.score, unitAssumed: !!r.unit.assumed,
  };
}
