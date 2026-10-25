// 목 API — 서버가 생기기 전까지 화면을 돌리는 메모리 구현.
// 공개 범위 · 권한 규칙은 db/schema.sql · db/roles.sql 과 같게 흉내 낸다:
//   작업중 · 검토중 리비전과 임시저장은 작성자와 관리자 모드(admin · approver)만 본다.
//   품번 발급(등록 요청 승인)과 분류 제안 검토는 관리자 모드만 한다.
import {
  ApiError,
  type BomNode, type BomRule, type DocumentLink, type DuplicateCandidate, type Item, type ItemDetail,
  type ItemQuery, type ItemSummary, type PartRequest, type PartRequestPayload, type Passage, type PdmApi, type Revision,
  type WhereUsedRow,
} from '../types';
import { createSeed, type MockDb } from './seed';

export interface Session {
  userId: number;
  adminMode: boolean;
}

export interface MockOptions {
  latencyMs?: number;
  /** 새로고침해도 임시저장이 남도록 브라우저 저장소에 둔다. 테스트에서는 null. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

export const MOCK_STORAGE_KEY = 'onto-pdm-mock-v1';

const clone = <T,>(v: T): T => structuredClone(v);
const now = () => new Date().toISOString();

/** 이름 비교 키: 대문자, 공백 · _ · - · . 제거 (DB norm_key 와 같다) */
export const normKey = (s: string) => s.toUpperCase().replace(/[\s_.\-]+/g, '');

/** 두 글자 묶음 유사도 (pg_trgm 대신 쓰는 근사) */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = ` ${s.toLowerCase()} `;
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a), B = grams(b);
  let common = 0;
  A.forEach(g => { if (B.has(g)) common++; });
  return A.size + B.size ? (2 * common) / (A.size + B.size) : 0;
}

export function createMockApi(getSession: () => Session, options: MockOptions = {}): PdmApi & { reset(): void } {
  const { latencyMs = 0, storage = null } = options;
  let db: MockDb = load();

  function load(): MockDb {
    try {
      const raw = storage?.getItem(MOCK_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as MockDb;
        if (parsed.version === 1) return parsed;
      }
    } catch { /* 저장소를 못 쓰면 기본 데이터로 */ }
    return createSeed();
  }
  function persist() {
    try { storage?.setItem(MOCK_STORAGE_KEY, JSON.stringify(db)); } catch { /* 무시 */ }
  }
  const wait = <T,>(v: T): Promise<T> =>
    latencyMs ? new Promise(res => setTimeout(() => res(clone(v)), latencyMs)) : Promise.resolve(clone(v));

  // ---------- 세션 · 권한 ----------
  const me = () => {
    const u = db.users.find(x => x.id === getSession().userId);
    if (!u) throw new ApiError('사용자가 없습니다', 403);
    return u;
  };
  const isAdmin = () => getSession().adminMode && ['admin', 'approver'].includes(me().role);
  const requireAdmin = () => {
    if (!isAdmin()) throw new ApiError('관리자 모드에서만 할 수 있습니다', 403);
  };
  const canSeeRevision = (r: Revision) =>
    r.status === 'released' || r.status === 'obsolete' || isAdmin() || r.createdBy === me().id;

  // ---------- 품목 · 리비전 ----------
  const itemById = (id: number) => db.items.find(i => i.id === id)!;
  const visibleRevisions = (itemId: number) =>
    db.revisions.filter(r => r.itemId === itemId && canSeeRevision(r)).sort((a, b) => a.revSeq - b.revSeq);
  const canSeeItem = (it: Item) => visibleRevisions(it.id).length > 0 || isAdmin() || it.createdBy === me().id;

  const summarize = (it: Item): ItemSummary => {
    const revs = visibleRevisions(it.id);
    const released = revs.filter(r => r.status === 'released');
    return { ...it, latestRevision: revs[revs.length - 1], releasedRevision: released[released.length - 1] };
  };

  /** effective_revision(): released = 최신 승인본(없으면 보이는 최신), latest = 보이는 최신 (폐기 제외) */
  const effectiveRevision = (itemId: number, rule: BomRule): Revision | undefined => {
    const revs = visibleRevisions(itemId).filter(r => r.status !== 'obsolete');
    if (rule === 'released') {
      const rel = revs.filter(r => r.status === 'released');
      if (rel.length) return rel[rel.length - 1];
    }
    return revs[revs.length - 1];
  };

  const findItem = (itemNo: string) => {
    const it = db.items.find(i => i.itemNo === itemNo);
    if (!it || !canSeeItem(it)) throw new ApiError(`품목 ${itemNo}을(를) 찾을 수 없습니다`, 404);
    return it;
  };
  const findRevision = (id: number) => {
    const r = db.revisions.find(x => x.id === id);
    if (!r || !canSeeRevision(r)) throw new ApiError('리비전을 찾을 수 없습니다', 404);
    return r;
  };

  function explode(revisionId: number, rule: BomRule, depth: number, total: number, path: number[]): BomNode[] {
    if (depth > 30) return [];
    return db.bomLines
      .filter(l => l.parentRevisionId === revisionId)
      .filter(l => !path.includes(l.childItemId))
      .sort((a, b) => (a.findNo ?? 0) - (b.findNo ?? 0))
      .map(l => {
        const child = itemById(l.childItemId);
        const childRev = effectiveRevision(child.id, rule);
        const t = total * l.quantity;
        return {
          lineId: l.id, depth, findNo: l.findNo, quantity: l.quantity, totalQuantity: t,
          item: summarize(child), revision: childRev,
          children: childRev ? explode(childRev.id, rule, depth + 1, t, [...path, child.id]) : [],
        };
      });
  }

  function whereUsed(itemId: number): WhereUsedRow[] {
    const out: WhereUsedRow[] = [];
    const walk = (id: number, depth: number, path: number[]) => {
      for (const l of db.bomLines.filter(x => x.childItemId === id)) {
        const pr = db.revisions.find(r => r.id === l.parentRevisionId)!;
        if (pr.status === 'obsolete' || !canSeeRevision(pr) || path.includes(pr.itemId)) continue;
        out.push({ depth, parent: summarize(itemById(pr.itemId)), parentRevision: pr, quantity: l.quantity });
        walk(pr.itemId, depth + 1, [...path, pr.itemId]);
      }
    };
    walk(itemId, 1, [itemId]);
    return out;
  }

  // ---------- 중복 후보 (match_item_candidates 근사) ----------
  function duplicateCandidates(name: string, aliasValues: string[] = []): DuplicateCandidate[] {
    const found = new Map<string, DuplicateCandidate>();
    const put = (c: DuplicateCandidate) => {
      const prev = found.get(c.itemNo);
      if (!prev || prev.score < c.score) found.set(c.itemNo, c);
    };
    for (const it of db.items) {
      if (it.itemNo === name || it.name === name) put({ itemNo: it.itemNo, name: it.name, method: 'exact', score: 1 });
      else if (normKey(it.itemNo) === normKey(name) || normKey(it.name) === normKey(name))
        put({ itemNo: it.itemNo, name: it.name, method: 'normalized', score: 0.95 });
      else {
        const s = Math.max(similarity(it.name, name), it.nameKo ? similarity(it.nameKo, name) : 0);
        if (s >= 0.3) put({ itemNo: it.itemNo, name: it.name, method: 'fuzzy', score: Math.round(s * 100) / 100 });
      }
    }
    // 이름과 요청에 적은 별칭 값 모두로 기존 별칭을 찾는다
    for (const term of [name, ...aliasValues]) {
      for (const x of db.identifiers) {
        if (x.value === term || normKey(x.value) === normKey(term)) {
          const it = itemById(x.itemId);
          put({ itemNo: it.itemNo, name: it.name, method: x.scheme === 'cad_name' ? 'cad_name' : 'alias',
                score: x.value !== term ? 0.95 : x.scheme === 'cad_name' ? 0.97 : 1 });
        }
      }
    }
    return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  }

  // ---------- 등록 요청 ----------
  const findRequest = (id: number) => {
    const r = db.partRequests.find(x => x.id === id);
    if (!r || (r.requestedBy !== me().id && !isAdmin())) throw new ApiError('등록 요청을 찾을 수 없습니다', 404);
    return r;
  };

  const findProposal = (id: number) => {
    requireAdmin();
    const p = db.classProposals.find(x => x.id === id);
    if (!p) throw new ApiError('분류 제안을 찾을 수 없습니다', 404);
    if (p.status !== 'proposed') throw new ApiError('검토 대기 중인 제안만 처리할 수 있습니다', 409);
    return p;
  };
  /** 제안을 기다리던 등록 요청에 확정된 분류를 넣는다 */
  const resolveWaitingRequests = (proposalId: number, classIri: string) => {
    db.partRequests
      .filter(r => r.classProposalId === proposalId && ['draft', 'submitted'].includes(r.status))
      .forEach(r => { r.payload.classIri = classIri; r.updatedAt = now(); });
  };

  const api: PdmApi & { reset(): void } = {
    reset() {
      db = createSeed();
      try { storage?.removeItem(MOCK_STORAGE_KEY); } catch { /* 무시 */ }
    },

    listUsers: async () => wait(db.users),
    listProducts: async () => wait(db.products),
    listClasses: async () => wait(db.classes),
    listMaterials: async () => wait(db.materials),

    async listItems(query: ItemQuery) {
      const q = query.q?.trim().toLowerCase();
      let rows = db.items.filter(canSeeItem).map(summarize);
      if (q) {
        rows = rows.filter(it =>
          [it.itemNo, it.name, it.nameKo ?? '', ...db.identifiers.filter(x => x.itemId === it.id).map(x => x.value)]
            .some(s => s.toLowerCase().includes(q)));
      }
      if (query.itemType) rows = rows.filter(it => it.itemType === query.itemType);
      if (query.status) rows = rows.filter(it => it.latestRevision?.status === query.status);
      if (query.productId) {
        const p = db.products.find(x => x.id === query.productId);
        const root = p && db.items.find(i => i.itemNo === p.rootItemNo);
        const inProduct = new Set<number>();
        if (root) {
          inProduct.add(root.id);
          const rr = effectiveRevision(root.id, 'released');
          const walk = (nodes: BomNode[]) => nodes.forEach(n => { inProduct.add(n.item.id); walk(n.children); });
          if (rr) walk(explode(rr.id, 'released', 1, 1, [root.id]));
        }
        rows = rows.filter(it => inProduct.has(it.id));
      }
      return wait(rows.sort((a, b) => a.itemNo.localeCompare(b.itemNo)));
    },

    async getItem(itemNo: string) {
      const it = findItem(itemNo);
      const usedBy = new Set(whereUsed(it.id).map(w => w.parent.itemNo).concat(it.itemNo));
      const detail: ItemDetail = {
        ...summarize(it),
        revisions: visibleRevisions(it.id).reverse(),
        identifiers: db.identifiers.filter(x => x.itemId === it.id).map(({ scheme, value }) => ({ scheme, value })),
        inventory: db.inventory.filter(x => x.itemId === it.id).map(({ itemId: _drop, ...row }) => row),
        products: db.products.filter(p => usedBy.has(p.rootItemNo)),
      };
      return wait(detail);
    },

    async getBom(revisionId: number, rule: BomRule) {
      const r = findRevision(revisionId);
      return wait(explode(r.id, rule, 1, 1, [r.itemId]));
    },

    async getWhereUsed(itemId: number) {
      const it = db.items.find(i => i.id === itemId);
      if (!it || !canSeeItem(it)) throw new ApiError('품목을 찾을 수 없습니다', 404);
      return wait(whereUsed(itemId));
    },

    async getDocuments(revisionId: number) {
      findRevision(revisionId);
      const rows: DocumentLink[] = db.docLinks.filter(l => l.revisionId === revisionId).map(l => {
        const d = db.documents.find(x => x.id === l.documentId)!;
        return {
          documentId: d.id, docNo: d.docNo, title: d.title, docType: d.docType, linkType: l.linkType, rev: d.rev,
          pinned: l.pinned, fileName: d.fileName, matchMethod: l.matchMethod, confidence: l.confidence, status: l.status,
        };
      });
      return wait(rows);
    },

    async getPassages(revisionId: number) {
      findRevision(revisionId);
      const rows: Passage[] = db.passages.filter(p => p.revisionId === revisionId).map(p => {
        const d = db.documents.find(x => x.id === p.documentId)!;
        const mate = p.mateItemNo ? db.items.find(i => i.itemNo === p.mateItemNo) : undefined;
        return {
          id: p.id, purpose: p.purpose, mateItemNo: p.mateItemNo, mateName: mate?.nameKo ?? mate?.name, docNo: d.docNo,
          docTitle: d.title, pageNo: p.pageNo, text: p.text, hitTerms: p.hitTerms, score: p.score, status: p.status,
          productScope: p.productScope,
        };
      });
      return wait(rows);
    },

    async listPartRequests(scope) {
      if (scope === 'all') requireAdmin();
      const rows = db.partRequests
        .filter(r => scope === 'all' || r.requestedBy === me().id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return wait(rows);
    },

    getPartRequest: async (id: number) => wait(findRequest(id)),

    async savePartRequest(id: number | null, payload: PartRequestPayload) {
      if (id === null) {
        const r: PartRequest = {
          id: Math.max(0, ...db.partRequests.map(x => x.id)) + 1, sourceSystem: 'PDM', status: 'draft', payload: clone(payload),
          requestedBy: me().id, createdAt: now(), updatedAt: now(),
        };
        db.partRequests.push(r);
        persist();
        return wait(r);
      }
      const r = findRequest(id);
      if (r.requestedBy !== me().id) throw new ApiError('다른 사람의 요청은 고칠 수 없습니다', 403);
      if (r.status !== 'draft') throw new ApiError('임시저장 상태에서만 고칠 수 있습니다', 409);
      r.payload = clone(payload);
      r.updatedAt = now();
      persist();
      return wait(r);
    },

    async submitPartRequest(id: number) {
      const r = findRequest(id);
      if (r.requestedBy !== me().id) throw new ApiError('다른 사람의 요청은 제출할 수 없습니다', 403);
      if (r.status !== 'draft') throw new ApiError('임시저장 상태에서만 제출할 수 있습니다', 409);
      if (!r.payload.name?.trim()) throw new ApiError('제출하려면 이름이 필요합니다', 400);
      r.status = 'submitted';
      r.duplicateCheck = duplicateCandidates(r.payload.name, (r.payload.aliases ?? []).map(a => a.value));
      r.updatedAt = now();
      persist();
      return wait(r);
    },

    async approvePartRequest(id: number, note?: string) {
      requireAdmin();
      const r = findRequest(id);
      if (r.status !== 'submitted') throw new ApiError('제출된 요청만 승인할 수 있습니다', 409);
      if (!r.payload.classIri) throw new ApiError('분류가 정해지지 않았습니다. 새 분류 제안이면 먼저 승인하세요', 400);
      const clash = (r.payload.aliases ?? []).find(a =>
        a.scheme !== 'cad_name' && db.identifiers.some(x => x.scheme === a.scheme && x.value === a.value));
      if (clash) throw new ApiError(`별칭 ${clash.value}(${clash.scheme})이(가) 이미 다른 품목에 있습니다`, 409);

      const itemNo = `P${String(db.nextItemNo).padStart(7, '0')}`;
      db.nextItemNo += 1;
      const itemId = Math.max(...db.items.map(i => i.id)) + 1;
      db.items.push({
        id: itemId, itemNo, name: r.payload.name!, nameKo: r.payload.nameKo, itemType: r.payload.itemType ?? 'part',
        unit: r.payload.unit ?? 'EA', classIri: r.payload.classIri, materialIri: r.payload.materialIri, attributes: {},
        createdBy: r.requestedBy,
      });
      (r.payload.aliases ?? []).forEach(a => db.identifiers.push({ itemId, ...a }));
      db.revisions.push({
        id: Math.max(...db.revisions.map(x => x.id)) + 1, itemId, rev: 'R00', revSeq: 0, status: 'wip',
        createdBy: r.requestedBy, createdAt: now(), changeNote: '신규 등록',
      });
      Object.assign(r, { status: 'approved', issuedItemNo: itemNo, reviewedBy: me().id, reviewNote: note, updatedAt: now() });
      persist();
      return wait(r);
    },

    async rejectPartRequest(id: number, note: string) {
      requireAdmin();
      const r = findRequest(id);
      if (r.status !== 'submitted') throw new ApiError('제출된 요청만 반려할 수 있습니다', 409);
      if (!note.trim()) throw new ApiError('반려 사유가 필요합니다', 400);
      Object.assign(r, { status: 'rejected', reviewedBy: me().id, reviewNote: note, updatedAt: now() });
      persist();
      return wait(r);
    },

    async listClassProposals() {
      requireAdmin();
      return wait([...db.classProposals].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    },

    async approveClassProposal(id: number, note?: string) {
      const p = findProposal(id);
      if (p.validation.some(v => v.severity === 'violation')) throw new ApiError('검사 위반이 있는 제안은 승인할 수 없습니다', 400);
      const parent = db.classes.find(c => c.iri === p.parentClassIri);
      if (!parent) throw new ApiError('상위 분류가 없습니다', 400);
      const prefix = parent.code.slice(0, 3);
      const used = db.classes.filter(c => c.code.startsWith(prefix)).map(c => Number(c.code.slice(3)));
      const code = `${prefix}${String(Math.max(...used) + 1).padStart(2, '0')}`;
      const iri = `cls:${code}`;
      db.classes.push({ iri, code, labelKo: p.labelKo, labelEn: p.labelEn, parentIri: parent.iri, kind: 'part' });
      Object.assign(p, { status: 'approved', approvedIri: iri, reviewNote: note });
      resolveWaitingRequests(p.id, iri);
      db.outbox.push({ id: Math.max(...db.outbox.map(o => o.id)) + 1, aggregate: 'class', target: `${iri} ${p.labelKo}`,
                       event: 'approved', createdAt: now(), attempts: 0 });
      persist();
      return wait(p);
    },

    async rejectClassProposal(id: number, note: string) {
      const p = findProposal(id);
      if (!note.trim()) throw new ApiError('거절 사유가 필요합니다', 400);
      Object.assign(p, { status: 'rejected', reviewNote: note });
      persist();
      return wait(p);
    },

    async mergeClassProposal(id: number, intoIri: string, note?: string) {
      const p = findProposal(id);
      if (!db.classes.some(c => c.iri === intoIri)) throw new ApiError('합칠 분류가 없습니다', 400);
      Object.assign(p, { status: 'merged', mergedIntoIri: intoIri, reviewNote: note });
      resolveWaitingRequests(p.id, intoIri);
      persist();
      return wait(p);
    },

    async listOutbox() {
      requireAdmin();
      return wait([...db.outbox].sort((a, b) => b.id - a.id));
    },
  };
  return api;
}
