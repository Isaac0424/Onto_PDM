// BOM 시트(csv · tsv) 본문 읽기 (순수 함수).
// 줄 번호(line)는 머리줄을 뺀 1부터이고, 빈 줄은 세지 않는다. 읽지 못한 줄은 건너뛰고 warnings 에 이유를 남긴다.
import type { BomSheet, BomSheetColumns } from './types';

interface Cell { v: string; quoted: boolean }

/** 구분자 자동 감지: 첫 줄(따옴표 밖)에서 가장 많이 나온 것. 같으면 탭 > 쉼표 > 세미콜론 */
export function detectDelimiter(text: string): string {
  let inQuote = false;
  const count: Record<string, number> = { '\t': 0, ',': 0, ';': 0 };
  for (const ch of text) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '\n') break;
    else if (!inQuote && ch in count) count[ch]!++;
  }
  const order = ['\t', ',', ';'];
  const best = order.reduce((a, b) => (count[b]! > count[a]! ? b : a), order[0]!);
  return count[best]! > 0 ? best : ',';
}

/** 따옴표("..."), 따옴표 안의 구분자 · 줄바꿈, 이중 따옴표(""), CRLF 를 처리하는 구분자 분리 */
export function parseDelimited(text: string, delimiter: string): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let cur = '';
  let quoted = false;
  let inQuote = false;
  const endCell = () => { row.push({ v: cur, quoted }); cur = ''; quoted = false; };
  const endRow = () => { endCell(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQuote = false;
      } else cur += ch;
    } else if (ch === '"') { inQuote = true; quoted = true; }
    else if (ch === delimiter) endCell();
    else if (ch === '\n') endRow();
    else if (ch === '\r') { if (text[i + 1] !== '\n') endRow(); }
    else cur += ch;
  }
  if (cur !== '' || quoted || row.length > 0) endRow();
  return rows;
}

const key = (s: string) => s.toLowerCase().replace(/[\s._\-()[\]'"’:/]+/g, '');

const HEADERS: Record<keyof BomSheetColumns, string[]> = {
  itemNo: ['품번', '품목코드', '품목번호', '자재코드', '자재번호', 'partno', 'partnumber', 'partnum', 'itemno', 'itemnumber', 'pn', 'partid'],
  name: ['품명', '이름', '품목명', '명칭', '자재명', '부품명', 'name', 'description', 'partname', 'itemname', 'desc'],
  quantity: ['수량', '개수', '소요량', 'qty', 'quantity', 'ea', 'qnty', 'qty'],
  findNo: ['도면번호', '번호', 'findno', 'find', 'no', 'item', 'pos', 'position', 'ref', '#'],
};
const FIELDS: (keyof BomSheetColumns)[] = ['itemNo', 'name', 'quantity', 'findNo'];

/** 첫 줄이 머리줄이면 열 위치를 돌려주고, 아니면 undefined */
function detectColumns(cells: Cell[]): BomSheetColumns | undefined {
  const cols: BomSheetColumns = {};
  const used = new Set<number>();
  for (const f of FIELDS) {
    const at = cells.findIndex((c, i) => !used.has(i) && HEADERS[f].includes(key(c.v)));
    if (at >= 0) { cols[f] = at; used.add(at); }
  }
  return Object.keys(cols).length >= 2 ? cols : undefined;
}

const normItemNo = (s: string) => s.toUpperCase().replace(/[\s_.\-]+/g, '');

function parseQuantity(cell: Cell): { value?: number; why?: string } {
  const raw = cell.v.trim();
  if (raw === '') return { why: '수량이 비어 있습니다' };
  const text = cell.quoted && /^\d+,\d+$/.test(raw) ? raw.replace(',', '.') : raw;          // 소수점 쉼표는 따옴표 안에서만
  const m = /^(\d+(?:\.\d+)?)\s*(?:ea|pcs|개)?$/i.exec(text);
  if (!m) return { why: `수량이 숫자가 아닙니다 ("${raw}")` };
  const n = Number(m[1]);
  if (!(n > 0)) return { why: `수량이 0 이하입니다 ("${raw}")` };
  return { value: n };
}

export function parseBom(text: string): BomSheet {
  const warnings: string[] = [];
  const clean = text.replace(/^﻿/, '');
  if (clean.trim() === '') return { rows: [], columns: {}, warnings: ['내용이 비어 있습니다'] };

  const table = parseDelimited(clean, detectDelimiter(clean)).filter(r => r.some(c => c.v.trim() !== ''));
  if (table.length === 0) return { rows: [], columns: {}, warnings: ['내용이 비어 있습니다'] };

  let columns = detectColumns(table[0]!);
  let data = table;
  if (columns) data = table.slice(1);
  else {
    columns = { itemNo: 0, name: 1, quantity: 2 };
    warnings.push('머리줄을 찾지 못해 (품번, 이름, 수량) 순서로 읽었습니다');
  }
  if (columns.quantity === undefined) {
    warnings.push('수량 열을 찾지 못했습니다. 수량이 없는 줄은 만들지 않아 모든 줄을 건너뜁니다');
    return { rows: [], columns, warnings };
  }

  const rows: BomSheet['rows'] = [];
  const firstLine = new Map<string, number>();
  data.forEach((cells, i) => {
    const line = i + 1;
    const at = (c: number | undefined) => (c === undefined ? '' : (cells[c]?.v ?? '').trim());
    const itemNo = at(columns!.itemNo);
    const name = at(columns!.name);
    if (!itemNo && !name) { warnings.push(`줄 ${line}: 품번과 이름이 모두 비어 있어 건너뜁니다`); return; }
    const qty = parseQuantity(cells[columns!.quantity!] ?? { v: '', quoted: false });
    if (qty.value === undefined) { warnings.push(`줄 ${line}: ${qty.why} — 건너뜁니다`); return; }

    let findNo: number | undefined;
    const rawFind = at(columns!.findNo);
    if (rawFind) {
      const n = Number(rawFind);
      if (Number.isInteger(n) && n >= 0) findNo = n;
      else warnings.push(`줄 ${line}: 도면 번호가 정수가 아닙니다 ("${rawFind}") — 번호 없이 읽습니다`);
    }
    if (itemNo) {
      const k = normItemNo(itemNo);
      const prev = firstLine.get(k);
      if (prev !== undefined) warnings.push(`줄 ${line}: 품번 ${itemNo}이(가) 줄 ${prev}와 겹칩니다 (합치지 않았습니다)`);
      else firstLine.set(k, line);
    }
    rows.push({ line, ...(itemNo ? { itemNo } : {}), ...(name ? { name } : {}), quantity: qty.value, ...(findNo !== undefined ? { findNo } : {}) });
  });
  return { rows, columns, warnings };
}
