import type {
  CadPartMatch, ChangeApplies, ChangeKind, ChangeOrigin, DispositionAction, DocType, DocumentLink, FindingKind, Identifier, ItemType, LinkStatus,
  OrderStatus, Passage, RequestStatus, RevisionStatus, ReviewFunction, ReviewVerdict, ScopeClass, Severity, Verdict,
} from './api/types';

export const ITEM_TYPE: Record<ItemType, string> = {
  assembly: '조립품', part: '가공품', standard: '표준품', purchased: '구매품',
};
export const REVISION_STATUS: Record<RevisionStatus, string> = {
  wip: '작업중', in_review: '검토중', released: '승인', obsolete: '폐기',
};
export const LINK_STATUS: Record<LinkStatus, string> = {
  suggested: '제안', confirmed: '확정', rejected: '거절',
};
export const DOC_TYPE: Record<DocType, string> = {
  cad_3d: '3D CAD', drawing: '도면', spec: '사양서', manual: '설명서', bom_sheet: 'BOM 시트', other: '기타',
};
export const MATCH_METHOD: Record<DocumentLink['matchMethod'], string> = {
  manual: '수동', filename: '파일명 규칙', step_product: 'STEP 구조', bom_import: 'BOM 가져오기', text_search: '구절 검색', ai: 'AI',
};
export const ID_SCHEME: Record<Identifier['scheme'], string> = {
  legacy: '레거시 품번', erp: 'ERP 코드', mes: 'MES 코드', supplier: '공급사 품번', customer: '고객 품번', drawing: '도면 번호',
  cad_name: 'CAD 이름',
};
export const DUPLICATE_METHOD: Record<NonNullable<CadPartMatch['method']>, string> = {
  exact: '정확 일치', alias: '별칭 일치', cad_name: 'CAD 이름', normalized: '정규화 일치', fuzzy: '유사도', attributes: '규격 일치',
};
export const PASSAGE_PURPOSE: Record<Passage['purpose'], string> = {
  definition: '정의', assembly: '조립 절차', disassembly: '분해 절차', reference: '참고',
};

/** 상태 → 배지 색 */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
export const REVISION_TONE: Record<RevisionStatus, Tone> = {
  wip: 'warning', in_review: 'info', released: 'success', obsolete: 'neutral',
};
export const LINK_TONE: Record<LinkStatus, Tone> = {
  suggested: 'warning', confirmed: 'success', rejected: 'neutral',
};

const dt = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const formatDateTime = (iso?: string) => (iso ? dt.format(new Date(iso)) : '—');
export const formatNumber = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 3 });

// ---------------------------------------------------------------- 설계 변경 영향 분석 (pages/changes)

export const CHANGE_STATUS: Record<RequestStatus, string> = {
  draft: '작성중', submitted: '제출됨', accepted: '접수됨', rejected: '반려', withdrawn: '철회',
};
export const CHANGE_STATUS_TONE: Record<RequestStatus, Tone> = {
  draft: 'neutral', submitted: 'info', accepted: 'success', rejected: 'neutral', withdrawn: 'neutral',
};
export const ORDER_STATUS: Record<OrderStatus, string> = {
  draft: '작성중', in_review: '검토중', approved: '승인', rejected: '반려', implemented: '반영됨', cancelled: '취소',
};
export const ORDER_STATUS_TONE: Record<OrderStatus, Tone> = {
  draft: 'neutral', in_review: 'info', approved: 'success', rejected: 'neutral', implemented: 'success', cancelled: 'neutral',
};
export const CHANGE_ORIGIN: Record<ChangeOrigin, string> = {
  design: '설계', quality: '품질', supplier: '공급사', ontology_impact: '온톨로지 변경 보고', other: '기타',
};
export const CHANGE_KIND: Record<ChangeKind, string> = {
  replace: '교체 (새 품번)', revise: '개정 (같은 품번)', bom_edit: 'BOM 편집', attribute_edit: '수치 변경',
};
export const CHANGE_KIND_HELP: Record<ChangeKind, string> = {
  replace: '규격(나사 규격 · 길이 · 피치 · 재질 · 강도 등급)이나 분류가 바뀌면 OPMS 에서 다른 품번입니다. 바꿀 품번을 적으세요.',
  revise: '같은 품번 안의 도면 · 공차 · 검사 조건 변경입니다. 규격이 바뀌면 개정이 아니라 교체입니다.',
  bom_edit: '조립품의 BOM 줄(부품 · 수량)을 바꿉니다. 조립품의 새 개정이 만들어집니다.',
  attribute_edit: '판 두께처럼 PDM 이 가진 수치를 바꿉니다(OPMS 가 값을 가진 부품은 이 방법이 아니라 교체입니다).',
};
export const APPLIES: Record<ChangeApplies, string> = { new: '새 개정 적용', old: '기존 개정 유지' };

/** 영향 심각도. 색에만 기대지 않도록 아이콘과 글자를 함께 쓴다 */
export const SEVERITY: Record<Severity, string> = { none: '영향 없음', review: '확인 필요', affected: '처분 필요', blocked: '막힘' };
export const SEVERITY_TONE: Record<Severity, Tone> = { none: 'neutral', review: 'info', affected: 'warning', blocked: 'danger' };
export const SEVERITY_ICON: Record<Severity, string> = { none: 'check_circle', review: 'visibility', affected: 'warning', blocked: 'block' };
export const SEVERITY_HELP: Record<Severity, string> = {
  none: '영향이 없거나 정보입니다. 처분이 필요 없습니다.',
  review: '사람이 확인하세요. "조치 없음"으로 닫을 수 있습니다.',
  affected: '영향이 있습니다. 처분(허용 · 재작업 · 격리 · 취소 …)을 정해야 승인할 수 있습니다.',
  blocked: '제안대로면 체결이 성립하지 않습니다. 변경안을 고쳐 다시 분석하기 전에는 승인할 수 없습니다.',
};
export const VERDICT: Record<Verdict, string> = { ok: '맞음', conditional: '조건부', no: '맞지 않음', unknown: '판정 불가' };
export const VERDICT_TONE: Record<Verdict, Tone> = { ok: 'success', conditional: 'warning', no: 'danger', unknown: 'neutral' };
export const VERDICT_ICON: Record<Verdict, string> = { ok: 'check_circle', conditional: 'warning', no: 'cancel', unknown: 'help' };

export const FINDING_KIND: Record<FindingKind, string> = {
  bom_usage: '사용처(BOM)', product: '제품', work_order: '작업지시', purchase_order_line: '발주 항목', stock_lot: '재고 로트',
  fit_pair: '볼트 · 너트 · 와셔 짝', fit_grip: '그립 길이', strength_grade: '강도 등급', substitute: '대체 부품',
};
export const SCOPE_CLASS: Record<ScopeClass, string> = { inside: '범위 안', outside: '범위 밖', partial: '일부 걸침', unknown: '범위 미확인' };

export const DISPOSITION: Record<DispositionAction, string> = {
  continue_old: '기존 개정으로 계속', change_in_progress: '진행 중 변경 검토', cancel_reissue: '취소 후 재발행', use_as_is: '기존 사양 그대로 허용', apply_new: '새 개정 적용',
  receive_and_use: '받아서 기존 사양 사용', amend: '수량 · 사양 정정 요청', cancel: '취소',
  use_up: '소진 후 전환', quarantine: '격리', return: '반품', scrap: '폐기',
  block_change: '변경안 수정', choose_substitute: '대체 부품 선택', review_with_design: '설계와 검토',
  accept_risk: '위험 수용(사유 필수)', acknowledge: '확인함', no_action_needed: '조치 없음',
};
export const REVIEW_FUNCTION: Record<ReviewFunction, string> = { design: '설계', purchasing: '구매', production: '생산' };
export const REVIEW_VERDICT: Record<ReviewVerdict, string> = { approve: '찬성', reject: '반대', comment: '의견' };

/** 분석이 낸 이유 코드(OPMS 가 주는 것과 PDM 이 더한 것) → 한 줄 이름 */
export const REASON_CODE: Record<string, string> = {
  shortfall: '길이 부족', thin_margin: '여유 적음', value_missing: '값 없음', value_unreadable: '값을 읽지 못함', approximate_value: '추정값',
  unit_unconvertible: '단위 변환 불가', no_rule: '적용할 규칙 없음',
  pair_mismatch: '짝 불일치', pair_unknown: '짝 판정 불가(값 없음)', pair_unrelated: '짝이 아님', strength_differs: '강도 등급이 다름',
  substitute_conditional: '대체 조건부', used_in_completed: '완료된 작업에 쓰임', used_in_progress: '진행 중 작업에 쓰임', open_po_line: '미입고 발주',
  stock_on_hand: '재고 있음', scope_unknown: '적용 범위 미확인', OPMS_UNAVAILABLE: 'OPMS 를 읽지 못함',
};

/** 백엔드 오류 코드 → 사람이 읽을 이유(승인이 막힌 까닭 등). 백엔드가 준 메시지가 있으면 그것이 먼저다 */
export const CHANGE_ERROR: Record<string, string> = {
  DISPOSITION_REQUIRED: '처분이 없는 영향이 있어요.', REVIEW_REQUIRED: '필요한 검토가 끝나지 않았어요.', IMPACT_STALE: '외부 데이터가 바뀌었어요. 다시 분석하세요.',
  IMPACT_PARTIAL: 'OPMS 를 읽지 못한 분석이라 승인할 수 없어요.', IMPACT_NOT_COMPUTED: '영향 분석을 먼저 실행하세요.', BLOCKED_FINDINGS: '막힘(blocked) 영향이 남아 있어요.',
  SCOPE_REQUIRED: '적용 범위를 정하세요.', SCOPE_OVERLAP: '적용 범위가 겹쳐요.', SCOPE_INVALID: '적용 범위가 올바르지 않아요.',
  CHANGE_STATE_INVALID: '지금 상태에서는 할 수 없어요.', REVISION_CHANGES_IDENTITY: '규격이 바뀌면 개정이 아니라 교체(새 품번)예요.',
  ONTOLOGY_NOT_A_TARGET: '온톨로지는 변경 대상이 아니에요.', TARGET_NOT_RELEASED: '승인된 개정만 변경 대상이 될 수 있어요.', DISPOSITION_INVALID: '이 영향에 없는 처분이에요.',
  FORBIDDEN: '권한이 없어요.', CHANGE_NOT_FOUND: '변경 건을 찾을 수 없어요.', ITEM_NOT_FOUND: '품목을 찾을 수 없어요.',
};
