import { describe, expect, it } from 'vitest';
import { parseBomSheet } from './index';
import { detectDelimiter, parseDelimited } from './bomSheet';

describe('구분자와 따옴표', () => {
  it('쉼표 · 탭 · 세미콜론을 자동으로 감지한다', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('단일 열')).toBe(',');
    expect(detectDelimiter('"a,b,c",x\n')).toBe(',');                      // 따옴표 안의 쉼표는 세지 않는다
  });

  it('따옴표 안의 쉼표 · 줄바꿈 · 이중 따옴표와 CRLF 를 읽는다', () => {
    const cells = parseDelimited('a,"b,c","d\ne",""""\r\nx,y,z\r\n', ',').map(r => r.map(c => c.v));
    expect(cells).toEqual([['a', 'b,c', 'd\ne', '"'], ['x', 'y', 'z']]);
  });

  it('서로 다른 구분자의 시트가 같은 결과를 낸다', () => {
    const rows = (t: string) => parseBomSheet(t).rows;
    const csv = rows('품번,품명,수량\nP-1,볼트,4\nP-2,너트,2');
    expect(rows('품번\t품명\t수량\nP-1\t볼트\t4\nP-2\t너트\t2')).toEqual(csv);
    expect(rows('품번;품명;수량\nP-1;볼트;4\nP-2;너트;2')).toEqual(csv);
    expect(csv).toEqual([
      { line: 1, itemNo: 'P-1', name: '볼트', quantity: 4 },
      { line: 2, itemNo: 'P-2', name: '너트', quantity: 2 },
    ]);
  });
});

describe('머리줄 감지', () => {
  it('한글 머리줄: 열 순서가 달라도 찾는다', () => {
    const s = parseBomSheet('수량,도면번호,품명,품번\n4,1,볼트 M3x8,P-00000000001\n1,2,하우징,P-00000000111');
    expect(s.columns).toEqual({ quantity: 0, findNo: 1, name: 2, itemNo: 3 });
    expect(s.rows[0]).toEqual({ line: 1, itemNo: 'P-00000000001', name: '볼트 M3x8', quantity: 4, findNo: 1 });
    expect(s.warnings).toEqual([]);
  });

  it('영문 머리줄: Part No · Description · Qty · Find No', () => {
    const s = parseBomSheet('Find No,Part No,Description,Qty\n1,P-1,Bolt,4');
    expect(s.columns).toEqual({ findNo: 0, itemNo: 1, name: 2, quantity: 3 });
    expect(s.rows).toEqual([{ line: 1, itemNo: 'P-1', name: 'Bolt', quantity: 4, findNo: 1 }]);
    expect(parseBomSheet('P/N,Name,Quantity\nP-1,Bolt,4').columns).toEqual({ itemNo: 0, name: 1, quantity: 2 });
    expect(parseBomSheet('Item No,Name,EA\nP-1,Bolt,4').columns).toEqual({ itemNo: 0, name: 1, quantity: 2 });     // Item No 는 품번
  });

  it('머리줄이 없으면 (품번, 이름, 수량) 순서로 읽고 알린다', () => {
    const s = parseBomSheet('P-1,볼트,4\nP-2,너트,2');
    expect(s.rows.map(r => r.itemNo)).toEqual(['P-1', 'P-2']);
    expect(s.warnings).toEqual(['머리줄을 찾지 못해 (품번, 이름, 수량) 순서로 읽었습니다']);
  });

  it('수량 열이 없으면 수량을 지어내지 않고 모두 건너뛴다', () => {
    const s = parseBomSheet('품번,품명\nP-1,볼트');
    expect(s.rows).toEqual([]);
    expect(s.warnings[0]).toContain('수량 열을 찾지 못했습니다');
  });

  it('UTF-8 BOM, 빈 줄, 빈 내용', () => {
    expect(parseBomSheet('﻿품번,품명,수량\n\nP-1,볼트,4\n\n').rows).toEqual([{ line: 1, itemNo: 'P-1', name: '볼트', quantity: 4 }]);
    expect(parseBomSheet('')).toEqual({ rows: [], columns: {}, warnings: ['내용이 비어 있습니다'] });
    expect(parseBomSheet('   \n\n').rows).toEqual([]);
  });
});

describe('수량과 이상한 줄', () => {
  const text = '품번,품명,수량\nP-1,볼트,4\nP-2,너트,abc\nP-3,와셔,0\nP-4,스프링,-2\n,,3\nP-6,핀,"1,5"\nP-7,캡,2 EA\nP-8,링,';

  it('숫자가 아니거나 0 이하인 수량은 줄을 건너뛰고 이유를 남긴다', () => {
    const s = parseBomSheet(text);
    expect(s.rows.map(r => r.itemNo)).toEqual(['P-1', 'P-6', 'P-7']);
    expect(s.warnings).toEqual([
      '줄 2: 수량이 숫자가 아닙니다 ("abc") — 건너뜁니다',
      '줄 3: 수량이 0 이하입니다 ("0") — 건너뜁니다',
      '줄 4: 수량이 숫자가 아닙니다 ("-2") — 건너뜁니다',
      '줄 5: 품번과 이름이 모두 비어 있어 건너뜁니다',
      '줄 8: 수량이 비어 있습니다 — 건너뜁니다',
    ]);
  });

  it('소수점 쉼표는 따옴표 안에서만 소수로 본다, 단위 글자(EA)는 떼어 낸다', () => {
    const s = parseBomSheet(text);
    expect(s.rows.find(r => r.itemNo === 'P-6')!.quantity).toBe(1.5);
    expect(s.rows.find(r => r.itemNo === 'P-7')!.quantity).toBe(2);
    expect(parseBomSheet('품번,품명,수량\nP-1,볼트,1.5').rows[0]!.quantity).toBe(1.5);
    expect(parseBomSheet('품번;품명;수량\nP-1;볼트;1,5').rows).toEqual([]);              // 따옴표 없는 쉼표는 소수로 보지 않는다
  });

  it('줄 번호는 머리줄과 빈 줄을 세지 않는다', () => {
    const s = parseBomSheet('품번,품명,수량\n\nP-1,볼트,4\n\nP-2,너트,2');
    expect(s.rows.map(r => r.line)).toEqual([1, 2]);
  });

  it('도면 번호가 정수가 아니면 번호 없이 읽고 알린다', () => {
    const s = parseBomSheet('품번,수량,도면번호\nP-1,4,A\nP-2,2,7');
    expect(s.rows[0]).toEqual({ line: 1, itemNo: 'P-1', quantity: 4 });
    expect(s.rows[1]!.findNo).toBe(7);
    expect(s.warnings).toEqual(['줄 1: 도면 번호가 정수가 아닙니다 ("A") — 번호 없이 읽습니다']);
  });
});

describe('중복 품번', () => {
  it('같은 품번이 두 번 나오면 알리되 합치지는 않는다 (대소문자 · 하이픈 무시)', () => {
    const s = parseBomSheet('품번,품명,수량\nP-00000000001,볼트,4\np00000000001,볼트,2\nP-2,너트,1');
    expect(s.rows).toHaveLength(3);
    expect(s.rows.map(r => r.quantity)).toEqual([4, 2, 1]);
    expect(s.warnings).toEqual(['줄 2: 품번 p00000000001이(가) 줄 1와 겹칩니다 (합치지 않았습니다)']);
  });

  it('품번 없이 이름만 있는 줄도 읽는다', () => {
    expect(parseBomSheet('품명,수량\n볼트,4').rows).toEqual([{ line: 1, name: '볼트', quantity: 4 }]);
  });
});
