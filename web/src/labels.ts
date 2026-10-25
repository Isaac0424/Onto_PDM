import type {
  DocType, DocumentLink, DuplicateCandidate, Identifier, ItemType, LinkStatus, Passage, ProposalStatus, RequestStatus, RevisionStatus,
} from './api/types';

export const ITEM_TYPE: Record<ItemType, string> = {
  assembly: '조립품', part: '가공품', standard: '표준품', purchased: '구매품',
};
export const REVISION_STATUS: Record<RevisionStatus, string> = {
  wip: '작업중', in_review: '검토중', released: '승인', obsolete: '폐기',
};
export const REQUEST_STATUS: Record<RequestStatus, string> = {
  draft: '임시저장', submitted: '제출됨', approved: '승인', rejected: '반려', cancelled: '취소',
};
export const PROPOSAL_STATUS: Record<ProposalStatus, string> = {
  proposed: '검토 대기', approved: '승인', rejected: '거절', merged: '기존 분류에 합침',
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
export const DUPLICATE_METHOD: Record<DuplicateCandidate['method'], string> = {
  exact: '정확 일치', alias: '별칭 일치', cad_name: 'CAD 이름', normalized: '정규화 일치', fuzzy: '유사도',
};
export const PASSAGE_PURPOSE: Record<Passage['purpose'], string> = {
  definition: '정의', assembly: '조립 절차', disassembly: '분해 절차', reference: '참고',
};

/** 상태 → 배지 색 */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
export const REVISION_TONE: Record<RevisionStatus, Tone> = {
  wip: 'warning', in_review: 'info', released: 'success', obsolete: 'neutral',
};
export const REQUEST_TONE: Record<RequestStatus, Tone> = {
  draft: 'neutral', submitted: 'info', approved: 'success', rejected: 'danger', cancelled: 'neutral',
};
export const PROPOSAL_TONE: Record<ProposalStatus, Tone> = {
  proposed: 'info', approved: 'success', rejected: 'danger', merged: 'neutral',
};
export const LINK_TONE: Record<LinkStatus, Tone> = {
  suggested: 'warning', confirmed: 'success', rejected: 'neutral',
};

const dt = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export const formatDateTime = (iso?: string) => (iso ? dt.format(new Date(iso)) : '—');
export const formatNumber = (n: number) => n.toLocaleString('ko-KR', { maximumFractionDigits: 3 });
