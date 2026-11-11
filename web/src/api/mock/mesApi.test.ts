import { describe, expect, it } from 'vitest';
import { createMesStore } from './mesApi';
import { createMockApi, type Session } from './mockApi';

function setup(initial: Session = { userId: 1, adminMode: true }) {
  const session = { ...initial };
  return { api: createMockApi(() => session), session };
}

describe('MES 묶음 만들기 (승인본 기준)', () => {
  it('최상위 조립품이 level 0 으로 앞에 오고, 아래는 깊이 우선 순서로 줄이 이어진다', async () => {
    const { api } = setup();
    const pkg = await api.buildMesPackage('HCR3A', 'released');
    expect(pkg).toMatchObject({ productCode: 'HCR3A', rootItemNo: 'P-00000000100', revision: 'R01', rule: 'released' });
    expect(pkg.bom).toHaveLength(18);
    expect(pkg.bom.map(b => b.seq)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(pkg.bom[0]).toMatchObject({ seq: 1, level: 0, itemNo: 'P-00000000100', quantity: 1, totalQuantity: 1 });
    // 조립품 바로 아래에 그 부품들이 온다: 베이스 조립품(L1) → 하우징 · 커버 · 볼트(L2)
    expect(pkg.bom.slice(1, 5).map(b => [b.level, b.itemNo])).toEqual([
      [1, 'P-00000000110'], [2, 'P-00000000111'], [2, 'P-00000000112'], [2, 'P-00000000002'],
    ]);
  });

  it('같은 품목이 여러 곳에 쓰이면 줄은 위치마다 따로 두고, 수량은 최상위 1개당으로 센다 (볼트 M3x8: J1 12 + J2 12)', async () => {
    const { api } = setup();
    const bolts = (await api.buildMesPackage('HCR3A', 'released')).bom.filter(b => b.itemNo === 'P-00000000001');
    expect(bolts).toHaveLength(2);
    expect(bolts.map(b => b.quantity)).toEqual([12, 12]);
    expect(bolts.map(b => b.totalQuantity)).toEqual([12, 12]);
    expect(bolts.reduce((s, b) => s + b.totalQuantity, 0)).toBe(24);
  });

  it('작업 단계는 하위 조립품부터이고, 조립품마다 한 단계다', async () => {
    const { api } = setup();
    const pkg = await api.buildMesPackage('HCR3A', 'released');
    expect(pkg.steps.map(s => s.title)).toEqual(['베이스 조립품 조립', 'J1 관절 모듈 조립', 'J2 관절 모듈 조립', 'HCR3A 본체 조립']);
    expect(pkg.steps.map(s => s.step)).toEqual([1, 2, 3, 4]);
    // 하위 조립품의 단계 번호는 항상 그것을 쓰는 상위 조립품의 단계 번호보다 작다
    const assemblies = ['P-00000000110', 'P-00000000120', 'P-00000000130'];
    const stepOf = pkg.bom.filter(x => assemblies.includes(x.itemNo)).map(x => x.step!);
    expect(stepOf).toEqual([1, 2, 3]);
    expect(stepOf.every(s => s < pkg.bom[0]!.step!)).toBe(true);
    // 단계의 부품은 그 조립품의 직접 자식과 부모 1개당 수량
    expect(pkg.steps[1]!.parts).toContainEqual({ itemNo: 'P-00000000001', name: '볼트 M3x8', quantity: 12 });
    expect(pkg.steps[3]!.parts.map(p => p.itemNo)).toEqual(['P-00000000110', 'P-00000000120', 'P-00000000130', 'P-00000000140']);
  });

  it('줄의 단계: 조립품은 자기를 조립하는 단계, 부품은 들어가는 조립품의 단계', async () => {
    const { api } = setup();
    const bom = (await api.buildMesPackage('HCR3A', 'released')).bom;
    const by = (no: string, level: number) => bom.find(b => b.itemNo === no && b.level === level)!;
    expect(by('P-00000000100', 0).step).toBe(4);
    expect(by('P-00000000120', 1).step).toBe(2);      // J1 관절 모듈 = 단계 2
    expect(by('P-00000000121', 2).step).toBe(2);      // 그 감속기는 단계 2 에서 들어간다
    expect(by('P-00000000131', 2).step).toBe(3);      // J2 감속기는 단계 3
  });

  it('규칙은 단계마다 합쳐 중복을 없앤다 (같은 규칙이 여러 부품에 걸려도 한 번)', async () => {
    const { api } = setup();
    const pkg = await api.buildMesPackage('HCR3A', 'released');
    const j1 = pkg.steps[1]!;
    expect(j1.ruleIds).toEqual(['SP-RED-01', 'SP-MOT-01', 'SP-HSG-01', 'SP-FAS-01']);       // 감속기 · 모터 · 하우징 · 볼트
    expect(new Set(j1.ruleIds).size).toBe(j1.ruleIds.length);
    expect(j1.operationLabel).toBe('장착');                                                // 첫 규칙(감속기 장착)의 공정
    expect(new Set(j1.cautions).size).toBe(j1.cautions.length);
    expect(j1.tools).toContain('토크 드라이버');
    expect(j1.params).toContainEqual({ label: '체결 토크', value: '0.6 N·m ±10%' });
    // 줄에도 그 품목에 걸린 규칙이 붙는다. 규칙이 없는 부품은 빈 배열
    const bom = pkg.bom;
    expect(bom.find(b => b.itemNo === 'P-00000000121')!.ruleIds).toEqual(['SP-RED-01']);
    expect(bom.find(b => b.itemNo === 'P-00000000123')!.ruleIds).toEqual([]);
  });

  it('문서는 모든 품목의 연결을 모아 문서 번호로 중복을 없앤다', async () => {
    const { api } = setup();
    const docs = (await api.buildMesPackage('HCR3A', 'released')).documents;
    expect(docs.map(d => d.docNo)).toEqual(['D-CAD-0100', 'D-CAD-0120', 'D-DRW-0124', 'D-MAN-HCR3A', 'D-SPEC-HCR']);
    expect(docs.find(d => d.docNo === 'D-CAD-0100')).toMatchObject({ docType: 'cad_3d', rev: 'R01' });
  });

  it('승인본 기준에서는 승인 전 품목 경고가 없고, 규칙이 없는 단계만 알린다', async () => {
    const { api } = setup();
    const pkg = await api.buildMesPackage('HCR3A', 'released');
    expect(pkg.warnings).toEqual(['조립 규칙이 없는 작업 단계 1개: HCR3A 본체 조립']);
  });
});

describe('MES 묶음: 최신 기준', () => {
  it('작업중 · 검토중 리비전이 들어오면 경고하고, 그 품목을 이름으로 알려 준다 (관리자 모드)', async () => {
    const { api } = setup();
    const pkg = await api.buildMesPackage('HCR3A', 'latest');
    expect(pkg.revision).toBe('R02');
    expect(pkg.bom).toHaveLength(19);                                                        // J1 브레이크가 더해졌다
    expect(pkg.bom.some(b => b.itemNo === 'P-00000000150')).toBe(true);
    expect(pkg.warnings[0]).toContain('최신');
    expect(pkg.warnings.find(w => w.startsWith('승인되지 않은 품목'))).toBe('승인되지 않은 품목: HCR3A 본체 (R02 작업중), 베이스 커버 (R01 검토중), J1 브레이크 (R00 작업중)');
    expect(pkg.warnings).toContain('최상위 조립품에 연결된 문서가 없습니다.');              // R02 에는 문서가 아직 없다
  });

  it('관리자 모드가 아니면 남의 작업중 리비전이 안 보이므로 승인본과 같다 (공개 범위)', async () => {
    const { api } = setup({ userId: 1, adminMode: false });
    const pkg = await api.buildMesPackage('HCR3A', 'latest');
    expect(pkg.revision).toBe('R01');
    expect(pkg.bom).toHaveLength(18);
    expect(pkg.warnings.some(w => w.startsWith('승인되지 않은 품목'))).toBe(false);
  });
});

describe('오류', () => {
  it('없는 제품은 404', async () => {
    const { api } = setup();
    await expect(api.buildMesPackage('NOPE', 'released')).rejects.toMatchObject({ status: 404 });
  });

  it('승인본이 없는 제품은 승인본 기준에서 409, 최신 기준에서는 만들어진다', async () => {
    const { api } = setup();
    // 목 데이터에는 승인본 없는 제품이 없어서, 최상위 조립품이 작업중뿐인 품목(P-00000000150)을 가진 제품을 끼워 넣는다
    const source = { ...api, listProducts: async () => [{ id: 99, code: 'NEW', name: '신규 제품', rootItemNo: 'P-00000000150' }] };
    const store = createMesStore();
    await expect(store.buildPackage(source, 'NEW', 'released')).rejects.toMatchObject({ status: 409, message: '승인된 리비전이 없습니다' });
    const latest = await store.buildPackage(source, 'NEW', 'latest');
    expect(latest.revision).toBe('R00');
    expect(latest.bom).toHaveLength(1);
    expect(latest.steps).toEqual([]);                                                        // 자식이 없으면 작업 단계도 없다
  });
});

describe('MES 발행', () => {
  it('발행하면 이력이 남고 최신이 앞에 온다', async () => {
    const { api } = setup();
    expect(await api.listMesPublications()).toEqual([]);
    const a = await api.publishMes('HCR3A', 'released');
    expect(a).toMatchObject({ id: 1, productCode: 'HCR3A', revision: 'R01', rule: 'released', status: 'sent', bomLines: 18, steps: 4 });
    expect(a.sentAt).toBe(a.createdAt);
    const b = await api.publishMes('HCR5A', 'released');
    expect(b).toMatchObject({ id: 2, productCode: 'HCR5A', revision: 'R00' });
    expect((await api.listMesPublications()).map(p => p.id)).toEqual([2, 1]);
  });

  it('같은 리비전을 같은 기준으로 다시 발행하면 409', async () => {
    const { api } = setup();
    await api.publishMes('HCR3A', 'released');
    await expect(api.publishMes('HCR3A', 'released')).rejects.toMatchObject({ status: 409, message: '이미 발행한 리비전입니다' });
    expect(await api.listMesPublications()).toHaveLength(1);
  });

  it('승인되지 않은 리비전이 들어 있으면 발행하지 않는다 (승인본만 발행)', async () => {
    const { api } = setup();
    await expect(api.publishMes('HCR3A', 'latest')).rejects.toMatchObject({ status: 409 });
    await expect(api.publishMes('HCR3A', 'latest')).rejects.toThrow('승인된 리비전만 MES로 발행할 수 있습니다');
    expect(await api.listMesPublications()).toEqual([]);
  });

  it('발행 이력은 mock 마다 따로다', async () => {
    const one = setup().api, two = setup().api;
    await one.publishMes('HCR3A', 'released');
    expect(await two.listMesPublications()).toEqual([]);
  });
});
