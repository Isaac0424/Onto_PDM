import { describe, expect, it } from 'vitest';
import { createHttpApi } from './httpApi';
import { fakeBackend } from './testBackend';
import { ApiError, RulebookError, type RulebookSource } from './types';

// 규칙집(조립 규칙 · 작업표준서) 읽기: 백엔드(snake_case) 응답 → 화면 모양(camelCase). 값이 비어 있는 항목은 null 로 오고 지어내지 않는다.
const rb = (init: Parameters<typeof fakeBackend>[0] = {}): { api: RulebookSource; fake: ReturnType<typeof fakeBackend> } => {
  const fake = fakeBackend(init);
  return { api: createHttpApi({ fetchImpl: fake.fetch }).rulebook!, fake };
};

describe('규칙집 읽기(httpApi.rulebook)', () => {
  it('HTTP 구현에만 있고, 기본(empty) API 에는 없다', async () => {
    expect(createHttpApi({ fetchImpl: fakeBackend().fetch }).rulebook).toBeDefined();
    const { createEmptyApi } = await import('./emptyApi');
    expect(createEmptyApi().rulebook).toBeUndefined();
  });

  it('상태: 적재됨(개수 · 값 출처별 수)과 검증 오류(invalid)·읽을 수 없음(unavailable)·백엔드 꺼짐을 구분한다', async () => {
    const ok = await rb().api.status();
    expect(ok).toMatchObject({ state: 'ok', counts: { rules: 5, workStandards: 3, gaps: 4 }, byGrade: { manual: expect.any(Number) } });
    expect(ok.errors).toBeUndefined();

    const invalid = await rb({ rulebook: 'invalid' }).api.status();
    expect(invalid.state).toBe('invalid');
    expect(invalid.errors).toEqual([
      { level: 'error', where: 'rules.yaml AR-FAS-001', message: '출처 등급이 없습니다' },
      { level: 'error', where: 'work-standards.yaml WS-HCR-INS-02', message: '없는 규칙 AR-X-999 을 참조합니다' },
    ]);
    expect((await rb({ rulebook: 'unavailable' }).api.status()).state).toBe('unavailable');
    expect(await rb({ backend: 'down' }).api.status()).toMatchObject({ state: 'backend_down', message: expect.stringContaining('PDM 백엔드') });
  });

  it('규칙: snake_case → camelCase, null 은 빠지되 값(value)의 null 은 남는다(근거가 없어 비어 있다는 뜻), values · where 의 키는 바꾸지 않는다', async () => {
    const { api } = rb();
    const rules = await api.listRules();
    expect(rules.map(r => r.id)).toEqual(['AR-FAS-001', 'AR-FAS-004', 'AR-FAS-006', 'AR-SAF-001', 'AR-CON-002']);

    const base = rules[0]!;
    expect(base).toMatchObject({ operationLabel: '볼트 체결', reviewStatus: 'unreviewed', scope: 'part' });
    expect(base.appliesTo).toMatchObject({ classes: ['Bolt'], proposedClasses: [], role: 'robot_base_mount', models: ['HCR-3A', 'HCR-5A', 'HCR-12A'], confirmed: true });
    expect(base.appliesTo.refs[0]).toMatchObject({ label: '사용설명서(KR) 3.3절 p.49', pages: [49] });
    expect(base.lookup?.rows[0]).toMatchObject({ key: 'HCR-3A', values: { threadSize: 'M6', length_mm: 15, torque_nm: 30, pin_diameter_mm: 5 } });   // 표의 열 키는 그대로
    expect(base.parameters[0]).not.toHaveProperty('gapId');                                           // null 은 빠진다
    expect(base.parameters[0]).not.toHaveProperty('condition');

    const arm = rules[2]!;
    expect(arm.appliesTo).toMatchObject({ source: 'cad', estimated: true, confirmed: false, where: { threadSize: ['M3', 'M4'] } });
    const torque = arm.parameters.find(p => p.name === 'torque_nm')!;
    expect(torque).toMatchObject({ source: 'unknown', gapId: 'G-001', confirmed: false, value: null, unit: 'N·m' });   // 값은 비어 있다 — 지어내지 않는다
    expect(arm.gapIds).toEqual(['G-001', 'G-005', 'G-008', 'G-016']);
  });

  it('필터는 백엔드 이름(class_code · role · operation · model · q)으로 보낸다', async () => {
    const { api, fake } = rb();
    await api.listRules({ classCode: 'SocketHeadBolt', role: 'arm_assembly_bolt', operation: 'BoltFastening', model: 'HCR-12A', q: '소켓' });
    const url = fake.calls.at(-1)!.path;
    expect(url.startsWith('/rulebook/rules?')).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(Object.fromEntries(q)).toEqual({ class_code: 'SocketHeadBolt', role: 'arm_assembly_bolt', operation: 'BoltFastening', model: 'HCR-12A', q: '소켓' });
    await api.listRules({});
    expect(fake.calls.at(-1)!.path).toBe('/rulebook/rules');                                          // 필터가 없으면 쿼리도 없다
    await api.listWorkStandards({ model: 'HCR-5A', kind: 'procedure' });
    expect(fake.calls.at(-1)!.path).toBe('/rulebook/work-standards?model=HCR-5A&kind=procedure');
  });

  it('규칙 하나 · 공정 · 공구 · 공백 · 작업표준서(단계 · 점검 · 대상 CAD 부품 · 표준 시간)를 읽는다', async () => {
    const { api } = rb();
    expect((await api.getRule('AR-SAF-001')).cautions[0]).toMatchObject({ level: '경고', source: 'manual', confirmed: true });
    expect((await api.listOperations()).operations.map(o => o.code)).toEqual(['Installation', 'BoltFastening']);
    expect((await api.listTools()).map(t => t.nameKo)).toContain('토크 렌치(토크 관리 공구)');
    expect(await api.listGaps()).toHaveLength(4);

    const ws = await api.getWorkStandard('WS-HCR-INS-02');
    expect(ws).toMatchObject({ stepCount: 3, kind: 'procedure', gapIds: ['G-006'] });
    expect(ws.standardTime).toMatchObject({ value: null, gapId: 'G-006', confirmed: false });          // 표준 시간은 근거가 없어 비어 있다
    expect(ws.steps[2]).toMatchObject({ seq: 3, rules: ['AR-FAS-001'], targets: [{ role: 'robot_base_mount', quantity: 4 }] });
    const mnt = await api.getWorkStandard('WS-HCR-MNT-01');
    expect(mnt.inspectionItems[1]).toMatchObject({ cycle: { value: 3, unit: '개월' } });
    expect((await api.getWorkStandard('WS-HCR12A-ASM-01')).assemblies[0]!.parts[0]).toMatchObject({ cadName: 'BOLT-M4X15', quantity: 18, classCode: 'SocketHeadBolt', threadSize: 'M4', lengthMm: 15 });
  });

  it('없는 규칙 · 작업표준서는 ApiError(404)', async () => {
    const { api } = rb();
    await expect(api.getRule('AR-NOPE')).rejects.toMatchObject({ status: 404, message: expect.stringContaining('AR-NOPE') });
    await expect(api.getWorkStandard('WS-NOPE')).rejects.toBeInstanceOf(ApiError);
  });

  it('규칙집을 읽지 못하면 이유별 RulebookError: 백엔드 꺼짐 · rules/ 검증 오류(오류 목록) · 파일 없음', async () => {
    await expect(rb({ backend: 'down' }).api.listRules()).rejects.toMatchObject({ kind: 'backend_down' });
    const invalid = await rb({ rulebook: 'invalid' }).api.listRules().catch(e => e);
    expect(invalid).toBeInstanceOf(RulebookError);
    expect(invalid).toMatchObject({ kind: 'invalid', errors: [{ level: 'error', where: 'rules.yaml AR-FAS-001' }, { where: 'work-standards.yaml WS-HCR-INS-02' }] });
    await expect(rb({ rulebook: 'unavailable' }).api.listGaps()).rejects.toMatchObject({ kind: 'unavailable', message: expect.stringContaining('rules/') });
  });
});

describe('규칙 고르기(selectRules)', () => {
  const req = { classCode: 'SocketHeadBolt', classPath: ['Fastener', 'Bolt', 'SocketHeadBolt'], attributes: { threadSize: 'M4', length: 15 }, model: 'HCR-12A' };

  it('요청을 snake_case 로 보내고(비어 있는 선택값은 빼고), 결과(적용 yes · 확정하면 unknown · 값이 비어 있는 파라미터)를 읽는다', async () => {
    const { api, fake } = rb();
    const res = await api.selectRules(req);
    expect(fake.calls.at(-1)).toMatchObject({ method: 'POST', path: '/rulebook/select' });
    expect(fake.calls.at(-1)!.body).toEqual({ class_code: 'SocketHeadBolt', class_path: ['Fastener', 'Bolt', 'SocketHeadBolt'], attributes: { threadSize: 'M4', length: 15 }, model: 'HCR-12A' });

    expect(res.counts).toEqual({ yes: 1, unknown: 3, no: 0 });
    expect(res.rules.find(r => r.applicable === 'yes')!.rule.id).toBe('AR-SAF-001');
    const arm = res.rules.find(r => r.rule.id === 'AR-FAS-006')!;
    expect(arm.applicable).toBe('unknown');                                                            // 역할을 모른다: 단정하지 않는다
    expect(arm.unknownConditions).toEqual([expect.objectContaining({ kind: 'role', key: 'role', expected: 'arm_assembly_bolt', result: 'unknown' })]);
    expect(arm.matchedConditions.map(c => c.kind)).toEqual(expect.arrayContaining(['class', 'model', 'attribute']));
    expect(arm.unconfirmedParameters).toEqual(['torque_nm', 'sequence']);
  });

  it('역할을 알면 yes 가 되고, 모델을 알면 표(lookup)의 행이 하나로 정해진다', async () => {
    const { api } = rb();
    const res = await api.selectRules({ ...req, role: 'robot_base_mount' });
    const base = res.rules.find(r => r.rule.id === 'AR-FAS-001')!;
    expect(base.applicable).toBe('yes');
    expect(base.lookup).toMatchObject({ key: 'model', status: 'selected' });
    expect(base.lookup!.rows).toHaveLength(1);
    expect(base.lookup!.rows[0]).toMatchObject({ key: 'HCR-12A', values: { threadSize: 'M12', torque_nm: 140 } });
  });

  it('같은 요청은 한 번만 보낸다. 읽지 못한 결과는 기억하지 않고, 기억은 clearMatchCache 로 비운다', async () => {
    const { api, fake } = rb();
    const post = () => fake.calls.filter(c => c.method === 'POST').length;
    await Promise.all([api.selectRules(req), api.selectRules({ ...req, attributes: { length: 15, threadSize: 'M4' } })]);    // 속성 순서가 달라도 같은 요청
    expect(post()).toBe(1);
    await api.selectRules(req);
    expect(post()).toBe(1);
    await api.selectRules({ ...req, role: 'tool_mount' });
    expect(post()).toBe(2);

    fake.state.rulebook = 'unavailable';
    await expect(api.selectRules({ ...req, model: 'HCR-5A' })).rejects.toBeInstanceOf(RulebookError);
    fake.state.rulebook = 'ok';
    await expect(api.selectRules({ ...req, model: 'HCR-5A' })).resolves.toMatchObject({ model: 'HCR-5A' });                  // 실패는 기억하지 않아 다시 시도된다
    expect(post()).toBe(4);

    const http = createHttpApi({ fetchImpl: fake.fetch });
    const before = post();
    await http.rulebook!.selectRules(req);
    await http.rulebook!.selectRules(req);
    expect(post()).toBe(before + 1);
    http.clearMatchCache?.();                                                                           // CAD 를 바꾸거나 연결이 돌아오면 기억을 비운다
    await http.rulebook!.selectRules(req);
    expect(post()).toBe(before + 2);
  });
});
