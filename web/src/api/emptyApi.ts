// 비어 있는 API: 백엔드 · OPMS 가 연결되기 전의 구현. 가짜 데이터를 만들지 않고 "없음"을 돌려준다.
// 화면은 connected=false 를 보고 "OPMS 에 연결되면 표시돼요"라고 말한다. 연결되면 같은 PdmApi 를 HTTP 로 구현해 createApi() 에서 바꿔 끼운다.
import { ApiError, type PdmApi } from './types';

export function createEmptyApi(): PdmApi {
  const none = <T,>(v: T): Promise<T> => Promise.resolve(v);
  const notConnected = async (): Promise<never> => { throw new ApiError('PDM 백엔드에 연결되면 쓸 수 있어요.', 503); };
  return {
    connected: false,
    listProducts: () => none([]),
    listClasses: () => none([]),
    listMaterials: () => none([]),

    listItems: () => none([]),
    getItem: async itemNo => { throw new ApiError(`품목 ${itemNo}을(를) 찾을 수 없습니다`, 404); },
    getBom: () => none([]),
    getWhereUsed: () => none([]),
    getDocuments: () => none([]),
    getPassages: () => none([]),

    // 보유 품번이 없으니 모든 부품이 '매칭 없음'이다 (이름도 분류도 지어내지 않는다)
    matchCadParts: names => none(names.map(name => ({ name, status: 'none' as const }))),
    getAssemblyGuides: () => none([]),
    listAssemblyRules: () => none([]),
    getAssemblyRule: async () => { throw new ApiError('규칙을 찾을 수 없습니다', 404); },

    buildMesPackage: async productCode => { throw new ApiError(`제품 ${productCode}을(를) 찾을 수 없습니다`, 404); },

    // 설계 변경: 읽어 올 곳이 없으면 가짜 변경 건을 만들지 않고 비어 있다. 쓰는 일은 거절한다
    changesAvailable: () => none(false),
    listChanges: () => none({ items: [], total: 0, page: 1, size: 25 }),
    getChange: () => none(null),
    createChange: notConnected,
    addChangeTarget: notConnected,
    removeChangeTarget: notConnected,
    setChangeScope: notConnected,
    getImpact: () => none(null),
    recomputeImpact: notConnected,
    getImpactGraph: () => none({ nodes: [], edges: [] }),
    setDisposition: notConnected,
    submitReview: notConnected,
    acceptChange: notConnected,
    submitChange: notConnected,
    approveChange: notConnected,
    rejectChange: notConnected,
    getOntologyImpact: () => none(null),
  };
}
