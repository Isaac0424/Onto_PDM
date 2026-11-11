// ① 대상: 무엇을 어떻게 바꾸나. 종류를 고르면 "개정이냐 교체냐" 안내가 나온다(규격이 바뀌면 새 품번).
import { useState, type FormEvent } from 'react';
import type { ChangeDetail, ChangeKind, ChangeTargetIn, ChangeTargetView } from '../../../api/types';
import { Badge, ErrorText } from '../../../components/ui';
import { CHANGE_KIND, CHANGE_KIND_HELP } from '../../../labels';
import { useSession } from '../../../session';
import { useAction } from '../changeUi';

/** "키=값" 줄들을 객체로. 숫자처럼 읽히면 숫자로 */
export function parseAttributes(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([^=:\s][^=:]*?)\s*[=:]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const num = Number(m[2]);
    out[m[1]!] = m[2] !== '' && Number.isFinite(num) ? num : m[2];
  }
  return out;
}

const KINDS = Object.keys(CHANGE_KIND) as ChangeKind[];

function BeforeAfter({ t }: { t: ChangeTargetView }) {
  const keys = [...new Set([...Object.keys(t.before), ...Object.keys(t.after)])];
  if (t.change_kind === 'replace') return <span className="mono">{t.item_no} → {t.replacement_item_no ?? '?'}</span>;
  if (keys.length === 0) return <span className="faint">—</span>;
  return <ul className="chg-attrs">{keys.map(k => <li key={k}><span className="muted">{k}</span> <span className="mono">{String(t.before[k] ?? '—')} → {String(t.after[k] ?? '—')}</span></li>)}</ul>;
}

function AddTarget({ code }: { code: string }) {
  const { api } = useSession();
  const { run, busy, error } = useAction();
  const [kind, setKind] = useState<ChangeKind>('replace');
  const [f, setF] = useState({ item_no: '', replacement_item_no: '', from_revision: '', to_revision: '', after: '', note: '' });
  const set = (k: keyof typeof f, v: string) => setF(s => ({ ...s, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const after = parseAttributes(f.after);
    const body: ChangeTargetIn = {
      change_kind: kind, item_no: f.item_no.trim(),
      ...(kind === 'replace' && f.replacement_item_no.trim() ? { replacement_item_no: f.replacement_item_no.trim() } : {}),
      ...(f.from_revision.trim() ? { from_revision: f.from_revision.trim() } : {}),
      ...(f.to_revision.trim() ? { to_revision: f.to_revision.trim() } : {}),
      ...(Object.keys(after).length > 0 ? { after } : {}),
      ...(f.note.trim() ? { note: f.note.trim() } : {}),
    };
    const added = await run(() => api.addChangeTarget(code, body));
    if (added) setF({ item_no: '', replacement_item_no: '', from_revision: '', to_revision: '', after: '', note: '' });
  };

  return (
    <form className="card chg-form" onSubmit={submit} aria-label="변경 대상 추가">
      <div className="card-head"><h3>변경 대상 추가</h3></div>
      <div className="card-body chg-form-grid">
        <label className="field"><span>변경 종류</span>
          <select className="select" value={kind} onChange={e => setKind(e.target.value as ChangeKind)}>
            {KINDS.map(k => <option key={k} value={k}>{CHANGE_KIND[k]}</option>)}
          </select>
          <span className="hint" role="note">{CHANGE_KIND_HELP[kind]}</span>
        </label>
        <label className="field"><span>품번</span><input className="input mono" required value={f.item_no} onChange={e => set('item_no', e.target.value)} placeholder="P-00000000022" /></label>
        {kind === 'replace' && (
          <label className="field"><span>바꿀 품번</span><input className="input mono" value={f.replacement_item_no} onChange={e => set('replacement_item_no', e.target.value)} placeholder="P-00000000023" /></label>
        )}
        {(kind === 'revise' || kind === 'attribute_edit') && (
          <>
            <label className="field"><span>이전 개정</span><input className="input mono" value={f.from_revision} onChange={e => set('from_revision', e.target.value)} placeholder="R00" /></label>
            <label className="field"><span>새 개정</span><input className="input mono" value={f.to_revision} onChange={e => set('to_revision', e.target.value)} placeholder="R01" /></label>
            <label className="field"><span>바뀌는 값 (한 줄에 하나, 키=값)</span><textarea className="textarea mono" value={f.after} onChange={e => set('after', e.target.value)} placeholder="thickness=12" /></label>
          </>
        )}
        <label className="field"><span>메모</span><input className="input" value={f.note} onChange={e => set('note', e.target.value)} /></label>
      </div>
      <div className="card-body chg-form-actions">
        <ErrorText {...(error ? { error } : {})} />
        <div className="row"><button type="submit" className="btn btn-primary btn-sm" disabled={busy || !f.item_no.trim()}>{busy ? '추가하는 중…' : '대상 추가'}</button></div>
      </div>
    </form>
  );
}

export function TargetsTab({ change }: { change: ChangeDetail }) {
  const { api } = useSession();
  const { run, busy, error } = useAction();
  const editable = !change.order || change.order.status === 'draft';
  return (
    <div className="chg-stack">
      {change.targets.length === 0
        ? <div className="empty">변경 대상이 아직 없어요. 아래에서 추가하세요.</div>
        : (
          <div className="card">
            <div className="table-wrap">
              <table className="table chg-table" aria-label="변경 대상">
                <thead><tr><th>종류</th><th>품번</th><th>이전 → 이후</th><th>개정</th><th>적용 범위</th><th /></tr></thead>
                <tbody>
                  {change.targets.map(t => (
                    <tr key={t.id}>
                      <td data-label="종류"><Badge tone={t.change_kind === 'replace' ? 'accent' : 'info'}>{CHANGE_KIND[t.change_kind]}</Badge></td>
                      <td data-label="품번" className="mono">{t.item_no}</td>
                      <td data-label="이전 → 이후"><BeforeAfter t={t} />{t.note && <small className="chg-sub">{t.note}</small>}</td>
                      <td data-label="개정" className="mono">{t.from_revision ?? '—'}{t.to_revision ? ` → ${t.to_revision}` : ''}</td>
                      <td data-label="적용 범위">{t.scopes.length > 0 ? `${t.scopes.length}개` : <Badge tone="warning">미정</Badge>}</td>
                      <td>
                        {editable && (
                          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} aria-label={`${t.item_no} 대상 빼기`}
                            onClick={() => run(() => api.removeChangeTarget(change.code, t.id))}>빼기</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      <ErrorText {...(error ? { error } : {})} />
      {editable ? <AddTarget code={change.code} /> : <p className="faint">검토가 시작된 뒤에는 대상을 바꿀 수 없어요.</p>}
    </div>
  );
}
