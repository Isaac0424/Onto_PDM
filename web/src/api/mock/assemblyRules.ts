// 가상 회사 "온토전자"의 조립 규칙 모음 (목업). 실제 회사의 규칙이 아니고, 여기 숫자는 화면 시연용이다.
// 구조와 설명은 docs/assembly-rules-spec.md 에 있다. 실제로는 OPMS 방식(ontology/*.yaml → Neo4j)으로 컴파일된 규칙을 읽는다.
import type { AssemblyGuide, AssemblyOperation, AssemblyPartInput, AssemblyRuleDetail, AssemblyRuleSummary } from '../types';

export const COMPANY = '온토전자 (가상 회사)';

export const OPERATION_LABEL: Record<AssemblyOperation, string> = {
  fasten: '볼트 체결', weld: '용접', press_fit: '압입', mount: '장착', insert: '삽입', cover: '커버 조립',
};

export interface RuleDef {
  id: string;
  name: string;
  operation: AssemblyOperation;
  /** 목록 · 상세에 보일 적용 대상 */
  appliesTo: string[];
  description: string;
  conditions: string[];
  status: 'approved' | 'draft';
  /** 상세에 보일 조건표 */
  table?: { title: string; columns: string[]; rows: string[][] };
  /** 규칙 상세에서 값을 보여 줄 때 쓰는 대표 부품 (이름과 크기) */
  sample: AssemblyPartInput;
  /** 규칙이 걸리는 분류 이름(예: '볼트'). 부품의 className 이 같거나 분류 사슬(예: '체결류 › 볼트')에 들어 있으면 걸린다. 없으면 이름으로만 찾는다 */
  classes?: string[];
  /** 분류가 맞은 부품에 더하는 속성 조건 (예: 나사 규격이 M3). 분류를 모르는 부품에는 쓰지 않는다 */
  when?: (part: AssemblyPartInput) => boolean;
  /** 규칙 출처 문서. 없으면 회사 조립 표준 번호로 본다. 비어 있는 문자열은 검증 오류 */
  source?: string;
  /** 분류를 모르는 부품(이름만 있는 CAD 부품)에 쓰는 이름 패턴. 분류가 있는 규칙도 하위 호환으로 함께 둔다 */
  match: RegExp;
  build(part: AssemblyPartInput): Omit<AssemblyGuide, 'partName' | 'ruleId' | 'ruleName' | 'operation' | 'operationLabel' | 'source'>;
}

/** 부품의 두께(mm): 확정된 thickness 속성이 있으면 그 값, 없으면 CAD 크기의 가장 얇은 치수. 모르면 undefined */
const thickness = (p: AssemblyPartInput) => {
  const attr = Number(p.attributes?.thickness);
  if (Number.isFinite(attr) && attr > 0) return attr;
  return p.size ? Math.min(...p.size) : undefined;
};
const mm = (v: number) => `${+v.toFixed(2)} mm`;

/** 용접 조건표 (가상 값). 얇은 쪽 모재 두께 → 개선 형상 · 필러(용접봉) 지름 · 루트 갭 */
export const WELD_TABLE = [
  { upTo: 1.5, groove: 'I형 (개선 없음)', filler: 'Φ1.0', gap: '0 mm' },
  { upTo: 3, groove: 'I형 (개선 없음)', filler: 'Φ1.6', gap: '0 ~ 0.5 mm' },
  { upTo: 6, groove: 'V형 60°', filler: 'Φ2.4', gap: '1 ~ 2 mm' },
  { upTo: Infinity, groove: 'V형 60° · 다층 용접', filler: 'Φ3.2', gap: '2 ~ 3 mm' },
] as const;

const RULES: RuleDef[] = [
  {
    id: 'SP-FAS-01', name: '소형 나사(M3) 체결', operation: 'fasten', appliesTo: ['볼트 (나사 규격 M3)'], description: 'M3 나사와 볼트를 조일 때 따르는 토크와 순서.', conditions: ['분류가 볼트이고 나사 규격(threadSize)이 M3이다', '분류를 모르면: 부품 이름에 나사 또는 볼트와 M3가 있다', '체결 공정'], status: 'approved', sample: { name: '기판 나사 M3', size: [3, 3, 8], className: '볼트', attributes: { threadSize: 'M3' } },
    classes: ['볼트'], when: p => String(p.attributes?.threadSize ?? '').toUpperCase() === 'M3' || /M3/.test(p.name), match: /(나사|볼트).*M3|M3.*(나사|볼트)/,
    build: p => ({
      title: `${p.name} 체결`,
      caption: '대각선 순서로 두 번에 나눠, 0.6 N·m까지 조입니다.',
      params: [
        { label: '체결 토크', value: '0.6 N·m ±10%' },
        { label: '체결 순서', value: '대각선, 2회 (50% → 100%)' },
        { label: '나사 규격', value: 'M3' },
      ],
      cautions: ['나사산이 상하면 폐기하고, 같은 나사를 3번 넘게 다시 쓰지 않습니다.', '토크 드라이버가 교정 기한 안인지 확인합니다.'],
      tools: ['토크 드라이버 0.2 ~ 1.0 N·m'],
    }),
  },
  {
    id: 'SP-CVR-01', name: '커버 조립', operation: 'cover', appliesTo: ['커버'], description: '커버를 닫을 때: 접촉면 청소, 가스켓 확인, 커버 두께로 나사 길이를 정한다.', conditions: ['분류가 커버이다', '분류를 모르면: 부품 이름이 커버로 끝난다', '커버 두께를 thickness 속성이나 CAD 크기에서 읽을 수 있다'], status: 'approved', sample: { name: '상부 커버', size: [126, 80, 3], className: '커버' },
    classes: ['커버'], match: /커버$/,
    build: p => {
      const t = thickness(p);
      const need = t === undefined ? undefined : t + 4.5;                    // 필요 나사 길이 = 커버 두께 + 체결 깊이(1.5 × 나사 지름 4.5 mm)
      return {
        title: `${p.name} 닫기`,
        caption: t === undefined
          ? '접촉면을 닦고, 가스켓이 제자리에 있는지 본 뒤 닫습니다.'
          : `커버 두께 ${mm(t)}: 나사 길이는 ${mm(need!)} 이상이어야 합니다. 접촉면을 닦고 닫습니다.`,
        params: [
          ...(t === undefined ? [] : [
            { label: '커버 두께', value: mm(t) },
            { label: '필요 나사 길이', value: `≥ ${mm(need!)} (두께 + 1.5 × 지름)` },
            { label: '사용 나사', value: 'M3 × 12', ok: 12 >= need! },
          ]),
          { label: '체결 순서', value: '중앙에서 모서리로' },
        ],
        cautions: ['접촉면의 이물을 닦아 냅니다.', '가스켓이 빠졌거나 말려 들어가지 않았는지 봅니다.'],
        tools: ['무진 와이퍼', '토크 드라이버'],
      };
    },
  },
  {
    id: 'SP-ELC-01', name: '제어 기판 장착', operation: 'mount', appliesTo: ['제어 기판'], description: '전자 기판을 올릴 때: 입력 · 출력 포트 방향과 정전기 방지.', conditions: ['부품 이름이 기판으로 끝난다 (시드 분류에 기판이 없어 이름으로 찾는다)'], status: 'approved', sample: { name: '제어 기판' }, match: /기판$/,
    build: p => ({
      title: `${p.name} 올리기`,
      caption: '입력 포트가 왼쪽, 출력 포트가 오른쪽으로 오도록 놓습니다.',
      params: [
        { label: '입력 포트 위치', value: '왼쪽 (−X)' },
        { label: '출력 포트 위치', value: '오른쪽 (+X)' },
        { label: '지지 스페이서', value: '4곳 정렬' },
      ],
      cautions: ['정전기 방지 손목 스트랩을 착용합니다.', '기판은 가장자리만 잡습니다.', '방향이 반대면 케이블이 닿지 않아 불량이 됩니다.'],
      tools: ['ESD 손목 스트랩', '핀셋'],
    }),
  },
  {
    id: 'SP-SPC-01', name: '스페이서 장착', operation: 'mount', appliesTo: ['스페이서'], description: '기판을 받치는 스페이서의 높이 확인.', conditions: ['부품 이름에 스페이서가 있다 (시드 분류에 스페이서가 없어 이름으로 찾는다)'], status: 'approved', sample: { name: '스페이서' }, match: /스페이서/,
    build: p => ({
      title: `${p.name} 세우기`,
      caption: '높이가 같은지 확인하고 보스에 세웁니다.',
      params: [{ label: '높이 허용 편차', value: '±0.1 mm' }, { label: '수량', value: '4개' }],
      cautions: ['높이 편차가 허용치를 넘으면 기판이 기웁니다. 그 스페이서는 쓰지 않습니다.'],
      tools: ['버니어 캘리퍼'],
    }),
  },
  {
    id: 'SP-BAT-01', name: '배터리 장착', operation: 'insert', appliesTo: ['배터리'], description: '배터리의 극성 확인과 단락 방지.', conditions: ['분류가 배터리이다', '분류를 모르면: 부품 이름에 배터리가 있다'], status: 'approved', sample: { name: '배터리', className: '배터리' },
    classes: ['배터리'], match: /배터리/,
    build: p => ({
      title: `${p.name} 넣기`,
      caption: '극성을 확인하고, 금속 공구가 단자에 닿지 않게 넣습니다.',
      params: [{ label: '극성', value: '(+)는 케이블 쪽' }, { label: '장착 시점', value: '기판 체결 후' }],
      cautions: ['금속 공구로 단자를 만지지 않습니다. 단락되면 발열합니다.', '부풀었거나 찍힌 배터리는 쓰지 않고 격리합니다.'],
      tools: ['절연 핀셋'],
    }),
  },
  {
    id: 'SP-SW-01', name: '버튼 장착', operation: 'insert', appliesTo: ['스위치 · 버튼'], description: '버튼을 개구부에 끼우고 걸림을 확인.', conditions: ['분류가 스위치 · 버튼이다', '분류를 모르면: 부품 이름에 버튼이 있다'], status: 'approved', sample: { name: '전원 버튼', className: '스위치 · 버튼' },
    classes: ['스위치 · 버튼'], match: /버튼/,
    build: p => ({
      title: `${p.name} 끼우기`,
      caption: '개구부에 맞춰 위에서 눌러 넣고, 걸림 없이 눌리는지 봅니다.',
      params: [{ label: '눌림 방향', value: '+Z (위쪽)' }, { label: '확인', value: '걸림 없이 복귀' }],
      cautions: ['눌렀을 때 걸리면 개구부 버를 확인합니다.'],
      tools: [],
    }),
  },
  {
    id: 'SP-RED-01', name: '감속기 장착', operation: 'mount', appliesTo: ['감속기'], description: '감속기를 관절 모듈에 장착할 때: 입력축 방향, 그리스, 체결 순서.',
    conditions: ['분류가 감속기이다', '분류를 모르면: 부품 이름에 감속기가 있다'], status: 'approved', sample: { name: 'J1 감속기', className: '감속기' },
    classes: ['감속기'], match: /감속기/,
    build: p => ({
      title: `${p.name} 장착`,
      caption: '입력축이 모터 쪽을 향하게 놓고, 대각선 순서로 체결합니다.',
      params: [{ label: '입력축 방향', value: '모터 쪽' }, { label: '체결 순서', value: '대각선' }, { label: '그리스', value: '규정량, 기어면만' }],
      cautions: ['입력축 방향이 반대면 조립 후 분해해야 합니다.', '그리스가 체결면에 묻지 않게 합니다.'],
      tools: ['토크 렌치', '그리스 도포기'],
    }),
  },
  {
    id: 'SP-MOT-01', name: '서보 모터 장착', operation: 'mount', appliesTo: ['서보 모터'], description: '서보 모터를 장착할 때: 전원 · 엔코더 포트의 방향과 케이블 여유.',
    conditions: ['분류가 서보 모터이다', '분류를 모르면: 부품 이름에 모터가 있다'], status: 'approved', sample: { name: '서보 모터 400W', className: '서보 모터' },
    classes: ['서보 모터'], match: /모터/,
    build: p => ({
      title: `${p.name} 장착`,
      caption: '전원 포트는 왼쪽, 엔코더 포트는 오른쪽으로 오게 돌려 끼웁니다.',
      params: [{ label: '전원 포트 위치', value: '왼쪽 (−X)' }, { label: '엔코더 포트 위치', value: '오른쪽 (+X)' }, { label: '케이블 여유', value: '굽힘 반경 이상' }],
      cautions: ['포트 방향이 바뀌면 케이블이 닿지 않습니다.', '엔코더 케이블을 당기지 않습니다.'],
      tools: ['토크 드라이버'],
    }),
  },
  {
    id: 'SP-HSG-01', name: '하우징 조립', operation: 'cover', appliesTo: ['하우징'], description: '하우징을 맞붙일 때: 접촉면 청소와 위치 핀 정렬.',
    conditions: ['분류가 하우징이다', '분류를 모르면: 부품 이름이 하우징으로 끝난다'], status: 'approved', sample: { name: 'J1 하우징', className: '하우징' },
    classes: ['하우징'], match: /하우징$/,
    build: p => ({
      title: `${p.name} 맞추기`,
      caption: '접촉면을 닦고, 위치 핀을 먼저 맞춘 뒤 눌러 붙입니다.',
      params: [{ label: '정렬', value: '위치 핀 먼저' }, { label: '접촉면', value: '이물 없음' }],
      cautions: ['접촉면에 흠집이 있으면 사용하지 않습니다.'],
      tools: ['무진 와이퍼'],
    }),
  },
  {
    id: 'SP-WLD-01', name: '박판 용접 (가상 조건표)', operation: 'weld', appliesTo: ['접합 부품 (러그)'], description: '얇은 쪽 모재 두께에 따라 개선 형상과 필러(용접봉) 지름을 정한다. 가상 조건표.', conditions: ['접합 방식이 용접이다 (시드 분류에 접합 부품이 없어 이름으로 찾는다)', '얇은 쪽 모재 두께를 thickness 속성이나 CAD 크기에서 읽을 수 있다'], status: 'draft', table: { title: '모재 두께별 용접 조건 (가상 값)', columns: ['모재 두께', '개선 형상', '필러 지름', '루트 갭'], rows: WELD_TABLE.map((r, i) => [i === 0 ? '< 1.5 mm' : r.upTo === Infinity ? '≥ 6 mm' : '< ' + r.upTo + ' mm', r.groove, r.filler, r.gap]) }, sample: { name: '러그', size: [3, 2.6, 7] }, match: /러그/,
    build: p => {
      const t = thickness(p) ?? 2;
      const row = WELD_TABLE.find(r => t < r.upTo)!;
      return {
        title: `${p.name} 용접`,
        caption: `모재 두께 ${mm(t)}: ${row.groove}, 필러 ${row.filler}로 접합합니다.`,
        params: [
          { label: '모재 두께', value: mm(t) },
          { label: '개선 형상', value: row.groove },
          { label: '필러(용접봉) 지름', value: row.filler },
          { label: '루트 갭', value: row.gap },
        ],
        cautions: ['가상 값입니다. 실제 용접 조건으로 쓰지 않습니다.', '지그로 고정한 뒤 용접하고, 용접 후 변형을 확인합니다.', '보호구(차광면, 장갑)를 착용합니다.'],
        tools: ['TIG 용접기', '용접 지그'],
      };
    },
  },
  {
    id: 'SP-PRS-01', name: '압입', operation: 'press_fit', appliesTo: ['유리 · 크리스털 (압입)'], description: '구멍과 중심을 맞춘 뒤 프레스로 천천히 눌러 넣는다. 압입력은 기록한다. 가상 값.', conditions: ['접합 방식이 압입이다 (시드 분류에 유리 · 크리스털이 없어 이름으로 찾는다)'], status: 'draft', sample: { name: '사파이어 크리스털' }, match: /크리스털|유리/,
    build: p => ({
      title: `${p.name} 압입`,
      caption: '구멍과 중심을 맞춘 뒤, 프레스로 천천히 눌러 넣습니다.',
      params: [
        { label: '끼워맞춤', value: 'H7 / p6 (가상)' },
        { label: '압입 속도', value: '느리게, 일정하게' },
        { label: '압입력', value: '상한 이내, 값은 기록' },
      ],
      cautions: ['중심이 어긋나면 깨질 수 있습니다. 정렬을 먼저 봅니다.', '압입력이 갑자기 오르면 멈추고 불량 처리합니다.'],
      tools: ['압입 프레스', '로드셀'],
    }),
  },
];

/** 분류 사슬: '체결류 › 볼트' 처럼 상위 분류가 함께 들어와도 각 분류 이름으로 나눠 본다 */
const classChain = (className: string) => className.split(/\s*[›>/]\s*/).map(c => c.trim()).filter(Boolean);

/**
 * 이 부품에 이 규칙이 걸리는가.
 *  ① 분류(className)가 들어온 부품: 규칙에 분류가 있으면 분류로만 판단한다(분류가 다르면 이름이 비슷해도 걸리지 않는다). 속성 조건(when)이 있으면 함께 본다.
 *  ② 분류를 모르거나 분류가 없는 규칙: 이름 패턴으로 찾는다 (이름만 가진 CAD 부품, 하위 호환).
 */
export function ruleApplies(rule: RuleDef, part: AssemblyPartInput): boolean {
  if (part.className && rule.classes?.length) {
    const chain = classChain(part.className);
    if (!rule.classes.some(c => chain.includes(c))) return false;
    return rule.when ? rule.when(part) : true;
  }
  return rule.match.test(part.name);
}

/** 부품(이름 · 분류 · 속성 · 크기)에 맞는 규칙을 적용해 조립 안내를 만든다. 맞는 규칙이 없으면 건너뛴다. */
export function guideFor(part: AssemblyPartInput): AssemblyGuide | undefined {
  // 규칙 순서가 우선순위다: 나사는 이름에 '커버'가 들어 있어도 나사 규칙이 먼저다
  const rule = RULES.find(r => ruleApplies(r, part));
  if (!rule) return undefined;
  return {
    partName: part.name, ruleId: rule.id, ruleName: rule.name, operation: rule.operation,
    operationLabel: OPERATION_LABEL[rule.operation], source: rule.source ?? `${COMPANY} 조립 표준 ${rule.id}`,
    ...rule.build(part),
  };
}

const sourceOf = (id: string) => `${COMPANY} 조립 표준 ${id}`;

/** 규칙 목록 (대표 부품으로 계산한 핵심 값 두 개를 함께) */
export function summarizeRules(): AssemblyRuleSummary[] {
  return RULES.map(r => {
    const g = r.build(r.sample);
    return {
      id: r.id, name: r.name, operation: r.operation, operationLabel: OPERATION_LABEL[r.operation], appliesTo: r.appliesTo,
      keyValues: g.params.slice(0, 2).map(({ label, value }) => ({ label, value })),
      cautionCount: g.cautions.length, toolCount: g.tools.length, status: r.status, source: sourceOf(r.id),
    };
  });
}

/** 규칙 하나의 상세. usedBy 는 부르는 쪽(목 API)이 보유 품목에서 채운다 */
export function describeRule(id: string): Omit<AssemblyRuleDetail, 'usedBy'> | undefined {
  const r = RULES.find(x => x.id === id);
  if (!r) return undefined;
  const g = r.build(r.sample);
  return {
    ...summarizeRules().find(x => x.id === id)!, description: r.description, conditions: r.conditions,
    parameters: g.params.map(({ label, value }) => ({ label, value })), ...(r.table ? { table: r.table } : {}),
    cautions: g.cautions, tools: g.tools,
  };
}

/** 이 규칙이 적용되는 부품 이름인가 (이름만으로. 분류와 속성까지 보려면 ruleApplies) */
export const ruleMatches = (id: string, name: string) => { const r = RULES.find(x => x.id === id); return !!r && ruleApplies(r, { name }); };
