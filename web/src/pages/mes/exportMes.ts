// MES 묶음을 파일로 내려받기 (클라이언트에서 Blob 으로 만든다. 네트워크 호출 없음). 형식은 docs/mes-handoff.md.
import type { MesPackage } from '../../api/types';

export const CSV_COLUMNS = ['seq', 'level', 'item_no', 'name', 'quantity', 'total_quantity', 'step', 'rule_ids'] as const;

/** 쉼표 · 따옴표 · 줄바꿈이 있으면 따옴표로 감싸고 안의 따옴표는 두 번 쓴다 */
export function csvCell(value: string | number | undefined): string {
  const s = value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 제조 BOM 표를 CSV 로. 맨 앞에 UTF-8 BOM(U+FEFF)을 붙여 엑셀에서 한글이 깨지지 않게 한다. 줄바꿈은 CRLF */
export function packageToCsv(pkg: MesPackage): string {
  const rows = pkg.bom.map(b => [b.seq, b.level, b.itemNo, b.name, b.quantity, b.totalQuantity, b.step, b.ruleIds.join(';')].map(csvCell).join(','));
  return `﻿${[CSV_COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}

export const packageToJson = (pkg: MesPackage): string => JSON.stringify(pkg, null, 2);

export const mesFileName = (pkg: Pick<MesPackage, 'productCode' | 'revision'>, ext: 'json' | 'csv') => `${pkg.productCode}_${pkg.revision}_mes.${ext}`;

/** 텍스트를 파일로 저장한다 (오브젝트 URL + 임시 <a download>, 바로 해제) */
export function downloadText(text: string, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
