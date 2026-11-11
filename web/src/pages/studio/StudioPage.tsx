import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssemblyGuide, CadPartMatch } from '../../api/types';
import { Icon } from '../../components/AppShell';
import { uploadToVault, type VaultKind } from '../../api/vault';
import { extractCadAttributes, extractSpecAttributes, type ExtractedAttribute } from '../../extract';
import { useSession } from '../../session';
import { AssemblyHud } from './AssemblyHud';
import { AssemblySteps } from './AssemblySteps';
import { AttributePanel, candidateId, type Decision } from './AttributePanel';
import { OntologyPanel } from './OntologyPanel';
import { useStudio, type ExampleName } from './useStudio';
import './studio.css';

/** 파일 본문을 글자로 읽는다 (File.text 가 없는 환경은 FileReader) */
function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/**
 * 메인 화면: CAD 3D 분해도(홀로그램) + 제조 순서 + 온톨로지.
 * CAD를 올리면 구조에서 제조(조립) 순서를 나누고, 단계마다 쓰이는 부품을 우리 회사가 보유한 품번과 매칭한다.
 * 보유하지 않은 부품은 CAD 이름 그대로(추정 분류가 있으면 함께) 보이고, OPMS로 등록 요청을 보낼 수 있다.
 */
export function StudioPage() {
  const { api } = useSession();
  const studio = useStudio();
  const { parts, layers, model, selected } = studio;

  const [matches, setMatches] = useState<Map<string, CadPartMatch>>(new Map());
  const [confirmed, setConfirmed] = useState<Map<string, CadPartMatch>>(new Map());
  const [guides, setGuides] = useState<Map<string, AssemblyGuide>>(new Map());
  const [example, setExample] = useState<ExampleName>('box');
  const [notice, setNotice] = useState<string>();
  const cadInput = useRef<HTMLInputElement>(null);
  const specInput = useRef<HTMLInputElement>(null);
  const bomInput = useRef<HTMLInputElement>(null);
  const [vaultError, setVaultError] = useState<string>();
  const [tab, setTab] = useState<'onto' | 'attr'>('onto');
  const [specCands, setSpecCands] = useState<Map<string, ExtractedAttribute[]>>(new Map());
  const [decisions, setDecisions] = useState<Map<string, Map<string, Decision>>>(new Map());
  const [attrNotice, setAttrNotice] = useState<string>();

  const names = useMemo(() => [...new Set(parts.map(p => p.name))], [parts]);

  // 속성 후보: CAD 형상 · 부품 이름에서 뽑은 것 + 올린 사양서(txt · md)에서 뽑은 것. 확정해야 부품 속성이 된다
  const cadCands = useMemo(() => {
    const inputs = names.map(name => {
      const p = parts.find(x => x.name === name);
      return { name, size: p?.size ?? null, ...(p?.unit ? { unit: p.unit } : {}) };
    });
    return new Map(extractCadAttributes(inputs).map(r => [r.partName, r.attributes]));
  }, [parts, names]);

  const candidatesOf = useCallback((name: string): ExtractedAttribute[] => {
    const seen = new Set<string>();
    const out: ExtractedAttribute[] = [];
    for (const a of [...(cadCands.get(name) ?? []), ...(specCands.get(name) ?? [])]) {
      const id = candidateId(a);
      if (!seen.has(id)) { seen.add(id); out.push(a); }
    }
    return out;
  }, [cadCands, specCands]);

  const confirmedAttrs = useMemo(() => {
    const out = new Map<string, Record<string, string | number>>();
    names.forEach(n => {
      const d = decisions.get(n);
      if (!d) return;
      const rec: Record<string, string | number> = {};
      candidatesOf(n).forEach(a => { if (d.get(candidateId(a)) === 'confirmed') rec[a.key] = a.value; });
      if (Object.keys(rec).length) out.set(n, rec);
    });
    return out;
  }, [names, decisions, candidatesOf]);

  const overview = useMemo(() => names.map(n => {
    const d = decisions.get(n);
    const alive = candidatesOf(n).filter(a => d?.get(candidateId(a)) !== 'rejected');
    return { name: n, count: alive.length, confirmed: alive.filter(a => d?.get(candidateId(a)) === 'confirmed').length };
  }), [names, decisions, candidatesOf]);
  const attrTotal = overview.reduce((s, o) => s + o.count, 0);
  const attrConfirmed = overview.reduce((s, o) => s + o.confirmed, 0);

  const decide = useCallback((partName: string, id: string, decision: Decision | undefined) => {
    setDecisions(prev => {
      const next = new Map(prev);
      const mine = new Map(next.get(partName) ?? []);
      if (decision) mine.set(id, decision); else mine.delete(id);
      if (decision === 'confirmed') {                                        // 같은 키는 하나만 확정한다 (출처마다 값이 다를 수 있다)
        const key = id.split('|')[0];
        candidatesOf(partName).forEach(a => {
          const other = candidateId(a);
          if (other !== id && a.key === key && mine.get(other) === 'confirmed') mine.delete(other);
        });
      }
      next.set(partName, mine);
      return next;
    });
  }, [candidatesOf]);

  const restoreRejected = useCallback((partName: string) => {
    setDecisions(prev => {
      const mine = new Map(prev.get(partName) ?? []);
      [...mine].forEach(([k, v]) => { if (v === 'rejected') mine.delete(k); });
      return new Map(prev).set(partName, mine);
    });
  }, []);

  // 올린 사양서가 txt · md 면 본문에서 부품에 관련된 속성 후보를 더한다. PDF 는 뷰어의 구절 검색만 된다
  const importSpec = async (file: File) => {
    if (/\.pdf$/i.test(file.name)) {
      setAttrNotice('PDF에서 속성 값을 뽑는 것은 아직 지원하지 않아요. 뷰어에서 구절 검색만 됩니다. 값을 뽑으려면 .txt나 .md로 올려 주세요.');
      return;
    }
    if (!/\.(txt|md)$/i.test(file.name)) return;
    const found = extractSpecAttributes(await readText(file), names);
    const added = found.reduce((n, r) => n + r.attributes.length, 0);
    setSpecCands(prev => {
      const next = new Map(prev);
      found.forEach(r => { if (r.attributes.length) next.set(r.partName, [...(next.get(r.partName) ?? []), ...r.attributes]); });
      return next;
    });
    setAttrNotice(added > 0 ? `${file.name}: 속성 후보 ${added}개를 찾았어요. 속성 탭에서 확정하세요.` : `${file.name}: 부품 이름과 관련된 속성 값을 찾지 못했어요.`);
  };

  // 부품 이름이 바뀔 때마다 보유 품번과 매칭한다 (단계 수만 바뀌면 이름은 같아서 다시 하지 않는다)
  const namesKey = names.join('|');
  useEffect(() => {
    let alive = true;
    if (names.length === 0) { setMatches(new Map()); return; }
    api.matchCadParts(names).then(rows => {
      if (alive) setMatches(new Map(rows.map(r => [r.name, r])));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, namesKey]);

  // 부품마다 적용되는 사내 조립 규칙. 두께 같은 값은 CAD 크기에서, 분류는 매칭 결과에서, 속성은 사람이 확정한 값에서 가져온다
  const guideKey = JSON.stringify(names.map(n => [n, matches.get(n)?.classLabel ?? '', confirmedAttrs.get(n) ?? {}]));
  useEffect(() => {
    let alive = true;
    if (names.length === 0) { setGuides(new Map()); return; }
    const inputs = names.map(name => {
      const size = parts.find(p => p.name === name)?.size;
      const className = matches.get(name)?.classLabel;
      const attributes = confirmedAttrs.get(name);
      return { name, ...(size ? { size } : {}), ...(className ? { className } : {}), ...(attributes ? { attributes } : {}) };
    });
    api.getAssemblyGuides(inputs).then(rows => { if (alive) setGuides(new Map(rows.map(g => [g.partName, g]))); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, namesKey, guideKey]);

  // 다른 모델을 열면 확정 · 요청 기록을 비운다
  useEffect(() => {
    setConfirmed(new Map()); setNotice(undefined);
    setSpecCands(new Map()); setDecisions(new Map()); setAttrNotice(undefined);
  }, [model]);

  const effective = useMemo(() => new Map([...matches, ...confirmed]), [matches, confirmed]);

  const confirm = useCallback((name: string) => {
    const m = matches.get(name);
    if (m) setConfirmed(prev => new Map(prev).set(name, { ...m, status: 'matched', method: m.method ?? 'exact' }));
  }, [matches]);

  // 올린 파일은 화면에서 열기와 별개로 파일 보관소에 원본 그대로 저장한다. 저장이 실패해도 화면에서 보는 건 막지 않는다
  const store = useCallback(async (file: File, kind: VaultKind) => {
    setVaultError(undefined);
    try {
      const saved = await uploadToVault(file, kind);
      setNotice(saved.duplicate
        ? `${file.name}: 같은 파일이 이미 보관소에 있어요 (${saved.sha256.slice(0, 8)})`
        : `${file.name}을(를) 보관소에 저장했어요 (${saved.sha256.slice(0, 8)})`);
    } catch (e) {
      setVaultError(String((e as Error).message ?? e));
    }
  }, []);

  // 안내가 가리킬 부품: 고른 부품, 없으면 지금 단계의 대표 부품
  const activeLayer = studio.step >= 2 ? layers[studio.step - 2] : undefined;
  const focusName = selected?.name ?? (activeLayer ? parts[activeLayer.partIds[0]!]?.name : undefined);
  const focusStep = focusName ? (parts.find(p => p.name === focusName)?.layer ?? -1) + 1 : 0;

  const pick = (file: File | undefined, kind: VaultKind, load?: (f: File) => Promise<unknown>) => {
    if (!file) return;
    void store(file, kind);
    if (load) void load(file);
  };

  return (
    <div className="holo-page">
      <div className="holo-backdrop" aria-hidden />

      <div className="holo-main">
        <header className="holo-head">
          <div>
            <p className="holo-eyebrow">CAD · 사양서 관리</p>
            <h1>CAD 스튜디오</h1>
          </div>
          <div className="row holo-actions">
            <div className="seg" role="group" aria-label="예시 모델">
              {([['box', '전자기기'], ['watch', '손목시계']] as const).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={example === key}
                  onClick={() => { setExample(key); void studio.loadExample(key); }}>{label}</button>
              ))}
            </div>
            <button type="button" className="btn" onClick={() => cadInput.current?.click()}><Icon name="upload_file" size={16} />CAD 올리기</button>
            <button type="button" className="btn" onClick={() => specInput.current?.click()}><Icon name="description" size={16} />사양서 올리기</button>
            <button type="button" className="btn" onClick={() => bomInput.current?.click()}><Icon name="table_chart" size={16} />BOM 올리기</button>
            <input ref={cadInput} type="file" hidden aria-label="CAD 파일" accept=".step,.stp,.iges,.igs,.stl,.obj,.glb,.gltf"
              onChange={e => { pick(e.target.files?.[0], 'cad', studio.loadCad); e.target.value = ''; }} />
            <input ref={specInput} type="file" hidden aria-label="사양서 파일" accept=".pdf,.txt,.md"
              onChange={e => { const f = e.target.files?.[0]; pick(f, 'spec', studio.loadSpec); if (f) void importSpec(f); e.target.value = ''; }} />
            <input ref={bomInput} type="file" hidden aria-label="BOM 파일" accept=".xlsx,.csv"
              onChange={e => { pick(e.target.files?.[0], 'bom'); e.target.value = ''; }} />
          </div>
        </header>

        {studio.error && <div className="banner banner-danger" role="alert">{studio.error}</div>}
        {vaultError && <div className="banner banner-danger" role="alert">{vaultError}</div>}
        {notice && <div className="banner banner-info" role="status">{notice}</div>}
        {attrNotice && <div className="banner banner-info" role="status">{attrNotice}</div>}

        <div className="holo-frame">
          <div className="holo-strip">
            <span className={`led ${studio.busy ? 'led-busy' : ''}`} aria-hidden />
            <span className="holo-model">{model || 'CAD 분석 대기'}</span>
            <span className="spacer" />
            {attrTotal > 0 && <span className="attr-chip" role="status" aria-label="속성 후보 요약">속성 후보 {attrTotal}개 · 확정 {attrConfirmed}개</span>}
            <span className="holo-meta">{studio.busy ? '분석 중…' : `부품 ${parts.length}개 · ${layers.length}단계`}</span>
          </div>
          <div ref={studio.host} className="holo-host" />
          <AssemblyHud stage={studio.stage} total={layers.length} stepNo={focusStep}
            {...(focusName ? { partName: focusName } : {})} {...(focusName && guides.get(focusName) ? { guide: guides.get(focusName)! } : {})} />
          <i className="corner corner-tl" aria-hidden /><i className="corner corner-tr" aria-hidden />
          <i className="corner corner-bl" aria-hidden /><i className="corner corner-br" aria-hidden />
        </div>
      </div>

      <aside className="holo-side">
        <AssemblySteps
          layers={layers} parts={parts} matches={effective} step={studio.step}
          {...(selected ? { selectedName: selected.name } : {})}
          onStep={studio.goStep} onSelect={studio.selectPart}
        />
        <div className="seg inspector-tabs" role="tablist" aria-label="부품 정보">
          <button type="button" role="tab" aria-selected={tab === 'onto'} onClick={() => setTab('onto')}>온톨로지</button>
          <button type="button" role="tab" aria-selected={tab === 'attr'} onClick={() => setTab('attr')}>속성{attrTotal > 0 ? ` ${attrTotal}` : ''}</button>
        </div>
        {tab === 'onto' ? (
          <OntologyPanel
            model={model} parts={parts} matches={effective}
            {...(selected ? { selectedName: selected.name } : {})}
            onConfirm={confirm}
          />
        ) : (
          <AttributePanel
            {...(selected ? { partName: selected.name } : {})}
            candidates={selected ? candidatesOf(selected.name) : []}
            decisions={selected ? (decisions.get(selected.name) ?? new Map()) : new Map()}
            overview={overview}
            onDecide={(id, d) => selected && decide(selected.name, id, d)}
            onRestore={() => selected && restoreRejected(selected.name)}
            onSelectPart={studio.selectPart}
          />
        )}
      </aside>
    </div>
  );
}
