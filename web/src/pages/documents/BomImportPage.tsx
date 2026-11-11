import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import type { BomSheetMatch } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { parseBomSheet, type BomSheet } from '../../extract';
import { useSession } from '../../session';
import '../studio/studio.css';
import './bom-import.css';

const SAMPLE = `품번,품명,수량,도면번호
P-00000000001,볼트 M3x8,12,1
P-00000000121,J1 감속기,1,2
,전원 버튼,1,3
SUP-X-100,방열판 20x20,2,4
`;

const COLUMN_LABEL = { itemNo: '품번', name: '이름', quantity: '수량', findNo: '도면 번호' } as const;
type ColumnKey = keyof typeof COLUMN_LABEL;

/** 파일 본문을 글자로 읽는다 (File.text 가 없는 환경은 FileReader). 서버로 보내지 않는다 */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

const STATUS_TEXT = { matched: '보유', suggested: '후보', none: '미보유' } as const;
const STATUS_CLASS = { matched: 'chip-ok', suggested: 'chip-maybe', none: 'chip-none' } as const;

/**
 * BOM 시트(csv · tsv) 가져오기: 시트의 줄마다 우리가 보유한 품번과 맞춰 보고, 없는 부품은 OPMS 등록 요청으로 보낸다.
 * 파일은 이 브라우저 안에서만 읽는다 (서버로 보내지 않는다). 후보는 사람이 확정해야 보유로 바뀐다.
 */
export function BomImportPage() {
  const { api, bump } = useSession();
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string>();
  const [sheet, setSheet] = useState<BomSheet | null>(null);
  const [matches, setMatches] = useState<Map<number, BomSheetMatch>>(new Map());
  const [confirmed, setConfirmed] = useState<Set<number>>(new Set());
  const [requested, setRequested] = useState<Map<number, number>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const analyze = useCallback(async (body: string, name?: string) => {
    setError(undefined); setNotice(undefined);
    setConfirmed(new Set()); setRequested(new Map()); setMatches(new Map());
    setFileName(name);
    if (!body.trim()) { setSheet(null); setError('내용이 비어 있어요. BOM 시트(csv)를 올리거나 붙여넣어 주세요.'); return; }
    const parsed = parseBomSheet(body);
    setSheet(parsed);
    if (parsed.rows.length === 0) {
      setError(Object.keys(parsed.columns).length === 0
        ? '머리줄에서 품번 · 이름 · 수량 열을 찾지 못했어요. 첫 줄에 "품번,품명,수량" 같은 머리줄이 있는지 확인해 주세요.'
        : '읽을 수 있는 줄이 없어요. 첫 줄에 "품번,품명,수량" 같은 머리줄이 있는지, 수량 칸이 숫자인지 확인해 주세요.');
      return;
    }
    setBusy(true);
    try {
      const rows = await api.matchBomSheet(parsed.rows.map(r => ({
        line: r.line, quantity: r.quantity,
        ...(r.itemNo ? { itemNo: r.itemNo } : {}), ...(r.name ? { name: r.name } : {}), ...(r.findNo !== undefined ? { findNo: r.findNo } : {}),
      })));
      setMatches(new Map(rows.map(m => [m.line, m])));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }, [api]);

  const loadFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    const body = await readText(file);
    setText(body);
    await analyze(body, file.name);
  }, [analyze]);

  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); void loadFile(e.dataTransfer.files?.[0]); };

  const statusOf = (line: number): BomSheetMatch['status'] => (confirmed.has(line) ? 'matched' : (matches.get(line)?.status ?? 'none'));
  const rows = sheet?.rows ?? [];
  const count = useMemo(() => {
    const c = { matched: 0, suggested: 0, none: 0 };
    rows.forEach(r => { if (matches.has(r.line)) c[statusOf(r.line)] += 1; });
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, matches, confirmed]);
  const pending = rows.filter(r => matches.has(r.line) && statusOf(r.line) === 'none' && !requested.has(r.line));

  const request = useCallback(async (line: number) => {
    const r = sheet?.rows.find(x => x.line === line);
    if (!r) return;
    const name = r.name ?? r.itemNo ?? `BOM 줄 ${line}`;
    const created = await api.savePartRequest(null, {
      name, itemType: 'part', unit: 'EA',
      ...(r.itemNo ? { aliases: [{ scheme: 'legacy' as const, value: r.itemNo }] } : { aliases: [] }),
      note: `BOM 시트 · 줄 ${line}${fileName ? ` · ${fileName}` : ''}`,
    });
    const sent = await api.submitPartRequest(created.id);
    setRequested(prev => new Map(prev).set(line, sent.id));
    bump();
  }, [api, bump, fileName, sheet]);

  const requestAll = async () => {
    const todo = [...pending];
    for (const r of todo) await request(r.line);
    setNotice(`${todo.length}줄을 OPMS 등록 요청으로 보냈습니다. 내 등록 요청에서 처리 상태를 볼 수 있습니다.`);
  };

  const detected = (Object.keys(COLUMN_LABEL) as ColumnKey[]).filter(k => sheet?.columns[k] !== undefined);
  const missing = (['itemNo', 'name', 'quantity'] as ColumnKey[]).filter(k => sheet && sheet.columns[k] === undefined);

  return (
    <div className="bom-page">
      <div className="holo-backdrop" aria-hidden />
      <div className="page-head">
        <div>
          <p className="holo-eyebrow">BOM · 보유 품번 매칭</p>
          <h1>BOM 가져오기</h1>
          <p className="sub">BOM 시트(csv)의 줄마다 우리가 보유한 품번과 맞춰 봅니다. 없는 부품은 OPMS에 등록을 요청할 수 있습니다. 파일은 이 브라우저 안에서만 읽습니다.</p>
        </div>
      </div>

      <section className="glass-panel bom-input" aria-label="BOM 입력">
        <header className="panel-head"><div><h2>시트 올리기</h2><p className="panel-sub">csv · tsv · 텍스트. 첫 줄은 머리줄(품번, 품명, 수량, 도면번호)입니다</p></div></header>
        <div className="bom-input-body">
          <label className={`bom-drop ${drag ? 'bom-drop-on' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
            <Icon name="upload_file" size={28} />
            <span><b>파일을 끌어 놓거나 눌러서 고르세요</b><small>{fileName ?? '아직 고른 파일이 없습니다'}</small></span>
            <input ref={fileInput} type="file" accept=".csv,.tsv,.txt" aria-label="BOM 시트 파일" hidden
              onChange={e => { void loadFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          <div className="bom-paste">
            <textarea className="textarea" aria-label="BOM 본문 붙여넣기" placeholder="또는 여기에 붙여넣기" value={text} onChange={e => setText(e.target.value)} rows={5} />
            <div className="row">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void analyze(text)}>읽기</button>
              <button type="button" className="btn btn-sm" onClick={() => { setText(SAMPLE); void analyze(SAMPLE, '예시.csv'); }}>예시 불러오기</button>
            </div>
          </div>
        </div>
      </section>

      {error && <div className="banner banner-warning" role="alert">{error}</div>}
      {notice && <div className="banner banner-info" role="status">{notice}</div>}

      {sheet && sheet.rows.length > 0 && (
        <section className="glass-panel bom-result" aria-label="가져오기 결과">
          <header className="panel-head">
            <div>
              <h2>미리보기</h2>
              <p className="panel-sub">{busy ? '보유 품번과 맞춰 보는 중…' : `${rows.length}줄${fileName ? ` · ${fileName}` : ''}`}</p>
            </div>
          </header>

          <div className="bom-meta">
            <div className="row" role="group" aria-label="감지한 열">
              {detected.map(k => <span key={k} className="chip">{COLUMN_LABEL[k]} · {sheet.columns[k]! + 1}열</span>)}
              {missing.length > 0 && <span className="chip-holo chip-maybe">찾지 못한 열: {missing.map(k => COLUMN_LABEL[k]).join(' · ')}</span>}
            </div>
            <div className="row" role="group" aria-label="매칭 요약">
              <span className="chip-holo chip-ok">보유 {count.matched}</span>
              <span className="chip-holo chip-maybe">후보 {count.suggested}</span>
              <span className="chip-holo chip-none">미보유 {count.none}</span>
              <span className="spacer" />
              <button type="button" className="btn btn-primary btn-sm" disabled={pending.length === 0} onClick={() => void requestAll()}>
                <Icon name="outbox" size={16} />OPMS 등록 요청 {pending.length > 0 ? pending.length : ''}
              </button>
            </div>
            {sheet.warnings.length > 0 && (
              <ul className="bom-warnings" aria-label="읽으며 확인할 것">
                {sheet.warnings.map(w => <li key={w}><Icon name="warning" size={14} />{w}</li>)}
              </ul>
            )}
          </div>

          <div className="table-wrap">
            <table className="table" aria-label="BOM 시트 미리보기">
              <thead>
                <tr><th>줄</th><th>시트의 품번</th><th>이름</th><th className="num">수량</th><th>도면 번호</th><th>상태</th><th>매칭 품번</th><th>사유</th><th>작업</th></tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const m = matches.get(r.line);
                  const status = statusOf(r.line);
                  const qtyBad = !(r.quantity > 0);
                  return (
                    <tr key={r.line}>
                      <td className="mono">{r.line}</td>
                      <td className="mono">{r.itemNo ?? <span className="faint">—</span>}</td>
                      <td>{r.name ?? <span className="faint">—</span>}</td>
                      <td className="num">{r.quantity}{qtyBad && <span className="chip-holo chip-maybe" title="수량이 0 이하이거나 숫자가 아닙니다">수량 확인</span>}</td>
                      <td className="mono">{r.findNo ?? <span className="faint">—</span>}</td>
                      <td>{m ? <span className={`chip-holo ${STATUS_CLASS[status]}`}>{STATUS_TEXT[status]}</span> : <span className="chip-holo chip-wait">매칭 중…</span>}</td>
                      <td>{m?.itemNo ? <Link to={`/items/${m.itemNo}`} className="mono">{m.itemNo}</Link> : <span className="faint">—</span>}{m?.itemName && <small className="bom-item-name">{m.itemName}</small>}</td>
                      <td className="bom-reason">{m?.reason}</td>
                      <td className="bom-actions">
                        {m?.status === 'suggested' && !confirmed.has(r.line) && (
                          <button type="button" className="btn btn-sm" aria-label={`줄 ${r.line} 이 품번으로 확정`} onClick={() => setConfirmed(prev => new Set(prev).add(r.line))}>이 품번으로 확정</button>
                        )}
                        {m && status === 'none' && (requested.has(r.line)
                          ? <span className="chip-holo chip-sent">요청됨 #{requested.get(r.line)}</span>
                          : <button type="button" className="btn btn-primary btn-sm" aria-label={`줄 ${r.line} OPMS에 등록 요청`} onClick={() => void request(r.line)}>OPMS 등록 요청</button>)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
