import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Identifier, Material, PartRequest, PartRequestPayload, TaxonomyClass } from '../../api/types';
import { RequestBadge } from '../../components/StatusBadges';
import { Badge, ErrorText, Loaded } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { DUPLICATE_METHOD, ID_SCHEME, ITEM_TYPE, formatDateTime } from '../../labels';
import { useSession } from '../../session';
import { classLabel, classOptions } from './classOptions';

export function RequestEditPage() {
  const { id } = useParams();
  const { api } = useSession();
  const isNew = id === undefined;
  const request = useAsync(() => (isNew ? Promise.resolve(null) : api.getPartRequest(Number(id))), [id]);
  const classes = useAsync(() => api.listClasses(), []);
  const materials = useAsync(() => api.listMaterials(), []);

  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <Loaded state={request}>
        {r => (
          <RequestForm
            key={r?.id ?? 'new'} request={r} classes={classes.data ?? []} materials={materials.data ?? []}
          />
        )}
      </Loaded>
    </div>
  );
}

function RequestForm({ request, classes, materials }: { request: PartRequest | null; classes: TaxonomyClass[]; materials: Material[] }) {
  const { api, user, bump } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState<PartRequestPayload>(request?.payload ?? { itemType: 'part', unit: 'EA', aliases: [] });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // 새 요청을 처음 저장하면 주소가 /requests/:id 로 바뀌며 폼이 다시 그려지므로 메시지를 이동 상태로 넘겨받는다
  const [saved, setSaved] = useState<string | undefined>((location.state as { saved?: string } | null)?.saved);
  const editable = !request || (request.status === 'draft' && request.requestedBy === user?.id);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const set = <K extends keyof PartRequestPayload>(k: K, v: PartRequestPayload[K]) => {
    setForm(f => ({ ...f, [k]: v }));
    setDirty(true);
    setSaved(undefined);
  };
  const aliases = form.aliases ?? [];
  const setAlias = (i: number, a: Identifier) => set('aliases', aliases.map((x, j) => (j === i ? a : x)));

  async function save(): Promise<PartRequest | undefined> {
    setBusy(true); setError(undefined);
    try {
      const clean = { ...form, aliases: aliases.filter(a => a.value.trim()) };
      const r = await api.savePartRequest(request?.id ?? null, clean);
      const message = `임시저장했습니다 (${formatDateTime(r.updatedAt)})`;
      setDirty(false);
      setSaved(message);
      bump();
      if (!request) navigate(`/requests/${r.id}`, { replace: true, state: { saved: message } });
      return r;
    } catch (e) {
      setError((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    const r = await save();
    if (!r) return;
    setBusy(true);
    try {
      await api.submitPartRequest(r.id);
      bump();
      navigate(`/requests/${r.id}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const classOpts = classOptions(classes);
  return (
    <>
      <div className="page-head">
        <div>
          <div className="row" style={{ gap: 8 }}>
            <Link to="/requests" className="muted">← 내 등록 요청</Link>
          </div>
          <h1 style={{ marginTop: 4 }}>
            {request ? `등록 요청 #${request.id}` : '새 등록 요청'} {request && <RequestBadge status={request.status} />}
          </h1>
          {request && <p className="sub">출처 {request.sourceSystem} · 마지막 수정 {formatDateTime(request.updatedAt)}</p>}
        </div>
      </div>

      {request?.status === 'approved' && request.issuedItemNo && (
        <div className="banner banner-info">
          품번 <Link className="mono" to={`/items/${request.issuedItemNo}`}>{request.issuedItemNo}</Link>이(가) 발급되었습니다. 첫 리비전 R00(작업중)이 함께 만들어졌습니다.
        </div>
      )}
      {request?.status === 'rejected' && <div className="banner banner-danger">반려: {request.reviewNote}</div>}
      {request?.status === 'submitted' && (
        <div className="banner banner-info">제출되었습니다. 관리자 모드에서 검토 중입니다. 제출 뒤에는 고칠 수 없습니다.</div>
      )}
      {request?.classProposalId && !form.classIri && (
        <div className="banner banner-warning">분류가 새 분류 제안 #{request.classProposalId}의 검토를 기다리고 있습니다.</div>
      )}

      <section className="card">
        <div className="card-body" style={{ display: 'grid', gap: 16 }}>
          <fieldset disabled={!editable || busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 16 }}>
            <div className="grid-2">
              <label className="field">
                <span>이름 (원래 이름) *</span>
                <input className="input" value={form.name ?? ''} onChange={e => set('name', e.target.value)} placeholder="예: Cable clamp" />
                <span className="hint">제출할 때 필요합니다. 임시저장은 비어 있어도 됩니다.</span>
              </label>
              <label className="field">
                <span>한글 이름</span>
                <input className="input" value={form.nameKo ?? ''} onChange={e => set('nameKo', e.target.value)} placeholder="예: 케이블 클램프" />
              </label>
              <label className="field">
                <span>구분</span>
                <select className="select" value={form.itemType ?? 'part'} onChange={e => set('itemType', e.target.value as PartRequestPayload['itemType'])}>
                  {Object.entries(ITEM_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="field">
                <span>관리 단위</span>
                <input className="input" value={form.unit ?? ''} onChange={e => set('unit', e.target.value)} placeholder="EA" />
              </label>
              <label className="field">
                <span>분류</span>
                <select className="select" value={form.classIri ?? ''} onChange={e => set('classIri', e.target.value || undefined)}>
                  <option value="">미지정</option>
                  {classOpts.map(o => <option key={o.iri} value={o.iri}>{o.label} ({o.code})</option>)}
                </select>
                <span className="hint">승인(품번 발급) 때 필요합니다. 맞는 분류가 없으면 비워 두고 메모에 적어 주세요.</span>
              </label>
              <label className="field">
                <span>재료</span>
                <select className="select" value={form.materialIri ?? ''} onChange={e => set('materialIri', e.target.value || undefined)}>
                  <option value="">없음</option>
                  {materials.map(m => <option key={m.iri} value={m.iri}>{m.name} ({m.aliases.join(', ')})</option>)}
                </select>
              </label>
            </div>

            <div className="field">
              <span>별칭</span>
              <span className="hint">레거시 품번 · ERP 코드 · 공급사 품번(공급사코드:품번) · CAD 이름. 다른 품목과 겹치면 승인이 거부됩니다.</span>
              {aliases.map((a, i) => (
                <div key={i} className="row">
                  <select className="select" style={{ width: 160 }} aria-label="별칭 종류" value={a.scheme} onChange={e => setAlias(i, { ...a, scheme: e.target.value as Identifier['scheme'] })}>
                    {Object.entries(ID_SCHEME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <input className="input mono" style={{ flex: 1, width: 'auto' }} aria-label="별칭 값" value={a.value} onChange={e => setAlias(i, { ...a, value: e.target.value })} />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => set('aliases', aliases.filter((_, j) => j !== i))}>삭제</button>
                </div>
              ))}
              <div><button type="button" className="btn btn-sm" onClick={() => set('aliases', [...aliases, { scheme: 'legacy', value: '' }])}>별칭 추가</button></div>
            </div>

            <label className="field">
              <span>메모</span>
              <textarea className="textarea" value={form.note ?? ''} onChange={e => set('note', e.target.value)} />
            </label>
          </fieldset>

          <ErrorText error={error} />
          {editable && (
            <div className="row">
              <button type="button" className="btn" disabled={busy} onClick={save}>임시저장</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>제출</button>
              {dirty ? <span className="faint">저장하지 않은 변경이 있습니다</span> : saved && <span className="muted">{saved}</span>}
            </div>
          )}
        </div>
      </section>

      {request?.duplicateCheck && request.duplicateCheck.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>중복 후보</h2><span className="faint" style={{ fontSize: 12 }}>제출할 때 이름 · 별칭 · 유사도로 찾은 기존 품목</span></div>
          <DuplicateTable request={request} />
        </section>
      )}
      {request && !editable && request.payload.classIri && (
        <p className="faint">분류: {classLabel(classes, request.payload.classIri)}</p>
      )}
    </>
  );
}

export function DuplicateTable({ request }: { request: PartRequest }) {
  return (
    <table className="table">
      <thead><tr><th>품번</th><th>이름</th><th>방법</th><th className="num">점수</th></tr></thead>
      <tbody>
        {request.duplicateCheck!.map(c => (
          <tr key={c.itemNo}>
            <td><Link className="mono" to={`/items/${c.itemNo}`}>{c.itemNo}</Link></td>
            <td>{c.name}</td>
            <td>{DUPLICATE_METHOD[c.method]}</td>
            <td className="num">{c.score >= 0.95 ? <Badge tone="danger">{c.score.toFixed(2)}</Badge> : c.score.toFixed(2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
