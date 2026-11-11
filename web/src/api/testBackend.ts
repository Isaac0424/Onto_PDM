// 시험 전용: PDM 백엔드(/api/v1/pdm)를 흉내 내는 가짜 fetch. 제품(앱)에는 가짜 데이터가 없다 — 시험 안에서만 쓴다.
// 백엔드 응답 모양(snake_case)은 backend/src/onto_pdm/opms/models.py 와 같다. backend 가 꺼진 것 · OPMS 가 꺼진 것을 흉내 낼 수 있다.

export type FakeOpmsDown = 'OPMS_UNAVAILABLE' | 'OPMS_NOT_CONFIGURED' | 'OPMS_AUTH_FAILED' | 'OPMS_NO_ONTOLOGY';

export interface FakeBackend {
  fetch: typeof fetch;
  /** 받은 요청 기록 */
  calls: { method: string; path: string; body?: unknown }[];
  /** backend: 'down' 이면 연결이 거부된다 · opms: 코드가 있으면 OPMS 읽기가 503 이다 */
  state: { backend: 'up' | 'down'; opms: FakeOpmsDown | null; /** 규칙집(rules/): ok · invalid(검증 오류) · unavailable(파일 없음) */ rulebook: 'ok' | 'invalid' | 'unavailable' };
}

const BOLT_PATH = ['기계 부품', '체결 부품', '볼트'];
const CLASSES = [
  { code: 'Bolt', label_ko: '볼트', label_en: 'Bolt', parent: 'Fastener', leaf: false, path: ['MechanicalPart', 'Fastener', 'Bolt'], path_labels: BOLT_PATH, family_root: 'Bolt', head_type: null },
  { code: 'HexBolt', label_ko: '육각볼트', label_en: 'Hex bolt', parent: 'Bolt', leaf: true, path: ['MechanicalPart', 'Fastener', 'Bolt', 'HexBolt'], path_labels: [...BOLT_PATH, '육각볼트'], family_root: 'Bolt', head_type: 'Hex' },
  { code: 'SocketHeadBolt', label_ko: '육각구멍붙이볼트', label_en: 'Socket head cap screw', parent: 'Bolt', leaf: true, path: ['MechanicalPart', 'Fastener', 'Bolt', 'SocketHeadBolt'], path_labels: [...BOLT_PATH, '육각구멍붙이볼트'], family_root: 'Bolt', head_type: 'Socket' },
];
const SOCKET = CLASSES[2]!;
export interface FakePart {
  part_no: string; class_code: string; class_label: string; class_path_labels: string[]; label: string;
  values: Record<string, string | number>; value_labels: Record<string, string>;
}
/** 육각구멍붙이볼트 한 개 (나사 규격 기본 M4) */
export const socketPart = (no: number, length: number, material: string, threadSize = 'M4'): FakePart => ({
  part_no: `P-${String(no).padStart(11, '0')}`, class_code: 'SocketHeadBolt', class_label: '육각구멍붙이볼트', class_path_labels: SOCKET.path_labels,
  label: `육각구멍붙이볼트 ${threadSize} · ${length} mm · ${material}`,
  values: { threadSize, length, material, surfaceTreatment: 'ZincPlated', pitch: 0.7, socketSize: 3 },
  value_labels: { material, surfaceTreatment: '아연도금' },
});
export const PARTS: FakePart[] = [socketPart(47, 10, 'SCM435'), socketPart(48, 15, 'SUS304'), socketPart(50, 15, 'SCM435')];
/** 분류의 유효 속성 — 실제 OPMS 0.15.0 의 Bolt · SocketHeadBolt 필수 속성과 같은 모양(필수 · 값 범위 · 관례로 채워지는 값) */
const prop = (key: string, label_ko: string, datatype: string, unit: string | null, extra: Record<string, unknown> = {}) =>
  ({ key, label_ko, datatype, unit, required: true, min: null, max: null, fixed: null, omitted_default: null, omitted_default_label: null, lookup_default: null, ...extra });
const BOLT_PROPS = [
  prop('threadSize', '나사 규격', 'string', null),
  prop('length', '길이', 'decimal', 'mm', { min: 3 }),
  prop('material', '재질', 'concept', null),
  prop('surfaceTreatment', '표면처리', 'concept', null),
  prop('pitch', '피치', 'decimal', 'mm', {
    lookup_default: { key: 'threadSize', series: 'Coarse', series_label: '보통 나사', values: { M3: [0.5], M4: [0.7], M5: [0.8], M6: [1.0], M8: [1.25] } },
  }),
  prop('threadDirection', '나사 방향', 'concept', null, { omitted_default: 'RightHand', omitted_default_label: '오른나사' }),
];
const SPEC_PROPS: Record<string, ReturnType<typeof prop>[]> = {
  Bolt: BOLT_PROPS,
  HexBolt: [...BOLT_PROPS, prop('strengthGrade', '강도 등급', 'string', null), prop('widthAcrossFlats', '이면폭', 'decimal', 'mm', { required: false })],
  SocketHeadBolt: [...BOLT_PROPS, prop('strengthGrade', '강도 등급', 'string', null), prop('socketSize', '육각구멍 크기', 'decimal', 'mm', { min: 1.5 })],
};

const MESSAGE: Record<FakeOpmsDown, string> = {
  OPMS_UNAVAILABLE: 'OPMS 의 Neo4j 에 연결하지 못했습니다 (ServiceUnavailable). OPMS 가 켜져 있는지 확인하세요.',
  OPMS_NOT_CONFIGURED: 'OPMS 읽기 설정이 없습니다. 백엔드를 켤 때 PDM_NEO4J_URI · PDM_NEO4J_USER · PDM_NEO4J_PASSWORD 를 지정하세요.',
  OPMS_AUTH_FAILED: 'OPMS 의 Neo4j 가 계정을 받아들이지 않았습니다.',
  OPMS_NO_ONTOLOGY: 'OPMS 에 적용된 온톨로지 버전이 없습니다.',
};
const STATE: Record<FakeOpmsDown, string> = {
  OPMS_UNAVAILABLE: 'opms_down', OPMS_NOT_CONFIGURED: 'not_configured', OPMS_AUTH_FAILED: 'auth_failed', OPMS_NO_ONTOLOGY: 'no_ontology',
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message, details: null } });

/** CAD 에서 확정한 값 → 후보: 소켓 M4×15 는 둘(재질만 다름), M4×10 은 하나, 그 밖은 없음. 머리 모양이 Socket 이 아니면 후보가 없다 */
function match(parts: FakePart[], body: { class_code?: string; head_type?: string; values: Record<string, string | number> }) {
  const head = body.head_type ?? (body.class_code === 'SocketHeadBolt' ? 'Socket' : undefined);
  const rows = head && head !== 'Socket' ? [] : parts.filter(p => p.values.threadSize === body.values.threadSize && (body.values.length === undefined || Math.abs(Number(p.values.length) - Number(body.values.length)) <= 0.2));
  const candidates = rows.map(p => ({
    part_no: p.part_no, class_code: p.class_code, class_label: p.class_label, class_path_labels: p.class_path_labels, label: p.label,
    verdict: 'suspected', score: 1, capped: true, class_capped: false,
    matched: [
      { prop_key: 'threadSize', label: '나사 규격', hit: true, doc_display: String(body.values.threadSize), part_display: String(p.values.threadSize) },
      { prop_key: 'length', label: '길이', hit: body.values.length === undefined ? null : true, doc_display: `${body.values.length} mm`, part_display: `${p.values.length} mm` },
      { prop_key: 'material', label: '재질', hit: null, doc_display: null, part_display: p.value_labels.material },
    ],
  }));
  return {
    verdict: candidates.length ? 'suspected' : 'none', reason: candidates.length ? 'ok' : 'no_candidate', candidates, ontology_version: '0.15.0', temporary: true, note: '임시 판정',
  };
}

// ---- 규칙집(rules/) 가짜 응답: 실제 rules/ 에서 대표 몇 개만 옮겼다(snake_case 선 형식, backend/src/onto_pdm/rulebook/models.py 와 같은 모양) ----
type Grade = 'manual' | 'standard' | 'cad' | 'unknown';
const ref = (label: string, pages: number[] = []) => ({ doc: 'UG-KR', doc_title: 'HCR-2G 사용설명서 한국어 V2.2', doc_kind: 'manual', sec: null, pages, node: null, standard: null, note: null, label });
const sourced = (source: Grade, refs: ReturnType<typeof ref>[] = [], extra: { gap_id?: string; estimated?: boolean; confirmed?: boolean } = {}) => ({
  source, refs, gap_id: extra.gap_id ?? null, estimated: extra.estimated ?? false, approval_required: false,
  confirmed: extra.confirmed ?? (source === 'manual' && !extra.estimated),
});
const manual = (label = '사용설명서(KR) 3.3절 p.49', pages = [49]) => sourced('manual', [ref(label, pages)]);
const unknownOf = (gap: string) => sourced('unknown', [], { gap_id: gap, confirmed: false });
const param = (name: string, value: unknown, unit: string | null, src: ReturnType<typeof sourced>) => ({ ...src, name, value, unit, condition: null, note: null });
const caution = (level: string, text: string, src: ReturnType<typeof sourced>) => ({ ...src, level, text, level_note: null });

const RB_RULES = [
  {
    id: 'AR-FAS-001', name: '로봇 암 베이스 고정 볼트 체결', operation: 'BoltFastening', operation_label: '볼트 체결', scope: 'part', review_status: 'unreviewed',
    applies_to: { ...manual(), classes: ['Bolt'], proposed_classes: [], role: 'robot_base_mount', role_label: '로봇 암 베이스를 설치면에 고정하는 볼트 4개 (사용설명서 3.3)', models: ['HCR-3A', 'HCR-5A', 'HCR-12A'], where: {} },
    parameters: [param('quantity', 4, '개', manual()), param('torque_policy', '모델별 표의 토크로 조인다', null, manual())],
    lookup: {
      key: 'model',
      rows: [
        { ...manual(), key: 'HCR-3A', values: { threadSize: 'M6', length_mm: 15, torque_nm: 30, pin_diameter_mm: 5 }, note: null },
        { ...manual(), key: 'HCR-5A', values: { threadSize: 'M8', length_mm: 15, torque_nm: 45, pin_diameter_mm: 8 }, note: null },
        { ...manual(), key: 'HCR-12A', values: { threadSize: 'M12', length_mm: 25, torque_nm: 140, pin_diameter_mm: 5 }, note: null },
      ],
    },
    tools: ['TL-TORQUE'],
    cautions: [caution('경고', '로봇을 고정할 때에는 볼트가 풀리지 않도록 단단히 고정하세요.', manual())],
    note: null, cad_inference: null, by_grade: { manual: 11, standard: 0, cad: 0, unknown: 0 }, gap_ids: [],
  },
  {
    id: 'AR-FAS-004', name: '툴 고정 볼트(M6) 체결', operation: 'BoltFastening', operation_label: '볼트 체결', scope: 'part', review_status: 'unreviewed',
    applies_to: { ...manual('사용설명서(KR) 3.4절 p.50', [50]), classes: ['Bolt'], proposed_classes: [], role: 'tool_mount', role_label: '툴을 툴 플랜지에 고정하는 M6 볼트 4개 (3.4)', models: ['HCR-3A', 'HCR-5A', 'HCR-12A'], where: {} },
    parameters: [
      param('threadSize', 'M6', null, manual('사용설명서(KR) 3.4절 p.50', [50])), param('quantity', 4, '개', manual('사용설명서(KR) 3.4절 p.50', [50])),
      param('length_mm', null, 'mm', unknownOf('G-002')), param('torque_nm', null, 'N·m', unknownOf('G-002')),
    ],
    lookup: null, tools: ['TL-TORQUE'],
    cautions: [caution('참고', '툴과 고정용 M6 볼트는 제품에 포함되지 않습니다.', manual('사용설명서(KR) 3.4절 p.50', [50]))],
    note: null, cad_inference: null, by_grade: { manual: 7, standard: 0, cad: 0, unknown: 2 }, gap_ids: ['G-002'],
  },
  {
    id: 'AR-FAS-006', name: '로봇 암 본체 소켓 헤드 볼트(M3 · M4) 체결', operation: 'BoltFastening', operation_label: '볼트 체결', scope: 'part', review_status: 'unreviewed',
    applies_to: {
      ...sourced('cad', [ref('FASTENER-CLS')], { estimated: true, confirmed: false }), classes: ['SocketHeadBolt'], proposed_classes: [], role: 'arm_assembly_bolt',
      role_label: '로봇 암 본체 조립에 쓰인 M3 · M4 소켓 헤드 볼트 (CAD 구조에서 도출. 사용설명서에는 없다)', models: ['HCR-3A', 'HCR-5A', 'HCR-12A'], where: { threadSize: ['M3', 'M4'] },
    },
    parameters: [param('torque_nm', null, 'N·m', unknownOf('G-001')), param('sequence', null, null, unknownOf('G-005'))],
    lookup: null, tools: ['TL-HEXKEY', 'TL-TORQUE'], cautions: [],
    note: '사용설명서는 로봇 암 본체 조립(커버 볼트)을 설명하지 않는다. 대상과 수량은 CAD 에서, 값은 비어 있다.', cad_inference: null,
    by_grade: { manual: 0, standard: 0, cad: 1, unknown: 2 }, gap_ids: ['G-001', 'G-005', 'G-008', 'G-016'],
  },
  {
    id: 'AR-SAF-001', name: '로봇에 조립되어 있는 볼트는 분해하지 않는다', operation: 'BoltFastening', operation_label: '볼트 체결', scope: 'part', review_status: 'unreviewed',
    applies_to: { ...manual('사용설명서(KR) 3.3절 p.50', [50]), classes: ['Bolt'], proposed_classes: [], role: null, role_label: null, models: ['HCR-3A', 'HCR-5A', 'HCR-12A'], where: {} },
    parameters: [], lookup: null, tools: [],
    cautions: [caution('경고', '로봇에 조립되어 있는 볼트는 절대 임의로 분해하지 마세요. 볼트가 분해된 상태에서 사용하면 제품이 파손되거나 안전에 심각한 영향을 미칠 수 있습니다.', manual('사용설명서(KR) 3.3절 p.50', [50]))],
    note: null, cad_inference: null, by_grade: { manual: 2, standard: 0, cad: 0, unknown: 0 }, gap_ids: [],
  },
  {
    id: 'AR-CON-002', name: '컨트롤러 전원 연결', operation: 'ConnectorMating', operation_label: '커넥터 체결', scope: 'product', review_status: 'unreviewed',
    applies_to: { ...manual('사용설명서(KR) 3.5절 p.54', [54]), classes: [], proposed_classes: [], role: null, role_label: null, models: ['HCR-3A', 'HCR-5A', 'HCR-12A'], where: {} },
    parameters: [param('input_voltage_vac', '100~240', 'VAC', manual('사용설명서(KR) 3.5절 p.54', [54])), param('external_fuse_a', '8~16', 'A', manual('사용설명서(KR) 3.5절 p.54', [54]))],
    lookup: null, tools: [],
    cautions: [caution('주의', '컨트롤러 전원이 켜진 상태에서 커넥터를 뽑지 마세요.', manual('사용설명서(KR) 3.5절 p.54', [54]))],
    note: null, cad_inference: null, by_grade: { manual: 8, standard: 0, cad: 0, unknown: 0 }, gap_ids: [],
  },
] as const;

const RB_TOOLS = [
  { id: 'TL-TORQUE', name_ko: '토크 렌치(토크 관리 공구)', need: { ...manual(), text: '정해진 토크로 볼트를 조이는 공구' }, spec: [param('torque_range', null, 'N·m', unknownOf('G-007'))], note: null, gap_ids: ['G-007'] },
  { id: 'TL-HEXKEY', name_ko: '육각 렌치(육각 구멍 볼트용)', need: { ...sourced('cad', [ref('FASTENER-CLS')], { estimated: true }), text: '육각 구멍 볼트를 조이는 공구' }, spec: [], note: null, gap_ids: ['G-007'] },
];
const RB_GAPS = [
  { id: 'G-001', title: '소켓 헤드 볼트(M3 · M4) 체결 토크', needs: '로봇 암 본체에 쓰이는 M3 · M4 소켓 헤드 볼트의 체결 토크와 조임 방식', why: '사용설명서는 설치 · 운영 설명서라 본체 조립 토크를 말하지 않는다.', who: '제조사 설계 · 사내 체결 기준표', blocks: ['AR-FAS-006'] },
  { id: 'G-002', title: '툴 고정 M6 볼트의 길이 · 토크', needs: '툴 고정 볼트 길이와 체결 토크', why: '사용설명서가 툴마다 다르다고만 한다.', who: '툴 제조사', blocks: ['AR-FAS-004'] },
  { id: 'G-005', title: '로봇 암 본체 조립 절차', needs: '조립 순서 · 체결 패턴', why: '근거 문서가 없다.', who: '사내 공정 담당', blocks: ['AR-FAS-006', 'WS-HCR12A-ASM-01'] },
  { id: 'G-006', title: '표준 시간', needs: '작업별 표준 시간', why: '근거가 없다.', who: '사내 공정 담당', blocks: ['WS-HCR-INS-02'] },
];
const RB_OPERATIONS = [
  { ...manual(), code: 'Installation', label_ko: '설치', label_en: 'Installation', definition: '로봇을 설치한다', parent: null, opms_code: null, path: ['Installation'] },
  { ...manual(), code: 'BoltFastening', label_ko: '볼트 체결', label_en: 'Bolt fastening', definition: '볼트로 체결한다', parent: 'Installation', opms_code: null, path: ['Installation', 'BoltFastening'] },
];

const stepOf = (seq: number, operation_label: string, text: string, rules: string[], extra: Record<string, unknown> = {}) => ({
  ...manual('사용설명서(KR) 3.3절 p.49', [49]), seq, operation: 'BoltFastening', operation_label, rules, text, condition: null, targets: [], order_binding: null, ...extra,
});
const RB_WS_INS = {
  id: 'WS-HCR-INS-02', title: '로봇 암 베이스 고정', models: ['HCR-3A', 'HCR-5A', 'HCR-12A'], kind: 'procedure', purpose: '로봇 암을 볼트 4개로 설치면에 정해진 토크로 고정한다',
  review_status: 'unreviewed', revision: 'R00 (초안, 사람 검토 전)', rules: ['AR-FAS-001', 'AR-SAF-001'], tools: ['TL-TORQUE'], step_count: 3, inspection_count: 0, assembly_count: 0, gap_ids: ['G-006'],
  standard_time: param('standard_time', null, null, unknownOf('G-006')),
  steps: [
    stepOf(1, '로봇 암 고정', '고정 베이스를 이용해 설치한다.', [], { condition: '설치면의 평면도 · 강성이 로봇 암을 지지하기에 부족한 경우' }),
    stepOf(2, '위치 결정 핀 정렬', '위치 결정 핀 2개로 설치 위치를 정한다. 핀 지름은 HCR-3A Φ5 · HCR-5A Φ8 · HCR-12A Φ5 mm.', ['AR-LOC-001']),
    stepOf(3, '볼트 체결', '로봇 암을 볼트 4개로 천장 · 벽면 · 바닥에 고정한다. 볼트와 토크: HCR-3A M6×15 mm 30 N·m, HCR-5A M8×15 mm 45 N·m, HCR-12A M12×25 mm 140 N·m.', ['AR-FAS-001'],
      { targets: [{ role: 'robot_base_mount', role_label: '로봇 암 베이스 고정 볼트', quantity: 4, source: 'manual' }] }),
  ],
  checks: [{ ...manual(), text: '로봇 암의 설치면이 베이스면과 완전히 밀착되었는지 확인한다', criterion: '완전 밀착' }, { ...manual(), text: '로봇 암을 작동하기 전에 모든 볼트가 잘 고정되어 있는지 확인한다', criterion: '모든 볼트 고정' }],
  precautions: ['AR-SAF-001'], inspection_items: [], event_checks: [], assemblies: [], source_files: [], procedure_gap: null, by_grade: { manual: 5, standard: 0, cad: 0, unknown: 1 },
};
const RB_WS_MNT = {
  id: 'WS-HCR-MNT-01', title: '정기 점검 항목과 주기', models: ['HCR-3A', 'HCR-5A', 'HCR-12A'], kind: 'procedure', purpose: '정해진 주기로 로봇의 이상 여부를 점검한다',
  review_status: 'unreviewed', revision: 'R00 (초안, 사람 검토 전)', rules: ['AR-MNT-001'], tools: [], step_count: 0, inspection_count: 2, assembly_count: 0, gap_ids: ['G-006'],
  standard_time: param('standard_time', null, null, unknownOf('G-006')), steps: [], checks: [], precautions: [],
  inspection_items: [
    { ...manual('사용설명서(KR) 8장 p.229', [229]), seq: 1, group: '로봇 암', target: '전체', check: '로봇에 적용한 프로그램에 따라 의도한 위치로 이동하는지 확인합니다.', cycle: { value: 1, unit: '일', label: '매일' }, cycle_note: null },
    { ...manual('사용설명서(KR) 8장 p.229', [229]), seq: 2, group: '로봇 암', target: '전체', check: '얼룩, 먼지 등 오염물질 제거합니다.', cycle: { value: 3, unit: '개월', label: null }, cycle_note: null },
  ],
  event_checks: [], assemblies: [], source_files: [], procedure_gap: null, by_grade: { manual: 4, standard: 0, cad: 0, unknown: 1 },
};
const RB_WS_ASM = {
  id: 'WS-HCR12A-ASM-01', title: 'HCR-12A 서브 조립별 체결 부품 (CAD 구조 · 조립 절차는 작성 필요)', models: ['HCR-12A'], kind: 'structure_only', purpose: 'CAD 구조에서 본 서브 조립별 체결 부품',
  review_status: 'unreviewed', revision: 'R00 (초안, 사람 검토 전)', rules: ['AR-FAS-006'], tools: ['TL-HEXKEY', 'TL-TORQUE'], step_count: 0, inspection_count: 0, assembly_count: 1, gap_ids: ['G-005', 'G-006'],
  standard_time: param('standard_time', null, null, unknownOf('G-006')), steps: [], checks: [], precautions: [], inspection_items: [], event_checks: [],
  assemblies: [{
    cad_name: 'HCR12A_2ND_ARM_ASSY_R1_ASM', label: '2번 암 조립품', model: 'HCR-12A',
    parts: [{ ...sourced('cad', [ref('FASTENER-CLS')], { estimated: true }), cad_name: 'BOLT-M4X15', quantity: 18, class_code: 'SocketHeadBolt', kind: 'bolt', thread_size: 'M4', length_mm: 15, length_source: 'cad', socket_size_mm: null, class_basis: null, note: null }],
  }],
  source_files: [], procedure_gap: 'G-005', by_grade: { manual: 0, standard: 0, cad: 1, unknown: 3 },
};
const RB_WS = [RB_WS_INS, RB_WS_MNT, RB_WS_ASM];
const wsSummary = (w: typeof RB_WS_INS | typeof RB_WS_MNT | typeof RB_WS_ASM) => ({
  id: w.id, title: w.title, models: w.models, kind: w.kind, purpose: w.purpose, review_status: w.review_status, revision: w.revision, rules: w.rules, tools: w.tools,
  step_count: w.step_count, inspection_count: w.inspection_count, assembly_count: w.assembly_count, gap_ids: w.gap_ids,
});

const byGradeOf = () => RB_RULES.reduce<Record<string, number>>((m, r) => { for (const [k, v] of Object.entries(r.by_grade)) m[k] = (m[k] ?? 0) + v; return m; }, { manual: 0, standard: 0, cad: 0, unknown: 0 });

/** POST /rulebook/select 의 조건 평가: 실제 백엔드(rulebook/select.py)와 같은 뜻 — 값이 없으면 unknown, 맞으면 yes, 다르면 no */
function fakeSelect(body: { class_code: string; class_path?: string[]; attributes?: Record<string, string | number | null>; role?: string; model?: string; include_inapplicable?: boolean }) {
  const chain = new Set([body.class_code, ...(body.class_path ?? [])]);
  const attrs = body.attributes ?? {};
  const cond = (kind: string, key: string, expected: string, actual: string | null, result: 'yes' | 'no' | 'unknown', message: string) => ({ kind, key, expected, ...(actual ? { actual } : { actual: null }), result, message });
  const rules = RB_RULES.flatMap(rule => {
    const ap = rule.applies_to;
    const all = [...ap.classes, ...ap.proposed_classes];
    if (all.length === 0 && !ap.role) return [];                                        // 분류도 역할도 없는 규칙(제품 전반)은 고르지 않는다: /rulebook/rules 로 본다
    if (all.length > 0 && !all.some(c => chain.has(c))) return [];                      // 분류가 맞지 않는 규칙은 고르지 않는다
    const conditions: ReturnType<typeof cond>[] = [];
    if (all.length > 0) conditions.push(cond('class', 'class', all.join(' · '), body.class_code, 'yes', `분류 ${body.class_code}은(는) 대상입니다`));
    if (ap.role) {
      conditions.push(!body.role ? cond('role', 'role', ap.role, null, 'unknown', `이 부품의 역할(role)을 알아야 확인됩니다: ${ap.role_label}`)
        : cond('role', 'role', ap.role, body.role, body.role === ap.role ? 'yes' : 'no', body.role === ap.role ? '역할 일치' : '역할이 다릅니다'));
    }
    if (ap.models.length > 0) {
      conditions.push(!body.model ? cond('model', 'model', ap.models.join(' · '), null, 'unknown', '로봇 모델을 알아야 확인됩니다')
        : cond('model', 'model', ap.models.join(' · '), body.model, (ap.models as readonly string[]).includes(body.model) ? 'yes' : 'no', '모델 확인'));
    }
    for (const [k, v] of Object.entries(ap.where)) {
      const allowed = v as unknown as string[];
      const actual = attrs[k] ?? null;
      conditions.push(actual === null ? cond('attribute', k, allowed.join(' | '), null, 'unknown', `${k} 값을 확정하면 확인됩니다`)
        : cond('attribute', k, allowed.join(' | '), String(actual), allowed.includes(String(actual)) ? 'yes' : 'no', `${k} = ${actual}`));
    }
    const failed = conditions.filter(c => c.result === 'no');
    const unknown = conditions.filter(c => c.result === 'unknown');
    const applicable = failed.length ? 'no' : unknown.length ? 'unknown' : 'yes';
    if (applicable === 'no' && !body.include_inapplicable) return [];
    const unconfirmed = rule.parameters.filter(p => !p.confirmed).map(p => p.name);
    const lookup = rule.lookup ? {
      key: rule.lookup.key,
      status: body.model ? 'selected' : 'all',
      rows: body.model ? rule.lookup.rows.filter(r => r.key === body.model) : rule.lookup.rows,
    } : null;
    return [{ rule, applicable, matched_conditions: conditions.filter(c => c.result === 'yes'), unknown_conditions: unknown, failed_conditions: failed, lookup, unconfirmed_parameters: unconfirmed }];
  });
  const count = (a: string) => rules.filter(r => r.applicable === a).length;
  return {
    class_code: body.class_code, role: body.role ?? null, model: body.model ?? null, rules, counts: { yes: count('yes'), unknown: count('unknown'), no: count('no') },
    note: "값이 없거나 확정되지 않은 조건은 '미확인'(unknown)이고 규칙이 적용된다고 단정하지 않습니다.",
  };
}

function rulebookResponse(path: string, method: string, body: unknown, state: 'ok' | 'invalid' | 'unavailable'): Response {
  const counts = { operations: RB_OPERATIONS.length, not_covered: 0, tools: RB_TOOLS.length, rules: RB_RULES.length, work_standards: RB_WS.length, gaps: RB_GAPS.length, steps: 3, inspection_items: 2 };
  if (path === '/rulebook/status') {
    if (state === 'invalid') {
      return json(200, {
        state: 'invalid', message: '조립 규칙 · 작업표준(rules/)에 오류가 2건 있어 내보내지 않습니다.', rules_dir: 'rules', loaded_at: null, counts: null, by_grade: null,
        validation: { tool: 'check_rules', errors: [{ level: 'error', where: 'rules.yaml AR-FAS-001', message: '출처 등급이 없습니다' }, { level: 'error', where: 'work-standards.yaml WS-HCR-INS-02', message: '없는 규칙 AR-X-999 을 참조합니다' }], warnings: [], notes: [] },
      });
    }
    if (state === 'unavailable') return json(200, { state: 'unavailable', message: 'rules/ 폴더를 찾을 수 없습니다', rules_dir: 'rules', loaded_at: null, counts: null, by_grade: null, validation: null });
    return json(200, { state: 'ok', message: null, rules_dir: 'rules', loaded_at: '2026-11-12T01:00:00+00:00', counts, by_grade: byGradeOf(), validation: { tool: 'check_rules', errors: [], warnings: [], notes: [] } });
  }
  if (state === 'invalid') {
    return json(503, {
      error: {
        code: 'RULEBOOK_INVALID', message: '조립 규칙 · 작업표준(rules/)에 오류가 2건 있어 내보내지 않습니다.',
        details: { errors: [{ where: 'rules.yaml AR-FAS-001', message: '출처 등급이 없습니다' }, { where: 'work-standards.yaml WS-HCR-INS-02', message: '없는 규칙 AR-X-999 을 참조합니다' }], total: 2 },
      },
    });
  }
  if (state === 'unavailable') return err(503, 'RULEBOOK_UNAVAILABLE', 'rules/ 폴더를 찾을 수 없습니다');
  const url = new URL(path, 'http://x');
  const q = url.searchParams;
  const p = url.pathname;
  if (p === '/rulebook/rules') {
    const rows = RB_RULES.filter(r => (!q.get('class_code') || ([...r.applies_to.classes, ...r.applies_to.proposed_classes] as string[]).includes(q.get('class_code')!))
      && (!q.get('role') || r.applies_to.role === q.get('role')) && (!q.get('operation') || r.operation === q.get('operation'))
      && (!q.get('model') || (r.applies_to.models as readonly string[]).length === 0 || (r.applies_to.models as readonly string[]).includes(q.get('model')!))
      && (!q.get('q') || (r.id + r.name).toLowerCase().includes(q.get('q')!.toLowerCase())));
    return json(200, rows);
  }
  const rule = /^\/rulebook\/rules\/([^/]+)$/.exec(p);
  if (rule) { const r = RB_RULES.find(x => x.id === rule[1]); return r ? json(200, r) : err(404, 'RULE_NOT_FOUND', `조립 규칙 ${rule[1]}을(를) 찾을 수 없습니다`); }
  if (p === '/rulebook/operations') return json(200, { operations: RB_OPERATIONS, not_covered: [] });
  if (p === '/rulebook/tools') return json(200, RB_TOOLS);
  if (p === '/rulebook/gaps') return json(200, RB_GAPS);
  if (p === '/rulebook/work-standards') return json(200, RB_WS.filter(w => !q.get('model') || w.models.includes(q.get('model')!)).map(wsSummary));
  const ws = /^\/rulebook\/work-standards\/([^/]+)$/.exec(p);
  if (ws) { const w = RB_WS.find(x => x.id === ws[1]); return w ? json(200, w) : err(404, 'WORK_STANDARD_NOT_FOUND', `작업표준서 ${ws[1]}을(를) 찾을 수 없습니다`); }
  if (p === '/rulebook/select' && method === 'POST') return json(200, fakeSelect(body as Parameters<typeof fakeSelect>[0]));
  return err(404, 'NOT_FOUND', path);
}

export function fakeBackend(initial: Partial<FakeBackend['state']> & { parts?: FakePart[] } = {}): FakeBackend {
  const { parts = PARTS, ...rest } = initial;
  const state: FakeBackend['state'] = { backend: 'up', opms: null, rulebook: 'ok', ...rest };
  const calls: FakeBackend['calls'] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (state.backend === 'down') throw new TypeError('Failed to fetch');
    const url = String(input);
    const path = url.replace('/api/v1/pdm', '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, ...(body ? { body } : {}) });

    if (path.startsWith('/rulebook/')) return rulebookResponse(path, method, body, state.rulebook);

    if (path === '/opms/status') {
      return state.opms
        ? json(200, { state: STATE[state.opms], message: MESSAGE[state.opms], ontology_version: null, classes: null, parts: null })
        : json(200, { state: 'ok', message: null, ontology_version: '0.15.0', classes: CLASSES.length, parts: parts.length });
    }
    if (state.opms) return err(503, state.opms, MESSAGE[state.opms]);
    if (path === '/opms/classes') return json(200, CLASSES);
    const detail = /^\/opms\/classes\/([^/]+)$/.exec(path);
    if (detail) {
      const c = CLASSES.find(x => x.code === detail[1]);
      return c ? json(200, { ...c, properties: SPEC_PROPS[c.code] ?? BOLT_PROPS, key_properties: [], distinguishing: [] }) : err(404, 'CLASS_NOT_FOUND', '분류를 찾을 수 없습니다');
    }
    const part = /^\/opms\/parts\/([^/]+)$/.exec(path);
    if (part) {
      const p = parts.find(x => x.part_no === decodeURIComponent(part[1]!));
      return p ? json(200, p) : err(404, 'PART_NOT_FOUND', '부품을 찾을 수 없습니다');
    }
    if (path === '/opms/match' && method === 'POST') return json(200, match(parts, body));
    return err(404, 'NOT_FOUND', path);
  };
  return { fetch: impl as typeof fetch, calls, state };
}
