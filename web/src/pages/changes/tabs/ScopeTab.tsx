// ③ 적용 범위: 바뀐 기준을 어디에 적용하나. 날짜뿐 아니라 사업장 · 생산 로트 · 제품 일련번호로 정한다.
// 범위를 정하지 않은 것은 "전체 · 즉시"가 아니라 "미정"이다. 겹치거나 올바르지 않은 범위는 서버가 거절하고 이유를 인라인으로 보인다.
import { useState } from 'react';
import type { ChangeApplies, ChangeDetail, ChangeScopeIn, ChangeTargetView } from '../../../api/types';
import { Badge, ErrorText } from '../../../components/ui';
import { APPLIES, CHANGE_KIND } from '../../../labels';
import { useSession } from '../../../session';
import { useAction } from '../changeUi';

interface Row { effective_from: string; effective_to: string; site: string; lots: string; serial_from: string; serial_to: string; applies: ChangeApplies; note: string }

const blank = (): Row => ({ effective_from: '', effective_to: '', site: '', lots: '', serial_from: '', serial_to: '', applies: 'new', note: '' });
const fromView = (s: ChangeTargetView['scopes'][number]): Row => ({
  effective_from: s.effective_from ?? '', effective_to: s.effective_to ?? '', site: s.site ?? '', lots: (s.lot_nos ?? []).join(', '),
  serial_from: s.serial_from !== undefined ? String(s.serial_from) : '', serial_to: s.serial_to !== undefined ? String(s.serial_to) : '', applies: s.applies, note: s.note ?? '',
});

/** 입력 줄 → 서버 형식. 비어 있는 칸은 보내지 않는다 */
export function toScope(r: Row): ChangeScopeIn {
  const lots = r.lots.split(',').map(x => x.trim()).filter(Boolean);
  return {
    applies: r.applies,
    ...(r.effective_from ? { effective_from: r.effective_from } : {}), ...(r.effective_to ? { effective_to: r.effective_to } : {}),
    ...(r.site.trim() ? { site: r.site.trim() } : {}), ...(lots.length > 0 ? { lot_nos: lots } : {}),
    ...(r.serial_from !== '' ? { serial_from: Number(r.serial_from) } : {}), ...(r.serial_to !== '' ? { serial_to: Number(r.serial_to) } : {}),
    ...(r.note.trim() ? { note: r.note.trim() } : {}),
  };
}

function ScopeEditor({ code, target, editable }: { code: string; target: ChangeTargetView; editable: boolean }) {
  const { api } = useSession();
  const { run, busy, error } = useAction();
  const [rows, setRows] = useState<Row[]>(() => target.scopes.map(fromView));
  const patch = (i: number, p: Partial<Row>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const label = `${target.item_no} 적용 범위`;

  return (
    <section className="card" aria-label={label}>
      <div className="card-head">
        <h3><span className="mono">{target.item_no}</span> <span className="muted">{CHANGE_KIND[target.change_kind]}</span></h3>
        {rows.length === 0 && <Badge tone="warning" title="범위가 없으면 전체 · 즉시가 아니라 미정이에요.">범위 미정</Badge>}
      </div>
      <div className="card-body chg-stack">
        {rows.map((r, i) => (
          <fieldset key={i} className="chg-scope" disabled={!editable} aria-label={`범위 ${i + 1}`}>
            <legend>범위 {i + 1}</legend>
            <div className="chg-form-grid">
              <label className="field"><span>적용 시작일</span><input className="input" type="date" value={r.effective_from} onChange={e => patch(i, { effective_from: e.target.value })} /></label>
              <label className="field"><span>적용 종료일</span><input className="input" type="date" value={r.effective_to} onChange={e => patch(i, { effective_to: e.target.value })} /></label>
              <label className="field"><span>사업장</span><input className="input" value={r.site} onChange={e => patch(i, { site: e.target.value })} placeholder="비우면 모든 사업장" /></label>
              <label className="field"><span>생산 로트 (쉼표로 구분)</span><input className="input mono" value={r.lots} onChange={e => patch(i, { lots: e.target.value })} placeholder="LOT-001, LOT-002" /></label>
              <label className="field"><span>일련번호 시작</span><input className="input mono" inputMode="numeric" value={r.serial_from} onChange={e => patch(i, { serial_from: e.target.value })} /></label>
              <label className="field"><span>일련번호 끝</span><input className="input mono" inputMode="numeric" value={r.serial_to} onChange={e => patch(i, { serial_to: e.target.value })} /></label>
              <label className="field"><span>적용 방식</span>
                <select className="select" value={r.applies} onChange={e => patch(i, { applies: e.target.value as ChangeApplies })}>
                  {(Object.keys(APPLIES) as ChangeApplies[]).map(a => <option key={a} value={a}>{APPLIES[a]}</option>)}
                </select>
              </label>
              <label className="field"><span>메모</span><input className="input" value={r.note} onChange={e => patch(i, { note: e.target.value })} /></label>
            </div>
            {editable && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>이 범위 빼기</button>}
          </fieldset>
        ))}
        <ErrorText {...(error ? { error } : {})} />
        {editable && (
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => setRows(rs => [...rs, blank()])}>범위 추가</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.setChangeScope(code, target.id, { scopes: rows.map(toScope) }))}>
              {busy ? '저장하는 중…' : '범위 저장'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export function ScopeTab({ change }: { change: ChangeDetail }) {
  const editable = !change.order || change.order.status === 'draft' || change.order.status === 'in_review';
  if (change.targets.length === 0) return <div className="empty">변경 대상을 먼저 추가하세요.</div>;
  return (
    <div className="chg-stack">
      <p className="muted chg-help">이미 만든 제품 · 진행 중 작업 · 재고는 기존 사양으로 허용될 수 있어요. 새 기준을 어디까지 적용할지 유효일 · 사업장 · 로트 · 일련번호로 정하세요.</p>
      {change.targets.map(t => <ScopeEditor key={`${t.id}-${t.scopes.map(s => s.id).join('.')}`} code={change.code} target={t} editable={editable} />)}
    </div>
  );
}
