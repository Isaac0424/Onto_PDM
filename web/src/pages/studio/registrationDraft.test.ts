import { describe, expect, it } from 'vitest';
import type { ExtractedAttribute } from '../../extract';
import type { FastenerCandidate } from '../../extract/fastener';
import { classRequestDraft, classRequestText } from './registrationDraft';

const cand = (over: Partial<FastenerCandidate> = {}): FastenerCandidate => ({
  classCode: 'ButtonHeadBolt', label: '버튼헤드볼트', headType: 'Button', score: 0.98, proposed: true,
  evidence: ['머리 윤곽 돔형, 단면 원형', '윗면에 육각 구멍(대변 2.5 mm)', '→ 버튼 머리(추정) · OPMS 미등록 제안 클래스'], ...over,
});
const attr = (key: string, value: string | number, over: Partial<ExtractedAttribute> = {}): ExtractedAttribute => ({
  key, label: key, value, source: 'cad', evidence: `${key} 근거`, confidence: 0.7, estimated: true, ...over,
});

describe('OPMS 분류 등록 요청 초안', () => {
  it('미등록(제안) 클래스면 클래스 이름 · 정의 · 부모 · 머리 모양과 근거 · 형상 속성 후보를 싣는다', () => {
    const d = classRequestDraft('PRT-B1', cand(), [attr('headType', 'Button'), attr('threadSize', 'M4'), attr('thickness', 3), attr('length', 8, { source: 'name' })], new Set(['threadSize']))!;
    expect(d).toMatchObject({ kind: 'new_class_proposal', source: 'onto-pdm:cad-shape', part: 'PRT-B1' });
    expect(d.proposedClass).toEqual({
      code: 'ButtonHeadBolt', label: '버튼헤드볼트', labelEn: 'Button head cap screw', parent: 'Bolt', headType: 'Button',
      definition: '낮은 돔형 머리에 육각 구멍이 있어 육각 렌치로 조이는 볼트',
    });
    expect(d.attributes.map(a => a.key)).toEqual(['headType', 'threadSize']);          // 형상 분류 키만 (두께 · 이름 출처는 뺀다)
    expect(d.attributes.find(a => a.key === 'threadSize')).toMatchObject({ confirmed: true, estimated: true, confidence: 0.7 });
    expect(d.attributes.find(a => a.key === 'headType')!.confirmed).toBe(false);
    expect(d.evidence).toEqual(cand().evidence);
    expect(d.notes.join(' ')).toContain('CR-NEXT-head-type-ontology');
  });

  it('OPMS 에 있는 클래스는 요청할 것이 없다', () => {
    expect(classRequestDraft('x', cand({ classCode: 'SocketHeadBolt', proposed: false }), [])).toBeUndefined();
  });

  it('요청 본문은 JSON 글이다', () => {
    const text = classRequestText(classRequestDraft('x', cand(), [])!);
    expect(JSON.parse(text).proposedClass.code).toBe('ButtonHeadBolt');
  });
});
