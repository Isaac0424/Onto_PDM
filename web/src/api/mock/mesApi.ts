// MES 발행 목 구현: 제품의 제조 BOM + 작업표준 묶음을 만들고, 발행 기록을 남긴다 (docs/mes-handoff.md).
// 공개 API(MesSource)로만 데이터를 읽는다. 공개 범위(남의 작업중 리비전은 보이지 않음)는 getItem · getBom 이 이미 따르므로 여기서 따로 검사하지 않는다.
import {
  ApiError,
  type AssemblyGuide, type BomNode, type BomRule, type DocumentLink, type ItemDetail, type MesBomLine, type MesPackage,
  type MesPublication, type MesWorkStep, type PdmApi, type Revision,
} from '../types';

export type MesSource = Pick<PdmApi, 'listProducts' | 'getItem' | 'getBom' | 'getAssemblyGuides' | 'getDocuments'>;

const nameOf = (n: { nameKo?: string; name: string }) => n.nameKo ?? n.name;
const STATUS_TEXT: Record<Revision['status'], string> = { wip: '작업중', in_review: '검토중', released: '승인', obsolete: '폐기' };
const dedupe = <T,>(xs: T[], key: (x: T) => string) => { const seen = new Set<string>(); return xs.filter(x => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

/** BOM 기준에 맞는 최상위 조립품 리비전. 승인본 기준인데 승인본이 없으면 409 */
function pickRevision(root: ItemDetail, rule: BomRule): Revision {
  if (rule === 'released') {
    if (!root.releasedRevision) throw new ApiError('승인된 리비전이 없습니다', 409);
    return root.releasedRevision;
  }
  const live = root.revisions.filter(r => r.status !== 'obsolete');          // revisions 는 최신이 앞이다
  const rev = live[0] ?? root.latestRevision;
  if (!rev) throw new ApiError('사용할 수 있는 리비전이 없습니다', 409);
  return rev;
}

/** 작업 단계로 보는 노드(자식이 있는 조립품)와 그 자식 */
interface Walk { node: BomNode; level: number; parent?: BomNode }

export async function buildPackage(api: MesSource, productCode: string, rule: BomRule): Promise<MesPackage> {
  const product = (await api.listProducts()).find(p => p.code === productCode);
  if (!product) throw new ApiError(`제품 ${productCode}을(를) 찾을 수 없습니다`, 404);
  const root = await api.getItem(product.rootItemNo);
  const revision = pickRevision(root, rule);
  const children = await api.getBom(revision.id, rule);
  // 최상위 조립품을 BOM 의 뿌리(level 0)로 둔다
  const rootNode: BomNode = { lineId: 0, depth: 0, quantity: 1, totalQuantity: 1, item: root, revision, children };

  // 깊이 우선 순서로 줄을 만든다. 같은 품목이 여러 곳에 쓰이면 줄은 위치마다 따로 둔다.
  const walks: Walk[] = [];
  const visit = (node: BomNode, level: number, parent?: BomNode) => {
    walks.push({ node, level, ...(parent ? { parent } : {}) });
    node.children.forEach(c => visit(c, level + 1, node));
  };
  visit(rootNode, 0);

  // 조립 규칙: 이름으로 한 번에 묻는다
  const names = [...new Set(walks.map(w => nameOf(w.node.item)))];
  const guides = new Map<string, AssemblyGuide[]>();
  (await api.getAssemblyGuides(names.map(name => ({ name })))).forEach(g => guides.set(g.partName, [...(guides.get(g.partName) ?? []), g]));
  const guidesOf = (n: BomNode) => guides.get(nameOf(n.item)) ?? [];

  // 작업 단계: 하위 조립품부터 (깊이 우선 후위 순회). 같은 조립품은 한 번만.
  const steps: MesWorkStep[] = [];
  const stepOf = new Map<string, number>();
  const post = (node: BomNode) => {
    node.children.forEach(post);
    if (node.children.length === 0 || stepOf.has(node.item.itemNo)) return;
    const gs = dedupe(node.children.flatMap(guidesOf), g => g.ruleId);
    const step = steps.length + 1;
    stepOf.set(node.item.itemNo, step);
    steps.push({
      step, title: `${nameOf(node.item)} 조립`,
      ...(gs[0] ? { operationLabel: gs[0].operationLabel } : {}),
      parts: node.children.map(c => ({ itemNo: c.item.itemNo, name: nameOf(c.item), quantity: c.quantity })),
      ruleIds: gs.map(g => g.ruleId),
      params: dedupe(gs.flatMap(g => g.params.map(({ label, value }) => ({ label, value }))), p => `${p.label}\u0001${p.value}`),
      cautions: [...new Set(gs.flatMap(g => g.cautions))],
      tools: [...new Set(gs.flatMap(g => g.tools))],
    });
  };
  post(rootNode);

  const bom: MesBomLine[] = walks.map(({ node, level, parent }, i) => {
    // 조립품은 자기를 조립하는 단계, 부품은 그것이 들어가는 부모 조립품의 단계
    const step = node.children.length > 0 ? stepOf.get(node.item.itemNo) : parent ? stepOf.get(parent.item.itemNo) : undefined;
    return {
      seq: i + 1, level, itemNo: node.item.itemNo, name: nameOf(node.item), quantity: node.quantity, totalQuantity: node.totalQuantity,
      ...(step !== undefined ? { step } : {}), ruleIds: guidesOf(node).map(g => g.ruleId),
    };
  });

  // 문서: 품목마다 리비전에 연결된 문서를 모아 중복을 없앤다 (거절된 연결은 뺀다)
  const withRevision = dedupe(walks.filter(w => w.node.revision), w => w.node.item.itemNo);
  const docsByItem = await Promise.all(withRevision.map(async w => ({
    itemNo: w.node.item.itemNo, links: await api.getDocuments(w.node.revision!.id).catch(() => [] as DocumentLink[]),
  })));
  const documents = dedupe(
    docsByItem.flatMap(d => d.links).filter(l => l.status !== 'rejected').map(l => ({ docNo: l.docNo, title: l.title, docType: l.docType, rev: l.rev })),
    d => d.docNo,
  ).sort((a, b) => a.docNo.localeCompare(b.docNo));
  const rootDocs = docsByItem.find(d => d.itemNo === root.itemNo)?.links.filter(l => l.status !== 'rejected') ?? [];

  // 발행 전에 사람이 확인할 것
  const items = withRevision.map(w => w.node);
  const unapproved = items.filter(n => n.revision!.status === 'wip' || n.revision!.status === 'in_review');
  const noRevision = dedupe(walks.filter(w => !w.node.revision), w => w.node.item.itemNo);
  const obsolete = items.filter(n => n.revision!.status === 'obsolete');
  const warnings: string[] = [];
  if (rule === 'latest' && unapproved.length > 0) warnings.push('BOM 기준이 \'최신\'이라 작업중 · 검토중 리비전이 들어 있습니다. 승인 전에는 MES로 발행할 수 없습니다.');
  if (unapproved.length + noRevision.length > 0) {
    warnings.push(`승인되지 않은 품목: ${[
      ...unapproved.map(n => `${nameOf(n.item)} (${n.revision!.rev} ${STATUS_TEXT[n.revision!.status]})`),
      ...noRevision.map(w => `${nameOf(w.node.item)} (승인 리비전 없음)`),
    ].join(', ')}`);
  }
  if (obsolete.length > 0) warnings.push(`폐기된 리비전이 들어 있습니다: ${obsolete.map(n => `${nameOf(n.item)} (${n.revision!.rev})`).join(', ')}`);
  const noRule = steps.filter(s => s.ruleIds.length === 0);
  if (noRule.length > 0) warnings.push(`조립 규칙이 없는 작업 단계 ${noRule.length}개: ${noRule.map(s => s.title).join(', ')}`);
  if (rootDocs.length === 0) warnings.push('최상위 조립품에 연결된 문서가 없습니다.');

  return {
    productCode: product.code, productName: product.name, rootItemNo: root.itemNo, revision: revision.rev, rule,
    generatedAt: new Date().toISOString(), bom, steps, documents, warnings,
  };
}

export function createMesStore() {
  const publications: MesPublication[] = [];
  let seq = 0;
  return {
    buildPackage,

    async list(): Promise<MesPublication[]> { return [...publications].sort((a, b) => b.id - a.id); },

    /** 묶음을 만들어 발행 기록을 남긴다. 실제 전송은 없다(목). 승인본만 · 같은 리비전은 한 번만 */
    async publish(api: MesSource, productCode: string, rule: BomRule): Promise<MesPublication> {
      const pkg = await buildPackage(api, productCode, rule);
      // 승인되지 않은 리비전이 하나라도 있으면 발행하지 않는다 (경고의 첫 줄이 이유다)
      const pending = pkg.warnings.find(w => w.startsWith('승인되지 않은 품목'));
      if (pending) throw new ApiError(`${pending}. 승인된 리비전만 MES로 발행할 수 있습니다.`, 409);
      if (publications.some(p => p.productCode === productCode && p.revision === pkg.revision && p.rule === rule && p.status === 'sent')) {
        throw new ApiError('이미 발행한 리비전입니다', 409);
      }
      const now = new Date().toISOString();
      const pub: MesPublication = {
        id: ++seq, productCode, revision: pkg.revision, rule, status: 'sent', createdAt: now, sentAt: now,
        bomLines: pkg.bom.length, steps: pkg.steps.length,
      };
      publications.push(pub);
      return pub;
    },
  };
}
